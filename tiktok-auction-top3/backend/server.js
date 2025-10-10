import 'dotenv/config';
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import TikTokLiveConnection from 'tiktok-live-connector';

const TIKTOK_USER = process.env.TIKTOK_USER || 'sticx33';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

let auction = {
  id: 'AUC-1',
  title: 'Subasta',
  endsAt: 0,
  donationsTotal: 0,
  top: []
};
const donors = new Map();

const tiktok = new TikTokLiveConnection(TIKTOK_USER);
tiktok.connect()
  .then(() => console.log('Conectado a TikTok LIVE de', TIKTOK_USER))
  .catch(err => console.error('Error conectando a TikTok:', err));

tiktok.on('gift', (data) => {
  const user = data?.nickname || data?.uniqueId || 'Anónimo';
  const avatar = data?.profilePictureUrl || '';
  const diamonds = (data?.gift?.diamondCount || 0) * (data?.repeatCount || 1);
  if (diamonds > 0) {
    const prev = donors.get(user) || { total: 0, avatar };
    prev.total += diamonds;
    prev.avatar = avatar || prev.avatar;
    donors.set(user, prev);

    const top = [...donors.entries()]
      .map(([u, v]) => ({ user: u, total: v.total, avatar: v.avatar }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    auction.donationsTotal += diamonds;
    auction.top = top;

    io.emit('donation', { donationsTotal: auction.donationsTotal, top });
  }
});

io.on('connection', (socket) => {
  socket.emit('state', auction);
});

app.post('/auction/start', (req, res) => {
  const { durationSec = 60, title } = req.body || {};
  if (title) auction.title = String(title);
  auction.endsAt = Date.now() + Number(durationSec) * 1000;
  auction.donationsTotal = 0;
  auction.top = [];
  donors.clear();
  io.emit('state', auction);
  res.json({ ok: true, auction });
});

app.get('/auction', (_req, res) => res.json(auction));
app.get('/health', (_req, res) => res.send('ok'));

server.listen(PORT, () => console.log('Backend on :' + PORT));
