// Game-side helpers: safe static serving with an error probe, asset listing, runtime error buffer.
import fs from 'node:fs';
import path from 'node:path';
import { IGNORE_DIRS } from './engine.mjs';

// Resolve a relative path inside root; returns null if it escapes root.
export function safeJoin(root, rel) {
  const full = path.resolve(root, '.' + path.sep + decodeURIComponent(rel || ''));
  const r = path.resolve(root);
  return full === r || full.startsWith(r + path.sep) ? full : null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wasm': 'application/wasm', '.ttf': 'font/ttf',
};

// Injected into every game page served under /play/<thread>/. It
//  - reports runtime errors / console errors / warnings for that thread,
//  - keeps WebGL drawing buffers readable so the canvas can be captured,
//  - opens a socket back to Forge that answers "shot" (canvas capture), "eval" and "reload" commands.
// Everything is keyed by thread, so two threads of one project never mix up their checks.
const probe = (threadId) => `<script>(()=>{const T=${JSON.stringify(threadId)},L=Date.now(),ROLE=new URLSearchParams(location.search).get('forge')==='hidden'?'hidden':'visible';
// three.js announces every Scene and WebGLRenderer it creates on __THREE_DEVTOOLS__ (if present). Keep them,
// and remember the camera of the last render, so a click can be turned into "which object is this".
const TH={scenes:[],renderers:[],camera:null};window.__forgeThree=TH;
const dt=window.__THREE_DEVTOOLS__||(window.__THREE_DEVTOOLS__=new EventTarget());
dt.addEventListener('observe',e=>{const o=e.detail;if(!o)return;if(o.isScene&&!TH.scenes.includes(o))TH.scenes.push(o);
if(o.isWebGLRenderer&&!TH.renderers.includes(o)){TH.renderers.push(o);const r=o.render.bind(o);o.render=(s,c)=>{TH.camera=c;TH.lastScene=s;return r(s,c)}}});
const s=(k,m)=>{try{navigator.sendBeacon('/__errors/'+T,JSON.stringify({kind:k,msg:String(m).slice(0,2000),t:Date.now(),load:L}))}catch{}};
addEventListener('error',e=>s('error',(e.message||e)+(e.filename?' @'+e.filename.split('/').pop()+':'+e.lineno:'')));
addEventListener('unhandledrejection',e=>s('promise',e.reason&&e.reason.stack||e.reason));
const ce=console.error;console.error=(...a)=>{s('console',a.map(x=>x&&x.stack||x).join(' '));ce.apply(console,a)};
const cw=console.warn;console.warn=(...a)=>{s('warn',a.join(' '));cw.apply(console,a)};s('load','page loaded');
const gc=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,o){if(/webgl/.test(t))o=Object.assign({},o,{preserveDrawingBuffer:true});return gc.call(this,t,o)};
let F=0;(function k(){F++;requestAnimationFrame(k)})();
function shot(){if(F<3)return{error:'not drawing frames'};const cs=[...document.querySelectorAll('canvas')].filter(c=>c.width*c.height>0).sort((a,b)=>b.width*b.height-a.width*a.height);const c=cs[0];if(!c)return{error:'no canvas on the page'};
const w=Math.min(640,c.width),h=Math.round(c.height*w/c.width),o=document.createElement('canvas');o.width=w;o.height=h;const x=o.getContext('2d');x.fillStyle='#000';x.fillRect(0,0,w,h);x.drawImage(c,0,0,w,h);
return{image:o.toDataURL('image/jpeg',0.75),w,h,canvas:c.width+'x'+c.height}}
function mainCanvas(){return[...document.querySelectorAll('canvas')].filter(c=>c.width*c.height>0).sort((a,b)=>b.width*b.height-a.width*a.height)[0]}
// Pick: which three.js objects are under a click? Uses three's own classes taken from the scene (no import needed).
function pickObjects(cx,cy){const cam=TH.camera,sc=TH.lastScene||TH.scenes[0];if(!cam||!sc)return[];const c=mainCanvas(),r=c.getBoundingClientRect();
const V=sc.position.constructor,out=[];sc.traverse(o=>{if(!o.isMesh&&!o.isSprite&&!o.isPoints)return;if(o.visible===false)return;
const g=o.geometry;if(g&&!g.boundingSphere&&g.computeBoundingSphere)g.computeBoundingSphere();const w=new V();o.getWorldPosition(w);const s=new V();o.getWorldScale(s);
const rad=(g&&g.boundingSphere?g.boundingSphere.radius:0.5)*Math.max(s.x,s.y,s.z);const p=w.clone().project(cam);if(p.z>1||p.z<-1)return;
const sx=r.left+(p.x+1)/2*r.width,sy=r.top+(1-p.y)/2*r.height;const e=w.clone().add(new V(rad,0,0)).project(cam);const pr=Math.max(4,Math.abs((e.x-p.x)/2*r.width));
const d=Math.hypot(cx-sx,cy-sy);if(d>pr*1.6)return;const path=[];let q=o;while(q&&q!==sc){path.unshift((q.name||q.type).slice(0,40));q=q.parent}
const col=o.material&&o.material.color&&o.material.color.getHexString?'#'+o.material.color.getHexString():null;
out.push({score:d/pr,name:(o.name||'').slice(0,60),type:o.type,path:path.join(' > ').slice(0,200),geometry:g&&g.type,color:col,
position:[w.x,w.y,w.z].map(v=>+v.toFixed(2)),size:+(rad*2).toFixed(2)})});return out.sort((a,b)=>a.score-b.score).slice(0,3)}
function marked(cx,cy){const s=shot();if(!s.image)return Promise.resolve(s);const c=mainCanvas(),r=c.getBoundingClientRect();return new Promise(res=>{const im=new Image();im.onload=()=>{
const o=document.createElement('canvas');o.width=s.w;o.height=s.h;const x=o.getContext('2d');x.drawImage(im,0,0);const mx=(cx-r.left)/r.width*s.w,my=(cy-r.top)/r.height*s.h;
x.strokeStyle='#ff3b3b';x.lineWidth=3;x.beginPath();x.arc(mx,my,14,0,7);x.stroke();x.beginPath();x.moveTo(mx-22,my);x.lineTo(mx-8,my);x.moveTo(mx+8,my);x.lineTo(mx+22,my);x.moveTo(mx,my-22);x.lineTo(mx,my-8);x.moveTo(mx,my+8);x.lineTo(mx,my+22);x.stroke();
res({...s,image:o.toDataURL('image/jpeg',0.8)})};im.src=s.image})}
let picking=null;
function pickMode(){if(picking)picking.cancel();return new Promise(res=>{const ov=document.createElement('div');
ov.style.cssText='position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.08)';
const tip=document.createElement('div');tip.textContent='Click what you mean · Esc to cancel';tip.style.cssText='position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#000c;color:#fff;font:13px system-ui;padding:6px 12px;border-radius:8px;pointer-events:none';ov.appendChild(tip);
const done=v=>{ov.remove();removeEventListener('keydown',esc,true);clearTimeout(tm);picking=null;res(v)};const esc=e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();done({cancelled:true})}};
const tm=setTimeout(()=>done({cancelled:true}),60000);addEventListener('keydown',esc,true);
ov.addEventListener('mousedown',async e=>{e.preventDefault();e.stopPropagation();const c=mainCanvas(),r=c?c.getBoundingClientRect():{left:0,top:0,width:innerWidth,height:innerHeight};
ov.remove();const objects=pickObjects(e.clientX,e.clientY),img=await marked(e.clientX,e.clientY);
done({x:Math.round(e.clientX-r.left),y:Math.round(e.clientY-r.top),fx:+((e.clientX-r.left)/r.width).toFixed(3),fy:+((e.clientY-r.top)/r.height).toFixed(3),w:Math.round(r.width),h:Math.round(r.height),objects,image:img.image||null,three:!!TH.camera})},true);
document.body.appendChild(ov);picking={cancel:()=>done({cancelled:true})};ov.tabIndex=-1;ov.focus()})}
// Playtest input: real DOM events, as if a player pressed keys or clicked the canvas.
function key(m){const t=document.activeElement&&document.activeElement!==document.body?document.activeElement:document.body;const o={code:m.code,key:m.key||m.code,bubbles:true,cancelable:true};
if(m.type!=='up')t.dispatchEvent(new KeyboardEvent('keydown',o));if(m.type!=='down')t.dispatchEvent(new KeyboardEvent('keyup',o));return{ok:true}}
function mouse(m){const c=mainCanvas()||document.body,r=c.getBoundingClientRect(),x=r.left+m.fx*r.width,y=r.top+m.fy*r.height,o={clientX:x,clientY:y,bubbles:true,cancelable:true,button:0,buttons:1};
c.dispatchEvent(new MouseEvent('mousemove',o));if(m.type!=='move'){c.dispatchEvent(new PointerEvent('pointerdown',o));c.dispatchEvent(new MouseEvent('mousedown',o));c.dispatchEvent(new PointerEvent('pointerup',o));c.dispatchEvent(new MouseEvent('mouseup',o));c.dispatchEvent(new MouseEvent('click',o))}return{ok:true}}
// Safe state read: a plain path like G.p.x or enemies.length (no code runs).
function read(p){if(!/^[A-Za-z_$][\\w$]*(\\.[A-Za-z_$][\\w$]*|\\[\\d+\\])*$/.test(p))return{error:'only plain paths like G.p.x are allowed'};
const parts=p.match(/[A-Za-z_$][\\w$]*|\\d+/g);let v;try{v=(0,eval)(parts[0])}catch{return{error:parts[0]+' is not defined (top-level variables of module scripts are not reachable)'}}
for(const k of parts.slice(1)){if(v==null)break;v=v[k]}let j;try{j=JSON.stringify(v)}catch{j=String(v)}return{value:(j===undefined?'undefined':j).slice(0,1000)}}
async function run(m){if(m.cmd==='shot')return shot();if(m.cmd==='pick')return pickMode();if(m.cmd==='unpick'){if(picking)picking.cancel();return{ok:true}}
if(m.cmd==='key')return key(m);if(m.cmd==='mouse')return mouse(m);if(m.cmd==='read')return read(m.path);if(m.cmd==='reload'){setTimeout(()=>location.reload(),30);return{ok:true}}
if(m.cmd==='eval'){let v=(0,eval)(m.code);if(v&&typeof v.then==='function')v=await v;let j;try{j=JSON.stringify(v,(k,x)=>typeof x==='bigint'?String(x):x)}catch{j=String(v)}return{value:j===undefined?'undefined':j.slice(0,4000)}}return{error:'unknown command'}}
function connect(){let ws;try{ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/__probe/'+T+'?load='+L+'&role='+ROLE)}catch{return}
ws.onmessage=async e=>{const m=JSON.parse(e.data);let r;try{r=await run(m)}catch(err){r={error:String(err&&err.stack||err).slice(0,2000)}}ws.send(JSON.stringify({id:m.id,...r}))};
ws.onclose=()=>setTimeout(connect,2000)}
addEventListener('load',()=>setTimeout(connect,50))})()</script>`;

export function serveGame(res, root, threadId, rel, inject = true) {
  let file = safeJoin(root, rel);
  if (!file) { res.writeHead(403).end('outside project'); return; }
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (ext === '.html' && inject) {
      let html = buf.toString('utf8');
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + probe(threadId)) : probe(threadId) + html;
      res.writeHead(200, headers).end(html);
    } else res.writeHead(200, headers).end(buf);
  });
}

// Runtime errors per thread, for the latest page load only; repeated messages are counted, not repeated.
const errors = new Map(); // threadId -> { load, list: [{kind,msg,count,t}] }
export function pushError(threadId, e) {
  let rec = errors.get(threadId);
  if (!rec || (e.load ?? 0) > rec.load) { rec = { load: e.load ?? Date.now(), list: [] }; errors.set(threadId, rec); }
  if ((e.load ?? rec.load) < rec.load) return;           // late report from an older page load
  if (e.kind === 'load') return;
  const same = rec.list.find((x) => x.kind === e.kind && x.msg === e.msg);
  if (same) { same.count++; same.t = e.t; return; }
  rec.list.push({ kind: e.kind, msg: e.msg, count: 1, t: e.t });
  if (rec.list.length > 50) rec.list.shift();
}
export const getErrors = (threadId) => errors.get(threadId)?.list ?? [];
export const lastLoad = (threadId) => errors.get(threadId)?.load ?? 0;
export function formatErrors(list) {
  return list.map((e) => `[${e.kind}]${e.count > 1 ? ` ×${e.count}` : ''} ${e.msg}`).join('\n');
}

// ---- probe sockets: Forge → game page commands ------------------------------------------------
const sockets = new Map(); // threadId -> [{ ws, load }]
let seq = 0;
const waiting = new Map();  // command id -> resolve
const loadWaiters = new Set(); // { threadId, after, resolve }

export function attachProbe(threadId, ws, load, role = 'visible') {
  const list = sockets.get(threadId) ?? [];
  list.push({ ws, load, role });
  sockets.set(threadId, list);
  for (const w of [...loadWaiters]) if (w.threadId === threadId && load > w.after) { loadWaiters.delete(w); w.resolve(true); }
  ws.on('message', (d) => { try { const m = JSON.parse(d); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch { /* junk */ } });
  ws.on('close', () => sockets.set(threadId, (sockets.get(threadId) ?? []).filter((x) => x.ws !== ws)));
}
export const probeConnected = (threadId) => (sockets.get(threadId) ?? []).length > 0;

export const probeConnectedAs = (threadId, role) => (sockets.get(threadId) ?? []).some((x) => x.role === role && x.ws.readyState === 1);

// Sends a command to the newest page of this thread. `role` picks the page you see in Forge ('visible')
// or the hidden offscreen preview ('hidden'); without it, the newest page of either kind.
export function probeCommand(threadId, cmd, extra = {}, timeoutMs = 8000, role = null) {
  const list = (sockets.get(threadId) ?? []).filter((x) => x.ws.readyState === 1 && (!role || x.role === role)).sort((a, b) => b.load - a.load);
  if (!list.length) return Promise.resolve({ error: role === 'visible' ? 'the Play tab is not open for this thread' : 'preview not open' });
  const id = ++seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: 'preview did not answer' }); }, timeoutMs);
    waiting.set(id, (m) => { clearTimeout(timer); resolve(m); });
    list[0].ws.send(JSON.stringify({ id, cmd, ...extra }));
  });
}
// Resolves true once a page of this thread loaded after `after` (ms timestamp), false on timeout.
export function waitForLoad(threadId, after, timeoutMs = 10000) {
  if ((sockets.get(threadId) ?? []).some((x) => x.load > after)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const w = { threadId, after, resolve };
    loadWaiters.add(w);
    setTimeout(() => { if (loadWaiters.delete(w)) resolve(false); }, timeoutMs);
  });
}

const KIND = { image: /\.(png|jpe?g|webp|gif|svg|psd|exr|hdr|ktx2)$/i, model: /\.(glb|gltf|fbx|obj|blend)$/i,
  audio: /\.(wav|mp3|ogg|flac)$/i, font: /\.(ttf|otf|woff2?)$/i, scene: /\.(tscn|scn|unity|umap|prefab)$/i,
  code: /\.(m?js|ts|gd|cs|cpp|h|py|lua|glsl|wgsl|shader|html?|css|json|md)$/i };

export function listAssets(root, limit = 2000) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (out.length >= limit) return;
      if (ent.isDirectory()) { if (!IGNORE_DIRS.has(ent.name) && !ent.name.startsWith('.')) walk(path.join(dir, ent.name)); continue; }
      const full = path.join(dir, ent.name);
      const kind = Object.keys(KIND).find((k) => KIND[k].test(ent.name)) ?? 'other';
      out.push({ path: path.relative(root, full).split(path.sep).join('/'), kind, size: fs.statSync(full).size });
    }
  };
  walk(root);
  return out;
}

// Compact text summary for the agent (much cheaper than letting it Glob around).
export function assetSummary(root) {
  const assets = listAssets(root).filter((a) => a.kind !== 'code');
  const byKind = {};
  for (const a of assets) (byKind[a.kind] ??= []).push(`${a.path} (${Math.round(a.size / 1024)}KB)`);
  return Object.entries(byKind).map(([k, v]) => `${k} (${v.length}):\n  ${v.slice(0, 60).join('\n  ')}${v.length > 60 ? '\n  …' : ''}`).join('\n') || 'no asset files found';
}
