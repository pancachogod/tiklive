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

// Orígenes permitidos (tu overlay + previews de Vercel + dev local)
const ORIGINS = [
  'https://tiklive-blue.vercel.app',  // <--- cambia si tu overlay tiene otro dominio
  /\.vercel\.app$/,                   // previews en Vercel (regex)
  'http://localhost:5173'             // desarrollo local (Vite)
];

// --- App / CORS ---
const app = express();
app.use(cors({
  origin: ORIGINS,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
  optionsSuccessStatus: 204
}));
app.options('*', cors({
  origin: ORIGINS,
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json());

// --- HTTP + Socket.IO ---
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS, methods: ['GET','POST'] },
  transports: ['websocket', 'polling']
});

// --- Estado de la subasta en memoria ---
let auction = { title: 'Subasta', endsAt: 0, donationsTotal: 0, top: [] };
const donors = new Map(); // user -> { total, avatar }

function recalcTop() {
  auction.top = [...donors.entries()]
    .map(([u, v]) => ({ user: u, total: v.total, avatar: v.avatar }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  io.emit('donation', { donationsTotal: auction.donationsTotal, top: auction.top });
}

// --- Conexión a TikTok con reintentos ---
let tiktok;
async function connectLoop() {
  try {
    tiktok = new WebcastPushConnection(TIKTOK_USER);
    await tiktok.connect();
    console.log('Conectado a TikTok LIVE de', TIKTOK_USER);

    // Regalos (manejo de rachas: giftType===1 -> sumamos al FINAL de la racha)
    tiktok.on('gift', (data) => {
      if (data?.giftType === 1 && !data?.repeatEnd) return; // ignorar mitad de racha

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

    // Reintenta si se cae
    tiktok.on('disconnected', () => {
      console.log('Desconectado. Reintentando en 30s…');
      setTimeout(connectLoop, 30_000);
    });
  } catch (err) {
    console.error('Error conectando a TikTok:', err?.message || err);
    setTimeout(connectLoop, 30_000);
  }
}
connectLoop();

// --- API ---
app.post('/auction/start', (req, res) => {
  const { durationSec = 60, title } = req.body || {};
  if (title) auction.title = String(title);
  auction.endsAt = Date.now() + Number(durationSec) * 1000;
  auction.donationsTotal = 0;
  auction.top = [];
  donors.clear();
  io.emit('state', auction);
  return res.json({ ok: true, auction });
});

app.get('/auction', (_req, res) => res.json(auction));
app.get('/health', (_req, res) => res.send('ok'));
app.get('/status', (_req, res) =>
  res.json({ user: TIKTOK_USER, endsAt: auction.endsAt, donors: donors.size, topSize: auction.top.length })
);

// --- DEBUG: simular donaciones sin estar en vivo ---
app.post('/debug/gift', (req, res) => {
  const { user = 'Tester', avatar = '', diamonds = 50 } = req.body || {};
  const prev = donors.get(user) || { total: 0, avatar };
  prev.total += Number(diamonds);
  prev.avatar = avatar || prev.avatar;
  donors.set(user, prev);
  recalcTop();
  res.json({ ok: true, top: auction.top });
});

// --- Socket.IO: enviar estado al conectar ---
io.on('connection', (socket) => {
  socket.emit('state', auction);
});

server.listen(PORT, () => console.log('Backend on :' + PORT));
