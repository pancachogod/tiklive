import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./style.css";

/* =================== CONFIG =================== */
const DEFAULT_WS = "https://tiklive-production.up.railway.app";

/* =================== Router mínimo =================== */
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

/* ============== Verificación por Usuario TikTok ============== */
function OverlayWithUser({ children }) {
  const q = new URLSearchParams(location.search);
  const RAW_WS = q.get("ws") || import.meta.env.VITE_WS_URL || DEFAULT_WS;
  const WS = sanitizeBaseUrl(RAW_WS);

  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(true);
  const [tiktokUser, setTiktokUser] = useState(
    q.get("user") || localStorage.getItem("TIKTOK_USER") || ""
  );
  const [msg, setMsg] = useState("");
  const [daysRemaining, setDaysRemaining] = useState(0);

  useEffect(() => {
    (async () => {
      const u = (q.get("user") || localStorage.getItem("TIKTOK_USER") || "")
        .trim()
        .replace(/^@+/, "");
      if (!u) {
        setBusy(false);
        return;
      }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/user/verify`, {
          tiktokUser: u,
        });
        if (httpOK && data?.ok) {
          localStorage.setItem("TIKTOK_USER", u);
          setDaysRemaining(data.daysRemaining || 0);
          setOk(true);
        }
      } catch {}
      setBusy(false);
    })();
  }, [WS]);

  if (busy)
    return (
      <div className="gate">
        <div className="g-card">
          <div className="g-title">Verificando acceso…</div>
        </div>
      </div>
    );

  if (!ok) {
    const verify = async (e) => {
      e?.preventDefault?.();
      setMsg("");
      const u = (tiktokUser || "").trim().replace(/^@+/, "");
      if (!u) {
        setMsg("Ingresa tu usuario de TikTok.");
        return;
      }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/user/verify`, {
          tiktokUser: u,
        });
        if (httpOK && data?.ok) {
          localStorage.setItem("TIKTOK_USER", u);
          setDaysRemaining(data.daysRemaining || 0);
          setOk(true);
        } else {
          const error = data?.error || "invalid";
          if (error === "subscription-expired")
            setMsg("Tu suscripción ha expirado.");
          else if (error === "user-disabled") setMsg("Usuario desactivado.");
          else if (error === "user-not-found")
            setMsg("Usuario no encontrado. Contacta al administrador.");
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
          <div className="g-field">
            <input
              value={tiktokUser}
              onChange={(e) => setTiktokUser(e.target.value)}
              placeholder="usuario123"
            />
          </div>
          {msg && <div className="g-msg">{msg}</div>}
          <div className="g-actions">
            <button className="g-primary" type="submit">
              Verificar
            </button>
            <a
              className="g-ghost"
              href="https://t.me/+ae-ctGPi8sM1MTYx"
              target="_blank"
              rel="noreferrer"
            >
              Obtener acceso
            </a>
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

/* ======================= OVERLAY (1 cronómetro + Delay) ======================= */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const room = (q.get("room") || "demo").trim();
  const RAW_WS = q.get("ws") || import.meta.env.VITE_WS_URL || DEFAULT_WS;
  const WS = sanitizeBaseUrl(RAW_WS);

  // Ajustes
  const initialTitle = q.get("title") || "Subasta";
  const autoUser = (q.get("autouser") || "").replace(/^@+/, "").trim();
  const topN = Number(q.get("top") || 3);

  // Estado de subasta
  const [state, setState] = useState({
    title: initialTitle,
    endsAt: 0,
    top: [],
    donationsTotal: 0,
  });
  const [now, setNow] = useState(Date.now());

  // Fases / control
  const [tInit, setTInit] = useState(60); // tiempo principal
  const [delayS, setDelayS] = useState(10); // tiempo de delay
  const [phase, setPhase] = useState("idle"); // idle | main | delay | ended
  const [paused, setPaused] = useState(false);
  const pausedRemainRef = useRef(0);
  const [showWinner, setShowWinner] = useState(false);
  const [currentWinner, setCurrentWinner] = useState(null);

  const [winners, setWinners] = useState([]);
  const [totalParticipants, setTotalParticipants] = useState(0);

  // socket
  const socketRef = useRef(null);

  // Persistencia de ganadores por sala
  const winnersKey = useMemo(() => `Winners:${room}`, [room]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(winnersKey) || "[]");
      if (Array.isArray(saved)) setWinners(saved);
    } catch {}
  }, [winnersKey]);
  useEffect(() => {
    try {
      localStorage.setItem(winnersKey, JSON.stringify(winners));
    } catch {}
  }, [winners, winnersKey]);

  // Conectar socket
  useEffect(() => {
    const socket = io(WS, { transports: ["websocket", "polling"], query: { room } });
    socketRef.current = socket;

    socket.on("state", (st) => {
      setState((prev) => ({ ...prev, ...st }));
    });
    socket.on("donation", (d) => {
      setState((prev) => ({
        ...prev,
        top: d.top,
        donationsTotal: d.donationsTotal ?? prev.donationsTotal,
      }));
    });
    return () => socket.close();
  }, [WS, room]);

  // Reloj estable
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    const onFocus = () => setNow(Date.now());
    document.addEventListener("visibilitychange", onFocus);
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onFocus);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Autoregistro de usuario (opcional)
  useEffect(() => {
    (async () => {
      if (!autoUser) return;
      try {
        await postJSON(`${WS}/${room}/user`, { user: autoUser });
      } catch {}
    })();
  }, [autoUser, WS, room]);

  // Cálculos de tiempo
  const remainMs = Math.max(0, (state.endsAt || 0) - now);
  const mm = String(Math.floor((paused ? pausedRemainRef.current : remainMs) / 1000 / 60)).padStart(2, "0");
  const ss = String(Math.floor((paused ? pausedRemainRef.current : remainMs) / 1000) % 60).padStart(2, "0");

  // Fase automática: al terminar main, ir a delay; al terminar delay, finalizar
  const delayStartedRef = useRef(false);
  useEffect(() => {
    setTotalParticipants(state.top?.length || 0);

    if (paused) return;

    // MAIN -> DELAY
    if (phase === "main" && remainMs === 0 && !delayStartedRef.current) {
      delayStartedRef.current = true;
      // no limpiamos donadores: extendemos el tiempo, así el backend sigue contando regalos
      postJSON(`${WS}/${room}/auction/extend`, {
        durationSec: Math.max(1, Number(delayS) || 1),
        title: state.title,
      }).finally(() => {
        setPhase("delay");
      });
      return;
    }

    // DELAY -> ENDED
    if (phase === "delay" && remainMs === 0) {
      // ganador final
      const finalWinner = state.top?.[0];
      if (finalWinner) {
        setCurrentWinner(finalWinner);
        setWinners((w) => [{ name: finalWinner.user, total: finalWinner.total }, ...w]);
      }
      setPhase("ended");
      setShowWinner(true);
      setTimeout(() => {
        setShowWinner(false);
        setCurrentWinner(null);
      }, 2200); // animación corta
    }
  }, [phase, remainMs, delayS, WS, room, state.title, state.top]);

  /* ====== Controles ====== */

  // Iniciar (limpia ranking en backend)
  const startAuction = async () => {
    delayStartedRef.current = false;
    setShowWinner(false);
    setCurrentWinner(null);
    setPhase("main");
    setPaused(false);
    pausedRemainRef.current = 0;
    await postJSON(`${WS}/${room}/auction/start`, {
      durationSec: Math.max(1, Number(tInit) || 1),
      title: state.title,
    });
  };

  // Pausar/Reanudar: mantenemos el backend “vivo” para que siga contando regalos
  const togglePause = async () => {
    if (!paused) {
      // Pausar: guardamos lo que queda y ponemos 24h de margen en el backend
      pausedRemainRef.current = Math.ceil(remainMs / 1000) * 1000;
      setPaused(true);
      await postJSON(`${WS}/${room}/auction/extend`, {
        durationSec: 24 * 3600, // evita que se termine en backend
        title: state.title,
      });
    } else {
      // Reanudar: devolvemos el tiempo que quedaba
      setPaused(false);
      await postJSON(`${WS}/${room}/auction/extend`, {
        durationSec: Math.max(1, Math.ceil(pausedRemainRef.current / 1000)),
        title: state.title,
      });
      pausedRemainRef.current = 0;
    }
  };

  // Finalizar rápido: 1s y mostrar ganador (no reinicia)
  const finalizeAuction = async () => {
    setPaused(false);
    pausedRemainRef.current = 0;
    setPhase("delay"); // para que NO vuelva a crear delay extra
    delayStartedRef.current = true;
    await postJSON(`${WS}/${room}/auction/extend`, { durationSec: 1, title: state.title });
  };

  // Restart: vuelve a iniciar limpio con tInit
  const restartAuction = async () => {
    await startAuction();
  };

  const getBorderColor = (i) =>
    ["#FFD700", "#C0C0C0", "#CD7F32", "#0ff"][i] || "#0ff";

  return (
    <>
      {/* Botón engranaje para abrir controles */}
      <button
        className="gear-floating"
        onClick={() => alert("Abre el panel admin en ?view=admin o usa el Dashboard de la izquierda 🛠️")}
        title="Panel/Controles"
      >
        ⚙️
      </button>

      {/* Winner overlay */}
      {showWinner && currentWinner && (
        <div className="winner-screen">
          <div className="winner-card">
            <div className="winner-badge">FINALIZADO</div>
            <div className="winner-trophy">🏆</div>
            <div className="winner-title">¡GANADOR!</div>
            <div className="winner-name">{currentWinner.user}</div>
            <div className="winner-amount">
              <span className="diamond-icon">💎</span>
              {currentWinner.total} diamantes
            </div>
            <div className="winner-congrats">🎉 ¡Felicidades! 🎉</div>
          </div>
        </div>
      )}

      {/* UI compacta */}
      <div className="panel">
        <div className="panel-container">
          {/* Cronómetro + etiqueta de fase */}
          <div className="timer-box">
            {phase === "delay" && (
              <div className="delay-label">⏳ TIEMPO DE DELAY</div>
            )}
            <div className="timer">
              {mm}:{ss}
            </div>
            {phase === "delay" && currentWinner && (
              <div className="delay-info">
                Ganador provisional: {currentWinner?.user || "—"} con{" "}
                {currentWinner?.total || 0} 💎
              </div>
            )}
          </div>

          {/* TABLERO principal */}
          <div className="board">
            {state.top.slice(0, topN).map((d, i) => (
              <div
                className="row"
                key={d.user + i}
                style={{ borderColor: getBorderColor(i) }}
              >
                <div className={`badge ${i === 1 ? "silver" : i === 2 ? "bronze" : ""}`}>
                  {i + 1}
                </div>
                <img className="avatar" src={d.avatar || ""} alt="" />
                <div className="name" title={d.user}>
                  {d.user}
                </div>
                <div className="coin">💎 {d.total}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Dashboard lateral “virtual” (se usa con CSS existente). Mantiene scroll en ganadores/participantes */}
      <div className="dash-wrap" style={{ display: "none" }}>
        <div className="dash-card">
          <div className="dash-tabs">
            <div className="tab active">🎮 Control</div>
          </div>
          <div className="dash-grid">
            <div className="dash-col">
              <div className="box box-blue">
                <div className="box-header">
                  🏆 GANADORES <span className="text-xs opacity-70"> (guardados por sala)</span>
                </div>
                <div className="box-body list">
                  {winners.length === 0 && <div className="empty">Sin ganadores</div>}
                  {winners.map((w, idx) => (
                    <div className="winner-row" key={idx}>
                      <div className="w-name">{w.name}</div>
                      <div className="w-total">💰 {w.total}</div>
                    </div>
                  ))}
                </div>
                <div className="box-footer">
                  Total: {winners.length}
                  <button
                    className="btn btn-gray"
                    style={{ marginLeft: 8 }}
                    onClick={() => {
                      if (confirm("¿Limpiar la lista de ganadores guardados?")) {
                        setWinners([]);
                        try {
                          localStorage.removeItem(winnersKey);
                        } catch {}
                      }
                    }}
                  >
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
                  {state.top.map((d, i) => (
                    <div className="winner-row" key={d.user + i}>
                      <div className="w-name">
                        {i + 1}. {d.user}
                      </div>
                      <div className="w-total">💎 {d.total}</div>
                    </div>
                  ))}
                </div>
                <div className="box-footer">
                  Total: {totalParticipants} | Diamantes: {state.donationsTotal || 0}
                </div>
              </div>
            </div>

            <div className="dash-col">
              <div className="box box-purple">
                <div className="box-header">🎮 CONTROLES</div>
                <div className="controls">
                  <div className="fields-3">
                    <div>
                      <label>Tiempo (s):</label>
                      <input
                        className="input"
                        type="number"
                        value={tInit}
                        min={1}
                        onChange={(e) => setTInit(Math.max(1, Number(e.target.value) || 1))}
                      />
                    </div>
                    <div>
                      <label>Delay (s):</label>
                      <input
                        className="input"
                        type="number"
                        value={delayS}
                        min={1}
                        onChange={(e) =>
                          setDelayS(Math.max(1, Number(e.target.value) || 1))
                        }
                      />
                    </div>
                    <div />
                  </div>

                  <div className="btn-row">
                    <button className="btn btn-green" onClick={startAuction}>
                      ▶️ Iniciar
                    </button>
                    <button className="btn btn-orange" onClick={togglePause}>
                      {paused ? "⏯ Reanudar" : "⏸ Pausar"}
                    </button>
                  </div>
                  <div className="btn-row">
                    <button className="btn btn-red" onClick={finalizeAuction}>
                      🏁 Finalizar
                    </button>
                    <button className="btn btn-gray" onClick={restartAuction}>
                      🔁 Restart
                    </button>
                  </div>

                  <div className="btn-row" style={{ marginTop: 8 }}>
                    <button
                      className="btn btn-gray"
                      onClick={() => {
                        // Limpia sólo la vista local
                        setState((prev) => ({ ...prev, top: [], donationsTotal: 0 }));
                        setTotalParticipants(0);
                      }}
                    >
                      🧽 Limpiar participantes (vista)
                    </button>
                  </div>

                  <div className="progress-strip" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>      
    </>
  );
}

/* ======================= WIZARD ======================= */
function RoomWizard() {
  const q = new URLSearchParams(location.search);
  const [room, setRoom] = useState(randomRoom());
  const [top, setTop] = useState(3);
  const [user, setUser] = useState("");
  const [ws] = useState(q.get("ws") || import.meta.env.VITE_WS_URL || DEFAULT_WS);

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
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="miSala123"
            />
            <button className="w-btn" onClick={() => setRoom(randomRoom())}>
              Aleatorio
            </button>
          </div>
        </div>
        <div className="w-field">
          <label>Top a mostrar</label>
          <select value={top} onChange={(e) => setTop(Number(e.target.value))}>
            <option value={1}>Top 1</option>
            <option value={3}>Top 3</option>
            <option value={5}>Top 5</option>
          </select>
        </div>
        <div className="w-field">
          <label>Usuario de TikTok (sin @)</label>
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="usuario123"
          />
        </div>
        <div className="w-actions">
          <button
            className="w-primary"
            onClick={() => {
              location.href = makeUrl();
            }}
          >
            Abrir overlay
          </button>
          <button
            className="w-success"
            onClick={async () => {
              const link = makeUrl();
              try {
                await navigator.clipboard.writeText(link);
                alert("Link copiado");
              } catch {
                prompt("Copia el link:", link);
              }
            }}
          >
            Copiar link
          </button>
        </div>
        <div className="w-hint">
          Pega el link en <b>Browser Source</b> de TikTok LIVE Studio.
        </div>
        <div className="w-hint" style={{ marginTop: 8 }}>
          Panel Admin:{" "}
          <a href={`/?view=admin&ws=${encodeURIComponent(sanitizeBaseUrl(ws))}`}>
            abrir aquí
          </a>
        </div>
      </div>
    </div>
  );
}

/* ======================= ADMIN PANEL ======================= */
function AdminPanel() {
  const q = new URLSearchParams(location.search);
  const RAW_WS = q.get("ws") || import.meta.env.VITE_WS_URL || DEFAULT_WS;
  const WS = sanitizeBaseUrl(RAW_WS);

  const [adminKey, setAdminKey] = useState("");
  const [authenticated, setAuthenticated] = useState(false);
  const [msg, setMsg] = useState("");

  const [view, setView] = useState("dashboard");
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState(null);

  const [newUser, setNewUser] = useState("");
  const [days, setDays] = useState(30);

  async function checkAuth(e) {
    e?.preventDefault?.();
    setMsg("");
    try {
      const r = await fetch(`${WS}/admin/stats`, {
        headers: { "x-admin-key": adminKey },
      });
      if (r.ok) {
        setAuthenticated(true);
        await loadStats();
      } else {
        setMsg("Admin Key incorrecta");
      }
    } catch {
      setMsg("Error de conexión");
    }
  }

  async function loadStats() {
    try {
      const r = await fetch(`${WS}/admin/stats`, {
        headers: { "x-admin-key": adminKey },
      });
      const data = await r.json().catch(() => ({}));
      if (data?.ok) setStats(data.stats);
    } catch {}
  }

  async function loadUsers() {
    try {
      const p = new URLSearchParams();
      if (filter !== "all") p.set("status", filter);
      if (search) p.set("search", search);
      const r = await fetch(`${WS}/admin/user/list?${p.toString()}`, {
        headers: { "x-admin-key": adminKey },
      });
      const data = await r.json().catch(() => ({}));
      if (data?.ok) setUsers(data.users || []);
    } catch {}
  }

  async function activateUser() {
    setMsg("");
    const u = (newUser || "").trim().replace(/^@+/, "");
    if (!u) {
      setMsg("Ingresa un usuario");
      return;
    }
    if (days < 1) {
      setMsg("Los días deben ser mayor a 0");
      return;
    }
    try {
      const r = await fetch(`${WS}/admin/user/activate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": adminKey,
        },
        body: JSON.stringify({ tiktokUser: u, days }),
      });
      const data = await r.json().catch(() => ({}));
      if (data?.ok) {
        alert(`✅ Usuario @${u} activado por ${days} días`);
        setNewUser("");
        setDays(30);
        loadStats();
        if (view === "list") loadUsers();
      } else {
        setMsg(data?.error || "Error");
      }
    } catch {
      setMsg("Error de red");
    }
  }

  async function viewDetails(tiktokUser) {
    try {
      const r = await fetch(`${WS}/admin/user/${tiktokUser}`, {
        headers: { "x-admin-key": adminKey },
      });
      const data = await r.json().catch(() => ({}));
      if (data?.ok) {
        setSelected(data.user);
        setView("details");
      }
    } catch {}
  }
  async function disableUser(tiktokUser) {
    if (!confirm(`¿Desactivar a @${tiktokUser}?`)) return;
    try {
      const r = await fetch(`${WS}/admin/user/${tiktokUser}/disable`, {
        method: "POST",
        headers: { "x-admin-key": adminKey },
      });
      if (r.ok) {
        alert("Usuario desactivado");
        if (view === "details") viewDetails(tiktokUser);
        if (view === "list") loadUsers();
        loadStats();
      }
    } catch {}
  }
  async function enableUser(tiktokUser) {
    try {
      const r = await fetch(`${WS}/admin/user/${tiktokUser}/enable`, {
        method: "POST",
        headers: { "x-admin-key": adminKey },
      });
      if (r.ok) {
        alert("Usuario reactivado");
        if (view === "details") viewDetails(tiktokUser);
        if (view === "list") loadUsers();
        loadStats();
      }
    } catch {}
  }
  async function deleteUser(tiktokUser) {
    if (!confirm(`¿Eliminar a @${tiktokUser}? Esta acción no se puede deshacer.`)) return;
    try {
      const r = await fetch(`${WS}/admin/user/${tiktokUser}/delete`, {
        method: "POST",
        headers: { "x-admin-key": adminKey },
      });
      if (r.ok) {
        alert("Usuario eliminado");
        if (view === "details") {
          setView("list");
          setSelected(null);
        }
        loadUsers();
        loadStats();
      }
    } catch {}
  }

  if (!authenticated) {
    return (
      <div className="gate">
        <form className="g-card" onSubmit={checkAuth}>
          <div className="g-title">🔒 Panel Admin</div>
          <div className="g-subtitle">Backend: {WS}</div>
          <div className="g-field">
            <input
              type="password"
              value={adminKey}
              onChange={(e) => setAdminKey(e.target.value)}
              placeholder="ADMIN_KEY"
            />
          </div>
          {msg && <div className="g-msg">{msg}</div>}
          <div className="g-actions">
            <button className="g-primary" type="submit">
              Acceder
            </button>
            <a className="g-ghost" href={`/?ws=${encodeURIComponent(WS)}`}>
              Volver
            </a>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="wizard">
      <div className="w-card" style={{ maxWidth: 980 }}>
        <h2>Panel Admin</h2>

        <div className="tabs">
          <button
            className={`tab-btn ${view === "dashboard" ? "active" : ""}`}
            onClick={() => {
              setView("dashboard");
              loadStats();
            }}
          >
            Dashboard
          </button>
          <button
            className={`tab-btn ${view === "list" ? "active" : ""}`}
            onClick={() => {
              setView("list");
              loadUsers();
            }}
          >
            Usuarios
          </button>
          <button
            className={`tab-btn ${view === "activate" ? "active" : ""}`}
            onClick={() => setView("activate")}
          >
            Agregar / Activar
          </button>
        </div>

        {view === "dashboard" && (
          <div className="grid-3">
            <div className="stat">
              <div className="stat-title">Activos</div>
              <div className="stat-value">{stats?.active ?? "-"}</div>
            </div>
            <div className="stat">
              <div className="stat-title">Expirados</div>
              <div className="stat-value">{stats?.expired ?? "-"}</div>
            </div>
            <div className="stat">
              <div className="stat-title">Deshabilitados</div>
              <div className="stat-value">{stats?.disabled ?? "-"}</div>
            </div>
            <div className="w-actions" style={{ gridColumn: "1 / -1" }}>
              <button className="w-primary" onClick={loadStats}>
                Refrescar
              </button>
              <a className="w-success" href={`/?ws=${encodeURIComponent(WS)}`}>
                Ir al Wizard
              </a>
            </div>
          </div>
        )}

        {view === "list" && (
          <>
            <div className="w-row" style={{ gap: 8 }}>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar…"
              />
              <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                <option value="all">Todos</option>
                <option value="active">Activos</option>
                <option value="expired">Expirados</option>
                <option value="disabled">Deshabilitados</option>
              </select>
              <button className="w-btn" onClick={loadUsers}>
                Buscar
              </button>
            </div>

            <div className="list-table" style={{ marginTop: 12, maxHeight: 420, overflow: "auto" }}>
              {users.length === 0 && <div className="w-hint">Sin resultados</div>}
              {users.map((u) => (
                <div key={u.tiktokUser} className="row-lite">
                  <div className="cell">@{u.tiktokUser}</div>
                  <div className="cell">Estado: {u.status}</div>
                  <div className="cell">Días: {u.daysRemaining ?? "-"}</div>
                  <div className="cell actions">
                    <button className="w-btn" onClick={() => viewDetails(u.tiktokUser)}>
                      Detalles
                    </button>
                    {u.status === "disabled" ? (
                      <button className="w-success" onClick={() => enableUser(u.tiktokUser)}>
                        Habilitar
                      </button>
                    ) : (
                      <button className="w-btn" onClick={() => disableUser(u.tiktokUser)}>
                        Deshabilitar
                      </button>
                    )}
                    <button className="w-danger" onClick={() => deleteUser(u.tiktokUser)}>
                      Eliminar
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {view === "activate" && (
          <>
            <div className="w-field">
              <label>Usuario TikTok (sin @)</label>
              <input
                value={newUser}
                onChange={(e) => setNewUser(e.target.value)}
                placeholder="usuario123"
              />
            </div>
            <div className="w-field">
              <label>Días de acceso</label>
              <input
                type="number"
                min="1"
                value={days}
                onChange={(e) => setDays(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            {msg && <div className="w-hint" style={{ color: "#ff6" }}>{msg}</div>}
            <div className="w-actions">
              <button className="w-primary" onClick={activateUser}>
                Guardar
              </button>
              <button
                className="w-btn"
                onClick={() => {
                  setNewUser("");
                  setDays(30);
                  setMsg("");
                }}
              >
                Limpiar
              </button>
            </div>
          </>
        )}

        {view === "details" && selected && (
          <div className="detail-card">
            <h3>@{selected.tiktokUser}</h3>
            <div className="w-hint">Estado: {selected.status}</div>
            <div className="w-hint">
              Días restantes: {selected.daysRemaining ?? "-"}
            </div>
            <div className="w-hint">
              Expira: {selected.expiresAt ? new Date(selected.expiresAt).toLocaleString() : "-"}
            </div>
            <div className="w-row" style={{ gap: 8, marginTop: 12 }}>
              {selected.status === "disabled" ? (
                <button className="w-success" onClick={() => enableUser(selected.tiktokUser)}>
                  Habilitar
                </button>
              ) : (
                <button className="w-btn" onClick={() => disableUser(selected.tiktokUser)}>
                  Deshabilitar
                </button>
              )}
              <button className="w-danger" onClick={() => deleteUser(selected.tiktokUser)}>
                Eliminar
              </button>
              <button className="w-btn" onClick={() => setView("list")}>
                Volver
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ======================= Helpers ======================= */
function sanitizeBaseUrl(u) {
  return String(u || "").trim().replace(/\/+$/, "");
}
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : {} };
}
function randomRoom() {
  return "room-" + Math.random().toString(36).slice(2, 7);
}
