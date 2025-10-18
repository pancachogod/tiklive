// backend/server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { WebcastPushConnection } from 'tiktok-live-connector';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

/* ================== CONFIG BÁSICA ================== */
const PORT = process.env.PORT || 3000;

/* Orígenes permitidos (ajusta tu Vercel si cambia) */
const ORIGINS = [
  'https://tiklive-6ywqave4w-pancachogods-projects.vercel.app',
  /\.vercel\.app$/,                 // cualquier *.vercel.app
  'http://localhost:5173',
];

/* ================== APP / IO ================== */
const app = express();
app.use(cors({
  origin: ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-admin-key'],
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS, methods: ['GET','POST'] },
  transports: ['websocket', 'polling'],
});

/* =====================================================
   MODELO MULTI-ROOM (subasta por sala)
===================================================== */
const rooms = new Map();
const ROOM_IDLE_MS = 60 * 60 * 1000; // 1h sin actividad => limpiar
const now = () => Date.now();

function newRoom(roomId) {
  return {
    id: roomId,
    user: (process.env.TIKTOK_USER || 'sticx33').trim(),
    auction: { title: 'Subasta', endsAt: 0, donationsTotal: 0, top: [] },
    donors: new Map(),
    tiktok: null,
    reconnectTimer: null,
    lastActivity: now(),
  };
}

function getRoom(roomId) {
  let r = rooms.get(roomId);
  if (!r) { r = newRoom(roomId); rooms.set(roomId, r); }
  r.lastActivity = now();
  return r;
}

const isRunning = (r) => Number(r.auction.endsAt) > now();

function emitDonation(r) {
  r.auction.top = [...r.donors.entries()]
    .map(([u, v]) => ({ user: u, total: v.total, avatar: v.avatar }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  io.to(r.id).emit('donation', { donationsTotal: r.auction.donationsTotal, top: r.auction.top });
}

function scheduleReconnect(r, ms = 30_000) {
  if (r.reconnectTimer) return;
  let left = Math.floor(ms / 1000);
  console.log(`[${r.id}] Reintentando conexión a TikTok en ${left}s…`);
  r.reconnectTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(r.reconnectTimer);
      r.reconnectTimer = null;
      connectLoop(r);
    } else {
      console.log(`[${r.id}] Reintentando en ${left}s…`);
    }
  }, 1000);
}

async function connectLoop(r) {
  try {
    if (r.tiktok) {
      r.tiktok.removeAllListeners('gift');
      r.tiktok.removeAllListeners('disconnected');
      try { r.tiktok.disconnect && r.tiktok.disconnect(); } catch {}
      r.tiktok = null;
    }

    r.tiktok = new WebcastPushConnection(r.user);
    await r.tiktok.connect();
    console.log(`[${r.id}] Conectado a TikTok LIVE de @${r.user}`);

    if (r.reconnectTimer) { clearInterval(r.reconnectTimer); r.reconnectTimer = null; }

    r.tiktok.on('gift', data => {
      if (!isRunning(r)) return;
      if (data?.giftType === 1 && !data?.repeatEnd) return;

      const user   = data?.nickname || data?.uniqueId || 'Anónimo';
      const avatar = data?.profilePictureUrl || '';
      const per    = data?.diamondCount ?? data?.gift?.diamondCount ?? 0;
      const count  = data?.repeatCount ?? 1;
      const diamonds = per * count;

      if (diamonds > 0) {
        const prev = r.donors.get(user) || { total: 0, avatar };
        prev.total += diamonds;
        prev.avatar = avatar || prev.avatar;
        r.donors.set(user, prev);
        r.auction.donationsTotal += diamonds;
        emitDonation(r);
      }
    });

    r.tiktok.on('disconnected', () => {
      console.log(`[${r.id}] Desconectado de TikTok.`);
      scheduleReconnect(r, 30_000);
    });
  } catch (err) {
    console.error(`[${r.id}] Error conectando a TikTok:`, err?.message || err);
    scheduleReconnect(r, 30_000);
  }
}

/* Limpieza de rooms inactivos */
setInterval(() => {
  const cutoff = now() - ROOM_IDLE_MS;
  for (const [id, r] of rooms) {
    if (r.lastActivity < cutoff && !isRunning(r)) {
      console.log(`🧹 Eliminando room inactivo: ${id}`);
      try { r.tiktok?.disconnect?.(); } catch {}
      clearInterval(r.reconnectTimer);
      rooms.delete(id);
    }
  }
}, 10 * 60 * 1000);

/* Watchdog */
setInterval(() => {
  for (const r of rooms.values()) {
    if (!isRunning(r) && r.auction.endsAt !== 0) {
      io.to(r.id).emit('state', r.auction);
    }
  }
}, 1000);

/* ================== ENDPOINTS DE SALA ================== */

app.post('/:room/user', (req, res) => {
  const roomId = String(req.params.room || '').trim();
  const r = getRoom(roomId);
  const clean = String((req.body?.user || '')).trim().replace(/^@+/, '');
  if (!clean) return res.status(400).json({ ok: false, error: 'user-required' });

  r.user = clean;
  console.log(`[${r.id}] Cambiando usuario a @${clean} y reconectando…`);
  r.donors.clear();
  r.auction.top = [];
  r.auction.donationsTotal = 0;

  scheduleReconnect(r, 1000);
  io.to(r.id).emit('state', r.auction);
  res.json({ ok: true, user: r.user });
});

app.post('/:room/auction/start', (req, res) => {
  const roomId = String(req.params.room || '').trim();
  const r = getRoom(roomId);
  const { durationSec = 60, title } = req.body || {};
  const dur = Math.max(1, Number(durationSec) || 60);
  if (title) r.auction.title = String(title);
  r.auction.endsAt = now() + dur * 1000;
  r.auction.donationsTotal = 0;
  r.auction.top = [];
  r.donors.clear();
  io.to(r.id).emit('state', r.auction);
  res.json({ ok: true, auction: r.auction });
});

app.get('/:room/auction', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  res.json(r.auction);
});

app.get('/:room/status', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  res.json({
    room: r.id,
    user: r.user,
    running: isRunning(r),
    endsAt: r.auction.endsAt,
    donors: r.donors.size,
    topSize: r.auction.top.length
  });
});

app.post('/:room/debug/gift', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  const { user='Tester', avatar='', diamonds=50 } = req.body || {};
  if (!isRunning(r)) return res.json({ ok: true, ignored: true, reason: 'auction-ended' });
  const prev = r.donors.get(user) || { total: 0, avatar };
  prev.total += Number(diamonds);
  prev.avatar = avatar || prev.avatar;
  r.donors.set(user, prev);
  r.auction.donationsTotal += Number(diamonds);
  emitDonation(r);
  res.json({ ok: true, top: r.auction.top });
});

/* =====================================================
   SISTEMA DE LICENCIAS MEJORADO
   - Sin base de datos, usa archivo JSON
   - Persistencia en disco
   - Sistema completo de gestión
===================================================== */

const ADMIN_KEY = 'pancacho123';
const LICENSE_FILE = path.join(process.cwd(), 'licenses.json');

// Estructura de licencia:
// {
//   key: string,
//   months: number,
//   createdAt: number,
//   expiresAt: number,
//   activatedAt: number | null,
//   lastUsed: number | null,
//   userIdentifier: string | null,
//   status: 'active' | 'expired' | 'revoked',
//   notes: string,
//   usageCount: number
// }

let LICENSES = new Map();

// Cargar licencias desde archivo
function loadLicenses() {
  try {
    if (fs.existsSync(LICENSE_FILE)) {
      const data = fs.readFileSync(LICENSE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      LICENSES = new Map(Object.entries(parsed));
      console.log(`📦 Cargadas ${LICENSES.size} licencias desde archivo`);
    }
  } catch (err) {
    console.error('❌ Error cargando licencias:', err.message);
  }
}

// Guardar licencias a archivo
function saveLicenses() {
  try {
    const obj = Object.fromEntries(LICENSES);
    fs.writeFileSync(LICENSE_FILE, JSON.stringify(obj, null, 2));
  } catch (err) {
    console.error('❌ Error guardando licencias:', err.message);
  }
}

// Cargar al inicio
loadLicenses();

// Auto-guardar cada 30 segundos
setInterval(saveLicenses, 30_000);

// Limpieza de llaves expiradas (marcar como expiradas)
setInterval(() => {
  const t = Date.now();
  let changed = false;
  for (const [k, v] of LICENSES) {
    if (v.status === 'active' && v.expiresAt <= t) {
      v.status = 'expired';
      changed = true;
    }
  }
  if (changed) saveLicenses();
}, 10 * 60 * 1000);

// Generar key legible
function genKeyReadable() {
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
  return raw.slice(0,4) + '-' + raw.slice(4,8) + '-' + raw.slice(8,12);
}

/* ============ USER ENDPOINTS ============ */

// Verificar/activar licencia
app.post('/license/verify', (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'key-required' });

  const lic = LICENSES.get(key);
  if (!lic) return res.json({ ok: false, error: 'invalid-key' });

  const t = Date.now();

  // Verificar si está revocada
  if (lic.status === 'revoked') {
    return res.json({ ok: false, error: 'license-revoked' });
  }

  // Verificar si expiró
  if (t > lic.expiresAt) {
    lic.status = 'expired';
    saveLicenses();
    return res.json({ ok: false, error: 'license-expired' });
  }

  // Activar si es primera vez
  if (!lic.activatedAt) {
    lic.activatedAt = t;
  }

  // Actualizar uso
  lic.lastUsed = t;
  lic.usageCount = (lic.usageCount || 0) + 1;
  saveLicenses();

  res.json({
    ok: true,
    expiresAt: lic.expiresAt,
    daysRemaining: Math.floor((lic.expiresAt - t) / (24 * 60 * 60 * 1000))
  });
});

/* ============ ADMIN ENDPOINTS ============ */

// Middleware para verificar admin
function requireAdmin(req, res, next) {
  const headerKey = String(req.headers['x-admin-key'] || '').trim();
  if (headerKey !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

// Crear licencias
app.post('/admin/license/create', requireAdmin, (req, res) => {
  const months = Math.max(1, Math.min(12, Number(req.body?.months) || 1));
  const count  = Math.max(1, Math.min(100, Number(req.body?.count) || 1));
  const t = Date.now();
  const expiresAt = t + months * 30 * 24 * 60 * 60 * 1000;

  const keys = [];
  for (let i = 0; i < count; i++) {
    let key;
    do { key = genKeyReadable(); } while (LICENSES.has(key));
    
    const lic = {
      key,
      months,
      createdAt: t,
      expiresAt,
      activatedAt: null,
      lastUsed: null,
      userIdentifier: null,
      status: 'active',
      notes: '',
      usageCount: 0
    };
    
    LICENSES.set(key, lic);
    keys.push({ key, expiresAt });
  }
  
  saveLicenses();
  console.log(`✅ Creadas ${count} licencias (${months} meses)`);
  res.json({ ok: true, keys, count: keys.length });
});

// Listar licencias con filtros
app.get('/admin/license/list', requireAdmin, (req, res) => {
  const { status, search } = req.query;
  const t = Date.now();
  
  let licenses = [...LICENSES.values()];
  
  // Filtrar por estado
  if (status && status !== 'all') {
    licenses = licenses.filter(l => l.status === status);
  }
  
  // Buscar por key o usuario
  if (search) {
    const s = search.toLowerCase();
    licenses = licenses.filter(l => 
      l.key.toLowerCase().includes(s) || 
      (l.userIdentifier && l.userIdentifier.toLowerCase().includes(s))
    );
  }
  
  // Agregar info calculada
  licenses = licenses.map(l => ({
    ...l,
    daysRemaining: Math.max(0, Math.floor((l.expiresAt - t) / (24 * 60 * 60 * 1000))),
    isExpired: t > l.expiresAt,
    isActivated: !!l.activatedAt
  }));
  
  // Ordenar por fecha de creación (más reciente primero)
  licenses.sort((a, b) => b.createdAt - a.createdAt);
  
  res.json({ ok: true, licenses, total: licenses.length });
});

// Obtener detalles de una licencia
app.get('/admin/license/:key', requireAdmin, (req, res) => {
  const key = String(req.params.key || '').trim();
  const lic = LICENSES.get(key);
  
  if (!lic) {
    return res.status(404).json({ ok: false, error: 'not-found' });
  }
  
  const t = Date.now();
  res.json({
    ok: true,
    license: {
      ...lic,
      daysRemaining: Math.max(0, Math.floor((lic.expiresAt - t) / (24 * 60 * 60 * 1000))),
      isExpired: t > lic.expiresAt
    }
  });
});

// Revocar licencia
app.post('/admin/license/:key/revoke', requireAdmin, (req, res) => {
  const key = String(req.params.key || '').trim();
  const lic = LICENSES.get(key);
  
  if (!lic) {
    return res.status(404).json({ ok: false, error: 'not-found' });
  }
  
  lic.status = 'revoked';
  saveLicenses();
  
  console.log(`🚫 Licencia revocada: ${key}`);
  res.json({ ok: true, message: 'License revoked' });
});

// Extender licencia
app.post('/admin/license/:key/extend', requireAdmin, (req, res) => {
  const key = String(req.params.key || '').trim();
  const lic = LICENSES.get(key);
  
  if (!lic) {
    return res.status(404).json({ ok: false, error: 'not-found' });
  }
  
  const months = Math.max(1, Number(req.body?.months) || 1);
  const t = Date.now();
  
  // Extender desde la fecha de expiración actual o desde ahora (lo que sea mayor)
  const baseTime = Math.max(lic.expiresAt, t);
  lic.expiresAt = baseTime + months * 30 * 24 * 60 * 60 * 1000;
  
  // Si estaba expirada, reactivar
  if (lic.status === 'expired') {
    lic.status = 'active';
  }
  
  saveLicenses();
  
  console.log(`⏱️ Licencia ${key} extendida por ${months} meses`);
  res.json({ 
    ok: true, 
    message: `Extended by ${months} months`,
    newExpiresAt: lic.expiresAt,
    daysRemaining: Math.floor((lic.expiresAt - t) / (24 * 60 * 60 * 1000))
  });
});

// Eliminar licencia permanentemente
app.post('/admin/license/:key/delete', requireAdmin, (req, res) => {
  const key = String(req.params.key || '').trim();
  const existed = LICENSES.delete(key);
  
  if (existed) {
    saveLicenses();
    console.log(`🗑️ Licencia eliminada: ${key}`);
  }
  
  res.json({ ok: true, deleted: existed });
});

// Estadísticas generales
app.get('/admin/stats', requireAdmin, (req, res) => {
  const t = Date.now();
  const all = [...LICENSES.values()];
  
  const stats = {
    total: all.length,
    active: all.filter(l => l.status === 'active' && l.expiresAt > t).length,
    expired: all.filter(l => l.status === 'expired' || (l.status === 'active' && l.expiresAt <= t)).length,
    revoked: all.filter(l => l.status === 'revoked').length,
    activated: all.filter(l => l.activatedAt).length,
    neverUsed: all.filter(l => !l.lastUsed).length
  };
  
  res.json({ ok: true, stats });
});

// Actualizar notas de una licencia
app.post('/admin/license/:key/notes', requireAdmin, (req, res) => {
  const key = String(req.params.key || '').trim();
  const lic = LICENSES.get(key);
  
  if (!lic) {
    return res.status(404).json({ ok: false, error: 'not-found' });
  }
  
  lic.notes = String(req.body?.notes || '');
  lic.userIdentifier = String(req.body?.userIdentifier || lic.userIdentifier || '');
  saveLicenses();
  
  res.json({ ok: true });
});

/* ================== SOCKET.IO ================== */
io.on('connection', (socket) => {
  const roomId = String((socket.handshake?.query?.room || '')).trim();
  if (!roomId) { socket.disconnect(true); return; }
  const r = getRoom(roomId);
  socket.join(r.id);
  socket.emit('state', r.auction);
});

/* ================== HEALTH ================== */
app.get('/health', (_req, res) => res.send('ok'));

/* ================== GRACEFUL SHUTDOWN ================== */
process.on('SIGINT', () => {
  console.log('\n💾 Guardando licencias antes de cerrar...');
  saveLicenses();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n💾 Guardando licencias antes de cerrar...');
  saveLicenses();
  process.exit(0);
});

/* ================== START ================== */
server.listen(PORT, () => {
  console.log(`🚀 Backend on :${PORT}`);
  console.log(`🔑 Admin key: ${ADMIN_KEY}`);
  console.log(`📦 Licencias cargadas: ${LICENSES.size}`);
});
