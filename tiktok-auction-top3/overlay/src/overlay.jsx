import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css'

/* ============================================================
   APP: Gate de licencia → (Admin? Gate? Wizard u Overlay)
============================================================ */
export default function App() {
  const q = new URLSearchParams(location.search)
  const admin = q.get('admin') === '1'
  if (admin) return <AdminPanel />
  return (
    <LicenseGate>
      <Decider />
    </LicenseGate>
  )
}

/* Decide si mostrar Room Wizard o Overlay */
function Decider() {
  const q = new URLSearchParams(location.search)
  const room = (q.get('room') || '').trim()
  if (!room) return <RoomWizard />
  return <AuctionOverlay />
}

/* ======================= LICENSE GATE ======================= */
function LicenseGate({ children }) {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = RAW_WS.replace(/\/+$/, '')
  const telURL = `${WS}/license/telegram` // abre tu canal de Telegram (Render env)

  const [checking, setChecking] = useState(true)
  const [ok, setOk] = useState(false)
  const [key, setKey] = useState(q.get('key') || localStorage.getItem('LIC_KEY') || '')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    (async () => {
      const k = (q.get('key') || localStorage.getItem('LIC_KEY') || '').trim()
      if (!k) { setChecking(false); setOk(false); return }
      const r = await verifyKey(WS, k)
      if (r.ok) { localStorage.setItem('LIC_KEY', k); setOk(true) }
      else { setOk(false) }
      setChecking(false)
    })()
  }, [WS])

  if (checking) {
    return (
      <div className="gate">
        <div className="g-card"><div className="g-title">Verificando licencia…</div></div>
      </div>
    )
  }
  if (ok) return children

  const redeem = async () => {
    setMsg('')
    const k = key.trim()
    if (!k) { setMsg('Ingresa tu código.'); return }
    const r = await verifyKey(WS, k)
    if (r.ok) { localStorage.setItem('LIC_KEY', k); setOk(true) }
    else setMsg('Código inválido o vencido.')
  }
  const getMembership = () => window.open(telURL, '_blank')

  return (
    <div className="gate">
      <div className="g-card">
        <div className="g-title">Canjear código</div>
        <div className="g-field">
          <input value={key} onChange={e=>setKey(e.target.value)} placeholder="Pega tu código aquí" />
        </div>
        {msg && <div className="g-msg">{msg}</div>}
        <div className="g-actions">
          <button className="g-primary" onClick={redeem}>Canjear</button>
          <button className="g-ghost" onClick={getMembership}>Obtener membresía</button>
        </div>
        <div className="g-hint">¿No tienes un código? Pulsa “Obtener membresía”.</div>
      </div>
    </div>
  )
}

async function verifyKey(WS, key) {
  try {
    const res = await fetch(`${WS}/license/verify`, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ key })
    })
    return await res.json()
  } catch {
    return { ok:false, error:'network' }
  }
}

/* ======================= ADMIN PANEL ======================= */
function AdminPanel() {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = RAW_WS.replace(/\/+$/, '')

  const [adminKey, setAdminKey] = useState('')
  const [months, setMonths] = useState(1)
  const [count, setCount] = useState(5)
  const [result, setResult] = useState(null)
  const [msg, setMsg] = useState('')

  const issue = async () => {
    setMsg('')
    try {
      const res = await fetch(`${WS}/admin/license/create`, {
        method:'POST',
        headers:{'Content-Type':'application/json', 'x-admin-key': adminKey},
        body: JSON.stringify({ months, count })
      })
      const j = await res.json()
      if (!j.ok) { setMsg(j.error || 'Error'); setResult(null); return }
      setResult(j)
    } catch {
      setMsg('Error de red')
    }
  }

  return (
    <div className="wizard">
      <div className="w-card">
        <h2>Admin: Generar llaves</h2>

        <div className="w-field">
          <label>ADMIN_KEY</label>
          <input value={adminKey} onChange={e=>setAdminKey(e.target.value)} placeholder="Tu clave de admin" />
        </div>

        <div className="w-field">
          <label>Meses de validez</label>
          <input type="number" min="1" max="12" value={months} onChange={e=>setMonths(Number(e.target.value))} />
        </div>

        <div className="w-field">
          <label>Cantidad de llaves</label>
          <input type="number" min="1" max="100" value={count} onChange={e=>setCount(Number(e.target.value))} />
        </div>

        <div className="w-actions">
          <button className="w-primary" onClick={issue}>Generar</button>
        </div>

        {msg && <div className="w-hint" style={{color:'#ff6'}}>{msg}</div>}

        {result?.ok && (
          <div className="w-field">
            <label>Keys generadas</label>
            <div className="keys">
              {result.keys.map((k, idx)=>(
                <div key={idx} className="keyrow">
                  <code className="keytxt">{k.key}</code>
                  <button className="w-btn" onClick={()=>navigator.clipboard.writeText(k.key)}>Copiar</button>
                </div>
              ))}
            </div>
            <div className="w-hint">Expiran en {months} mes(es) desde hoy.</div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ======================= OVERLAY (contador + top) ======================= */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const room = (q.get('room') || 'demo').trim()
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = RAW_WS.replace(/\/+$/, '')
  const initialTitle = q.get('title') || 'Subasta'
  const autoUser = (q.get('autouser') || '').replace(/^@+/, '').trim()
  const topN = Number(q.get('top') || 3)

  const [state, setState] = useState({ title: initialTitle, endsAt: 0, top: [] })
  const [now, setNow] = useState(Date.now())
  const [modal, setModal] = useState(null)
  const [showPanel, setShowPanel] = useState(false)
  const [userInput, setUserInput] = useState('')
  const socketRef = useRef(null)

  useEffect(() => {
    const socket = io(WS, { transports:['websocket'], query:{ room } })
    socketRef.current = socket
    socket.on('state', st => setState(prev => ({ ...prev, ...st })))
    socket.on('donation', d => setState(prev => ({ ...prev, top: d.top })))
    return () => socket.close()
  }, [WS, room])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [])

  const remain = Math.max(0, (state.endsAt || 0) - now)
  const mm = String(Math.floor(remain / 1000 / 60)).padStart(2, '0')
  const ss = String(Math.floor(remain / 1000) % 60).padStart(2, '0')

  useEffect(() => {
    if (remain === 0 && (state.endsAt || 0) > 0) {
      const winner = state.top?.[0]
      if (winner) setModal({ user: winner.user, total: winner.total, avatar: winner.avatar || '' })
    }
  }, [remain, state.endsAt, state.top])

  useEffect(() => {
    (async () => {
      if (!autoUser) return
      try {
        await fetch(`${WS}/${room}/user`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ user: autoUser })
        })
      } catch {}
    })()
  }, [autoUser, WS, room])

  useEffect(() => {
    const onKey = async (e) => {
      if (e.key.toLowerCase() === 't') {
        const v = Number(prompt('Duración en segundos (ej. 120):') || 0)
        if (v > 0) {
          await fetch(`${WS}/${room}/auction/start`, {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ durationSec: v, title: state.title })
          })
          setModal(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [WS, room, state.title])

  const applyUser = async () => {
    const clean = (userInput || '').trim().replace(/^@+/, '')
    if (!clean) return alert('Escribe un usuario de TikTok (sin @).')
    try {
      const res = await fetch(`${WS}/${room}/user`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ user: clean })
      })
      const j = await res.json().catch(()=>({}))
      if (j?.ok) { alert(`Conectando a @${clean}…`); setShowPanel(false); setModal(null) }
      else { alert('No se pudo cambiar el usuario.') }
    } catch { alert('No se pudo comunicar con el backend.') }
  }

  return (
    <>
      <div className="panel">
        <div className="timer">{mm}:{ss}</div>

        {state.top.slice(0, topN).map((d, i) => (
          <div className="row" key={d.user + i}>
            <div className={`badge ${i===1 ? 'silver' : i===2 ? 'bronze' : ''}`}>{i+1}</div>
            <img className="avatar" src={d.avatar || ''} alt="" />
            <div className="name" title={d.user}>{d.user}</div>
            <div className="coin">{d.total}</div>
          </div>
        ))}

        <button className="gear" title="Cambiar usuario de TikTok" onClick={()=>setShowPanel(v=>!v)}>⚙️</button>
      </div>

      {showPanel && (
        <div className="sheet" onClick={()=>setShowPanel(false)}>
          <div className="card" onClick={e=>e.stopPropagation()}>
            <h3>Conectar a otro usuario</h3>
            <p>Escribe el <b>usuario de TikTok</b> (sin @) y el backend se reconectará.</p>
            <div className="field">
              <span>@</span>
              <input placeholder="sticx33" value={userInput} onChange={e=>setUserInput(e.target.value)} />
            </div>
            <div className="actions">
              <button onClick={()=>setShowPanel(false)}>Cancelar</button>
              <button onClick={applyUser}>Conectar</button>
            </div>
          </div>
        </div>
      )}

      {modal && (
        <div className="winner">
          <div className="win-card">
            <div className="trophy">🏆</div>
            <div className="win-title">¡GANADOR!</div>
            <div className="win-name">{modal.user}</div>
            <div className="win-coins">
              <span className="dot"></span><b>{modal.total}</b>&nbsp;diamantes
            </div>
            <div className="win-footer">¡Felicidades! 🎉</div>
            <button className="win-close" onClick={()=>setModal(null)}>Cerrar</button>
          </div>
        </div>
      )}
    </>
  )
}

/* ======================= ROOM WIZARD (crear sala) ======================= */
function RoomWizard() {
  const [room, setRoom] = useState(randomRoom())
  const [ws, setWs] = useState('https://tiklive-63mk.onrender.com')
  const [top, setTop] = useState(3)
  const [user, setUser] = useState('')

  const makeUrl = () => {
    const p = new URLSearchParams()
    p.set('ws', ws.replace(/\/+$/, ''))
    p.set('room', room.trim())
    p.set('top', String(top))
    const key = localStorage.getItem('LIC_KEY')
    if (key) p.set('key', key)
    if (user.trim()) p.set('autouser', user.replace(/^@+/, '').trim())
    return `${location.origin}/?${p.toString()}`
  }

  const openOverlay = () => { location.href = makeUrl() }
  const copyLink = async () => {
    const link = makeUrl()
    try { await navigator.clipboard.writeText(link); alert('Link copiado:\n'+link) }
    catch { prompt('Copia el link:', link) }
  }

  return (
    <div className="wizard">
      <div className="w-card">
        <h2>Crear mi sala de subasta</h2>

        <div className="w-field">
          <label>Nombre de sala (room)</label>
          <div className="w-row">
            <input value={room} onChange={e=>setRoom(e.target.value)} placeholder="miSala123" />
            <button className="w-btn" onClick={()=>setRoom(randomRoom())}>Aleatorio</button>
          </div>
        </div>

        <div className="w-field">
          <label>Backend (Render)</label>
          <input value={ws} onChange={e=>setWs(e.target.value)} placeholder="https://tu-backend.onrender.com" />
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
          <label>Usuario de TikTok (opcional, sin @)</label>
          <input value={user} onChange={e=>setUser(e.target.value)} placeholder="sticx33" />
        </div>

        <div className="w-actions">
          <button className="w-primary" onClick={openOverlay}>Abrir overlay</button>
          <button className="w-success" onClick={copyLink}>Copiar link</button>
        </div>

        <div className="w-hint">Pega el link en <b>Browser Source</b> de TikTok LIVE Studio.</div>
      </div>
    </div>
  )
}
function randomRoom(){ return 'room-' + Math.random().toString(36).slice(2,7) }
