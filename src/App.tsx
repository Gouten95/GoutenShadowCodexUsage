import RingGraphic from "./RingGraphic"
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, isTauri } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { isEnabled, enable, disable } from '@tauri-apps/plugin-autostart'
import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'
import './App.css'

type WindowLimit = { usedPercent: number; windowDurationMins: number; resetsAt: number | null }
type Bucket = { limitId: string; limitName: string | null; primary: WindowLimit | null; secondary: WindowLimit | null }
type Result = { rateLimits: Bucket | null; rateLimitsByLimitId?: Record<string, Bucket> | null }
type Theme = 'default' | 'green' | 'red' | 'blue' | 'purple' | 'gold' | 'rgb'
type Settings = { interval: number; alert: number; notifications: boolean; theme: Theme; floating: boolean; floatingOpacity: number }
const defaults: Settings = { interval: 3, alert: 10, notifications: false, theme: 'default', floating: false, floatingOpacity: 100 }
const themes: { id: Theme; label: string }[] = [{id:'default',label:'Original'},{id:'green',label:'Verde'},{id:'red',label:'Rojo'},{id:'blue',label:'Azul'},{id:'purple',label:'Morado'},{id:'gold',label:'Dorado'},{id:'rgb',label:'RGB'}]
function initialSettings(): Settings { try { return { ...defaults, ...JSON.parse(localStorage.getItem('usage-settings') || '{}') } } catch { return defaults } }
function remaining(w: WindowLimit) { return Math.max(0, Math.min(100, 100 - w.usedPercent)) }
// El matiz se desplaza suavemente desde rojo (vacío) hasta verde (lleno).
function usageColor(percent: number) { return `hsl(${Math.round(Math.max(0, Math.min(100, percent)) * 1.2)} 100% 60%)` }
const usageGradient = 'linear-gradient(90deg, #ff335c 0%, #ff8533 25%, #fff43d 50%, #6dff35 75%, #39ff94 100%)'
function duration(minutes: number) { if (minutes === 10080) return 'semanal'; if (minutes % 1440 === 0) return `de ${minutes / 1440} ${minutes === 1440 ? 'día' : 'días'}`; if (minutes % 60 === 0) return `de ${minutes / 60} h`; return `de ${minutes} min` }
function resetText(ts: number | null) { if (!ts) return 'Hora de reinicio no disponible'; return new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ts * 1000)) }
function until(ts: number | null, now: number) { if (!ts) return ''; const m = Math.max(0, Math.ceil((ts * 1000 - now) / 60000)); return m < 60 ? `En ${m} min` : m < 1440 ? `En ${Math.floor(m / 60)} h ${m % 60} min` : `En ${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h` }
type Snapshot = { data: Result; updated: number; stale?: boolean }
function useSharedSettings() {
 const [settings, setSettings] = useState(initialSettings)
 useEffect(() => {
  document.documentElement.dataset.theme = settings.theme
  document.documentElement.style.setProperty('--surface-opacity', `${Math.max(20, Math.min(100, Number(settings.floatingOpacity) || 100))}%`)
 }, [settings.theme, settings.floatingOpacity])
 useEffect(() => {
  const change = (e: StorageEvent) => { if (e.key === 'usage-settings') setSettings(initialSettings()) }
  window.addEventListener('storage', change)
  return () => window.removeEventListener('storage', change)
 }, [])
 return [settings, setSettings] as const
}
function useSnapshot() {
 const [snapshot, setSnapshot] = useState<Snapshot | null>(() => { try { return JSON.parse(localStorage.getItem('usage-snapshot') || 'null') } catch { return null } })
 useEffect(() => { const change = (e: StorageEvent) => { if(e.key === 'usage-snapshot' && e.newValue) { try { setSnapshot(JSON.parse(e.newValue)) } catch { /* ignore invalid data */ } } }; window.addEventListener('storage',change); return () => window.removeEventListener('storage',change) }, [])
 return snapshot
}
function Peek({ floating = false }: { floating?: boolean }) {
 const snapshot = useSnapshot()
 useSharedSettings()
 const dragged = useRef(false)
 const dragState = useRef<{ startX:number; startY:number; origin:Promise<PhysicalPosition>; lastX:number; lastY:number; pending:boolean } | null>(null)
 const [compact, setCompact] = useState(() => localStorage.getItem('floating-compact') === 'true')
 useEffect(() => {
  if (!floating || !isTauri()) return
  let size: { width: number; height: number } | null = null
  try { size = JSON.parse(localStorage.getItem(`floating-size-${compact ? 'compact' : 'expanded'}`) || 'null') } catch { /* use defaults */ }
  void invoke('set_floating_compact', { compact, width: size?.width ?? null, height: size?.height ?? null }).catch(() => {})
 }, [compact, floating])
 function rememberSize(mode: boolean) { localStorage.setItem(`floating-size-${mode ? 'compact' : 'expanded'}`, JSON.stringify({width:window.innerWidth,height:window.innerHeight})) }
 useEffect(() => {
  if (!floating) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => { clearTimeout(timer); timer = setTimeout(() => rememberSize(compact), 400) })
  observer.observe(document.documentElement)
  return () => { clearTimeout(timer); observer.disconnect() }
 }, [compact, floating])
 function toggleCompact() {
  rememberSize(compact)
  setCompact(previous => {
   localStorage.setItem('floating-compact', String(!previous))
   return !previous
  })
 }
 function startMove(event: React.PointerEvent<HTMLDivElement>) {
  if (!floating || !isTauri() || event.button !== 0 || (event.target as Element).closest('button, [data-tauri-drag-region]')) return
  dragged.current = false
  event.currentTarget.setPointerCapture(event.pointerId)
  dragState.current = { startX:event.screenX, startY:event.screenY, origin:getCurrentWindow().outerPosition(), lastX:event.screenX, lastY:event.screenY, pending:false }
 }
 function moveWindow(event: React.PointerEvent<HTMLDivElement>) {
  const drag = dragState.current
  if (!drag) return
  drag.lastX = event.screenX; drag.lastY = event.screenY
  if (!dragged.current && Math.hypot(event.screenX - drag.startX, event.screenY - drag.startY) < 5) return
  dragged.current = true
  if (drag.pending) return
  drag.pending = true
  void (async () => {
   try {
    const origin = await drag.origin
    // Coalesce rapid pointer events while respecting the display's scale factor.
    while (true) {
     const x = drag.lastX, y = drag.lastY
     await getCurrentWindow().setPosition(new PhysicalPosition(Math.round(origin.x + (x - drag.startX) * window.devicePixelRatio), Math.round(origin.y + (y - drag.startY) * window.devicePixelRatio)))
     if (x === drag.lastX && y === drag.lastY) break
    }
   } catch { /* conservamos la última posición válida */ }
   finally { drag.pending = false }
  })()
 }
 function finishMove() { dragState.current = null }
 async function closeFloating() {
  try { await invoke('set_floating_visible', { visible: false }); localStorage.setItem('usage-settings',JSON.stringify({...initialSettings(), floating:false})) } catch { /* la vista sigue disponible si no se pudo ocultar */ }
 }
 const b = snapshot?.data.rateLimitsByLimitId?.codex || snapshot?.data.rateLimits
 const windows = [b?.primary,b?.secondary].filter((w): w is WindowLimit => !!w && (w.windowDurationMins === 300 || w.windowDurationMins === 10080)).sort((a,b)=>a.windowDurationMins-b.windowDurationMins)
 const close = floating && <button className="floating-close" aria-label="Cerrar ventana flotante" title="Cerrar ventana flotante" onClick={event => { event.stopPropagation(); void closeFloating() }}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
 const adjustSize = (delta: number, event: React.MouseEvent) => { event.stopPropagation(); void invoke('adjust_floating_size', { compact, delta }).catch(() => {}) }
 const sizeButtons = floating && <span className="size-buttons" onClick={event => event.stopPropagation()}><button aria-label="Reducir tamaño de ventana" title="Reducir tamaño" onClick={event => adjustSize(-1,event)}>−</button><button aria-label="Aumentar tamaño de ventana" title="Aumentar tamaño" onClick={event => adjustSize(1,event)}>+</button></span>
 const resize = floating && <button className="floating-resize" aria-label="Cambiar tamaño de ventana" title="Arrastrar para cambiar tamaño" onClick={event => event.stopPropagation()} onPointerDown={event => { event.stopPropagation(); if (event.button === 0 && isTauri()) void getCurrentWindow().startResizeDragging('SouthEast') }}>◢</button>
 const toggle = floating && <button className="floating-toggle" aria-label={compact ? 'Ampliar ventana' : 'Reducir ventana'} title={compact ? 'Ampliar ventana' : 'Reducir ventana'} onClick={event => { event.stopPropagation(); toggleCompact() }}>{compact ? '⛶' : '⊟'}</button>
 const grip = floating && <span className="floating-grip" data-tauri-drag-region title="Arrastrar ventana" aria-label="Arrastrar ventana" onClick={event => event.stopPropagation()}>⠿</span>
 const cardProps = floating ? { role:'button' as const, tabIndex:0, onPointerDown:startMove, onPointerMove:moveWindow, onPointerUp:finishMove, onPointerCancel:finishMove, onClick:() => { if (dragged.current) { dragged.current = false; return } toggleCompact() }, onKeyDown:(event: React.KeyboardEvent) => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleCompact() } }, 'aria-label':compact ? 'Ampliar ventana de consumo' : 'Reducir ventana de consumo' } : {}
 if (floating && compact) return <div className="peek floating compact" {...cardProps}>
  <div className="compact-controls">{grip}{sizeButtons}{toggle}{close}</div>
  <div className="compact-rings">{windows.length ? windows.map(w => {
   const value = remaining(w)
   return <div className="ring-item" key={w.windowDurationMins} title={snapshot?.stale ? 'Sin conexión: última lectura' : undefined} aria-label={`${w.windowDurationMins === 300 ? '5 horas' : 'Semanal'}: ${Math.round(value)}% disponible${snapshot?.stale ? ' (última lectura, sin conexión)' : ''}`}>
    <div className="ring">
     <RingGraphic value={value} color={usageColor(value)} />
     <div className="ring-reading">
      <strong className="ring-value">{Math.round(value)}<small>%</small></strong>
      <span className="ring-caption">{w.windowDurationMins === 300 ? '5 H' : 'SEM'}</span>
     </div>
    </div>
   </div>
  }) : <span className="compact-wait">Esperando datos…</span>}</div>{resize}
 </div>
 return <div className={`peek ${floating ? 'floating' : ''}`} {...cardProps}><div className="peek-head">{grip}<span className="peek-logo"><img src="/dragon.png" alt="" /></span><div><strong>GoutenShadow Codex Usage</strong><small>USO DISPONIBLE</small></div>{sizeButtons}{toggle}{close}</div>{windows.length ? windows.map(w=><div className="peek-row" key={w.windowDurationMins}><div className="peek-label"><strong>{w.windowDurationMins === 300 ? '5 horas' : 'Esta semana'}</strong><small>Reinicio: {resetText(w.resetsAt)}</small></div><div className="peek-number">{Math.round(remaining(w))}<small>%</small></div></div>) : <p className="peek-wait">Esperando datos de Codex…</p>}<div className="peek-footer"><i/> {snapshot?.stale ? 'Última lectura · sin conexión' : snapshot ? `Actualizado ${new Intl.DateTimeFormat('es-MX',{timeStyle:'short'}).format(snapshot.updated)}` : 'Conectando…'}</div>{floating && <span className="resize-hint">Clic para reducir</span>}{resize}</div>
}
function App() {
 const [settings,setSettings]=useSharedSettings(); const [data,setData]=useState<Result | null>(null); const [error,setError]=useState(''); const [updated,setUpdated]=useState<number | null>(null); const [loading,setLoading]=useState(false); const [showSettings,setShowSettings]=useState(false); const [auto,setAuto]=useState(false); const [now,setNow]=useState(Date.now()); const busy=useRef(false); const notified=useRef<Record<string,number>>({});
 const refresh=useCallback(async()=>{ if(busy.current)return; busy.current=true;setLoading(true); try { if(!isTauri()) throw new Error('Abre la aplicación de escritorio para conectar con Codex.'); const result=await invoke<Result>('read_usage'); const buckets=Object.values(result.rateLimitsByLimitId || {}); if(!buckets.length && result.rateLimits) buckets.push(result.rateLimits); const windows=buckets.flatMap(b=>[b.primary,b.secondary]).filter((w): w is WindowLimit => !!w && Number.isFinite(w.usedPercent)); if (!windows.length) throw new Error('Codex no devolvió límites para esta cuenta. Comprueba que iniciaste sesión con ChatGPT.'); setData(result);setUpdated(Date.now());setError(''); const stamp=Date.now(); localStorage.setItem('usage-snapshot',JSON.stringify({data:result,updated:stamp})); if(settings.notifications) { for(const b of buckets) for(const w of [b.primary,b.secondary]) { if(!w || remaining(w)>settings.alert) continue; const key=`${b.limitId}-${w.windowDurationMins}`; if(notified.current[key]===w.resetsAt)continue; let granted=await isPermissionGranted(); if(!granted) granted=(await requestPermission())==='granted'; if(granted) { sendNotification({title:'Codex: uso disponible bajo',body:`Queda ${Math.round(remaining(w))}% del límite ${duration(w.windowDurationMins)}.`});notified.current[key]=w.resetsAt ?? 0 } } } } catch(e) {setError(String(e)); try { const old=JSON.parse(localStorage.getItem('usage-snapshot') || 'null'); if(old) localStorage.setItem('usage-snapshot',JSON.stringify({...old,stale:true})) } catch { /* ignore invalid cache */ }} finally {busy.current=false;setLoading(false)} },[settings.notifications,settings.alert]);
 useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),settings.interval*60000);return()=>clearInterval(timer)},[refresh,settings.interval]);
 useEffect(()=>{localStorage.setItem('usage-settings',JSON.stringify(settings))},[settings]);
 useEffect(() => {
  if (!isTauri()) return
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const updateVisibility = async (attempt: number) => {
   try { await invoke('set_floating_visible', { visible: settings.floating }) }
   catch {
    if (cancelled) return
    if (attempt < 8) timer = setTimeout(() => void updateVisibility(attempt + 1), 250)
    else setError('No se pudo cambiar la ventana flotante.')
   }
  }
  void updateVisibility(0)
  return () => { cancelled = true; clearTimeout(timer) }
 }, [settings.floating]);
 useEffect(()=>{const t=setInterval(()=>setNow(Date.now()),30000); if(isTauri()) void isEnabled().then(setAuto).catch(()=>{});return()=>clearInterval(t)},[]);
 const buckets=data ? Object.values(data.rateLimitsByLimitId || {}) : []; if(data && buckets.length===0 && data.rateLimits) buckets.push(data.rateLimits);
 async function toggleAuto(value:boolean){ try { if(value) await enable();else await disable();setAuto(value) }catch{setError('No se pudo cambiar el inicio automático en este equipo.')} }
 return <main><header><div className="brand"><div className="logo"><img src="/dragon.png" alt="" /></div><div><div className="eyebrow">TU PANEL DE USO</div><h1>GoutenShadow<br />Codex Usage</h1><div className="subtitle">ChatGPT · Codex</div></div></div><button className="icon-button" aria-label="Configuración" onClick={()=>setShowSettings(!showSettings)}>⚙</button></header>
 {showSettings ? <section className="settings"><div className="section-heading"><h2>Configuración</h2><button className="text-button" onClick={()=>setShowSettings(false)}>Listo</button></div><div className="theme-field"><span>Tema de colores</span><div className="theme-grid">{themes.map(theme => <button key={theme.id} type="button" aria-pressed={settings.theme===theme.id} className={`theme-option theme-${theme.id}`} onClick={()=>setSettings({...settings,theme:theme.id})}><span className="theme-swatch"/>{theme.label}</button>)}</div></div><label className="switch-row">Ventana flotante siempre visible<input type="checkbox" checked={settings.floating} onChange={e=>setSettings({...settings,floating:e.target.checked})}/></label><p className="setting-note">Arrastra desde cualquier zona para moverla; usa ⛶ / ⊟ para cambiar de vista y − / + para cambiar su tamaño.</p><label className="opacity-label">Opacidad del fondo <strong>{settings.floatingOpacity}%</strong></label><input className="opacity-slider" type="range" min="20" max="100" step="5" value={settings.floatingOpacity} aria-label="Opacidad del fondo de la ventana flotante" onChange={e=>setSettings({...settings,floatingOpacity:Number(e.target.value)})}/><p className="setting-note">Ajusta la transparencia de la ventana flotante sin ocultar las cifras.</p><label>Actualizar cada<select value={settings.interval} onChange={e=>setSettings({...settings,interval:Number(e.target.value)})}><option value={1}>1 minuto</option><option value={3}>3 minutos</option><option value={5}>5 minutos</option><option value={15}>15 minutos</option></select></label><label className="switch-row">Avisar cuando quede poco<input type="checkbox" checked={settings.notifications} onChange={e=>setSettings({...settings,notifications:e.target.checked})}/></label><label>Umbral de aviso<select value={settings.alert} onChange={e=>setSettings({...settings,alert:Number(e.target.value)})}><option value={5}>5 %</option><option value={10}>10 %</option><option value={20}>20 %</option><option value={30}>30 %</option></select></label><label className="switch-row">Iniciar con el equipo<input type="checkbox" checked={auto} onChange={e=>void toggleAuto(e.target.checked)}/></label><p className="hint">Las consultas se hacen desde este equipo mediante Codex. No se envían datos a un servidor adicional.</p></section> : <><div className="intro"><span>DISPONIBLE AHORA</span><span className="live"><i/> {error ? 'SIN CONEXIÓN' : 'EN LÍNEA'}</span></div><div className="cards">{buckets.map(b=>[b.primary,b.secondary].filter((w):w is WindowLimit=>!!w).map(w=>{const left=remaining(w);return <article className="card" key={`${b.limitId}-${w.windowDurationMins}`}><div className="card-top"><h2>Límite {duration(w.windowDurationMins)}</h2><span>{b.limitName || 'CODEX'}</span></div><div className={`amount ${left<=10 ? "low" : left<=30 ? "caution" : ""}`} style={{color:usageColor(left)}}>{Math.round(left)}<small>%</small><em> disponible</em></div><div className="track"><div style={{width:`${left}%`,background:usageGradient,backgroundSize:`${10000 / Math.max(left, 0.01)}% 100%`}}/></div><div className="reset"><span>↻</span><div><strong>Se reinicia {resetText(w.resetsAt)}</strong><small>{until(w.resetsAt,now)}</small></div></div></article>}))}{!data && !error && <div className="empty">Conectando con Codex…</div>}{error && <div className="error"><strong>No se pudo actualizar</strong><p>{error}</p>{data && <p>Se muestran los últimos datos recibidos.</p>}</div>}</div><div className="status"><div><i className={error?'warning':''}/>{updated ? `Actualizado ${new Intl.DateTimeFormat('es-MX',{timeStyle:'short'}).format(updated)}` : 'Esperando datos'}</div><button className={`refresh ${loading?'spinning':''}`} onClick={()=>void refresh()} aria-label="Actualizar" disabled={loading}>↻</button></div><footer><span>●</span> Tus datos permanecen en este equipo <br/><small>Actualización cada {settings.interval} min · hora local</small></footer></>}
 </main>
}
export default function Root() { const label = isTauri() ? getCurrentWindow().label : 'main'; document.documentElement.dataset.window = label; return label === 'peek' ? <Peek /> : label === 'floating' ? <Peek floating /> : <App /> }
