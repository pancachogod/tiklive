import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css'

/* =================== App (router mínimo por query) =================== */
export default function App() {
  const q = new URLSearchParams(location.search)
  const view = (q.get('view') || '').toLowerCase()
  const room = (q.get('room') || '').trim()

  if (view === 'admin') return <AdminPanel />
  if (!room) return <RoomWizard />
  return (
    <OverlayWithLicense>
      <AuctionOverlay />
    </OverlayWithLicense>
  )
}

/* ============== Licencias (canje simple via backend) ============== */
function OverlayWithLicense({ children }) {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = sanitizeBaseUrl(RAW_WS)
  const [ok, setOk] = useState(false)
  const [busy, setBusy] = useState(true)
  const [key, setKey] = useState(q.get('key') || localStorage.getItem('LIC_KEY') || '')
  const [msg, setMsg] = useState('')

  useEffect(() => {
    (async () => {
      const k = (q.get('key') || localStorage.getItem('LIC_KEY') || '').trim()
      if (!k) { setBusy(false); return }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/license/verify`, { key: k })
        if (httpOK && data?.ok) {
          localStorage.setItem('LIC_KEY', k)
          setOk(true)
        }
      } catch {}
      setBusy(false)
    })()
  }, [WS])

  if (busy) return <div className="gate"><div className="g-card"><div className="g-title">Verificando licencia…</div></div></div>

  if (!ok) {
    const redeem = async (e) => {
      e?.preventDefault?.()
      setMsg('')
      const k = key.trim()
      if (!k) { setMsg('Ingresa tu código.'); return }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/license/verify`, { key: k })
        if (httpOK && data?.ok) {
          localStorage.setItem('LIC_KEY', k)
          setOk(true)
        } else setMsg('Código inválido o expirado.')
      } catch { setMsg('No se pudo contactar con el servidor.') }
    }
    return (
      <div className="gate">
        <form className="g-card" onSubmit={redeem}>
          <div className="g-title">Canjear código</div>
          <div className="g-field"><input value={key} onChange={e=>setKey(e.target.value)} placeholder="Pega tu código" /></div>
          {msg && <div className="g-msg">{msg}</div>}
          <div className="g-actions">
            <button className="g-primary" type="submit">Canjear</button>
            <a className="g-ghost" href="https://t.me/+ae-ctGPi8sM1MTYx" target="_blank" rel="noreferrer">Obtener membresía</a>
          </div>
        </form>
      </div>
    )
  }

  return children
}

/* ======================= ADMIN PANEL ======================= */
function AdminPanel() {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = sanitizeBaseUrl(RAW_WS)

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
      const j = await res.json().catch(()=>({}))
      if (!j?.ok) { setMsg(j?.error || 'Unauthorized'); setResult(null); return }
      setResult(j)
    } catch { setMsg('Error de red') }
  }

  return (
    <div className="wizard">
      <div className="w-card" style={{maxWidth: 560}}>
        <h2>Admin: Generar llaves</h2>

        <div className="w-field">
          <label>ADMIN_KEY</label>
          <input value={adminKey} onChange={e=>setAdminKey(e.target.value)} placeholder="Tu clave de admin" />
        </div>

        <div className="w-field">
          <label>Meses de validez</label>
          <input type="number" min="1" max="12" value={months} onChange={e=>setMonths(Number(e.target.value)||1)} />
        </div>

        <div className="w-field">
          <label>Cantidad de llaves</label>
          <input type="number" min="1" max="100" value={count} onChange={e=>setCount(Number(e.target.value)||1)} />
        </div>

        <div className="w-actions">
          <button className="w-primary" onClick={issue}>Generar</button>
          <a className="w-success" style={{textAlign:'center'}} href={`/?ws=${encodeURIComponent(WS)}`} >Ir al Wizard</a>
        </div>

        {msg && <div className="w-hint" style={{color:'#ff6', marginTop:8}}>{msg}</div>}

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

/* ======================= OVERLAY (temporizador + top + dashboard) ======================= */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const room = (q.get('room') || 'demo').trim()
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = sanitizeBaseUrl(RAW_WS)
  const initialTitle = q.get('title') || 'Subasta'
  const autoUser = (q.get('autouser') || '').replace(/^@+/, '').trim()
  const topN = Number(q.get('top') || 3)

  const [state, setState] = useState({ title: initialTitle, endsAt: 0, top: [], donationsTotal: 0 })
  const [now, setNow] = useState(Date.now())
  const [dashboard, setDashboard] = useState(false)
  const [paused, setPaused] = useState(false)

  // tablero UI
  const [tInit, setTInit] = useState(60)
  const [delayS, setDelayS] = useState(10)
  const [minEntry, setMinEntry] = useState(20)
  const [editDelta, setEditDelta] = useState(10)

  const [winners, setWinners] = useState([])        // {name, total}
  const [totalParticipants, setTotalParticipants] = useState(0)
  const socketRef = useRef(null)

  useEffect(() => {
    const socket = io(WS, { transports:['websocket'], query:{ room } })
    socketRef.current = socket
    socket.on('state', st => setState(prev => ({ ...prev, ...st })))
    socket.on('donation', d => setState(prev => ({ ...prev, top: d.top, donationsTotal: d.donationsTotal ?? prev.donationsTotal })))
    return () => socket.close()
  }, [WS, room])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 150)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    (async () => {
      if (!autoUser) return
      try {
        await postJSON(`${WS}/${room}/user`, { user: autoUser })
      } catch {}
    })()
  }, [autoUser, WS, room])

  const remain = Math.max(0, (state.endsAt || 0) - now)
  const mm = String(Math.floor((paused ? 0 : remain) / 1000 / 60)).padStart(2, '0')
  const ss = String(Math.floor((paused ? 0 : remain) / 1000) % 60).padStart(2, '0')

  useEffect(() => {
    if (!paused && remain === 0 && (state.endsAt || 0) > 0) {
      const win = state.top?.[0]
      if (win) setWinners(w => [{ name: win.user, total: win.total }, ...w])
    }
    setTotalParticipants(state.top?.length || 0)
  }, [paused, remain, state.endsAt, state.top])

  const startAuction = async (seconds) => {
    const s = Math.max(1, Number(seconds)||0)
    setPaused(false)
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: s, title: state.title })
  }
  const finalizeAuction = async () => {
    setPaused(false)
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: 1, title: state.title })
  }
  const addTime = async (plus) => {
    const remainS = Math.max(0, Math.floor(remain/1000))
    const next = Math.max(1, remainS + plus)
    await startAuction(next)
  }

  return (
    <>
      {/* Botón Engranaje */}
      <button className="gear-floating" title="Abrir panel de control" onClick={()=>setDashboard(true)}>⚙️</button>

      {/* Panel compacto en vivo */}
      <div className="panel">
        <div className="timer">{mm}:{ss}</div>
        <div className="board">
          {state.top.slice(0, topN).map((d, i) => (
            <div className="row" key={d.user + i}>
              <div className={`badge ${i===1 ? 'silver' : i===2 ? 'bronze' : ''}`}>{i+1}</div>
              <img className="avatar" src={d.avatar || ''} alt="" />
              <div className="name" title={d.user}>{d.user}</div>
              <div className="coin">{d.total}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Dashboard estilo imagen */}
      {dashboard && (
        <div className="dash-wrap" onClick={()=>setDashboard(false)}>
          <div className="dash-card" onClick={e=>e.stopPropagation()}>
            <div className="dash-tabs">
              <div className="tab active">🎮 Control Principal</div>
              <div className="tab muted">⚙️ Configurar Estilos</div>
            </div>

            <div className="dash-grid">
              <div className="dash-col">
                <div className="box box-blue">
                  <div className="box-header">🏆 GANADORES</div>
                  <div className="box-body list">
                    {winners.length === 0 && <div className="empty">Aún no hay ganadores</div>}
                    {winners.map((w, idx)=>(
                      <div className="winner-row" key={idx}>
                        <div className="w-name">{w.name}</div>
                        <div className="w-total">💰 {w.total}</div>
                      </div>
                    ))}
                  </div>
                  <div className="box-footer">Total Ganadores: {winners.length}</div>
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
                  <div className="box-footer">
                    Total Participantes: {totalParticipants} &nbsp;|&nbsp; Total Diamantes: {state.donationsTotal || 0}
                  </div>
                </div>
              </div>

              <div className="dash-col">
                <div className="box box-purple">
                  <div className="box-header">🎮 CONTROLES</div>
                  <div className="controls">
                    <div className="fields-3">
                      <div>
                        <label>Tiempo inicial (s):</label>
                        <input className="input" type="number" value={tInit} onChange={e=>setTInit(Number(e.target.value)||0)} />
                      </div>
                      <div>
                        <label>Delay (s):</label>
                        <input className="input" type="number" value={delayS} onChange={e=>setDelayS(Number(e.target.value)||0)} />
                      </div>
                      <div>
                        <label>Mínimo de entrada:</label>
                        <input className="input" type="number" value={minEntry} onChange={e=>setMinEntry(Number(e.target.value)||0)} />
                      </div>
                    </div>

                    <div className="btn-row">
                      <button className="btn btn-green" onClick={()=>startAuction(tInit)}>▶️ Iniciar</button>
                      <button className="btn btn-orange" onClick={()=>setPaused(p=>!p)}>{paused ? '⏯ Reanudar' : '⏸ Pausar'}</button>
                    </div>
                    <div className="btn-row">
                      <button className="btn btn-red" onClick={finalizeAuction}>🏁 Finalizar</button>
                      <button className="btn btn-gray" onClick={()=>startAuction(tInit)}>🔁 Restart</button>
                    </div>

                    <div className="fields-1">
                      <label>Modificar tiempo (s):</label>
                      <input className="input" type="number" value={editDelta} onChange={e=>setEditDelta(Number(e.target.value)||0)} />
                      <div className="btn-row">
                        <button className="btn btn-green" onClick={()=>addTime(+Math.abs(editDelta))}>+</button>
                        <button className="btn btn-red" onClick={()=>addTime(-Math.abs(editDelta))}>-</button>
                      </div>
                    </div>
                  </div>

                  <div className="progress-strip"></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/* ======================= WIZARD ======================= */
function RoomWizard() {
  const q = new URLSearchParams(location.search)
  const [room, setRoom] = useState(randomRoom())
  const [top, setTop] = useState(3)
  const [user, setUser] = useState('')
  const [ws] = useState(q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000')

  const makeUrl = () => {
    const p = new URLSearchParams()
    p.set('ws', sanitizeBaseUrl(ws))
    p.set('room', room.trim())
    p.set('top', String(top))
    const key = localStorage.getItem('LIC_KEY')
    if (key) p.set('key', key)
    if (user.trim()) p.set('autouser', user.replace(/^@+/, '').trim())
    return `${location.origin}/?${p.toString()}`
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
          <button className="w-primary" onClick={()=>{ location.href = makeUrl() }}>Abrir overlay</button>
          <button className="w-success" onClick={async()=>{
            const link = makeUrl()
            try { await navigator.clipboard.writeText(link); alert('Link copiado:\n'+link) }
            catch { prompt('Copia el link:', link) }
          }}>Copiar link</button>
        </div>

        <div className="w-hint">Pega el link en <b>Browser Source</b> de TikTok LIVE Studio.</div>
        <div className="w-hint" style={{marginTop:8}}>
          Panel Admin: <a href={`/?view=admin&ws=${encodeURIComponent(sanitizeBaseUrl(ws))}`}>abrir aquí</a>
        </div>
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
