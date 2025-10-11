import { WebcastPushConnection } from 'tiktok-live-connector';
// --- Config ---
const DEFAULT_USER = (process.env.TIKTOK_USER || 'sticx33').trim();
const PORT = process.env.PORT || 3000;

// ...
let currentUser = DEFAULT_USER;       // <— usuario actual (dinámico)
let tiktok;

// --- Reconexión con cuenta regresiva ---
let reconnectTimer = null;
function scheduleReconnect(ms = 30_000) {
  if (reconnectTimer) return;
  let left = Math.floor(ms / 1000);
  console.log(`Reintentando conexión a TikTok en ${left}s…`);
  reconnectTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      clearInterval(reconnectTimer);
      reconnectTimer = null;
      connectLoop(); // intenta de nuevo con currentUser
    } else {
      console.log(`Reintentando en ${left}s…`);
    }
  }, 1000);
}

// --- Conexión a TikTok (usa currentUser dinámico) ---
async function connectLoop() {
  try {
    tiktok = new WebcastPushConnection(currentUser);
    await tiktok.connect();
    console.log('Conectado a TikTok LIVE de', currentUser);
    if (reconnectTimer) { clearInterval(reconnectTimer); reconnectTimer = null; }

    tiktok.removeAllListeners('gift');
    tiktok.removeAllListeners('disconnected');

    tiktok.on('gift', (data) => {
      if (!isAuctionRunning()) return;
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

// --- NUEVO: endpoint para cambiar el usuario y reconectar ---
app.post('/user', (req, res) => {
  const { user } = req.body || {};
  const clean = String(user || '').trim().replace(/^@+/, '');
  if (!clean) return res.status(400).json({ ok: false, error: 'user-required' });

  currentUser = clean;  // cambia el usuario actual
  console.log('🟡 Cambiando usuario a', currentUser, 'y reconectando…');

  try {
    // reinicio “suave”: limpiamos ranking y estado de subasta, y reconectamos
    donors.clear();
    auction.top = [];
    auction.donationsTotal = 0;
    // No tocamos auction.endsAt (para no romper el timer del front)

    scheduleReconnect(1000); // reintenta en 1s
    io.emit('state', auction);
    return res.json({ ok: true, user: currentUser });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || 'reconnect-failed' });
  }
});

// Ajusta también /status para mostrar el usuario actual:
app.get('/status', (_req, res) =>
  res.json({ user: currentUser, running: isAuctionRunning(), endsAt: auction.endsAt, donors: donors.size, topSize: auction.top.length })
);
