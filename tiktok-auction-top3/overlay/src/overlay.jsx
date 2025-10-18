import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css'

// ⚠️ CAMBIO CRÍTICO: URL correcta del backend
const DEFAULT_WS = 'https://tiklive-63mk.onrender.com'

/* =================== App (router mínimo por query) =================== */
export default function App() {
  const q = new URLSearchParams(location.search)
  const view = (q.get('view') || '').toLowerCase()
  const room = (q.get('room') || '').trim()

  if (view === 'admin') return <AdminPanel />
  if (!room) return <RoomWizard />
  return (
    <OverlayWithUser>
      <AuctionOverlay />
    </OverlayWithUser>
  )
}

/* ============== Verificación por Usuario TikTok ============== */
function OverlayWithUser({ children }) {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || DEFAULT_WS
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
        console.log('🔍 Verificando usuario:', u)
        console.log('📡 Backend URL:', WS)
        
        const { ok: httpOK, data } = await postJSON(`${WS}/user/verify`, { tiktokUser: u })
        console.log('✅ Respuesta del servidor:', data)
        
        if (httpOK && data?.ok) {
          localStorage.setItem('TIKTOK_USER', u)
          setDaysRemaining(data.daysRemaining || 0)
          setOk(true)
        } else {
          console.error('❌ Usuario no verificado:', data?.error)
        }
      } catch (err) {
        console.error('❌ Error de conexión:', err)
      }
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
        console.log('🔄 Intentando verificar:', u)
        const { ok: httpOK, data } = await postJSON(`${WS}/user/verify`, { tiktokUser: u })
        console.log('📥 Respuesta:', data)
        
        if (httpOK && data?.ok) {
          localStorage.setItem('TIKTOK_USER', u)
          setDaysRemaining(data.daysRemaining || 0)
          setOk(true)
        } else {
          const error = data?.error || 'invalid'
          if (error === 'subscription-expired') setMsg('Tu suscripción ha expirado.')
          else if (error === 'user-disabled') setMsg('Usuario desactivado.')
          else if (error === 'user-not-found') setMsg('Usuario no encontrado. Contacta al administrador.')
          else setMsg('No tienes acceso.')
        }
      } catch (err) { 
        console.error('❌ Error:', err)
        setMsg('No se pudo contactar con el servidor.') 
      }
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
            <a className="g-ghost" href="https://t.me/+ae-ctGPi8sM1MTYx" target="_blank" rel="noreferrer">Obtener acceso</a>
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

/* ======================= ADMIN PANEL ======================= */
function AdminPanel() {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || DEFAULT_WS
  const WS = sanitizeBaseUrl(RAW_WS)

  const [adminKey, setAdminKey] = useState('')
  const [authenticated, setAuthenticated] = useState(false)
  const [msg, setMsg] = useState('')
  const [view, setView] = useState('dashboard')
  const [stats, setStats] = useState(null)
  const [users, setUsers] = useState([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selectedUser, setSelectedUser] = useState(null)
  const [newUser, setNewUser] = useState('')
  const [days, setDays] = useState(30)

  const checkAuth = async (e) => {
    e?.preventDefault?.()
    setMsg('')
    try {
      const res = await fetch(`${WS}/admin/stats`, {
        headers: { 'x-admin-key': adminKey }
      })
      if (res.ok) {
        setAuthenticated(true)
        await loadStats()
      } else {
        setMsg('Admin Key incorrecta')
      }
    } catch {
      setMsg('Error de conexión')
    }
  }

  const loadStats = async () => {
    try {
      const res = await fetch(`${WS}/admin/stats`, {
        headers: { 'x-admin-key': adminKey }
      })
      const data = await res.json().catch(()=>({}))
      if (data?.ok) setStats(data.stats)
    } catch {}
  }

  const loadUsers = async () => {
    try {
      const params = new URLSearchParams()
      if (filter !== 'all') params.set('status', filter)
      if (search) params.set('search', search)
      const res = await fetch(`${WS}/admin/user/list?${params.toString()}`, {
        headers: { 'x-admin-key': adminKey }
      })
      const data = await res.json().catch(()=>({}))
      if (data?.ok) setUsers(data.users || [])
    } catch {}
  }

  const activateUser = async () => {
    setMsg('')
    const u = (newUser || '').trim().replace(/^@+/, '')
    if (!u) { setMsg('Ingresa un usuario'); return }
    if (days < 1) { setMsg('Los días deben ser mayor a 0'); return }
    try {
      const res = await fetch(`${WS}/admin/user/activate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ tiktokUser: u, days })
      })
      const data = await res.json().catch(()=>({}))
      if (data?.ok) {
        alert(`✅ Usuario @${u} activado por ${days} días`)
        setNewUser('')
        setDays(30)
        loadStats()
        if (view === 'list') loadUsers()
      } else {
        setMsg(data?.error || 'Error')
      }
    } catch {
      setMsg('Error de red')
    }
  }

  const viewDetails = async (tiktokUser) => {
    try {
      const res = await fetch(`${WS}/admin/user/${tiktokUser}`, {
        headers: { 'x-admin-key': adminKey }
      })
      const data = await res.json().catch(()=>({}))
      if (data?.ok) {
        setSelectedUser(data.user)
        setView('details')
      }
    } catch {}
  }

  const disableUser = async (tiktokUser) => {
    if (!confirm(`¿Desactivar a @${tiktokUser}?`)) return
    try {
      const res = await fetch(`${WS}/admin/user/${tiktokUser}/disable`, {
        method: 'POST',
        headers: { 'x-admin-key': adminKey }
      })
      if (res.ok) {
        alert('Usuario desactivado')
        if (view === 'details') viewDetails(tiktokUser)
        if (view === 'list') loadUsers()
      }
    } catch {}
  }

  const enableUser = async (tiktokUser) => {
    try {
      const res = await fetch(`${WS}/admin/user/${tiktokUser}/enable`, {
        method: 'POST',
        headers: { 'x-admin-key': adminKey }
      })
      if (res.ok) {
        alert('Usuario reactivado')
        if (view === 'details') viewDetails(tiktokUser)
        if (view === 'list') loadUsers()
      }
    } catch {}
  }

  const deleteUser = async (tiktokUser) => {
    if (!confirm(`¿Eliminar a @${tiktokUser}? Esta acción no se puede deshacer.`)) return
    try {
      const res = await fetch(`${WS}/admin/user/${tiktokUser}/delete`, {
        method: 'POST',
        headers: { 'x-admin-key': adminKey }
      })
      if (res.ok) {
        alert('Usuario eliminado')
        if (view === 'details') { setView('list'); setSelectedUser(null) }
        loadUsers()
        loadStats()
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
              onChange={e=>setAdminKey(e.target.value)} 
              placeholder="ADMIN_KEY" 
            />
          </div>
          {msg && <div className="g-msg">{msg}</div>}
          <div className="g-actions">
            <button className="g-primary" type="submit">Acceder</button>
            <a className="g-ghost" href={`/?ws=${encodeURIComponent(WS)}`}>Volver</a>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="wizard">
      <div className="w-card" style={{maxWidth: 940}}>
        <h2>Admin Panel</h2>
        <div className="tabs">
          <button className={`tab-btn ${view==='dashboard'?'active':''}`} onClick={()=>{setView('dashboard'); loadStats()}}>Dashboard</button>
          <button className={`tab-btn ${view==='list'?'active':''}`} onClick={()=>{setView('list'); loadUsers()}}>Usuarios</button>
          <button className={`tab-btn ${view==='activate'?'active':''}`} onClick={()=>setView('activate')}>Activar</button>
        </div>

        {view==='dashboard' && (
          <div className="grid-3">
            <div className="stat"><div className="stat-title">Activos</div><div className="stat-value">{stats?.active ?? '-'}</div></div>
            <div className="stat"><div className="stat-title">Expirados</div><div className="stat-value">{stats?.expired ?? '-'}</div></div>
            <div className="stat"><div className="stat-title">Deshabilitados</div><div className="stat-value">{stats?.disabled ?? '-'}</div></div>
            <div className="w-actions" style={{gridColumn:'1 / -1'}}>
              <button className="w-primary" onClick={loadStats}>Refrescar</button>
              <a className="w-success" href={`/?ws=${encodeURIComponent(WS)}`}>Ir al Wizard</a>
            </div>
          </div>
        )}

        {view==='list' && (
          <>
            <div className="w-row" style={{gap:8}}>
              <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar..." />
              <select value={filter} onChange={e=>setFilter(e.target.value)}>
                <option value="all">Todos</option>
                <option value="active">Activos</option>
                <option value="expired">Expirados</option>
                <option value="disabled">Deshabilitados</option>
              </select>
              <button className="w-btn" onClick={loadUsers}>Buscar</button>
            </div>
            <div className="list-table" style={{marginTop:12}}>
              {users.length===0 && <div className="w-hint">Sin resultados</div>}
              {users.map(u=>(
                <div key={u.tiktokUser} className="row-lite">
                  <div className="cell">@{u.tiktokUser}</div>
                  <div className="cell">Estado: {u.status}</div>
                  <div className="cell">Días: {u.daysRemaining ?? '-'}</div>
                  <div className="cell actions">
                    <button className="w-btn" onClick={()=>viewDetails(u.tiktokUser)}>Detalles</button>
                    {u.status==='disabled'
                      ? <button className="w-success" onClick={()=>enableUser(u.tiktokUser)}>Habilitar</button>
                      : <button className="w-btn" onClick={()=>disableUser(u.tiktokUser)}>Deshabilitar</button>}
                    <button className="w-danger" onClick={()=>deleteUser(u.tiktokUser)}>Eliminar</button>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {view==='activate' && (
          <>
            <div className="w-field">
              <label>Usuario TikTok (sin @)</label>
              <input value={newUser} onChange={e=>setNewUser(e.target.value)} placeholder="usuario123" />
            </div>
            <div className="w-field">
              <label>Días de acceso</label>
              <input type="number" min="1" value={days} onChange={e=>setDays(Number(e.target.value)||1)} />
            </div>
            {msg && <div className="w-hint" style={{color:'#ff6'}}>{msg}</div>}
            <div className="w-actions">
              <button className="w-primary" onClick={activateUser}>Activar</button>
              <button className="w-btn" onClick={()=>{setNewUser(''); setDays(30)}}>Limpiar</button>
            </div>
          </>
        )}

        {view==='details' && selectedUser && (
          <div className="detail-card">
            <h3>@{selectedUser.tiktokUser}</h3>
            <div className="w-hint">Estado: {selectedUser.status}</div>
            <div className="w-hint">Días restantes: {selectedUser.daysRemaining ?? '-'}</div>
            <div className="w-hint">Expira: {selectedUser.expiresAt ? new Date(selectedUser.expiresAt).toLocaleString() : '-'}</div>
            <div className="w-row" style={{gap:8, marginTop:12}}>
              {selectedUser.status==='disabled'
                ? <button className="w-success" onClick={()=>enableUser(selectedUser.tiktokUser)}>Habilitar</button>
                : <button className="w-btn" onClick={()=>disableUser(selectedUser.tiktokUser)}>Deshabilitar</button>}
              <button className="w-danger" onClick={()=>deleteUser(selectedUser.tiktokUser)}>Eliminar</button>
              <button className="w-btn" onClick={()=>setView('list')}>Volver</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ======================= OVERLAY ======================= */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const room = (q.get('room') || 'demo').trim()
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || DEFAULT_WS
  const WS = sanitizeBaseUrl(RAW_WS)
  const initialTitle = q.get('title') || 'Subasta'
  const autoUser = (q.get('autouser') || '').replace(/^@+/, '').trim()
  const topN = Number(q.get('top') || 3)

  const [state, setState] = useState({ title: initialTitle, endsAt: 0, top: [], donationsTotal: 0 })
  const [now, setNow] = useState(Date.now())
  const [dashboard, setDashboard] = useState(false)
  const [paused, setPaused] = useState(false)
  const [inDelay, setInDelay] = useState(false)
  const [delayEndsAt, setDelayEndsAt] = useState(0)
  const [tInit, setTInit] = useState(60)
  const [delayS, setDelayS] = useState(10)
  const [minEntry, setMinEntry] = useState(20)
  const [editDelta, setEditDelta] = useState(10)
  const [winners, setWinners] = useState([])
  const [totalParticipants, setTotalParticipants] = useState(0)
  const [showWinner, setShowWinner] = useState(false)
  const [currentWinner, setCurrentWinner] = useState(null)
  const socketRef = useRef(null)
  const lastEndsAtRef = useRef(0)

  useEffect(() => {
    console.log('🔌 Conectando a:', WS, 'Room:', room)
    const socket = io(WS, { transports:['websocket', 'polling'], query:{ room } })
    socketRef.current = socket
    socket.on('connect', () => console.log('✅ Conectado'))
    socket.on('disconnect', () => console.log('❌ Desconectado'))
    socket.on('state', st => { console.log('📡 State:', st); setState(prev => ({ ...prev, ...st })) })
    socket.on('donation', d => { console.log('💎 Donación:', d); setState(prev => ({ ...prev, top: d.top, donationsTotal: d.donationsTotal ?? prev.donationsTotal })) })
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
  const delayRemain = Math.max(0, delayEndsAt - now)
  const mm = String(Math.floor((paused ? 0 : (inDelay ? delayRemain : remain)) / 1000 / 60)).padStart(2, '0')
  const ss = String(Math.floor((paused ? 0 : (inDelay ? delayRemain : remain)) / 1000) % 60).padStart(2, '0')

  useEffect(() => {
    if (!paused && !inDelay && remain === 0 && (state.endsAt || 0) > 0 && state.endsAt !== lastEndsAtRef.current) {
      lastEndsAtRef.current = state.endsAt
      const win = state.top?.[0]
      if (win) {
        setCurrentWinner(win)
        setWinners(w => [{ name: win.user, total: win.total }, ...w])
      }
      setInDelay(true)
      setDelayEndsAt(Date.now() + (delayS * 1000))
    }
    if (inDelay && delayRemain === 0 && delayEndsAt > 0) {
      const finalWinner = state.top?.[0]
      if (finalWinner) {
        setCurrentWinner(finalWinner)
        setWinners(w => {
          const newWinners = [...w]
          if (newWinners.length > 0) newWinners[0] = { name: finalWinner.user, total: finalWinner.total }
          return newWinners
        })
      }
      setInDelay(false)
      setDelayEndsAt(0)
      setShowWinner(true)
      setTimeout(() => { setShowWinner(false); setCurrentWinner(null) }, 5000)
    }
    setTotalParticipants(state.top?.length || 0)
  }, [paused, remain, state.endsAt, state.top, inDelay, delayRemain, delayEndsAt, delayS])

  const startAuction = async (seconds) => {
    setPaused(false); setInDelay(false); setDelayEndsAt(0)
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: Math.max(1, Number(seconds)||0), title: state.title })
  }
  const finalizeAuction = async () => {
    setPaused(false); setInDelay(false); setDelayEndsAt(0)
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: 1, title: state.title })
  }
  const addTime = async (plus) => {
    if (inDelay) return
    const next = Math.max(1, Math.floor(remain/1000) + plus)
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: next, title: state.title })
  }

  const getBorderColor = (i) => ['#FFD700','#C0C0C0','#CD7F32','#0ff'][i] || '#0ff'

  return (
    <>
      <button className="gear-floating" onClick={()=>setDashboard(true)}>⚙️</button>

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

      {!showWinner && (
        <div className="panel">
          <div className="panel-container">
            <div className="timer-box">
              {inDelay && <div className="delay-label">⏳ DELAY</div>}
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
      )}

      {dashboard && (
        <div className="dash-wrap" onClick={()=>setDashboard(false)}>
          <div className="dash-card" onClick={e=>e.stopPropagation()}>
            <div className="dash-tabs"><div className="tab active">🎮 Control</div></div>
            <div className="dash-grid">
              <div className="dash-col">
                <div className="box box-blue">
                  <div className="box-header">🏆 GANADORES</div>
                  <div className="box-body list">
                    {winners.length === 0 && <div className="empty">Sin ganadores</div>}
                    {winners.map((w, idx)=>(
                      <div className="winner-row" key={idx}>
                        <div className="w-name">{w.name}</div>
                        <div className="w-total">💰 {w.total}</div>
                      </div>
                    ))}
                  </div>
                  <div className="box-footer">Total: {winners.length}</div>
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
                      <div><label>Tiempo (s):</label><input className="input" type="number" value={tInit} onChange={e=>setTInit(Number(e.target.value)||0)} /></div>
                      <div><label>Delay (s):</label><input className="input" type="number" value={delayS} onChange={e=>setDelayS(Number(e.target.value)||0)} /></div>
                      <div><label>Mínimo:</label><input className="input" type="number" value={minEntry} onChange={e=>setMinEntry(Number(e.target.value)||0)} /></div>
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
  const [ws] = useState(q.get('ws') || import.meta.env.VITE_WS_URL || DEFAULT_WS)

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

        <div className="w-hint">Agrega una captura de ventana de TikTok LIVE Studio del overlay.</div>
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
