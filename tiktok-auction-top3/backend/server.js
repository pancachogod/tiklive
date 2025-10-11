// backend/server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { WebcastPushConnection } from 'tiktok-live-connector';
import crypto from 'crypto';

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
/**
 * rooms: Map<roomId, Room>
 * Room = {
 *   id, user, auction:{title,endsAt,donationsTotal,top},
 *   donors: Map,
 *   tiktok: WebcastPushConnection|null,
 *   reconnectTimer: NodeJS.Timer|null,
 *   lastActivity: number
 * }
 */
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
      // regalos en racha: solo sumar cuando termina
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

/* Limpieza de rooms inactivos (opcional) */
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

/* Watchdog: al terminar el tiempo, reemitir estado (no sumar más) */
setInterval(() => {
  for (const r of rooms.values()) {
    if (!isRunning(r) && r.auction.endsAt !== 0) {
      io.to(r.id).emit('state', r.auction);
    }
  }
}, 1000);

/* ================== ENDPOINTS DE SALA ================== */

// Cambiar usuario de TikTok para un room
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

// Iniciar/reiniciar subasta
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

// Estado
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

// Simular donación (solo si la subasta está activa)
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
   SISTEMA DE LLAVES (admin + verificación)
   - ADMIN_KEY fija a 'pancacho123'
   - Almacenamiento en memoria (se pierde al reiniciar)
===================================================== */
const ADMIN_KEY = 'pancacho123';      // ← tu clave admin solicitada
const LICENSES = new Map();            // key -> { expiresAt }

/* limpieza de llaves vencidas */
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of LICENSES) {
    if (v.expiresAt <= t) LICENSES.delete(k);
  }
}, 10 * 60 * 1000);

/* generador legible: ABCD-1234-EFGH */
function genKeyReadable() {
  const raw = crypto.randomBytes(8).toString('hex').toUpperCase();
  return raw.slice(0,4) + '-' + raw.slice(4,8) + '-' + raw.slice(8,12);
}

/* Verificar/canjear: público
   body: { key }
   resp: { ok, expiresAt? } */
app.post('/license/verify', (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'key-required' });

  const info = LICENSES.get(key);
  if (!info) return res.json({ ok: false });

  if (Date.now() > info.expiresAt) {
    LICENSES.delete(key);
    return res.json({ ok: false });
  }
  res.json({ ok: true, expiresAt: info.expiresAt });
});

/* Crear llaves: solo admin
   headers: x-admin-key: pancacho123
   body: { months=1, count=5 } */
app.post('/admin/license/create', (req, res) => {
  const headerKey = String(req.headers['x-admin-key'] || '').trim();
  if (headerKey !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const months = Math.max(1, Math.min(12, Number(req.body?.months) || 1));
  const count  = Math.max(1, Math.min(100, Number(req.body?.count) || 1));
  const expiresAt = Date.now() + months * 30 * 24 * 60 * 60 * 1000;

  const keys = [];
  for (let i = 0; i < count; i++) {
    let key;
    do { key = genKeyReadable(); } while (LICENSES.has(key));
    LICENSES.set(key, { expiresAt });
    keys.push({ key, expiresAt: new Date(expiresAt).toISOString() });
  }
  res.json({ ok: true, keys });
});

/* Opcional: listar/borrar (solo admin) */
app.get('/admin/license/list', (req, res) => {
  const headerKey = String(req.headers['x-admin-key'] || '').trim();
  if (headerKey !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const out = [...LICENSES.entries()].map(([k, v]) => ({
    key: k, expiresAt: new Date(v.expiresAt).toISOString()
  }));
  res.json({ ok: true, licenses: out });
});

app.post('/admin/license/delete', (req, res) => {
  const headerKey = String(req.headers['x-admin-key'] || '').trim();
  if (headerKey !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const key = String(req.body?.key || '').trim();
  if (!key) return res.json({ ok:false, error:'key-required' });
  const existed = LICENSES.delete(key);
  res.json({ ok:true, deleted: existed });
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

/* ================== START ================== */
server.listen(PORT, () => console.log('Backend on :' + PORT));
