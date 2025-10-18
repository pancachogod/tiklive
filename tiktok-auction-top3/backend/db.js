// backend/db.js
// -----------------------------------------------------------------------------
// Conexión robusta a PostgreSQL (Supabase/Render)
// - Fuerza IPv4 (evita ENETUNREACH por IPv6)
// - SSL para Supabase (?sslmode=require)
// - Un solo Pool reutilizable
// - Helpers: query(), testDb(), initDb()
// -----------------------------------------------------------------------------

import { Pool } from 'pg'
import dns from 'dns/promises'

const raw = process.env.DATABASE_URL
if (!raw) {
  throw new Error('DATABASE_URL no configurada')
}

// Parseamos la URL
const url = new URL(raw)

// ¿La URL pide SSL?
const sslRequired = (url.searchParams.get('sslmode') || '').toLowerCase() === 'require'

// Forzamos IPv4 resolviendo el hostname a su A record (si falla, continúa con el hostname)
let host = url.hostname
try {
  const { address } = await dns.lookup(url.hostname, { family: 4 })
  host = address
} catch {
  // Si no se pudo resolver a IPv4 aquí, igual el NODE_OPTIONS=--dns-result-order=ipv4first
  // en Render ayudará. Continuamos con el hostname.
}

// Construimos el Pool manualmente para inyectar el host IPv4 cuando esté disponible
export const pool = new Pool({
  host,
  port: Number(url.port || 5432),
  database: url.pathname.replace(/^\//, '') || 'postgres',
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  ssl: sslRequired ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 8_000,
})

// Log básico de errores del pool (útil en Render)
pool.on('error', (err) => {
  console.error('PG Pool error:', err)
})

// Helper simple para consultas
export const query = (text, params) => pool.query(text, params)

// Ping de prueba
export async function testDb() {
  await pool.query('select 1')
}

// Migración/creación mínima de ejemplo
export async function initDb() {
  // Crea la tabla base de usuarios para el panel admin
  await pool.query(`
    create table if not exists users (
      id serial primary key,
      tiktok_user text unique not null,
      status text not null default 'active',           -- active | disabled
      expires_at timestamptz                           -- fecha de expiración de acceso
    );
  `)

  // Índices útiles
  await pool.query(`create index if not exists idx_users_status on users(status);`)
  await pool.query(`create index if not exists idx_users_expires_at on users(expires_at);`)
}
