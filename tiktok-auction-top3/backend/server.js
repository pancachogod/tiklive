// backend/server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { WebcastPushConnection } from 'tiktok-live-connector';
import pg from 'pg';

const { Pool } = pg;

/* ================== CONFIG BÁSICA ================== */
const PORT = process.env.PORT || 3000;

const ORIGINS = [
  'https://tiklive-6ywqave4w-pancachogods-projects.vercel.app',
  /\.vercel\.app$/,
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

/* ================== POSTGRESQL DATABASE (SUPABASE) ================== */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  },
  connectionTimeoutMillis: 20000, // 20 segundos para Supabase
  idleTimeoutMillis: 30000,
  max: 10 // Supabase free tier tiene límite de conexiones
});

// Manejador de errores del pool
pool.on('error', (err) => {
  console.error('❌ Error inesperado en el pool de PostgreSQL:', err.message);
});

// Test y creación de tablas con reintentos
async function initDatabase() {
  const maxRetries = 5;
  let currentRetry = 0;

  while (currentRetry < maxRetries) {
    try {
      console.log(`🔄 Intentando conectar a Supabase (intento ${currentRetry + 1}/${maxRetries})...`);
      
      // Test de conexión
      const testResult = await pool.query('SELECT NOW()');
      console.log('✅ Conexión a Supabase establecida:', testResult.rows[0].now);

      // Crear tabla si no existe
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
        )
      `);

      // Crear índices para mejorar el rendimiento
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_users_tiktok_user ON users(tiktok_user);
        CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
        CREATE INDEX IF NOT EXISTS idx_users_expires_at ON users(expires_at);
      `);

      console.log('✅ Base de datos inicializada correctamente con índices');
      
      // Mostrar estadísticas
      const countResult = await pool.query('SELECT COUNT(*) FROM users');
      console.log(`📊 Total de usuarios en la base de datos: ${countResult.rows[0].count}`);
      
      return; // Salir si todo fue exitoso
      
    } catch (err) {
      currentRetry++;
      console.error(`❌ Error en intento ${currentRetry}:`, err.message);
      console.error('Código de error:', err.code);
      
      if (currentRetry >= maxRetries) {
        console.error('❌ No se pudo conectar a Supabase después de varios intentos');
        console.error('📋 Verifica lo siguiente:');
        console.error('   1. Tu DATABASE_URL está configurada en Render');
        console.error('   2. La URL es correcta (postgres://... de Supabase)');
        console.error('   3. Tu base de datos en Supabase está activa');
        console.error('   4. No has excedido el límite de conexiones');
        
        // No lanzar error para que el servidor inicie de todos modos
        console.log('⚠️ Servidor iniciará sin conexión a la base de datos');
        return;
      }
      
      // Esperar antes del siguiente intento (backoff exponencial)
      const waitTime = Math.min(1000 * Math.pow(2, currentRetry), 10000);
      console.log(`⏳ Esperando ${waitTime}ms antes del siguiente intento...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

initDatabase();

// Función helper para verificar la conexión antes de queries importantes
async function ensureConnection() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch (err) {
    console.error('❌ Conexión perdida, reintentando...', err.message);
    return false;
  }
}
/* =====================================================
   MODELO MULTI-ROOM (subasta por sala)
   ⚠️ NO MODIFICADO - TODO IGUAL
===================================================== */
const rooms = new Map();
const ROOM_IDLE_MS = 60 * 60 * 1000;
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

/* ================== ENDPOINTS DE SALA (SIN CAMBIOS) ================== */

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
   SISTEMA DE USUARIOS CON POSTGRESQL
===================================================== */

const ADMIN_KEY = 'pancacho123';

function normalizeUsername(u) {
  return String(u || '').trim().toLowerCase().replace(/^@+/, '');
}

/* ============ USER ENDPOINTS ============ */

app.post('/user/verify', async (req, res) => {
  const tiktokUser = normalizeUsername(req.body?.tiktokUser);
  if (!tiktokUser) return res.status(400).json({ ok: false, error: 'user-required' });

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE tiktok_user = $1',
      [tiktokUser]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: false, error: 'user-not-found' });
    }

    const user = result.rows[0];
    const t = Date.now();

    if (user.status === 'disabled') {
      return res.json({ ok: false, error: 'user-disabled' });
    }

    if (t > user.expires_at) {
      await pool.query(
        'UPDATE users SET status = $1 WHERE tiktok_user = $2',
        ['expired', tiktokUser]
      );
      return res.json({ ok: false, error: 'subscription-expired', daysRemaining: 0 });
    }

    await pool.query(
      'UPDATE users SET last_used = $1, usage_count = usage_count + 1 WHERE tiktok_user = $2',
      [t, tiktokUser]
    );

    res.json({
      ok: true,
      tiktokUser: user.tiktok_user,
      expiresAt: user.expires_at,
      daysRemaining: Math.ceil((user.expires_at - t) / (24 * 60 * 60 * 1000))
    });
  } catch (err) {
    console.error('Error verificando usuario:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

/* ============ ADMIN ENDPOINTS ============ */

function requireAdmin(req, res, next) {
  const headerKey = String(req.headers['x-admin-key'] || '').trim();
  if (headerKey !== ADMIN_KEY) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

app.post('/admin/user/activate', requireAdmin, async (req, res) => {
  const tiktokUser = normalizeUsername(req.body?.tiktokUser);
  const days = Math.max(1, Number(req.body?.days) || 30);

  if (!tiktokUser) {
    return res.status(400).json({ ok: false, error: 'user-required' });
  }

  const t = Date.now();

  try {
    const result = await pool.query(
      'SELECT * FROM users WHERE tiktok_user = $1',
      [tiktokUser]
    );

    if (result.rows.length > 0) {
      const user = result.rows[0];
      const baseTime = user.status === 'expired' ? t : Math.max(user.expires_at, t);
      const newExpiresAt = baseTime + (days * 24 * 60 * 60 * 1000);
      const newDaysActive = Math.ceil((newExpiresAt - t) / (24 * 60 * 60 * 1000));

      await pool.query(
        'UPDATE users SET expires_at = $1, days_active = $2, status = $3 WHERE tiktok_user = $4',
        [newExpiresAt, newDaysActive, 'active', tiktokUser]
      );

      console.log(`✅ Usuario ${tiktokUser} extendido por ${days} días`);
    } else {
      const expiresAt = t + (days * 24 * 60 * 60 * 1000);
      await pool.query(
        'INSERT INTO users (tiktok_user, days_active, expires_at, created_at, status, notes, usage_count) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [tiktokUser, days, expiresAt, t, 'active', '', 0]
      );

      console.log(`✅ Usuario ${tiktokUser} activado por ${days} días`);
    }

    const updated = await pool.query('SELECT * FROM users WHERE tiktok_user = $1', [tiktokUser]);
    const user = updated.rows[0];

    res.json({
      ok: true,
      user: {
        tiktokUser: user.tiktok_user,
        daysActive: user.days_active,
        expiresAt: user.expires_at,
        status: user.status
      }
    });
  } catch (err) {
    console.error('Error activando usuario:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

app.get('/admin/user/list', requireAdmin, async (req, res) => {
  const { status, search } = req.query;
  const t = Date.now();

  try {
    let query = 'SELECT * FROM users WHERE 1=1';
    const params = [];

    if (status && status !== 'all') {
      query += ` AND status = $${params.length + 1}`;
      params.push(status);
    }

    if (search) {
      query += ` AND tiktok_user ILIKE $${params.length + 1}`;
      params.push(`%${search}%`);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);

    const users = result.rows.map(u => ({
      tiktokUser: u.tiktok_user,
      daysActive: u.days_active,
      expiresAt: u.expires_at,
      createdAt: u.created_at,
      lastUsed: u.last_used,
      status: u.status,
      notes: u.notes,
      usageCount: u.usage_count,
      daysRemaining: Math.max(0, Math.ceil((u.expires_at - t) / (24 * 60 * 60 * 1000))),
      isExpired: t > u.expires_at
    }));

    res.json({ ok: true, users, total: users.length });
  } catch (err) {
    console.error('Error listando usuarios:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

app.get('/admin/user/:tiktokUser', requireAdmin, async (req, res) => {
  const tiktokUser = normalizeUsername(req.params.tiktokUser);
  const t = Date.now();

  try {
    const result = await pool.query('SELECT * FROM users WHERE tiktok_user = $1', [tiktokUser]);

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'not-found' });
    }

    const u = result.rows[0];

    res.json({
      ok: true,
      user: {
        tiktokUser: u.tiktok_user,
        daysActive: u.days_active,
        expiresAt: u.expires_at,
        createdAt: u.created_at,
        lastUsed: u.last_used,
        status: u.status,
        notes: u.notes,
        usageCount: u.usage_count,
        daysRemaining: Math.max(0, Math.ceil((u.expires_at - t) / (24 * 60 * 60 * 1000))),
        isExpired: t > u.expires_at
      }
    });
  } catch (err) {
    console.error('Error obteniendo usuario:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

app.post('/admin/user/:tiktokUser/disable', requireAdmin, async (req, res) => {
  const tiktokUser = normalizeUsername(req.params.tiktokUser);

  try {
    const result = await pool.query(
      'UPDATE users SET status = $1 WHERE tiktok_user = $2 RETURNING *',
      ['disabled', tiktokUser]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'not-found' });
    }

    console.log(`🚫 Usuario ${tiktokUser} desactivado`);
    res.json({ ok: true, message: 'User disabled' });
  } catch (err) {
    console.error('Error desactivando usuario:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

app.post('/admin/user/:tiktokUser/enable', requireAdmin, async (req, res) => {
  const tiktokUser = normalizeUsername(req.params.tiktokUser);
  const t = Date.now();

  try {
    const result = await pool.query('SELECT * FROM users WHERE tiktok_user = $1', [tiktokUser]);

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'not-found' });
    }

    const user = result.rows[0];

    if (t > user.expires_at) {
      return res.json({ ok: false, error: 'expired', message: 'Use /activate to add days' });
    }

    await pool.query('UPDATE users SET status = $1 WHERE tiktok_user = $2', ['active', tiktokUser]);

    console.log(`✅ Usuario ${tiktokUser} reactivado`);
    res.json({ ok: true, message: 'User enabled' });
  } catch (err) {
    console.error('Error reactivando usuario:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

app.post('/admin/user/:tiktokUser/delete', requireAdmin, async (req, res) => {
  const tiktokUser = normalizeUsername(req.params.tiktokUser);

  try {
    const result = await pool.query('DELETE FROM users WHERE tiktok_user = $1 RETURNING *', [tiktokUser]);

    if (result.rows.length > 0) {
      console.log(`🗑️ Usuario ${tiktokUser} eliminado`);
    }

    res.json({ ok: true, deleted: result.rows.length > 0 });
  } catch (err) {
    console.error('Error eliminando usuario:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

app.get('/admin/stats', requireAdmin, async (req, res) => {
  const t = Date.now();

  try {
    const result = await pool.query('SELECT * FROM users');
    const all = result.rows;

    const stats = {
      total: all.length,
      active: all.filter(u => u.status === 'active' && u.expires_at > t).length,
      expired: all.filter(u => u.status === 'expired' || (u.status === 'active' && u.expires_at <= t)).length,
      disabled: all.filter(u => u.status === 'disabled').length,
      neverUsed: all.filter(u => !u.last_used).length
    };

    res.json({ ok: true, stats });
  } catch (err) {
    console.error('Error obteniendo stats:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
});

app.post('/admin/user/:tiktokUser/notes', requireAdmin, async (req, res) => {
  const tiktokUser = normalizeUsername(req.params.tiktokUser);
  const notes = String(req.body?.notes || '');

  try {
    const result = await pool.query(
      'UPDATE users SET notes = $1 WHERE tiktok_user = $2 RETURNING *',
      [notes, tiktokUser]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'not-found' });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Error actualizando notas:', err);
    res.status(500).json({ ok: false, error: 'database-error' });
  }
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
server.listen(PORT, () => {
  console.log(`🚀 Backend on :${PORT}`);
  console.log(`🔑 Admin key: ${ADMIN_KEY}`);
  console.log(`💾 Database: ${process.env.DATABASE_URL ? 'Connected' : 'Not configured'}`);
});
