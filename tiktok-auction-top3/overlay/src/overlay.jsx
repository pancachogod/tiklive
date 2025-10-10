import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io } from 'socket.io-client'

export default function Overlay(){
  const q = useMemo(() => new URLSearchParams(location.search), []);
  const WS = q.get('ws') || import.meta.env.VITE_WS_URL || 'http://localhost:3000';

  const [state, setState] = useState({
    title: 'Subasta',
    endsAt: 0,
    top: []
  });

  const socketRef = useRef(null);

  useEffect(()=>{
    const socket = io(WS, { transports: ['websocket'] });
    socketRef.current = socket;
    socket.on('state', st => setState(prev => ({...prev, ...st})));
    socket.on('donation', d => setState(prev => ({...prev, top: d.top})));
    return ()=> socket.close();
  }, [WS]);

  const [now, setNow] = useState(Date.now());
  useEffect(()=>{
    const id = setInterval(()=>setNow(Date.now()), 200);
    return ()=> clearInterval(id);
  }, []);
  const remain = Math.max(0, (state.endsAt||0) - now);
  const mm = String(Math.floor(remain/1000/60)).padStart(2,'0');
  const ss = String(Math.floor(remain/1000)%60).padStart(2,'0');

  useEffect(()=>{
    const onKey = async (e)=>{
      if(e.key.toLowerCase() === 't'){
        const v = Number(prompt('Duración en segundos (ej. 120):') || 0);
        if(v>0){
          await fetch(`${WS}/auction/start`, {
            method:'POST',
            headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ durationSec: v, title: state.title })
          });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return ()=> window.removeEventListener('keydown', onKey);
  }, [WS, state.title]);

  return (
    <div className="panel">
      <div className="timer">{mm}:{ss}</div>
      {state.top.slice(0,3).map((d, i)=>(
        <div className="row" key={d.user+i}>
          <div className={`badge ${i===1?'silver': i===2?'bronze':''}`}>{i+1}</div>
          <img className="avatar" src={d.avatar || ''} alt="" />
          <div className="name" title={d.user}>{d.user}</div>
          <div className="coin">{d.total}</div>
        </div>
      ))}
    </div>
  )
}
