import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./style.css";

/* =================== Config =================== */
const DEFAULT_WS = (import.meta.env?.VITE_WS_URL || "https://tiklive-production.up.railway.app").replace(/\/+$/,"");

/* =================== Helpers =================== */
function sanitizeBaseUrl(u){ return String(u||'').trim().replace(/\/+$/,''); }
async function postJSON(url, body, headers = {}){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json', ...headers}, body: JSON.stringify(body ?? {}) });
  const text = await r.text(); 
  return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : {} }
}
function randomRoom(){ return "room-" + Math.random().toString(36).slice(2,7); }

/* =========================================================
   ADMIN PANEL (EMBEBIDO)
   Entra con:  /?view=admin&ws=https://tu-back
   ========================================================= */
function AdminPanel() {
  const q = new URLSearchParams(location.search);
  const defaultWS = q.get("ws") || DEFAULT_WS;

  const [baseUrl, setBaseUrl] = useState(localStorage.getItem("ADMIN_WS") || sanitizeBaseUrl(defaultWS));
  const [adminKey, setAdminKey] = useState(localStorage.getItem("ADMIN_KEY") || "");
  const WS = useMemo(() => sanitizeBaseUrl(baseUrl), [baseUrl]);

  const [tab, setTab] = useState("dashboard"); // dashboard | users | detail
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [stats, setStats] = useState({ total: 0, active: 0, expired: 0, disabled: 0 });
  const [users, setUsers] = useState([]);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [detail, setDetail] = useState(null);

  useEffect(() => { localStorage.setItem("ADMIN_WS", WS); }, [WS]);
  useEffect(() => { if (adminKey) localStorage.setItem("ADMIN_KEY", adminKey); }, [adminKey]);

  const getJSON = async (url) => {
    const r = await fetch(url, { headers: adminKey ? { "x-admin-key": adminKey } : {} });
    const txt = await r.text();
    return { ok: r.ok, data: txt ? JSON.parse(txt) : {} };
  };

  const loadStats = async () => {
    setLoading(true); setError("");
    const { ok, data } = await getJSON(`${WS}/admin/stats`);
    if (ok && data?.ok) setStats(data.stats || { total:0, active:0, expired:0, disabled:0 });
    else setError("No se pudieron cargar las estadísticas");
    setLoading(false);
  };
  const loadUsers = async () => {
    setLoading(true); setError("");
    const url = new URL(`${WS}/admin/user/list`);
    if (filter && filter !== "all") url.searchParams.set("status", filter);
    if (search) url.searchParams.set("search", search);
    const { ok, data } = await getJSON(url.toString());
    if (ok && data?.ok) setUsers(data.users || []);
    else setError("No se pudo cargar la lista de usuarios");
    setLoading(false);
  };
  const loadDetail = async (u) => {
    setLoading(true); setError("");
    const { ok, data } = await getJSON(`${WS}/admin/user/${encodeURIComponent(u)}`);
    if (ok && data?.ok) { setDetail(data.user); setTab("detail"); }
    else setError("No se pudo cargar el usuario");
    setLoading(false);
  };

  useEffect(() => { if (tab === "dashboard") loadStats(); }, [tab, WS, adminKey]);
  useEffect(() => { if (tab === "users") loadUsers(); }, [tab, filter, search, WS, adminKey]);

  const actionPost = async (url, body={}) => postJSON(url, body, adminKey?{"x-admin-key": adminKey}:{});

  const activateUser = async (user, days) => {
    setLoading(true); setError("");
    const { ok, data } = await actionPost(`${WS}/admin/user/activate`, { tiktokUser: user, days });
    if (!ok || !data?.ok) setError("No se pudo activar/Extender días");
    await loadDetail(user);
    setLoading(false);
  };
  const disableUser = async (user) => {
    setLoading(true); setError("");
    const { ok } = await actionPost(`${WS}/admin/user/${encodeURIComponent(user)}/disable`);
    if (!ok) setError("No se pudo desactivar");
    await loadDetail(user);
    setLoading(false);
  };
  const enableUser = async (user) => {
    setLoading(true); setError("");
    const { ok, data } = await actionPost(`${WS}/admin/user/${encodeURIComponent(user)}/enable`);
    if (!ok || !data?.ok) setError(data?.message || "No se pudo habilitar (si expiró, usa Activar)");
    await loadDetail(user);
    setLoading(false);
  };
  const deleteUser = async (user) => {
    if (!confirm(`¿Eliminar ${user}?`)) return;
    setLoading(true); setError("");
    const { ok } = await actionPost(`${WS}/admin/user/${encodeURIComponent(user)}/delete`);
    if (!ok) setError("No se pudo eliminar");
    setTab("users");
    await loadUsers();
    setLoading(false);
  };

  const fmt = (ts) => {
    if (!ts) return "—";
    const d = new Date(Number(ts));
    return isNaN(d.getTime()) ? "—" : d.toLocaleString();
    };

  return (
    <div className="manage-panel">
      <div className="manage-header">
        <h1>Panel de Administración</h1>
        <div className="manage-nav">
          <button className={`tab-btn ${tab === "dashboard" ? "active" : ""}`} onClick={() => setTab("dashboard")}>Dashboard</button>
          <button className={`tab-btn ${tab === "users" ? "active" : ""}`} onClick={() => setTab("users")}>Usuarios</button>
        </div>
      </div>

      <div className="manage-content">
        <div className="toolbar">
          <input className="search-input" placeholder="Base URL del backend" value={baseUrl} onChange={(e)=>setBaseUrl(e.target.value)} />
          <input className="search-input" placeholder="Admin Key (x-admin-key)" value={adminKey} onChange={(e)=>setAdminKey(e.target.value)} />
        </div>

        {error && <div className="g-msg" style={{ marginBottom: 15 }}>{error}</div>}

        {tab === "dashboard" && (
          <>
            <div className="stats-grid">
              <div className="stat-card blue"><div className="stat-number">{stats.total}</div><div className="stat-label">Total</div></div>
              <div className="stat-card green"><div className="stat-number">{stats.active}</div><div className="stat-label">Activos</div></div>
              <div className="stat-card orange"><div className="stat-number">{stats.expired}</div><div className="stat-label">Expirados</div></div>
              <div className="stat-card red"><div className="stat-number">{stats.disabled}</div><div className="stat-label">Deshabilitados</div></div>
            </div>
            <button className="btn w-btn" onClick={loadStats} disabled={loading}>{loading ? "Actualizando..." : "Actualizar"}</button>
          </>
        )}

        {tab === "users" && (
          <>
            <div className="toolbar">
              <input className="search-input" placeholder="Buscar usuario…" value={search} onChange={(e)=>setSearch(e.target.value)} />
              <select className="filter-select" value={filter} onChange={(e)=>setFilter(e.target.value)}>
                <option value="all">Todos</option>
                <option value="active">Activos</option>
                <option value="expired">Expirados</option>
                <option value="disabled">Deshabilitados</option>
              </select>
              <button className="btn-export" onClick={loadUsers} disabled={loading}>{loading?"Cargando…":"Buscar"}</button>
            </div>

            <div className="licenses-table">
              <div className="table-header">
                <div>Usuario</div><div>Días activos</div><div>Restantes</div><div>Creado</div><div>Último uso</div><div>Estatus</div><div>Acciones</div>
              </div>
              {users.map(u=>(
                <div className="table-row" key={u.tiktokUser}>
                  <div><b>@{u.tiktokUser}</b></div>
                  <div>{u.daysActive}</div>
                  <div>{u.daysRemaining}</div>
                  <div>{fmt(u.createdAt)}</div>
                  <div>{u.lastUsed?fmt(u.lastUsed):"—"}</div>
                  <div><span className={`badge ${u.status}`}>{u.status}</span></div>
                  <div className="table-actions">
                    <button className="btn-sm view" onClick={()=>loadDetail(u.tiktokUser)}>Ver</button>
                    <button className="btn-sm extend" onClick={()=>{
                      const d = Number(prompt("Días a agregar:", "30"));
                      if (d>0) activateUser(u.tiktokUser, d);
                    }}>Extender</button>
                    {u.status!=='disabled'
                      ? <button className="btn-sm revoke" onClick={()=>disableUser(u.tiktokUser)}>Desactivar</button>
                      : <button className="btn-sm enable" onClick={()=>enableUser(u.tiktokUser)}>Habilitar</button>}
                    <button className="btn-sm revoke" onClick={()=>deleteUser(u.tiktokUser)}>Eliminar</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "detail" && detail && (
          <>
            <button className="btn-back" onClick={()=>setTab("users")}>← Volver</button>
            <div className="detail-card">
              <h3>Usuario: @{detail.tiktokUser}</h3>
              <div className="detail-row"><strong>Días activos</strong><div>{detail.daysActive}</div></div>
              <div className="detail-row"><strong>Vence</strong><div>{fmt(detail.expiresAt)}</div></div>
              <div className="detail-row"><strong>Restantes</strong><div>{detail.daysRemaining}</div></div>
              <div className="detail-row"><strong>Estatus</strong><div><span className={`badge ${detail.status}`}>{detail.status}</span></div></div>
              <div className="detail-row"><strong>Creado</strong><div>{fmt(detail.createdAt)}</div></div>
              <div className="detail-row"><strong>Último uso</strong><div>{detail.lastUsed?fmt(detail.lastUsed):"—"}</div></div>
              <div style={{marginTop:15, display:"flex", gap:8}}>
                <button className="btn-export" onClick={()=>{
                  const d = Number(prompt("Días a agregar:", "30"));
                  if (d>0) activateUser(detail.tiktokUser, d);
                }}>Agregar días</button>
                {detail.status!=='disabled'
                  ? <button className="w-danger" onClick={()=>disableUser(detail.tiktokUser)}>Desactivar</button>
                  : <button className="btn-export" onClick={()=>enableUser(detail.tiktokUser)}>Habilitar</button>}
                <button className="w-danger" onClick={()=>deleteUser(detail.tiktokUser)}>Eliminar</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* =========================================================
   APP
   ========================================================= */
export default function App() {
  const q = new URLSearchParams(location.search);
  const view = (q.get("view") || "").toLowerCase();
  const room = (q.get("room") || "").trim();

  if (view === "admin") return <AdminPanel />;
  if (!room) return <RoomWizard />;
  return (
    <OverlayWithUser>
      <AuctionOverlay />
    </OverlayWithUser>
  );
}

/* ================= Verificación de usuario ================= */
function OverlayWithUser({ children }) {
  const q = new URLSearchParams(location.search);
  const RAW_WS = q.get("ws") || DEFAULT_WS;
  const WS = sanitizeBaseUrl(RAW_WS);

  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(true);
  const [tiktokUser, setTiktokUser] = useState(q.get("user") || localStorage.getItem("TIKTOK_USER") || "");
  const [msg, setMsg] = useState("");
  const [daysRemaining, setDaysRemaining] = useState(0);

  useEffect(() => {
    (async () => {
      const u = (q.get("user") || localStorage.getItem("TIKTOK_USER") || "").trim().replace(/^@+/, "");
      if (!u) { setBusy(false); return; }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/user/verify`, { tiktokUser: u });
        if (httpOK && data?.ok) {
          localStorage.setItem("TIKTOK_USER", u);
          setDaysRemaining(data.daysRemaining || 0);
          setOk(true);
        }
      } catch {}
      setBusy(false);
    })();
  }, [WS]);

  if (busy) return <div className="gate"><div className="g-card"><div className="g-title">Verificando acceso…</div></div></div>;

  if (!ok) {
    const verify = async (e) => {
      e?.preventDefault?.();
      setMsg("");
      const u = (tiktokUser || "").trim().replace(/^@+/, "");
      if (!u) { setMsg("Ingresa tu usuario de TikTok."); return; }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/user/verify`, { tiktokUser: u });
        if (httpOK && data?.ok) {
          localStorage.setItem("TIKTOK_USER", u);
          setDaysRemaining(data.daysRemaining || 0);
          setOk(true);
        } else {
          const error = data?.error || "invalid";
          if (error === "subscription-expired") setMsg("Tu suscripción ha expirado.");
          else if (error === "user-disabled") setMsg("Usuario desactivado.");
          else if (error === "user-not-found") setMsg("Usuario no encontrado. Contacta al administrador.");
          else setMsg("No tienes acceso.");
        }
      } catch {
        setMsg("No se pudo contactar con el servidor.");
      }
    };
    return (
      <div className="gate">
        <form className="g-card" onSubmit={verify}>
          <div className="g-title">Verificar Acceso</div>
          <div className="g-subtitle">Ingresa tu usuario de TikTok (sin @)</div>
          <div className="g-field"><input value={tiktokUser} onChange={e=>setTiktokUser(e.target.value)} placeholder="usuario123" /></div>
          {msg && <div className="g-msg">{msg}</div>}
          <div className="g-actions">
            <button className="g-primary" type="submit">Verificar</button>
            <a className="g-ghost" href="https://t.me/+ae-ctGPi8sM1MTYx" target="_blank" rel="noreferrer">Obtener acceso</a>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div>
      <div className="days-remaining">
        <span>👤 {localStorage.getItem("TIKTOK_USER") || tiktokUser}</span>
        <span>⏱️ {daysRemaining} días restantes</span>
      </div>
      {children}
    </div>
  );
}

/* ======================= OVERLAY ======================= */
/**
 * Un solo cronómetro:
 * - Corre tiempo normal (tInit).
 * - Al llegar a 0, automáticamente muestra "Tiempo de delay" y corre delayS.
 * - Durante normal y delay, las donaciones cuentan y se acumulan.
 * - Al terminar delay, el reloj queda en 00:00 (no reinicia).
 * Controles: Iniciar, Pausar/Reanudar, Restart, Finalizar.
 */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const room = (q.get("room") || "demo").trim();
  const RAW_WS = q.get("ws") || DEFAULT_WS;
  const WS = sanitizeBaseUrl(RAW_WS);

  const initialTitle = q.get("title") || "Subasta";
  const autoUser = (q.get("autouser") || "").replace(/^@+/, "").trim();
  const topN = Number(q.get("top") || 3);

  const [state, setState] = useState({ title: initialTitle, endsAt: 0, top: [], donationsTotal: 0 });
  const [now, setNow] = useState(Date.now());
  const [dashboard, setDashboard] = useState(false);

  // Config de tiempos
  const [tInit, setTInit] = useState(60);
  const [delayS, setDelayS] = useState(10);

  // Fases
  const [phase, setPhase] = useState("normal"); // normal | delay | ended
  const [paused, setPaused] = useState(false);

  // Ganadores / participantes
  const [winners, setWinners] = useState([]);
  const [showWinner, setShowWinner] = useState(false);
  const [currentWinner, setCurrentWinner] = useState(null);
  const [totalParticipants, setTotalParticipants] = useState(0);

  const socketRef = useRef(null);
  const lastEndsAtRef = useRef(0);

  // Persistir ganadores por sala
  const winnersKey = useMemo(() => `Winners:${room}`, [room]);

  useEffect(() => {
    try { const saved = JSON.parse(localStorage.getItem(winnersKey) || "[]"); if (Array.isArray(saved)) setWinners(saved); } catch {}
  }, [winnersKey]);
  useEffect(() => {
    try { localStorage.setItem(winnersKey, JSON.stringify(winners)); } catch {}
  }, [winners, winnersKey]);

  useEffect(() => {
    const socket = io(WS, { transports:["websocket","polling"], query:{ room } });
    socketRef.current = socket;

    socket.on("connect", () => console.log("✅ Socket conectado"));
    socket.on("disconnect", () => console.log("❌ Socket desconectado"));

    socket.on("state", st => {
      setState(prev => ({ ...prev, ...st }));
    });

    socket.on("donation", d => {
      // Donaciones cuentan SIEMPRE (server emite donation cuando endsAt>now; en delay extendemos endsAt)
      setState(prev => ({ ...prev, top: d.top || prev.top, donationsTotal: d.donationsTotal ?? prev.donationsTotal }));
    });

    return () => socket.close();
  }, [WS, room]);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 150);
    const handleVis = () => { if (!document.hidden) setNow(Date.now()); };
    const handleFocus = () => setNow(Date.now());
    document.addEventListener("visibilitychange", handleVis);
    window.addEventListener("focus", handleFocus);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", handleVis); window.removeEventListener("focus", handleFocus); };
  }, []);

  useEffect(() => { (async () => { if (!autoUser) return; try { await postJSON(`${WS}/${room}/user`, { user: autoUser }); } catch {} })(); }, [autoUser, WS, room]);

  // Tiempos restantes
  const remain = Math.max(0, (state.endsAt || 0) - now);

  // Render del tiempo (mm:ss)
  const mm = String(Math.floor((paused ? 0 : remain) / 1000 / 60)).padStart(2, '0');
  const ss = String(Math.floor((paused ? 0 : remain) / 1000) % 60).padStart(2, '0');

  // Faseo (normal -> delay -> ended)
  useEffect(() => {
    // Si se llegó a 0 y hay cambio de endsAt, decidir transición
    if (!paused && remain === 0 && (state.endsAt || 0) > 0 && state.endsAt !== lastEndsAtRef.current) {
      lastEndsAtRef.current = state.endsAt;

      if (phase === "normal") {
        // Ganador provisional
        const win = state.top?.[0];
        if (win) {
          setCurrentWinner(win);
          setWinners(w => [{ name: win.user, total: win.total }, ...w]);
        }

        // Pasar a DELAY: extender en backend para que cuenten donaciones
        setPhase("delay");
        postJSON(`${WS}/${room}/auction/extend`, { durationSec: Math.max(1, Number(delayS)||10), title: state.title })
          .then(()=>console.log("✅ Delay extendido en backend"))
          .catch(e=>console.error("❌ Error extendiendo delay:", e));
      } else if (phase === "delay") {
        // Cierre definitivo (ENDED)
        const finalWinner = state.top?.[0];
        if (finalWinner) {
          setCurrentWinner(finalWinner);
          // Actualizar el primer ganador con total final
          setWinners(w => {
            const copy = [...w];
            if (copy.length > 0) copy[0] = { name: finalWinner.user, total: finalWinner.total };
            return copy;
          });
        }
        setPhase("ended");
        // Mostrar animación breve (más corta)
        setShowWinner(true);
        setTimeout(() => { setShowWinner(false); setCurrentWinner(null); }, 2200); // 2.2s
      }
    }

    setTotalParticipants(state.top?.length || 0);
  }, [paused, remain, state.endsAt, state.top, phase, WS, room, state.title, delayS]);

  // Controles
  const optimisticSetEnds = (sec) => {
    // arranca al primer click sin esperar red
    const localEnds = Date.now() + Math.max(1, Number(sec)||1)*1000;
    setState(prev => ({ ...prev, endsAt: localEnds }));
    lastEndsAtRef.current = 0; // permitir que el watcher detecte fin correcto
  };

  const startAuction = async () => {
    setPhase("normal");
    setShowWinner(false);
    setCurrentWinner(null);
    optimisticSetEnds(tInit);
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: Math.max(1, Number(tInit)||60), title: state.title });
  };

  const togglePause = () => setPaused(p => !p);

  const restartAuction = async () => {
    setPhase("normal");
    setShowWinner(false);
    setCurrentWinner(null);
    optimisticSetEnds(tInit);
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: Math.max(1, Number(tInit)||60), title: state.title });
  };

  const finalizeAuction = async () => {
    // Forzamos cierre rápido: set 1s y dejamos que transición lleve a delay y luego ended
    if (phase === "normal") {
      await postJSON(`${WS}/${room}/auction/extend`, { durationSec: 1, title: state.title });
    } else if (phase === "delay") {
      await postJSON(`${WS}/${room}/auction/extend`, { durationSec: 1, title: state.title });
    }
  };

  const clearParticipantsClient = () => {
    setState(prev => ({ ...prev, top: [], donationsTotal: 0 }));
  };

  return (
    <>
      <button className="gear-floating" onClick={()=>setDashboard(true)}>⚙️</button>

      {/* Ganador */}
      {showWinner && currentWinner && (
        <div className="winner-screen">
          <div className="winner-card">
            <div className="winner-badge">FINALIZADO</div>
            <div className="winner-trophy">🏆</div>
            <div className="winner-title">¡GANADOR!</div>
            <div className="winner-name">{currentWinner.user}</div>
            <div className="winner-amount"><span className="diamond-icon">💎</span>{currentWinner.total} diamantes</div>
            <div className="winner-congrats">🎉 ¡Felicidades! 🎉</div>
          </div>
        </div>
      )}

      {/* Overlay */}
      {!showWinner && (
        <div className="panel">
          <div className="panel-container">
            <div className="timer-box">
              {phase === "delay" && (
                <div className="delay-label">⏳ TIEMPO DE DELAY</div>
              )}
              {phase === "ended" && (
                <div className="delay-label">⛔ FINALIZADO</div>
              )}
              <div className="timer">{paused ? "00:00" : `${mm}:${ss}`}</div>
              {phase === "delay" && currentWinner && (
                <div className="delay-info">
                  Ganador provisional: {currentWinner?.user || "—"} con {currentWinner?.total || 0} 💎
                </div>
              )}
            </div>

            <div className="board">
              {state.top.slice(0, topN).map((d, i) => (
                <div className="row" key={d.user + i} style={{borderColor: ['#FFD700','#C0C0C0','#CD7F32','#0ff'][i] || '#0ff'}}>
                  <div className={`badge ${i===1?'silver':i===2?'bronze':''}`}>{i+1}</div>
                  <img className="avatar" src={d.avatar || ''} alt="" />
                  <div className="name" title={d.user}>{d.user}</div>
                  <div className="coin">💎 {d.total}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Dashboard / Controles */}
      {dashboard && (
        <div className="dash-wrap" onClick={()=>setDashboard(false)}>
          <div className="dash-card" onClick={e=>e.stopPropagation()}>
            <div className="dash-tabs"><div className="tab active">🎮 Control</div></div>
            <div className="dash-grid">
              <div className="dash-col">
                <div className="box box-blue">
                  <div className="box-header">🏆 GANADORES <span className="text-xs opacity-70"> (guardados por sala)</span></div>
                  <div className="box-body list">
                    {winners.length === 0 && <div className="empty">Sin ganadores</div>}
                    {winners.map((w, idx)=>(
                      <div className="winner-row" key={idx}>
                        <div className="w-name">{w.name}</div>
                        <div className="w-total">💰 {w.total}</div>
                      </div>
                    ))}
                  </div>
                  <div className="box-footer">
                    Total: {winners.length}
                    <button className="btn btn-gray" style={{marginLeft:8}}
                      onClick={()=>{ if (confirm('¿Limpiar la lista de ganadores guardados?')) { setWinners([]); try { localStorage.removeItem(winnersKey) } catch {} } }}>
                      🧹 Limpiar
                    </button>
                  </div>
                </div>
              </div>

              <div className="dash-col">
                <div className="box box-green">
                  <div className="box-header">👥 PARTICIPANTES</div>
                  <div className="box-body list">
                    {state.top.length === 0 && <div className="empty">Sin participantes</div>}
                    {state.top.map((d, i)=>(
                      <div className="winner-row" key={d.user+i}>
                        <div className="w-name">{i+1}. {d.user}</div>
                        <div className="w-total">💎 {d.total}</div>
                      </div>
                    ))}
                  </div>
                  <div className="box-footer">Total: {totalParticipants} | Diamantes: {state.donationsTotal || 0}</div>
                </div>
              </div>

              <div className="dash-col">
                <div className="box box-purple">
                  <div className="box-header">🎮 CONTROLES</div>
                  <div className="controls">
                    <div className="fields-3">
                      <div>
                        <label>Tiempo normal (s):</label>
                        <input className="input" type="number" value={tInit} onChange={e=>setTInit(Math.max(1, Number(e.target.value)||1))} />
                      </div>
                      <div>
                        <label>Delay (s):</label>
                        <input className="input" type="number" value={delayS} onChange={e=>setDelayS(Math.max(1, Number(e.target.value)||1))} />
                      </div>
                      <div>
                        <label>Acciones</label>
                        <div className="btn-row">
                          <button className="btn btn-green" onClick={startAuction}>▶️ Iniciar</button>
                          <button className="btn btn-orange" onClick={togglePause}>{paused ? "⏯ Reanudar" : "⏸ Pausar"}</button>
                        </div>
                      </div>
                    </div>

                    <div className="btn-row">
                      <button className="btn btn-gray" onClick={restartAuction}>🔁 Restart</button>
                      <button className="btn btn-red" onClick={finalizeAuction}>🏁 Finalizar</button>
                    </div>

                    <div className="btn-row" style={{marginTop:8}}>
                      <button className="btn btn-gray" onClick={clearParticipantsClient}>🧽 Limpiar participantes (vista)</button>
                    </div>
                  </div>

                  <div className="progress-strip" />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ======================= WIZARD ======================= */
function RoomWizard() {
  const q = new URLSearchParams(location.search);
  const [room, setRoom] = useState(randomRoom());
  const [top, setTop] = useState(3);
  const [user, setUser] = useState("");
  const [ws] = useState(q.get("ws") || DEFAULT_WS);

  const makeUrl = () => {
    const p = new URLSearchParams();
    p.set("ws", sanitizeBaseUrl(ws));
    p.set("room", room.trim());
    p.set("top", String(top));
    if (user.trim()) {
      p.set("autouser", user.replace(/^@+/, "").trim());
      p.set("user", user.replace(/^@+/, "").trim());
    }
    return `${location.origin}/?${p.toString()}`;
  };

  return (
    <div className="wizard">
      <div className="w-card">
        <h2>Crear sala de subasta</h2>
        <div className="w-field">
          <label>Nombre de sala</label>
          <div className="w-row">
            <input value={room} onChange={e=>setRoom(e.target.value)} placeholder="miSala123" />
            <button className="w-btn" onClick={()=>setRoom(randomRoom())}>Aleatorio</button>
          </div>
        </div>
        <div className="w-field">
          <label>Top a mostrar</label>
          <select value={top} onChange={e=>setTop(Number(e.target.value))}>
            <option value={1}>Top 1</option>
            <option value={3}>Top 3</option>
            <option value={5}>Top 5</option>
          </select>
        </div>
        <div className="w-field">
          <label>Usuario de TikTok (sin @)</label>
          <input value={user} onChange={e=>setUser(e.target.value)} placeholder="usuario123" />
        </div>
        <div className="w-actions">
          <button className="w-primary" onClick={()=>{ location.href = makeUrl() }}>Abrir overlay</button>
          <button className="w-success" onClick={async()=>{
            const link = makeUrl();
            try { await navigator.clipboard.writeText(link); alert("Link copiado"); }
            catch { prompt("Copia el link:", link); }
          }}>Copiar link</button>
        </div>
        <div className="w-hint">Pega el link en <b>Browser Source</b> de TikTok LIVE Studio.</div>
        <div className="w-hint" style={{marginTop:8}}>
          Panel Admin: <a href={`/?view=admin&ws=${encodeURIComponent(sanitizeBaseUrl(ws))}`}>abrir aquí</a>
        </div>
      </div>
    </div>
  );
}
