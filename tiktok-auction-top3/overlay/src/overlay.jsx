import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css' // asegúrate de tener tu CSS del contador aquí también

export default function Overlay() {
  // ----- Config / URL backend -----
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = RAW_WS.replace(/\/+$/, '') // quita barras finales
  const initialTitle = q.get('title') || 'Subasta'

  // ----- Estado UI -----
  const [state, setState] = useState({ title: initialTitle, endsAt: 0, top: [] })
  const [now, setNow] = useState(Date.now())
  const [modal, setModal] = useState(null)        // { user, total, avatar }
  const [showPanel, setShowPanel] = useState(false)
  const [userInput, setUserInput] = useState('')  // input @usuario (sin @)

  const socketRef = useRef(null)

  // ----- Socket.IO -----
  useEffect(() => {
    const socket = io(WS, { transports: ['websocket'] })
    socketRef.current = socket
    socket.on('state', st => setState(prev => ({ ...prev, ...st })))
    socket.on('donation', d => setState(prev => ({ ...prev, top: d.top })))
    return () => socket.close()
  }, [WS])

  // ----- Reloj (no cambia el diseño del contador) -----
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [])

  const remain = Math.max(0, (state.endsAt || 0) - now)
  const mm = String(Math.floor(remain / 1000 / 60)).padStart(2, '0')
  const ss = String(Math.floor(remain / 1000) % 60).padStart(2, '0')

  // ----- Modal GANADOR al llegar a 0 -----
  useEffect(() => {
    if (remain === 0 && (state.endsAt || 0) > 0) {
      const winner = state.top?.[0]
      if (winner) setModal({ user: winner.user, total: winner.total, avatar: winner.avatar || '' })
    }
  }, [remain, state.endsAt, state.top])

  // ----- Tecla T = iniciar/reiniciar subasta -----
  useEffect(() => {
    const onKey = async (e) => {
      if (e.key.toLowerCase() === 't') {
        const v = Number(prompt('Duración en segundos (ej. 120):') || 0)
        if (v > 0) {
          await fetch(`${WS}/auction/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ durationSec: v, title: state.title })
          })
          setModal(null) // ocultar modal si estaba visible
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [WS, state.title])

  // ----- Cambiar usuario TikTok (sin @) -----
  const applyUser = async () => {
    const clean = (userInput || '').trim().replace(/^@+/, '')
    if (!clean) return alert('Escribe un usuario de TikTok (sin @).')
    try {
      const res = await fetch(`${WS}/user`, {
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
      {/* Panel principal (tu contador original + Top 3) */}
      <div className="panel">
        {/* ⬇️ Mantiene tu diseño del contador */}
        <div className="timer">{mm}:{ss}</div>

        {state.top.slice(0, 3).map((d, i) => (
          <div className="row" key={d.user + i}>
            <div className={`badge ${i === 1 ? 'silver' : i === 2 ? 'bronze' : ''}`}>{i + 1}</div>
            <img className="avatar" src={d.avatar || ''} alt="" />
            <div className="name" title={d.user}>{d.user}</div>
            <div className="coin">{d.total}</div>
          </div>
        ))}

        {/* Botón de ajustes (no afecta al timer) */}
        <button className="gear" title="Cambiar usuario de TikTok" onClick={() => setShowPanel(v => !v)}>⚙️</button>
      </div>

      {/* Panel para cambiar usuario */}
      {showPanel && (
        <div className="sheet" onClick={() => setShowPanel(false)}>
          <div className="card" onClick={e => e.stopPropagation()}>
            <h3>Conectar a otro usuario</h3>
            <p>Escribe el <b>usuario de TikTok</b> (sin @) y el backend se reconectará.</p>
            <div className="field">
              <span>@</span>
              <input
                placeholder="sticx33"
                value={userInput}
                onChange={e => setUserInput(e.target.value)}
              />
            </div>
            <div className="actions">
              <button onClick={() => setShowPanel(false)}>Cancelar</button>
              <button onClick={applyUser}>Conectar</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal GANADOR (aparece cuando termina el tiempo) */}
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
