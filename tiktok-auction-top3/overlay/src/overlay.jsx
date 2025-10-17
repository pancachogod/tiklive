import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import './style.css'

/* ======================== HELPERS ======================== */
function sanitizeBaseUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '')
}

async function postJSON(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await r.text()
  const data = text ? JSON.parse(text) : {}
  return { ok: r.ok, status: r.status, data }
}

function randomRoom() {
  return 'room-' + Math.random().toString(36).slice(2, 7)
}

/* ======================== LICENSE GATE ======================== */
function LicenseGate({ children }) {
  const q = new URLSearchParams(location.search)
  const RAW_WS = 'https://tiklive-63mk.onrender.com'
  const WS = sanitizeBaseUrl(RAW_WS)

  const [checking, setChecking] = useState(true)
  const [ok, setOk] = useState(false)
  const [key, setKey] = useState(q.get('key') || localStorage.getItem('LIC_KEY') || '')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    (async () => {
      const k = (q.get('key') || localStorage.getItem('LIC_KEY') || '').trim()
      if (!k) {
        setChecking(false)
        setOk(false)
        return
      }
      try {
        const { ok: httpOK, data } = await postJSON(`${WS}/license/verify`, { key: k })
        if (httpOK && data?.ok) {
          localStorage.setItem('LIC_KEY', k)
          setOk(true)
        } else {
          setOk(false)
        }
      } catch {
        setOk(false)
      } finally {
        setChecking(false)
      }
    })()
  }, [WS])

  if (checking) {
    return (
      <div className="gate">
        <div className="g-card">
          <div className="g-title">Verificando licencia…</div>
        </div>
      </div>
    )
  }

  if (ok) return children

  const redeem = async (e) => {
    e?.preventDefault?.()
    setMsg('')
    const k = key.trim()
    if (!k) {
      setMsg('Ingresa tu código.')
      return
    }

    setBusy(true)
    try {
      const { ok: httpOK, data } = await postJSON(`${WS}/license/verify`, { key: k })
      if (httpOK && data?.ok) {
        localStorage.setItem('LIC_KEY', k)
        setOk(true)
      } else {
        setMsg('Código inválido o vencido.')
      }
    } catch {
      setMsg('No se pudo contactar con el servidor.')
    } finally {
      setBusy(false)
    }
  }

  const goTelegram = () => window.open('https://t.me/+ae-ctGPi8sM1MTYx', '_blank')

  return (
    <div className="gate">
      <form className="g-card" onSubmit={redeem}>
        <div className="g-title">Canjear código</div>

        <div className="g-field">
          <input
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Pega tu código aquí"
            disabled={busy}
          />
        </div>

        {msg && <div className="g-msg">{msg}</div>}

        <div className="g-actions">
          <button className="g-primary" type="submit" disabled={busy}>
            {busy ? 'Validando…' : 'Canjear'}
          </button>
          <button type="button" className="g-ghost" onClick={goTelegram} disabled={busy}>
            Obtener membresía
          </button>
        </div>

        <div className="g-hint">¿No tienes un código? Pulsa “Obtener membresía”.</div>
      </form>
    </div>
  )
}

/* ======================== ADMIN PANEL ======================== */
function AdminPanel() {
  const WS = 'https://tiklive-63mk.onrender.com'
  const [adminKey, setAdminKey] = useState('')
  const [months, setMonths] = useState(1)
  const [count, setCount] = useState(5)
  const [result, setResult] = useState(null)
  const [msg, setMsg] = useState('')

  const issue = async () => {
    setMsg('')
    try {
      const res = await fetch(`${WS}/admin/license/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey },
        body: JSON.stringify({ months, count }),
      })
      const j = await res.json()
      if (!j.ok) {
        setMsg(j.error || 'No autorizado')
        setResult(null)
        return
      }
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
          <input
            value={adminKey}
            onChange={(e) => setAdminKey(e.target.value)}
            placeholder="Tu clave de admin"
          />
        </div>

        <div className="w-field">
          <label>Meses de validez</label>
          <input
            type="number"
            min="1"
            max="12"
            value={months}
            onChange={(e) => setMonths(Number(e.target.value))}
          />
        </div>

        <div className="w-field">
          <label>Cantidad de llaves</label>
          <input
            type="number"
            min="1"
            max="100"
            value={count}
            onChange={(e) => setCount(Number(e.target.value))}
          />
        </div>

        <div className="w-actions">
          <button className="w-primary" onClick={issue}>
            Generar
          </button>
        </div>

        {msg && <div className="w-hint" style={{ color: '#ff6' }}>{msg}</div>}

        {result?.ok && (
          <div className="w-field">
            <label>Keys generadas</label>
            <div className="keys">
              {result.keys.map((k, idx) => (
                <div key={idx} className="keyrow">
                  <code className="keytxt">{k.key}</code>
                  <button className="w-btn" onClick={() => navigator.clipboard.writeText(k.key)}>
                    Copiar
                  </button>
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

/* ======================== ROOM WIZARD (sin backend visible) ======================== */
function RoomWizard() {
  const [room, setRoom] = useState(randomRoom())
  const ws = 'https://tiklive-63mk.onrender.com' // fijo
  const [top, setTop] = useState(3)
  const [user, setUser] = useState('')

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

  const openOverlay = () => { location.href = makeUrl() }
  const copyLink = async () => {
    const link = makeUrl()
    try { await navigator.clipboard.writeText(link); alert('Link copiado:\n' + link) }
    catch { prompt('Copia el link:', link) }
  }

  return (
    <div className="wizard">
      <div className="w-card">
        <h2>Crear mi sala de subasta</h2>

        <div className="w-field">
          <label>Nombre de sala (room)</label>
          <div className="w-row">
            <input value={room} onChange={(e) => setRoom(e.target.value)} placeholder="miSala123" />
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
          <label>Usuario de TikTok (opcional, sin @)</label>
          <input
            value={user}
            onChange={(e) => setUser(e.target.value)}
            placeholder="sticx33"
          />
        </div>

        <div className="w-actions">
          <button className="w-primary" onClick={openOverlay}>Abrir overlay</button>
          <button className="w-success" onClick={copyLink}>Copiar link</button>
        </div>

        <div className="w-hint">
          Pega el link en <b>Browser Source</b> o usa <b>Captura de ventana</b> en OBS / TikTok Live Studio.
        </div>
      </div>
    </div>
  )
}

/* ======================== OVERLAY ======================== */
function AuctionOverlay() {
  const q = useMemo(() => new URLSearchParams(location.search), [])
  const room = (q.get('room') || 'demo').trim()
  const RAW_WS = 'https://tiklive-63mk.onrender.com'
  const WS = sanitizeBaseUrl(RAW_WS)
  const topN = Number(q.get('top') || 3)
  const autoUser = (q.get('autouser') || '').replace(/^@+/, '').trim()

  const [state, setState] = useState({ endsAt: 0, top: [] })
  const [now, setNow] = useState(Date.now())
  const [modal, setModal] = useState(null)

  useEffect(() => {
    const socket = io(WS, { transports: ['websocket'], query: { room } })
    socket.on('state', (st) => setState((prev) => ({ ...prev, ...st })))
    socket.on('donation', (d) => setState((prev) => ({ ...prev, top: d.top })))
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
      if (winner) setModal({ user: winner.user, total: winner.total })
    }
  }, [remain, state.endsAt, state.top])

  useEffect(() => {
    (async () => {
      if (!autoUser) return
      try {
        await fetch(`${WS}/${room}/user`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user: autoUser }),
        })
      } catch {}
    })()
  }, [autoUser, WS, room])

  return (
    <>
      <div className="panel">
        <div className="timer">{mm}:{ss}</div>

        <div className="board">
          {state.top.slice(0, topN).map((d, i) => (
            <div className="row" key={d.user + i}>
              <div className={`badge ${i===1 ? 'silver' : i===2 ? 'bronze' : ''}`}>{i + 1}</div>
              <img className="avatar" src={d.avatar || ''} alt="" />
              <div className="name" title={d.user}>{d.user}</div>
              <div className="coin">{d.total}</div>
            </div>
          ))}
        </div>
      </div>

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
            <button className="win-close" onClick={() => setModal(null)}>Cerrar</button>
          </div>
        </div>
      )}
    </>
  )
}

/* ======================== APP DECIDER ======================== */
function App() {
  const q = new URLSearchParams(location.search)
  if (q.get('admin')) return <AdminPanel />
  const room = (q.get('room') || '').trim()
  if (!room) return <RoomWizard />
  return (
    <LicenseGate>
      <AuctionOverlay />
    </LicenseGate>
  )
}

export default App
