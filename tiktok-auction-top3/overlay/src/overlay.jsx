import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css'

const DEFAULT_WS = 'https://tiklive-production.up.railway.app'

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

/* ==== Verificación de usuario ==== */
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
          else if (error === 'user-not-found') setMsg('Usuario no encontrado. Contacta al administrador.')
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
// (tu AdminPanel tal como lo tenías — sin cambios funcionales, usa WS + x-admin-key)

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
      const res = await fetch(`${WS}/admin/stats`, { headers: { 'x-admin-key': adminKey } })
      if (res.ok) { setAuthenticated(true); await loadStats() } else { setMsg('Admin Key incorrecta') }
    } catch { setMsg('Error de conexión') }
  }

  const loadStats = async () => {
    try {
      const res = await fetch(`${WS}/admin/stats`, { headers: { 'x-admin-key': adminKey } })
      const data = await res.json().catch(()=>({}))
      if (data?.ok) setStats(data.stats)
    } catch {}
  }

  const loadUsers = async () => {
    try {
      const params = new URLSearchParams()
      if (filter !== 'all') params.set('status', filter)
      if (search) params.set('search', search)
      const res = await fetch(`${WS}/admin/user/list?${params.toString()}`, { headers: { 'x-admin-key': adminKey } })
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
        setNewUser(''); setDays(30); loadStats(); if (view==='list') loadUsers()
      } else { setMsg(data?.error || 'Error') }
    } catch { setMsg('Error de red') }
  }

  const viewDetails = async (tiktokUser) => {
    try {
      const res = await fetch(`${WS}/admin/user/${tiktokUser}`, { headers: { 'x-admin-key': adminKey } })
      const data = await res.json().catch(()=>({}))
      if (data?.ok) { setSelectedUser(data.user); setView('details') }
    } catch {}
  }

  const disableUser = async (tiktokUser) => {
    if (!confirm(`¿Desactivar a @${tiktokUser}?`)) return
    try {
      const res = await fetch(`${WS}/admin/user/${tiktokUser}/disable`, { method: 'POST', headers: { 'x-admin-key': adminKey } })
      if (res.ok) { alert('Usuario desactivado'); if (view==='details') viewDetails(tiktokUser); if (view==='list') loadUsers(); loadStats() }
    } catch {}
  }

  const enableUser = async (tiktokUser) => {
    try {
      const res = await fetch(`${WS}/admin/user/${tiktokUser}/enable`, { method: 'POST', headers: { 'x-admin-key': adminKey } })
      if (res.ok) { alert('Usuario reactivado'); if (view==='details') viewDetails(tiktokUser); if (view==='list') loadUsers(); loadStats() }
    } catch {}
  }

  const deleteUser = async (tiktokUser) => {
    if (!confirm(`¿Eliminar a @${tiktokUser}? Esta acción no se puede deshacer.`)) return
    try {
      const res = await fetch(`${WS}/admin/user/${tiktokUser}/delete`, { method: 'POST', headers: { 'x-admin-key': adminKey } })
      if (res.ok) { alert('Usuario eliminado'); if (view==='details') { setView('list'); setSelectedUser(null) } loadUsers(); loadStats() }
    } catch {}
  }

  if (!authenticated) {
    return (
      <div className="gate">
        <form className="g-card" onSubmit={checkAuth}>
          <div className="g-title">🔒 Panel Admin</div>
          <div className="g-subtitle">Backend: {WS}</div>
          <div className="g-field">
            <input type="password" value={adminKey} onChange={e=>setAdminKey(e.target.value)} placeholder="ADMIN_KEY" />
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
      {/* … el resto de tu UI tal como lo tenías (lista/activar/detalles) … */}
      <div className="w-card" style={{maxWidth: 940}}>
        <h2>Admin Panel</h2>
        {/* tabs + vistas exactamente como tu versión */}
      </div>
    </div>
  )
}

/* ======================= OVERLAY (AuctionOverlay) + Wizard ======================= */
/* — Usa tu componente tal como lo tenías; no lo repito entero por espacio.
   Asegúrate que use:
   - const RAW_WS = q.get('ws') || import.meta.env.VITE_WS_URL || DEFAULT_WS
   - sanitizeBaseUrl agrega https:// si falta
*/

function RoomWizard() {
  const q = new URLSearchParams(location.search)
  const [room, setRoom] = useState('room-' + Math.random().toString(36).slice(2,7))
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
        {/* campos y acciones como ya tienes */}
      </div>
    </div>
  )
}

/* ======================= Helpers ======================= */
function sanitizeBaseUrl(u){
  let s = String(u||'').trim().replace(/\/+$/,'')
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  return s
}
async function postJSON(url, body){
  const r = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body ?? {}) })
  const text = await r.text(); return { ok: r.ok, status: r.status, data: text ? JSON.parse(text) : {} }
}
