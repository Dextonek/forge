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
const probe = (threadId) => `<script>(()=>{const T=${JSON.stringify(threadId)},L=Date.now();
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
async function run(m){if(m.cmd==='shot')return shot();if(m.cmd==='reload'){setTimeout(()=>location.reload(),30);return{ok:true}}
if(m.cmd==='eval'){let v=(0,eval)(m.code);if(v&&typeof v.then==='function')v=await v;let j;try{j=JSON.stringify(v,(k,x)=>typeof x==='bigint'?String(x):x)}catch{j=String(v)}return{value:j===undefined?'undefined':j.slice(0,4000)}}return{error:'unknown command'}}
function connect(){let ws;try{ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/__probe/'+T+'?load='+L)}catch{return}
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

export function attachProbe(threadId, ws, load) {
  const list = sockets.get(threadId) ?? [];
  list.push({ ws, load });
  sockets.set(threadId, list);
  for (const w of [...loadWaiters]) if (w.threadId === threadId && load > w.after) { loadWaiters.delete(w); w.resolve(true); }
  ws.on('message', (d) => { try { const m = JSON.parse(d); waiting.get(m.id)?.(m); waiting.delete(m.id); } catch { /* junk */ } });
  ws.on('close', () => sockets.set(threadId, (sockets.get(threadId) ?? []).filter((x) => x.ws !== ws)));
}
export const probeConnected = (threadId) => (sockets.get(threadId) ?? []).length > 0;

// Sends a command to the newest page of this thread (iframe in Forge, or the hidden preview).
export function probeCommand(threadId, cmd, extra = {}, timeoutMs = 8000) {
  const list = (sockets.get(threadId) ?? []).filter((x) => x.ws.readyState === 1).sort((a, b) => b.load - a.load);
  if (!list.length) return Promise.resolve({ error: 'preview not open' });
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
