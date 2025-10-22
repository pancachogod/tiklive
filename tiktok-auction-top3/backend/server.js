// server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { WebcastPushConnection } from 'tiktok-live-connector';
import pg from 'pg';

const { Pool } = pg;

/* ================== CONFIG ================== */
const PORT = process.env.PORT || 8080;
const ADMIN_KEY = process.env.ADMIN_KEY || 'pancacho123';

function parseOriginsFromEnv() {
  const raw = process.env.ALLOWED_ORIGINS || '';
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}
const ORIGINS = [
  'https://tiklive-blue.vercel.app',
  'https://tiklive-production.up.railway.app',
  /\.vercel\.app$/i,
  /\.railway\.app$/i,
  ...parseOriginsFromEnv(),
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
  cors: { origin: ORIGINS, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

/* ================== POSTGRES ================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false, require: true },
  connectionTimeoutMillis: 30000,
  idleTimeoutMillis: 30000,
  max: 5,
  allowExitOnIdle: false
});
pool.on('error', (err) => console.error('❌ Pool error:', err.message));

async function initDatabase() {
  const maxRetries = 5;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await pool.query('SELECT NOW()');
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          tiktok_user VARCHAR(255) UNIQUE NOT NULL,
          days_active INTEGER NOT NULL,
          expires_at BIGINT NOT NULL,
          created_at BIGINT NOT NULL,
          last_used BIGINT,
          status VARCHAR(50) DEFAULT 'active',
          notes TEXT,
          usage_count INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_users_tiktok_user ON users(tiktok_user);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
        CREATE INDEX IF NOT EXISTS idx_users_expires_at ON users(expires_at);
      `);
      console.log('✅ DB OK');
      return;
    } catch (e) {
      console.error(`❌ DB intento ${i+1}:`, e.message);
      if (i === maxRetries - 1) { console.log('⚠️ sigo sin DB; el server arranca igual'); return; }
      await new Promise(r => setTimeout(r, Math.min(1000 * 2 ** (i + 1), 10000)));
    }
  }
}
initDatabase();

/* ================== ROOMS / AUCTION ================== */
const rooms = new Map();
const ROOM_IDLE_MS = 60 * 60 * 1000;
const now = () => Date.now();

function newRoom(roomId) {
  return {
    id: roomId,
    user: (process.env.TIKTOK_USER || 'sticx33').trim(),
    auction: {
      title: 'Subasta',
      endsAt: 0,            // timestamp ms; >now => contando
      donationsTotal: 0,
      top: [],
    },
    donors: new Map(),     // user -> { total, avatar }
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
    .slice(0, 50);
  io.to(r.id).emit('donation', {
    donationsTotal: r.auction.donationsTotal,
    top: r.auction.top
  });
}

function scheduleReconnect(r, ms = 30_000) {
  if (r.reconnectTimer) return;
  let left = Math.floor(ms / 1000);
  console.log(`[${r.id}] Reintentando conexión en ${left}s…`);
  r.reconnectTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(r.reconnectTimer);
      r.reconnectTimer = null;
      connectLoop(r);
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
    console.log(`[${r.id}] Conectado a @${r.user}`);

    if (r.reconnectTimer) { clearInterval(r.reconnectTimer); r.reconnectTimer = null; }

    r.tiktok.on('gift', data => {
      // ✅ Cuenta SIEMPRE que endsAt > now() (tanto tiempo normal como delay)
      if (!isRunning(r)) return;

      // gifts tipo 1 sin repeatEnd son el barrido; esperamos cierre
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

/* Limpieza periódica y pulso de estado */
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

setInterval(() => {
  for (const r of rooms.values()) {
    if (!isRunning(r) && r.auction.endsAt !== 0) {
      io.to(r.id).emit('state', r.auction);
    }
  }
}, 1000);

/* ================== HELPERS ================== */
const postJSON = (res, data) => res.json(data);
const normalizeUsername = (u) => String(u || '').trim().toLowerCase().replace(/^@+/, '');

/* ================== ENDPOINTS DE SALA ================== */
// Cambiar usuario de TikTok
app.post('/:room/user', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  const clean = normalizeUsername(req.body?.user);
  if (!clean) return res.status(400).json({ ok: false, error: 'user-required' });

  r.user = clean;
  console.log(`[${r.id}] Usuario cambiado a @${clean} (reconectando)…`);
  // No tocamos donadores aquí.
  scheduleReconnect(r, 1000);
  io.to(r.id).emit('state', r.auction);
  postJSON(res, { ok: true, user: r.user });
});

// Iniciar subasta (limpia ranking)
app.post('/:room/auction/start', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  const { durationSec = 60, title } = req.body || {};
  const dur = Math.max(1, Number(durationSec) || 60);
  if (title) r.auction.title = String(title);

  r.auction.endsAt = now() + dur * 1000;
  r.auction.donationsTotal = 0;
  r.auction.top = [];
  r.donors.clear();

  io.to(r.id).emit('state', r.auction);
  postJSON(res, { ok: true, auction: r.auction });
});

// Extender tiempo (delay) sin limpiar donadores
app.post('/:room/auction/extend', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  const { durationSec = 10, title } = req.body || {};
  const dur = Math.max(1, Number(durationSec) || 10);
  if (title) r.auction.title = String(title);

  r.auction.endsAt = now() + dur * 1000; // sigue contando
  io.to(r.id).emit('state', r.auction);
  postJSON(res, { ok: true, auction: r.auction });
});

// Parar (forzar 0 y limpiar participantes)
app.post('/:room/auction/stop', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  r.auction.endsAt = 0;
  r.auction.donationsTotal = 0;
  r.auction.top = [];
  r.donors.clear();
  io.to(r.id).emit('state', r.auction);
  postJSON(res, { ok: true });
});

// Estado actual
app.get('/:room/auction', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  postJSON(res, r.auction);
});

app.get('/:room/status', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  postJSON(res, {
    room: r.id,
    user: r.user,
    running: isRunning(r),
    endsAt: r.auction.endsAt,
    donors: r.donors.size,
    topSize: r.auction.top.length
  });
});

// Debug regalo
app.post('/:room/debug/gift', (req, res) => {
  const r = getRoom(String(req.params.room || '').trim());
  const { user='Tester', avatar='', diamonds=50 } = req.body || {};
  if (!isRunning(r)) return postJSON(res, { ok: true, ignored: true, reason: 'auction-ended' });
  const prev = r.donors.get(user) || { total: 0, avatar };
  prev.total += Number(diamonds);
  prev.avatar = avatar || prev.avatar;
  r.donors.set(user, prev);
  r.auction.donationsTotal += Number(diamonds);
  emitDonation(r);
  postJSON(res, { ok: true, top: r.auction.top });
});

/* ================== USERS / ADMIN (igual que antes resumido) ================== */
function requireAdmin(req, res, next) {
  const headerKey = String(req.headers['x-admin-key'] || '').trim();
  if (headerKey !== ADMIN_KEY) return res.status(401).json({ ok: false, error: 'unauthorized' });
  next();
}

app.post('/user/verify', async (req, res) => {
  const tiktokUser = normalizeUsername(req.body?.tiktokUser);
  if (!tiktokUser) return res.status(400).json({ ok: false, error: 'user-required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE tiktok_user = $1', [tiktokUser]);
    if (result.rows.length === 0) return res.json({ ok: false, error: 'user-not-found' });
    const user = result.rows[0];
    const t = Date.now();
    if (user.status === 'disabled') return res.json({ ok: false, error: 'user-disabled' });
    if (t > user.expires_at) {
      await pool.query('UPDATE users SET status = $1 WHERE tiktok_user = $2', ['expired', tiktokUser]);
      return res.json({ ok: false, error: 'subscription-expired', daysRemaining: 0 });
    }
    await pool.query('UPDATE users SET last_used = $1, usage_count = usage_count + 1 WHERE tiktok_user = $2', [t, tiktokUser]);
    res.json({ ok: true, tiktokUser: user.tiktok_user, expiresAt: user.expires_at, daysRemaining: Math.ceil((user.expires_at - t) / 86400000) });
  } catch (err) {
    console.error('Error verificando usuario:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

// (Opcional) stats mínimas para panel
app.get('/admin/stats', requireAdmin, async (_req, res) => {
  try {
    const q = `
      SELECT
        COUNT(*)::int AS total,
        SUM((status = 'active')::int)::int   AS active,
        SUM((status = 'expired')::int)::int  AS expired,
        SUM((status = 'disabled')::int)::int AS disabled
      FROM users;
    `;
    const r = await pool.query(q);
    res.json({ ok: true, stats: r.rows[0] || { total:0, active:0, expired:0, disabled:0 } });
  } catch (err) {
    console.error('Error /admin/stats:', err);
    res.status(500).json({ ok:false, error:'database-error' });
  }
});

/* ================== SOCKET & HEALTH ================== */
io.on('connection', (socket) => {
  const roomId = String((socket.handshake?.query?.room || '')).trim();
  if (!roomId) { socket.disconnect(true); return; }
  const r = getRoom(roomId);
  socket.join(r.id);
  socket.emit('state', r.auction);
});

app.get('/health', (_req, res) => res.send('ok'));

server.listen(PORT, () => {
  console.log(`🚀 Backend on :${PORT}`);
  console.log(`🔑 Admin key: ${ADMIN_KEY ? '(set)' : '(not set)'}`);
  console.log(`💾 Database: ${process.env.DATABASE_URL ? 'Configured' : 'Not configured'}`);
});
