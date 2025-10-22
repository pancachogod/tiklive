import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css'

const DEFAULT_WS = 'https://tiklive-production.up.railway.app'

export default function App() {
  const q = new URLSearchParams(location.search)
  const view = (q.get('view') || '').toLowerCase()
  const room = (q.get('room') || '').trim()

  if (view === 'admin') {
    return (
      <div className="wizard">
        <div className="w-card">
          <h2>Admin mínimo</h2>
          <div className="w-hint">Usa tu panel existente.</div>
        </div>
      </div>
    )
  }
  if (!room) return <RoomWizard />
  return <OverlayWithUser><AuctionOverlay /></OverlayWithUser>
}

/* ============== Gate por usuario TikTok (mínimo) ============== */
function OverlayWithUser({ children }) {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env?.VITE_WS_URL || DEFAULT_WS
  const WS = sanitizeBaseUrl(RAW_WS)
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(true)
  const [tiktokUser, setTiktokUser] = useState(q.get('user') || localStorage.getItem('TIKTOK_USER') || '')
  const [msg, setMsg] = useState('')
  const [daysRemaining, setDaysRemaining] = useState(0)

  useEffect(() => {
    (async () => {
      const u = (q.get('user') || localStorage.getItem('TIKTOK_USER') || '').trim().replace(/^@+/, '')
      if (!u) { setBusy(false); return }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/user/verify`, { tiktokUser: u })
        if (httpOK && data?.ok) {
          localStorage.setItem('TIKTOK_USER', u)
          setDaysRemaining(data.daysRemaining || 0)
          setOk(true)
        }
      } catch {}
      setBusy(false)
    })()
  }, [WS])

  if (busy) return <div className="gate"><div className="g-card"><div className="g-title">Verificando acceso…</div></div></div>

  if (!ok) {
    const verify = async (e) => {
      e?.preventDefault?.()
      setMsg('')
      const u = (tiktokUser || '').trim().replace(/^@+/, '')
      if (!u) { setMsg('Ingresa tu usuario de TikTok.'); return }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/user/verify`, { tiktokUser: u })
        if (httpOK && data?.ok) {
          localStorage.setItem('TIKTOK_USER', u)
          setDaysRemaining(data.daysRemaining || 0)
          setOk(true)
        } else {
          const error = data?.error || 'invalid'
          if (error === 'subscription-expired') setMsg('Tu suscripción ha expirado.')
          else if (error === 'user-disabled') setMsg('Usuario desactivado.')
          else if (error === 'user-not-found') setMsg('Usuario no encontrado.')
          else setMsg('No tienes acceso.')
        }
      } catch { setMsg('No se pudo contactar con el servidor.') }
    }
    return (
      <div className="gate">
        <form className="g-card" onSubmit={verify}>
          <div className="g-title">Verificar Acceso</div>
          <div className="g-subtitle">Ingresa tu usuario de TikTok (sin @)</div>
          <div className="g-field">
            <input value={tiktokUser} onChange={e=>setTiktokUser(e.target.value)} placeholder="usuario123" />
          </div>
          {msg && <div className="g-msg">{msg}</div>}
          <div className="g-actions">
            <button className="g-primary" type="submit">Verificar</button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div>
      <div className="days-remaining">
        <span>👤 {localStorage.getItem('TIKTOK_USER') || tiktokUser}</span>
        <span>⏱️ {daysRemaining} días restantes</span>
      </div>
      {children}
    </div>
  )
}

/* ======================= OVERLAY ======================= */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const room = (q.get('room') || 'demo').trim()
  const RAW_WS = q.get('ws') || import.meta.env?.VITE_WS_URL || DEFAULT_WS
  const WS = sanitizeBaseUrl(RAW_WS)
  const initialTitle = q.get('title') || 'Subasta'
  const autoUser = (q.get('autouser') || '').replace(/^@+/, '').trim()
  const topN = Number(q.get('top') || 3)

  const [state, setState] = useState({ title: initialTitle, endsAt: 0, top: [], donationsTotal: 0 })
  const [now, setNow] = useState(Date.now())

  // controles
  const [tInit, setTInit] = useState(60)   // tiempo principal
  const [delayS, setDelayS] = useState(10) // delay
  const [paused, setPaused] = useState(false)
  const [inDelay, setInDelay] = useState(false)
  const [showWinner, setShowWinner] = useState(false)
  const [currentWinner, setCurrentWinner] = useState(null)

  const socketRef = useRef(null)
  const alreadyExtendedRef = useRef(false)
  const startedRef = useRef(false)

  // socket
  useEffect(() => {
    const socket = io(WS, { transports:['websocket','polling'], query:{ room } })
    socketRef.current = socket

    socket.on('state', st => { setState(prev => ({ ...prev, ...st })) })
    socket.on('donation', d => {
      setState(prev => ({ ...prev, top: d.top, donationsTotal: d.donationsTotal ?? prev.donationsTotal }))
    })
    return () => socket.close()
  }, [WS, room])

  // reloj
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(id)
  }, [])

  // autouser opcional
  useEffect(() => {
    (async () => {
      if (!autoUser) return
      try { await postJSON(`${WS}/${room}/user`, { user: autoUser }) } catch {}
    })()
  }, [autoUser, WS, room])

  const remain = Math.max(0, (state.endsAt || 0) - now)
  const mm = String(Math.floor((paused ? 0 : remain) / 1000 / 60)).padStart(2, '0')
  const ss = String(Math.floor((paused ? 0 : remain) / 1000) % 60).padStart(2, '0')

  // lógica: pasar a delay automáticamente y finalizar al terminar delay
  useEffect(() => {
    if (paused) return
    if (!startedRef.current) return
    if (remain === 0 && state.endsAt > 0) {
      if (!inDelay && !alreadyExtendedRef.current) {
        // Entrar al delay (una sola vez)
        alreadyExtendedRef.current = true
        setInDelay(true)
        postJSON(`${WS}/${room}/auction/extend`, { durationSec: Math.max(1, Number(delayS)||0), title: state.title })
          .catch(()=>{})
      } else if (inDelay) {
        // Delay terminado -> parar y limpiar
        finishClean()
      }
    }
  }, [remain, paused, inDelay, delayS, WS, room, state.endsAt, state.title])

  async function finishClean() {
    setInDelay(false)
    setShowWinner(false)
    setCurrentWinner(null)
    startedRef.current = false
    alreadyExtendedRef.current = false
    await postJSON(`${WS}/${room}/auction/stop`, {})
  }

  // helpers UI
  const startAuction = async () => {
    const dur = Math.max(1, Number(tInit)||0)
    startedRef.current = true
    alreadyExtendedRef.current = false
    setInDelay(false)
    setShowWinner(false)
    setCurrentWinner(null)
    setPaused(false)
    // optimista: avanzar reloj de inmediato
    setState(prev => ({ ...prev, endsAt: Date.now() + dur * 1000, title: prev.title, top: [], donationsTotal: 0 }))
    try { await postJSON(`${WS}/${room}/auction/start`, { durationSec: dur, title: state.title }) } catch {}
  }

  const pauseToggle = () => setPaused(p => !p)

  const finalizeAuction = async () => { await finishClean() }

  const restartAuction = async () => { await startAuction() }

  const getBorderColor = (i) => ['#FFD700','#C0C0C0','#CD7F32','#0ff'][i] || '#0ff'

  return (
    <>
      <button
        className="gear-floating"
        onClick={()=>document.querySelector('.dash-wrap')?.classList?.toggle('hidden')}
        title="Abrir controles"
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
            <div className="winner-amount"><span className="diamond-icon">💎</span>{currentWinner.total} diamantes</div>
            <div className="winner-congrats">🎉 ¡Felicidades! 🎉</div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-container">
          <div className="timer-box">
            {inDelay && <div className="delay-label">Tiempo de delay</div>}
            <div className="timer">{mm}:{ss}</div>
          </div>

          <div className="board">
            {state.top.slice(0, topN).map((d, i) => (
              <div className="row" key={d.user + i} style={{borderColor: getBorderColor(i)}}>
                <div className={`badge ${i===1?'silver':i===2?'bronze':''}`}>{i+1}</div>
                <img className="avatar" src={d.avatar || ''} alt="" />
                <div className="name" title={d.user}>{d.user}</div>
                <div className="coin">💎 {d.total}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Dashboard de controles */}
      <div className="dash-wrap hidden" onClick={e=>e.currentTarget.classList.add('hidden')}>
        <div className="dash-card" onClick={e=>e.stopPropagation()}>
          <div className="box box-purple" style={{minHeight: 'auto'}}>
            <div className="box-header">🎮 CONTROLES</div>
            <div className="controls">
              <div className="fields-2">
                <div>
                  <label>Tiempo (s)</label>
                  <input className="input" type="number" min="1" value={tInit} onChange={e=>setTInit(+e.target.value||1)} />
                </div>
                <div>
                  <label>Delay (s)</label>
                  <input className="input" type="number" min="1" value={delayS} onChange={e=>setDelayS(+e.target.value||1)} />
                </div>
              </div>
              <div className="btn-row">
                <button className="btn btn-green" onClick={startAuction}>▶️ Iniciar</button>
                <button className="btn btn-orange" onClick={pauseToggle}>{paused ? '⏯ Reanudar' : '⏸ Pausar'}</button>
              </div>
              <div className="btn-row">
                <button className="btn btn-red" onClick={finalizeAuction}>🏁 Finalizar</button>
                <button className="btn btn-gray" onClick={restartAuction}>🔁 Restart</button>
              </div>
              <div className="box-footer">Diamantes: {state.donationsTotal || 0}</div>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}

/* ======================= WIZARD ======================= */
function RoomWizard() {
  const q = new URLSearchParams(location.search)
  const [room, setRoom] = useState(randomRoom())
  const [top, setTop] = useState(3)
  const [user, setUser] = useState('')
  const [ws] = useState(q.get('ws') || import.meta.env?.VITE_WS_URL || DEFAULT_WS)

  const makeUrl = () => {
    const p = new URLSearchParams()
    p.set('ws', sanitizeBaseUrl(ws))
    p.set('room', room.trim())
    p.set('top', String(top))
    if (user.trim()) {
      p.set('autouser', user.replace(/^@+/, '').trim())
      p.set('user', user.replace(/^@+/, '').trim())
    }
    return `${location.origin}/?${p.toString()}`
  }

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
            const link = makeUrl()
            try { await navigator.clipboard.writeText(link); alert('Link copiado') }
            catch { prompt('Copia el link:', link) }
          }}>Copiar link</button>
        </div>
        <div className="w-hint">Pega el link en <b>Browser Source</b> de TikTok LIVE Studio.</div>
      </div>
    </div>
  )
}

/* ======================= Helpers ======================= */
function sanitizeBaseUrl(u){ return String(u||'').trim().replace(/\/+$/,'') }
async function postJSON(url, body){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body ?? {}) })
  const text = await r.text(); return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : {} }
}
function randomRoom(){ return 'room-' + Math.random().toString(36).slice(2,7) }
