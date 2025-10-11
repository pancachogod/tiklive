import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css'

/* =======================
   App: decide qué mostrar
   ======================= */
export default function App() {
  const q = new URLSearchParams(location.search)
  const room = (q.get('room') || '').trim()

  if (!room) return <RoomWizard />
  return <AuctionOverlay />
}

/* ======================================================
   OVERLAY de subasta (lo que ya tenías, con room/auto)
   ====================================================== */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const room = (q.get('room') || 'demo').trim()
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = RAW_WS.replace(/\/+$/, '')
  const initialTitle = q.get('title') || 'Subasta'
  const autoUser = (q.get('autouser') || '').replace(/^@+/, '').trim()

  const [state, setState] = useState({ title: initialTitle, endsAt: 0, top: [] })
  const [now, setNow] = useState(Date.now())
  const [modal, setModal] = useState(null)        // { user, total, avatar }
  const [showPanel, setShowPanel] = useState(false)
  const [userInput, setUserInput] = useState('')
  const socketRef = useRef(null)

  // socket por room
  useEffect(() => {
    const socket = io(WS, { transports: ['websocket'], query: { room } })
    socketRef.current = socket
    socket.on('state', st => setState(prev => ({ ...prev, ...st })))
    socket.on('donation', d => setState(prev => ({ ...prev, top: d.top })))
    return () => socket.close()
  }, [WS, room])

  // reloj
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [])

  const remain = Math.max(0, (state.endsAt || 0) - now)
  const mm = String(Math.floor(remain / 1000 / 60)).padStart(2, '0')
  const ss = String(Math.floor(remain / 1000) % 60).padStart(2, '0')

  // modal ganador
  useEffect(() => {
    if (remain === 0 && (state.endsAt || 0) > 0) {
      const winner = state.top?.[0]
      if (winner) setModal({ user: winner.user, total: winner.total, avatar: winner.avatar || '' })
    }
  }, [remain, state.endsAt, state.top])

  // tecla T = iniciar
  useEffect(() => {
    const onKey = async (e) => {
      if (e.key.toLowerCase() === 't') {
        const v = Number(prompt('Duración en segundos (ej. 120):') || 0)
        if (v > 0) {
          await fetch(`${WS}/${room}/auction/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ durationSec: v, title: state.title })
          })
          setModal(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [WS, room, state.title])

  // autoconectar usuario si viene ?autouser=
  useEffect(() => {
    (async () => {
      if (!autoUser) return
      try {
        await fetch(`${WS}/${room}/user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: autoUser })
        })
      } catch {}
    })()
  }, [autoUser, WS, room])

  // cambiar usuario desde engranaje
  const applyUser = async () => {
    const clean = (userInput || '').trim().replace(/^@+/, '')
    if (!clean) return alert('Escribe un usuario de TikTok (sin @).')
    try {
      const res = await fetch(`${WS}/${room}/user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: clean })
      })
      const j = await res.json().catch(() => ({}))
      if (j?.ok) {
        alert(`Usuario cambiado a @${clean}. El backend se reconectará en segundos.`)
        setShowPanel(false)
        setModal(null)
      } else {
        alert('No se pudo cambiar el usuario.')
      }
    } catch {
      alert('No se pudo comunicar con el backend.')
    }
  }

  return (
    <>
      {/* CONTADOR + TOP */}
      <div className="panel">
        <div className="timer">{mm}:{ss}</div>
        {state.top.slice(0, Number(q.get('top') || 3)).map((d, i) => (
          <div className="row" key={d.user + i}>
            <div className={`badge ${i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}`}>{i + 1}</div>
            <img className="avatar" src={d.avatar || ''} alt="" />
            <div className="name" title={d.user}>{d.user}</div>
            <div className="coin">{d.total}</div>
          </div>
        ))}
        {/* engranaje */}
        <button className="gear" title="Cambiar usuario de TikTok" onClick={() => setShowPanel(v => !v)}>⚙️</button>
      </div>

      {/* Panel de usuario */}
      {showPanel && (
        <div className="sheet" onClick={() => setShowPanel(false)}>
          <div className="card" onClick={e => e.stopPropagation()}>
            <h3>Conectar a otro usuario</h3>
            <p>Escribe el <b>usuario de TikTok</b> (sin @) y el backend se reconectará.</p>
            <div className="field">
              <span>@</span>
              <input placeholder="sticx33" value={userInput} onChange={e => setUserInput(e.target.value)} />
            </div>
            <div className="actions">
              <button onClick={() => setShowPanel(false)}>Cancelar</button>
              <button onClick={applyUser}>Conectar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal ganador */}
      {modal && (
        <div className="winner">
          <div className="win-card">
            <div className="trophy">🏆</div>
            <div className="win-title">¡GANADOR!</div>
            <div className="win-name">{modal.user}</div>
            <div className="win-coins">
              <span className="dot"></span>
              <b>{modal.total}</b>&nbsp;diamantes
            </div>
            <div className="win-footer">¡Felicidades! 🎉</div>
            <button className="win-close" onClick={() => setModal(null)}>Cerrar</button>
          </div>
        </div>
      )}
    </>
  )
}

/* ============================================
   ROOM WIZARD (sin ?room= muestra este panel)
   ============================================ */
function RoomWizard() {
  const [room, setRoom] = useState(randomRoom())
  const [ws, setWs] = useState('https://tiklive-63mk.onrender.com')
  const [top, setTop] = useState(3)
  const [user, setUser] = useState('') // opcional (sin @)

  const makeUrl = () => {
    const p = new URLSearchParams()
    p.set('ws', ws.replace(/\/+$/, ''))
    p.set('room', room.trim())
    p.set('top', String(top))
    if (user.trim()) p.set('autouser', user.replace(/^@+/, '').trim())
    return `${location.origin}/?${p.toString()}`
  }

  const openOverlay = () => { location.href = makeUrl() }
  const copyLink = async () => {
    const link = makeUrl()
    try {
      await navigator.clipboard.writeText(link)
      alert('Link copiado:\n' + link)
    } catch {
      prompt('Copia el link:', link)
    }
  }

  return (
    <div className="wizard">
      <div className="w-card">
        <h2>Crear mi sala de subasta</h2>
        <div className="w-field">
          <label>Nombre de sala (room)</label>
          <div className="w-row">
            <input value={room} onChange={e => setRoom(e.target.value)} placeholder="miSala123" />
            <button onClick={() => setRoom(randomRoom())}>Aleatorio</button>
          </div>
        </div>

        <div className="w-field">
          <label>Backend (Render)</label>
          <input value={ws} onChange={e => setWs(e.target.value)} placeholder="https://tu-backend.onrender.com" />
        </div>

        <div className="w-field">
          <label>Top a mostrar</label>
          <select value={top} onChange={e => setTop(Number(e.target.value))}>
            <option value={1}>Top 1</option>
            <option value={3}>Top 3</option>
            <option value={5}>Top 5</option>
          </select>
        </div>

        <div className="w-field">
          <label>Usuario de TikTok (opcional, sin @)</label>
          <input value={user} onChange={e => setUser(e.target.value)} placeholder="sticx33" />
        </div>

        <div className="w-actions">
          <button onClick={openOverlay}>Abrir overlay</button>
          <button onClick={copyLink}>Copiar link</button>
        </div>

        <div className="w-hint">
          Consejo: pega el link en <b>Browser Source</b> de TikTok LIVE Studio.
        </div>
      </div>
    </div>
  )
}

function randomRoom() {
  const s = Math.random().toString(36).slice(2, 7)
  return 'room-' + s
}
