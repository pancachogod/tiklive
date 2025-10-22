import React, { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./style.css";

const DEFAULT_WS = "https://tiklive-production.up.railway.app";

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

/* =================== Gate (verificación) =================== */
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

/* =================== Overlay (1 cronómetro + delay) =================== */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const room = (q.get("room") || "demo").trim();
  const RAW_WS = q.get("ws") || import.meta.env.VITE_WS_URL || DEFAULT_WS;
  const WS = sanitizeBaseUrl(RAW_WS);

  const initialTitle = q.get("title") || "Subasta";
  const autoUser = (q.get("autouser") || "").replace(/^@+/, "").trim();
  const topN = Number(q.get("top") || 3);

  const [state, setState] = useState({
    title: initialTitle,
    endsAt: 0,
    top: [],
    donationsTotal: 0,
  });
  const [now, setNow] = useState(Date.now());

  const [tInit, setTInit] = useState(60);
  const [delayS, setDelayS] = useState(10);
  const [phase, setPhase] = useState("idle"); // idle | main | delay | ended
  const [paused, setPaused] = useState(false);
  const pausedRemainRef = useRef(0);
  const [showWinner, setShowWinner] = useState(false);
  const [currentWinner, setCurrentWinner] = useState(null);

  const [winners, setWinners] = useState([]);
  const [totalParticipants, setTotalParticipants] = useState(0);

  // ⬇️ Nuevo: control de apertura del panel de ajustes
  const [controlsOpen, setControlsOpen] = useState(false);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") setControlsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const socketRef = useRef(null);

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

  useEffect(() => {
    const socket = io(WS, { transports: ["websocket", "polling"], query: { room } });
    socketRef.current = socket;

    socket.on("state", (st) => setState((prev) => ({ ...prev, ...st })));
    socket.on("donation", (d) =>
      setState((prev) => ({
        ...prev,
        top: d.top,
        donationsTotal: d.donationsTotal ?? prev.donationsTotal,
      }))
    );
    return () => socket.close();
  }, [WS, room]);

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

  useEffect(() => {
    (async () => {
      if (!autoUser) return;
      try {
        await postJSON(`${WS}/${room}/user`, { user: autoUser });
      } catch {}
    })();
  }, [autoUser, WS, room]);

  const remainMs = Math.max(0, (state.endsAt || 0) - now);
  const mm = String(Math.floor((paused ? pausedRemainRef.current : remainMs) / 1000 / 60)).padStart(2, "0");
  const ss = String(Math.floor((paused ? pausedRemainRef.current : remainMs) / 1000) % 60).padStart(2, "0");

  const delayStartedRef = useRef(false);
  useEffect(() => {
    setTotalParticipants(state.top?.length || 0);
    if (paused) return;

    if (phase === "main" && remainMs === 0 && !delayStartedRef.current) {
      delayStartedRef.current = true;
      postJSON(`${WS}/${room}/auction/extend`, {
        durationSec: Math.max(1, Number(delayS) || 1),
        title: state.title,
      }).finally(() => setPhase("delay"));
      return;
    }

    if (phase === "delay" && remainMs === 0) {
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
      }, 2200);
    }
  }, [phase, remainMs, delayS, WS, room, state.title, state.top, paused]);

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

  const togglePause = async () => {
    if (!paused) {
      pausedRemainRef.current = Math.ceil(remainMs / 1000) * 1000;
      setPaused(true);
      await postJSON(`${WS}/${room}/auction/extend`, {
        durationSec: 24 * 3600,
        title: state.title,
      });
    } else {
      setPaused(false);
      await postJSON(`${WS}/${room}/auction/extend`, {
        durationSec: Math.max(1, Math.ceil(pausedRemainRef.current / 1000)),
        title: state.title,
      });
      pausedRemainRef.current = 0;
    }
  };

  const finalizeAuction = async () => {
    setPaused(false);
    pausedRemainRef.current = 0;
    setPhase("delay");
    delayStartedRef.current = true;
    await postJSON(`${WS}/${room}/auction/extend`, { durationSec: 1, title: state.title });
  };

  const restartAuction = async () => {
    await startAuction();
  };

  const getBorderColor = (i) =>
    ["#FFD700", "#C0C0C0", "#CD7F32", "#0ff"][i] || "#0ff";

  return (
    <>
      {/* ⚙️ Ahora abre/cierra el panel de controles */}
      <button
        className="gear-floating"
        onClick={() => setControlsOpen((v) => !v)}
        title="Abrir/Cerrar controles"
      >
        ⚙️
      </button>

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

      <div className="panel">
        <div className="panel-container">
          <div className="timer-box">
            {phase === "delay" && (
              <div className="delay-label">⏳ TIEMPO DE DELAY</div>
            )}
            <div className="timer">
              {mm}:{ss}
            </div>
          </div>

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

      {/* Panel de controles: ahora visible/invisible con controlsOpen */}
      <div className="dash-wrap" style={{ display: controlsOpen ? "flex" : "none" }}>
        <div className="dash-card">
          <div className="dash-tabs">
            <div className="tab active">🎮 Control</div>
            <button
              className="tab muted"
              style={{ marginLeft: "auto" }}
              onClick={() => setControlsOpen(false)}
              title="Cerrar (Esc)"
            >
              ✖ Cerrar
            </button>
          </div>
          <div className="dash-grid">
            <div className="dash-col">
              <div className="box box-blue">
                <div className="box-header">
                  🏆 GANADORES <span className="text-xs opacity-70">(guardados por sala)</span>
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
                        onChange={(e) => setDelayS(Math.max(1, Number(e.target.value) || 1))}
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

/* =================== Wizard =================== */
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

/* =================== Admin (igual que antes) =================== */
function AdminPanel() {
  // … (SIN CAMBIOS respecto a tu última versión que ya tienes funcionando)
  // Para mantener el foco en el cambio solicitado (abrir ajustes desde el engranaje),
  // deja tu misma implementación del Admin que pegaste antes.
  return (
    <div className="wizard">
      <div className="w-card">
        <h2>Panel Admin</h2>
        <div className="w-hint">Usa la versión completa del Admin que ya incluimos anteriormente.</div>
        <a className="w-btn" href="/?ws=https://tiklive-production.up.railway.app">Volver</a>
      </div>
    </div>
  );
}

/* =================== Helpers =================== */
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
