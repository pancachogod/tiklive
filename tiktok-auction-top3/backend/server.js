// backend/server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { WebcastPushConnection } from 'tiktok-live-connector';

// --- Config ---
const TIKTOK_USER = (process.env.TIKTOK_USER || 'sticx33').trim();
const PORT = process.env.PORT || 3000;

// Cambia el primer origin por TU dominio de Vercel:
const ORIGINS = [
  'https://tiklive-m2cpe7yaf-pancachogods-projects.vercel.app', // tu overlay prod
  /\.vercel\.app$/,                                              // previews Vercel
  'http://localhost:5173'                                        // dev local (Vite)
];

// --- App / CORS ---
const app = express();
app.use(cors({
  origin: ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
  optionsSuccessStatus: 204
}));
app.options('*', cors({
  origin: ORIGINS,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// --- HTTP + Socket.IO ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling']
});

// --- Estado de la subasta en memoria ---
let auction = { title: 'Subasta', endsAt: 0, donationsTotal: 0, top: [] };
const donors = new Map(); // user -> { total, avatar }

const isAuctionRunning = () => Number(auction.endsAt) > Date.now();

function recalcTop() {
  auction.top = [...donors.entries()]
    .map(([u, v]) => ({ user: u, total: v.total, avatar: v.avatar }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  io.emit('donation', { donationsTotal: auction.donationsTotal, top: auction.top });
}

// --- Reconexión con cuenta regresiva ---
let reconnectTimer = null;
function scheduleReconnect(ms = 30_000) {
  if (reconnectTimer) return; // evita múltiples contadores

  let left = Math.floor(ms / 1000);
  console.log(`Reintentando conexión a TikTok en ${left}s…`);
  reconnectTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      connectLoop(); // intenta de nuevo
    } else {
      console.log(`Reintentando en ${left}s…`);
    }
  }, 1000);
}

// --- Conexión a TikTok (con reintentos) ---
let tiktok;
async function connectLoop() {
  try {
    tiktok = new WebcastPushConnection(TIKTOK_USER);
    await tiktok.connect();
    console.log('Conectado a TikTok LIVE de', TIKTOK_USER);

    // Limpia cualquier contador si se conectó bien
    if (reconnectTimer) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
    }

    // Regalos (manejo de rachas: sumamos al FINAL de la racha)
    tiktok.on('gift', (data) => {
      // si la subasta no está activa, ignorar
      if (!isAuctionRunning()) return;

      // regalos de racha: esperar a que termine
      if (data?.giftType === 1 && !data?.repeatEnd) return;

      const user = data?.nickname || data?.uniqueId || 'Anónimo';
      const avatar = data?.profilePictureUrl || '';
      const perGift = data?.diamondCount ?? data?.gift?.diamondCount ?? 0;
      const count = data?.repeatCount ?? 1;
      const diamonds = perGift * count;

      if (diamonds > 0) {
        const prev = donors.get(user) || { total: 0, avatar };
        prev.total += diamonds;
        prev.avatar = avatar || prev.avatar;
        donors.set(user, prev);
        auction.donationsTotal += diamonds;
        recalcTop();
      }
    });

    tiktok.on('disconnected', () => {
      console.log('Desconectado de TikTok.');
      scheduleReconnect(30_000);
    });
  } catch (err) {
    console.error('Error conectando a TikTok:', err?.message || err);
    scheduleReconnect(30_000);
  }
}
connectLoop();

// --- Watchdog: cuando acabe el tiempo, emitimos estado (para que el overlay lo note) ---
setInterval(() => {
  if (!isAuctionRunning() && auction.endsAt !== 0) {
    io.emit('state', auction);
  }
}, 1000);

// --- API ---
app.post('/auction/start', (req, res) => {
  const { durationSec = 60, title } = req.body || {};
  const dur = Math.max(1, Number(durationSec) || 60);

  if (title) auction.title = String(title);
  auction.endsAt = Date.now() + dur * 1000;

  // Reset para una nueva subasta
  auction.donationsTotal = 0;
  auction.top = [];
  donors.clear();

  io.emit('state', auction);
  return res.json({ ok: true, auction });
});

app.get('/auction', (_req, res) => res.json(auction));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/status', (_req, res) =>
  res.json({ user: TIKTOK_USER, running: isAuctionRunning(), endsAt: auction.endsAt, donors: donors.size, topSize: auction.top.length })
);

// --- DEBUG: simular donaciones (respeta el tiempo: fuera de ventana, ignora) ---
app.post('/debug/gift', (req, res) => {
  const { user = 'Tester', avatar = '', diamonds = 50 } = req.body || {};
  if (!isAuctionRunning()) return res.json({ ok: true, ignored: true, reason: 'auction-ended' });

  const prev = donors.get(user) || { total: 0, avatar };
  prev.total += Number(diamonds);
  prev.avatar = avatar || prev.avatar;
  donors.set(user, prev);
  auction.donationsTotal += Number(diamonds);
  recalcTop();
  res.json({ ok: true, top: auction.top });
});

// --- Socket.IO: enviar estado al conectar ---
io.on('connection', (socket) => {
  socket.emit('state', auction);
});

server.listen(PORT, () => console.log('Backend on :' + PORT));
