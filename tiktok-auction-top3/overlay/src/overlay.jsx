import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css'

/* =================== App (router mínimo por query) =================== */
export default function App() {
  const q = new URLSearchParams(location.search)
  const view = (q.get('view') || '').toLowerCase()
  const room = (q.get('room') || '').trim()

  if (view === 'admin') return <AdminPanel />
  if (view === 'manage') return <ManageLicenses />
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
        } else {
          const error = data?.error || 'invalid'
          if (error === 'license-expired') setMsg('Licencia expirada.')
          else if (error === 'license-revoked') setMsg('Licencia revocada.')
          else setMsg('Código inválido.')
        }
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

/* ======================= ADMIN PANEL (Crear Keys) ======================= */
function AdminPanel() {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = sanitizeBaseUrl(RAW_WS)

  const [pin, setPin] = useState('')
  const [authenticated, setAuthenticated] = useState(false)
  const [adminKey, setAdminKey] = useState('')
  const [months, setMonths] = useState(1)
  const [count, setCount] = useState(5)
  const [result, setResult] = useState(null)
  const [msg, setMsg] = useState('')

  const ADMIN_PIN = '1234'

  const checkPin = (e) => {
    e?.preventDefault?.()
    if (pin === ADMIN_PIN) {
      setAuthenticated(true)
      setMsg('')
    } else {
      setMsg('PIN incorrecto')
    }
  }

  if (!authenticated) {
    return (
      <div className="gate">
        <form className="g-card" onSubmit={checkPin}>
          <div className="g-title">🔒 Panel Admin</div>
          <div className="g-field">
            <input 
              type="password" 
              value={pin} 
              onChange={e=>setPin(e.target.value)} 
              placeholder="Ingresa el PIN" 
            />
          </div>
          {msg && <div className="g-msg">{msg}</div>}
          <div className="g-actions">
            <button className="g-primary" type="submit">Acceder</button>
            <a className="g-ghost" href={`/?ws=${encodeURIComponent(WS)}`}>Volver al Wizard</a>
          </div>
        </form>
      </div>
    )
  }

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
          <input value={adminKey} onChange={e=>setAdminKey(e.target.value)} placeholder="pancacho123" />
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
          <a className="w-success" style={{textAlign:'center'}} href={`/?view=manage&ws=${encodeURIComponent(WS)}`}>Gestionar Licencias</a>
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

        <div className="w-hint" style={{marginTop:20}}>
          <a href={`/?ws=${encodeURIComponent(WS)}`}>← Volver al Wizard</a>
        </div>
      </div>
    </div>
  )
}

/* ======================= GESTOR DE LICENCIAS ======================= */
function ManageLicenses() {
  const q = new URLSearchParams(location.search)
  const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000'
  const WS = sanitizeBaseUrl(RAW_WS)

  const [authenticated, setAuthenticated] = useState(false)
  const [adminKey, setAdminKey] = useState('')
  const [msg, setMsg] = useState('')
  const [view, setView] = useState('dashboard')
  const [stats, setStats] = useState(null)
  const [licenses, setLicenses] = useState([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selectedLicense, setSelectedLicense] = useState(null)

  const checkAuth = async () => {
    try {
      const res = await fetch(`${WS}/admin/stats`, {
        headers: { 'x-admin-key': adminKey }
      })
      if (res.ok) {
        setAuthenticated(true)
        loadStats()
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
      const data = await res.json()
      if (data.ok) setStats(data.stats)
    } catch {}
  }

  const loadLicenses = async () => {
    try {
      const params = new URLSearchParams()
      if (filter !== 'all') params.set('status', filter)
      if (search) params.set('search', search)
      
      const res = await fetch(`${WS}/admin/license/list?${params}`, {
        headers: { 'x-admin-key': adminKey }
      })
      const data = await res.json()
      if (data.ok) setLicenses(data.licenses)
    } catch {}
  }

  const viewDetails = async (key) => {
    try {
      const res = await fetch(`${WS}/admin/license/${key}`, {
        headers: { 'x-admin-key': adminKey }
      })
      const data = await res.json()
      if (data.ok) {
        setSelectedLicense(data.license)
        setView('details')
      }
    } catch {}
  }

  const extendLicense = async (key) => {
    const months = prompt('¿Cuántos meses extender?', '1')
    if (!months) return
    try {
      const res = await fetch(`${WS}/admin/license/${key}/extend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ months: Number(months) })
      })
      if (res.ok) {
        alert(`Extendida por ${months} meses`)
        loadLicenses()
        loadStats()
      }
    } catch {}
  }

  const revokeLicense = async (key) => {
    if (!confirm('¿Revocar esta licencia?')) return
    try {
      const res = await fetch(`${WS}/admin/license/${key}/revoke`, {
        method: 'POST',
        headers: { 'x-admin-key': adminKey }
      })
      if (res.ok) {
        alert('Licencia revocada')
        loadLicenses()
        loadStats()
      }
    } catch {}
  }

  const exportCSV = () => {
    const csv = [
      ['Key', 'Estado', 'Días Restantes', 'Creada', 'Expira', 'Último Uso', 'Usos'].join(','),
      ...licenses.map(l => [
        l.key,
        l.status,
        l.daysRemaining,
        new Date(l.createdAt).toLocaleDateString(),
        new Date(l.expiresAt).toLocaleDateString(),
        l.lastUsed ? new Date(l.lastUsed).toLocaleDateString() : 'Nunca',
        l.usageCount || 0
      ].join(','))
    ].join('\n')
    
    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `licenses_${Date.now()}.csv`
    a.click()
  }

  useEffect(() => {
    if (authenticated && view === 'list') loadLicenses()
  }, [authenticated, view, search, filter])

  if (!authenticated) {
    return (
      <div className="gate">
        <div className="g-card">
          <div className="g-title">🔐 Gestor de Licencias</div>
          <div className="g-field">
            <input 
              type="password"
              value={adminKey}
              onChange={e=>setAdminKey(e.target.value)}
              placeholder="Admin Key (pancacho123)"
              onKeyPress={e => e.key === 'Enter' && checkAuth()}
            />
          </div>
          {msg && <div className="g-msg">{msg}</div>}
          <div className="g-actions">
            <button className="g-primary" onClick={checkAuth}>Acceder</button>
            <a className="g-ghost" href={`/?ws=${encodeURIComponent(WS)}`}>Volver</a>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="manage-panel">
      <div className="manage-header">
        <h1>⚡ Gestor de Licencias</h1>
        <div className="manage-nav">
          <a href={`/?view=admin&ws=${encodeURIComponent(WS)}`} className="nav-link">➕ Crear</a>
          <a href={`/?ws=${encodeURIComponent(WS)}`} className="nav-link">🏠 Inicio</a>
        </div>
      </div>

      <div className="manage-tabs">
        <button className={view === 'dashboard' ? 'tab active' : 'tab'} onClick={()=>{setView('dashboard'); loadStats()}}>
          📊 Dashboard
        </button>
        <button className={view === 'list' ? 'tab active' : 'tab'} onClick={()=>{setView('list'); loadLicenses()}}>
          📋 Todas las Licencias
        </button>
      </div>

      {view === 'dashboard' && stats && (
        <div className="manage-content">
          <div className="stats-grid">
            <div className="stat-card blue">
              <div className="stat-number">{stats.total}</div>
              <div className="stat-label">Total</div>
            </div>
            <div className="stat-card green">
              <div className="stat-number">{stats.active}</div>
              <div className="stat-label">Activas</div>
            </div>
            <div className="stat-card orange">
              <div className="stat-number">{stats.expired}</div>
              <div className="stat-label">Expiradas</div>
            </div>
            <div className="stat-card red">
              <div className="stat-number">{stats.revoked}</div>
              <div className="stat-label">Revocadas</div>
            </div>
            <div className="stat-card purple">
              <div className="stat-number">{stats.activated}</div>
              <div className="stat-label">Activadas</div>
            </div>
          </div>
        </div>
      )}

      {view === 'list' && (
        <div className="manage-content">
          <div className="toolbar">
            <input
              className="search-input"
              placeholder="🔍 Buscar por key o usuario..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select className="filter-select" value={filter} onChange={e => setFilter(e.target.value)}>
              <option value="all">Todas</option>
              <option value="active">Activas</option>
              <option value="expired">Expiradas</option>
              <option value="revoked">Revocadas</option>
            </select>
            <button className="btn-export" onClick={exportCSV}>📥 Exportar</button>
          </div>

          <div className="licenses-table">
            <div className="table-header">
              <div>Key</div>
              <div>Estado</div>
              <div>Días</div>
              <div>Creada</div>
              <div>Último Uso</div>
              <div>Usos</div>
              <div>Acciones</div>
            </div>
            {licenses.map(l => (
              <div className="table-row" key={l.key}>
                <div><code>{l.key}</code></div>
                <div><span className={`badge ${l.status}`}>{l.status}</span></div>
                <div>{l.isExpired ? '⏰ Exp' : `${l.daysRemaining}d`}</div>
                <div>{new Date(l.createdAt).toLocaleDateString()}</div>
                <div>{l.lastUsed ? new Date(l.lastUsed).toLocaleDateString() : '—'}</div>
                <div>{l.usageCount || 0}</div>
                <div className="table-actions">
                  <button className="btn-sm view" onClick={()=>viewDetails(l.key)}>👁️</button>
                  <button className="btn-sm extend" onClick={()=>extendLicense(l.key)}>⏱️</button>
                  <button className="btn-sm revoke" onClick={()=>revokeLicense(l.key)}>🚫</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === 'details' && selectedLicense && (
        <div className="manage-content">
          <button className="btn-back" onClick={()=>setView('list')}>← Volver</button>
          <h2>Detalles de Licencia</h2>
          <div className="detail-card">
            <div className="detail-row">
              <strong>Key:</strong>
              <code>{selectedLicense.key}</code>
            </div>
            <div className="detail-row">
              <strong>Estado:</strong>
              <span className={`badge ${selectedLicense.status}`}>{selectedLicense.status}</span>
            </div>
            <div className="detail-row">
              <strong>Días restantes:</strong>
              {selectedLicense.daysRemaining}
            </div>
            <div className="detail-row">
              <strong>Creada:</strong>
              {new Date(selectedLicense.createdAt).toLocaleString()}
            </div>
            <div className="detail-row">
              <strong>Expira:</strong>
              {new Date(selectedLicense.expiresAt).toLocaleString()}
            </div>
            <div className="detail-row">
              <strong>Activada:</strong>
              {selectedLicense.activatedAt ? new Date(selectedLicense.activatedAt).toLocaleString() : 'No activada'}
            </div>
            <div className="detail-row">
              <strong>Último uso:</strong>
              {selectedLicense.lastUsed ? new Date(selectedLicense.lastUsed).toLocaleString() : 'Nunca'}
            </div>
            <div className="detail-row">
              <strong>Usos totales:</strong>
              {selectedLicense.usageCount || 0}
            </div>
          </div>
        </div>
      )}
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
          if (newWinners.length > 0) {
            newWinners[0] = { name: finalWinner.user, total: finalWinner.total }
          }
          return newWinners
        })
      }
      
      setInDelay(false)
      setDelayEndsAt(0)
      setShowWinner(true)
      
      setTimeout(() => {
        setShowWinner(false)
        setCurrentWinner(null)
      }, 5000)
    }
    
    setTotalParticipants(state.top?.length || 0)
  }, [paused, remain, state.endsAt, state.top, inDelay, delayRemain, delayEndsAt, delayS])

  const startAuction = async (seconds) => {
    const s = Math.max(1, Number(seconds)||0)
    setPaused(false)
    setInDelay(false)
    setDelayEndsAt(0)
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: s, title: state.title })
  }
  
  const finalizeAuction = async () => {
    setPaused(false)
    setInDelay(false)
    setDelayEndsAt(0)
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: 1, title: state.title })
  }
  
  const addTime = async (plus) => {
    if (inDelay) return
    const remainS = Math.max(0, Math.floor(remain/1000))
    const next = Math.max(1, remainS + plus)
    await postJSON(`${WS}/${room}/auction/start`, { durationSec: next, title: state.title })
  }

  const getBorderColor = (index) => {
    if (index === 0) return '#FFD700'
    if (index === 1) return '#C0C0C0'
    if (index === 2) return '#CD7F32'
    return '#0ff'
  }

  return (
    <>
      <button className="gear-floating" title="Abrir panel de control" onClick={()=>setDashboard(true)}>⚙️</button>

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

      {!showWinner && (
        <div className="panel">
          <div className="panel-container">
            <div className="timer-box">
              {inDelay && <div className="delay-label">⏳ TIEMPO DE DELAY</div>}
              <div className="timer">{mm}:{ss}</div>
            </div>
            <div className="board">
              {state.top.slice(0, topN).map((d, i) => (
                <div className="row" key={d.user + i} style={{borderColor: getBorderColor(i)}}>
                  <div className={`badge ${i===1 ? 'silver' : i===2 ? 'bronze' : ''}`}>{i+1}</div>
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
                    Total Participantes: {total
