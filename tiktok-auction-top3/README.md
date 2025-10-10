# TikTok Auction (Top 3 Overlay) — @sticx33

App de subastas para LIVE de TikTok que muestra **solo donaciones** con **Top 3** y **timer rojo**.

## Estructura
```
tiktok-auction/
 ├─ backend/   # Node + Socket.IO + TikTok live (donaciones)
 └─ overlay/   # React (Vite) — overlay Top 3 con timer
```

## Local (Windows/macOS/Linux)
1) **Backend**
```
cd backend
cp .env.example .env
npm install
npm start
```
- Variables:
```
TIKTOK_USER=sticx33
PORT=3000
```
- Salud: http://localhost:3000/health

2) **Overlay**
```
cd overlay
npm install
npm run dev
```
- Abre: `http://localhost:5173/?ws=http://localhost:3000`

## Cambiar tiempo de subasta
- En la ventana del overlay, presiona **T** y escribe segundos (ej. 120).
- API: `POST /auction/start` con body `{"durationSec":120,"title":"Subasta"}`

## Deploy gratis
- **Backend en Render**: usa `render.yaml` (Blueprint) o Web Service con rootDir `backend`, build `npm install`, start `npm start`, env `TIKTOK_USER`, `PORT`.
- **Overlay en Vercel**: root `overlay`, env `VITE_WS_URL` con la URL pública del backend.

## TikTok Studio
- Agrega Browser/Link Source con la URL del overlay de Vercel:
```
https://<TU_OVERLAY>.vercel.app/?top=3&title=Subasta
```
(o sin params, ya muestra top 3 por defecto).
