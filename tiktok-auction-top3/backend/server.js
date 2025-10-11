// backend/server.js
import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { WebcastPushConnection } from 'tiktok-live-connector';

// ---------- Config ----------
const DEFAULT_USER = (process.env.TIKTOK_USER || 'sticx33').trim();
const PORT = process.env.PORT || 3000;

// Cambia el primer origin por TU dominio de Vercel (prod):
const ORIGINS = [
  'https://tiklive-m2cpe7yaf-pancachogods-projects.vercel.app',
  /\.vercel\.app$/,      // previews Vercel
  'http://localhost:5173'
];

// ---------- App / CORS ----------
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

// ---------- HTTP + Socket.IO ----------
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: ORIGINS, methods: ['GET','POST'] },
  transports: ['websocket','polling']
});

// ---------- Estado de subasta ----------
let auction = { title: 'Subasta', endsAt: 0, donationsTotal: 0, top: [] };
const donors = new Map(); // user -> { total, avatar }
const isAuctionRunning = () => Number(auction.endsAt) > Date.now();

function recalcTop(){
  auction.top = [...donors.entries()]
    .map(([u,v]) => ({ user: u, total: v.total, avatar: v.avatar }))
    .sort((a,b)=> b.total - a.total)
    .slice(0,10);
  io.emit('donation', { donationsTotal: auction.donationsTotal, top: auction.top });
}

// ---------- Reconexión con cuenta regresiva ----------
let reconnectTimer = null;
function scheduleReconnect(ms = 30_000){
  if (reconnectTimer) return;
  let left = Math.floor(ms/1000);
  console.log(`Reintentando conexión a TikTok en ${left}s…`);
  reconnectTimer = setInterval(()=>{
    left -= 1;
    if (left <= 0){
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      connectLoop();
    } else {
      console.log(`Reintentando en ${left}s…`);
    }
  }, 1000);
}

// ---------- Conexión a TikTok (usuario dinámico) ----------
let currentUser = DEFAULT_USER;
let tiktok;

async function connectLoop(){
  try {
    tiktok = new WebcastPushConnection(currentUser);
    await tiktok.connect();
    console.log('Conectado a TikTok LIVE de', currentUser);

    if (reconnectTimer){ clearInterval(reconnectTimer); reconnectTimer = null; }

    // Limpia listeners por si reconectamos
    tiktok.removeAllListeners('gift');
    tiktok.removeAllListeners('disconnected');

    // Regalos (maneja rachas: solo suma al final)
    tiktok.on('gift', (data)=>{
      if (!isAuctionRunning()) return;
      if (data?.giftType === 1 && !data?.repeatEnd) return;

      const user = data?.nickname || data?.uniqueId || 'Anónimo';
      const avatar = data?.profilePictureUrl || '';
      const perGift = data?.diamondCount ?? data?.gift?.diamondCount ?? 0;
      const count   = data?.repeatCount ?? 1;
      const diamonds = perGift * count;

      if (diamonds > 0){
        const prev = donors.get(user) || { total: 0, avatar };
        prev.total += diamonds;
        prev.avatar = avatar || prev.avatar;
        donors.set(user, prev);
        auction.donationsTotal += diamonds;
        recalcTop();
      }
    });

    tiktok.on('disconnected', ()=>{
      console.log('Desconectado de TikTok.');
      scheduleReconnect(30_000);
    });

  } catch (err){
    console.error('Error conectando a TikTok:', err?.message || err);
    scheduleReconnect(30_000);
  }
}
connectLoop();

// Watchdog: notifica estado cuando termina el tiempo (no suma más)
setInterval(()=>{
  if (!isAuctionRunning() && auction.endsAt !== 0){
    io.emit('state', auction);
  }
}, 1000);

// ---------- ENDPOINTS (¡YA con app definido!) ----------

// Cambiar usuario y reconectar (para multi-usuario)
app.post('/user', (req, res)=>{
  const { user } = req.body || {};
  const clean = String(user || '').trim().replace(/^@+/, '');
  if (!clean) return res.status(400).json({ ok:false, error:'user-required' });

  currentUser = clean;
  console.log('🟡 Cambiando usuario a', currentUser, 'y reconectando…');

  // Reset ranking (no tocamos endsAt para no romper el timer del front)
  donors.clear();
  auction.top = [];
  auction.donationsTotal = 0;

  scheduleReconnect(1000);
  io.emit('state', auction);
  return res.json({ ok:true, user: currentUser });
});

// Iniciar/reiniciar subasta
app.post('/auction/start', (req,res)=>{
  const { durationSec = 60, title } = req.body || {};
  const dur = Math.max(1, Number(durationSec) || 60);
  if (title) auction.title = String(title);
  auction.endsAt = Date.now() + dur*1000;
  auction.donationsTotal = 0;
  auction.top = [];
  donors.clear();
  io.emit('state', auction);
  res.json({ ok:true, auction });
});

// Estado/Salud
app.get('/auction', (_req,res)=> res.json(auction));
app.get('/health',  (_req,res)=> res.send('ok'));
app.get('/status',  (_req,res)=> res.json({
  user: currentUser,
  running: isAuctionRunning(),
  endsAt: auction.endsAt,
  donors: donors.size,
  topSize: auction.top.length
}));

// Simulador de donaciones (respeta la ventana de tiempo)
app.post('/debug/gift', (req,res)=>{
  const { user='Tester', avatar='', diamonds=50 } = req.body || {};
  if (!isAuctionRunning()) return res.json({ ok:true, ignored:true, reason:'auction-ended' });
  const prev = donors.get(user) || { total: 0, avatar };
  prev.total += Number(diamonds);
  prev.avatar = avatar || prev.avatar;
  donors.set(user, prev);
  auction.donationsTotal += Number(diamonds);
  recalcTop();
  res.json({ ok:true, top: auction.top });
});

// Socket.IO: enviar estado al conectar
io.on('connection', (socket)=> socket.emit('state', auction));

server.listen(PORT, ()=> console.log('Backend on :' + PORT));
