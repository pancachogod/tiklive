// backend/server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { WebcastPushConnection } from 'tiktok-live-connector';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';          // ⬅️ añade solo este si aún no está
// ← NUEVO: licencias

const PORT = process.env.PORT || 3000;

/* ===== Orígenes permitidos (ajusta el dominio de tu Vercel) ===== */
const ORIGINS = [
  'https://tiklive-6ywqave4w-pancachogods-projects.vercel.app',
  /\.vercel\.app$/,
  'http://localhost:5173',
];

/* ===== Variables para licencias y Telegram (NUEVO) ===== */
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'change_me_please';
const ADMIN_KEY      = process.env.ADMIN_KEY      || 'superadmin';
const TELEGRAM_URL   = process.env.TELEGRAM_URL   || 'https://t.me/+ae-ctGPi8sM1MTYx';

/* ===== App / IO ===== */
const app = express();
app.use(cors({
  origin: ORIGINS,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-admin-key'], // ← permitir header admin
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS, methods: ['GET','POST'] },
  transports: ['websocket', 'polling'],
});

/** =========================
 *   MODELO MULTI-ROOM
 *  =========================
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
const ROOM_IDLE_MS = 60 * 60 * 1000; // 1h sin actividad => limpieza opcional

function now() { return Date.now(); }

function newRoom(roomId) {
  return {
    id: roomId,
    user: (process.env.TIKTOK_USER || 'sticx33').trim(),   // usuario por defecto
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
      // si existe instancia vieja, cerramos listeners
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
      if (data?.giftType === 1 && !data?.repeatEnd) return; // sumar al final de racha

      const user = data?.nickname || data?.uniqueId || 'Anónimo';
      const avatar = data?.profilePictureUrl || '';
      const perGift = data?.diamondCount ?? data?.gift?.diamondCount ?? 0;
      const count   = data?.repeatCount ?? 1;
      const diamonds = perGift * count;

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

// Limpieza simple de rooms inactivos (opcional)
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
}, 10 * 60 * 1000); // cada 10 min

// Watchdog: notifica al terminar el tiempo (no suma más)
setInterval(() => {
  for (const r of rooms.values()) {
    if (!isRunning(r) && r.auction.endsAt !== 0) {
      io.to(r.id).emit('state', r.auction);
    }
  }
}, 1000);

/* ============ ENDPOINTS POR ROOM ============ */

// Cambiar usuario de TikTok para un room
app.post('/:room/user', (req, res) => {
  const roomId = String(req.params.room || '').trim();
  const r = getRoom(roomId);
  const clean = String((req.body?.user || '')).trim().replace(/^@+/, '');
  if (!clean) return res.status(400).json({ ok: false, error: 'user-required' });

  r.user = clean;
  console.log(`[${r.id}] Cambiando usuario a @${clean} y reconectando…`);
  // no tocamos endsAt; solo reiniciamos ranking
  r.donors.clear();
  r.auction.top = [];
  r.auction.donationsTotal = 0;

  scheduleReconnect(r, 1000);
  io.to(r.id).emit('state', r.auction);
  res.json({ ok: true, user: r.user });
});

// Iniciar/reiniciar subasta en un room
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
  res.json({ room: r.id, user: r.user, running: isRunning(r), endsAt: r.auction.endsAt, donors: r.donors.size, topSize: r.auction.top.length });
});

// Simular donación (respeta ventana de tiempo)
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



const PORT = process.env.PORT || 3000;

/* ===== Orígenes permitidos (ajusta el dominio de tu Vercel) ===== */
const ORIGINS = [
  'https://tiklive-6ywqave4w-pancachogods-projects.vercel.app',
  /\.vercel\.app$/,
  'http://localhost:5173',
];

/* ===== Variables para licencias y Telegram (NUEVO) ===== */
const LICENSE_SECRET = process.env.LICENSE_SECRET || 'change_me_please';
const ADMIN_KEY      = process.env.ADMIN_KEY      || 'superadmin';
const TELEGRAM_URL   = process.env.TELEGRAM_URL   || 'https://t.me/+ae-ctGPi8sM1MTYx';

/* ===== App / IO ===== */
const app = express();
app.use(cors({
  origin: ORIGINS,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','x-admin-key'], // ← permitir header admin
}));
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS, methods: ['GET','POST'] },
  transports: ['websocket', 'polling'],
});

/** =========================
 *   MODELO MULTI-ROOM
 *  =========================
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
const ROOM_IDLE_MS = 60 * 60 * 1000; // 1h sin actividad => limpieza opcional

function now() { return Date.now(); }

function newRoom(roomId) {
  return {
    id: roomId,
    user: (process.env.TIKTOK_USER || 'sticx33').trim(),   // usuario por defecto
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
      // si existe instancia vieja, cerramos listeners
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
      if (data?.giftType === 1 && !data?.repeatEnd) return; // sumar al final de racha

      const user = data?.nickname || data?.uniqueId || 'Anónimo';
      const avatar = data?.profilePictureUrl || '';
      const perGift = data?.diamondCount ?? data?.gift?.diamondCount ?? 0;
      const count   = data?.repeatCount ?? 1;
      const diamonds = perGift * count;

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

// Limpieza simple de rooms inactivos (opcional)
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
}, 10 * 60 * 1000); // cada 10 min

// Watchdog: notifica al terminar el tiempo (no suma más)
setInterval(() => {
  for (const r of rooms.values()) {
    if (!isRunning(r) && r.auction.endsAt !== 0) {
      io.to(r.id).emit('state', r.auction);
    }
  }
}, 1000);

/* ============ ENDPOINTS POR ROOM ============ */

// Cambiar usuario de TikTok para un room
app.post('/:room/user', (req, res) => {
  const roomId = String(req.params.room || '').trim();
  const r = getRoom(roomId);
  const clean = String((req.body?.user || '')).trim().replace(/^@+/, '');
  if (!clean) return res.status(400).json({ ok: false, error: 'user-required' });

  r.user = clean;
  console.log(`[${r.id}] Cambiando usuario a @${clean} y reconectando…`);
  // no tocamos endsAt; solo reiniciamos ranking
  r.donors.clear();
  r.auction.top = [];
  r.auction.donationsTotal = 0;

  scheduleReconnect(r, 1000);
  io.to(r.id).emit('state', r.auction);
  res.json({ ok: true, user: r.user });
});

// Iniciar/reiniciar subasta en un room
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
  res.json({ room: r.id, user: r.user, running: isRunning(r), endsAt: r.auction.endsAt, donors: r.donors.size, topSize: r.auction.top.length });
});

// Simular donación (respeta ventana de tiempo)
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

/* ============ LICENCIAS (JWT) ============ */
// Genera key válida por X meses (≈ 30 días/mes)
function issueKey(months = 1) {
  const nowS = Math.floor(Date.now() / 1000);
  const expS = nowS + Math.floor(30 * 24 * 60 * 60 * months);
  const payload = { k: Math.random().toString(36).slice(2, 10) }; // id aleatoria
  const token = jwt.sign(payload, LICENSE_SECRET, { algorithm: 'HS256', expiresIn: expS - nowS });
  return { key: token, expiresAt: expS * 1000 };
}
function verifyKey(key) {
  try {
    const decoded = jwt.verify(key, LICENSE_SECRET);
    return { ok: true, decoded };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Redirige a tu canal de Telegram (Obtener membresía)
app.get('/license/telegram', (_req, res) => {
  try { res.redirect(TELEGRAM_URL); }
  catch { res.status(302).redirect('https://t.me/+ae-ctGPi8sM1MTYx'); }
});

// Verificar/canjear key (público)
app.post('/license/verify', (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) return res.status(400).json({ ok: false, error: 'key-required' });
  const v = verifyKey(key);
  if (!v.ok) return res.status(401).json({ ok: false, error: 'invalid-or-expired' });
  const dec = jwt.decode(key);
  const exp = dec?.exp ? dec.exp * 1000 : null;
  res.json({ ok: true, expiresAt: exp });
});

// Generar keys (solo admin)
app.post('/admin/license/create', (req, res) => {
  const ak = req.header('x-admin-key');
  if (ak !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });

  const months = Math.max(1, Number(req.body?.months || 1));
  const count  = Math.min(100, Math.max(1, Number(req.body?.count || 1)));
  const keys = [];
  for (let i = 0; i < count; i++) keys.push(issueKey(months));
  res.json({ ok: true, months, count, keys });
});

/* ============ SOCKET.IO (join por room) ============ */
io.on('connection', (socket) => {
  const roomId = String((socket.handshake?.query?.room || '')).trim();
  if (!roomId) { socket.disconnect(true); return; }
  const r = getRoom(roomId);
  socket.join(r.id);
  // enviar estado inicial
  socket.emit('state', r.auction);
});

/* ============ HEALTH ============ */
app.get('/health', (_req, res) => res.send('ok'));

/* ============ START ============ */
server.listen(PORT, () => console.log('Backend on :' + PORT));

/* ============ SOCKET.IO (join por room) ============ */
io.on('connection', (socket) => {
  const roomId = String((socket.handshake?.query?.room || '')).trim();
  if (!roomId) { socket.disconnect(true); return; }
  const r = getRoom(roomId);
  socket.join(r.id);
  // enviar estado inicial
  socket.emit('state', r.auction);
});

/* ============ HEALTH ============ */
app.get('/health', (_req, res) => res.send('ok'));

/* ============ START ============ */
server.listen(PORT, () => console.log('Backend on :' + PORT));
