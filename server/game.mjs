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

// Injected into every served HTML page: reports runtime errors back to Forge so the agent can
// read them with a cheap text tool instead of needing screenshots.
const probe = (projectId) => `<script>(()=>{const s=(k,m)=>{try{navigator.sendBeacon('/__errors/${projectId}',JSON.stringify({kind:k,msg:String(m).slice(0,2000),t:Date.now()}))}catch{}};
addEventListener('error',e=>s('error',(e.message||e)+(e.filename?' @'+e.filename.split('/').pop()+':'+e.lineno:'')));
addEventListener('unhandledrejection',e=>s('promise',e.reason&&e.reason.stack||e.reason));
const ce=console.error;console.error=(...a)=>{s('console',a.map(x=>x&&x.stack||x).join(' '));ce.apply(console,a)};
const cw=console.warn;console.warn=(...a)=>{s('warn',a.join(' '));cw.apply(console,a)};s('load','page loaded')})()</script>`;

export function serveGame(res, root, projectId, rel) {
  let file = safeJoin(root, rel);
  if (!file) { res.writeHead(403).end('outside project'); return; }
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch { /* 404 below */ }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    const ext = path.extname(file).toLowerCase();
    const headers = { 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (ext === '.html') {
      let html = buf.toString('utf8');
      html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + probe(projectId)) : probe(projectId) + html;
      res.writeHead(200, headers).end(html);
    } else res.writeHead(200, headers).end(buf);
  });
}

// Runtime errors per project (ring buffer).
const errors = new Map();
export function pushError(projectId, e) {
  const list = errors.get(projectId) ?? [];
  if (e.kind === 'load') list.length = 0; // fresh page load starts a fresh log
  list.push(e);
  if (list.length > 100) list.shift();
  errors.set(projectId, list);
}
export const getErrors = (projectId) => (errors.get(projectId) ?? []).filter((e) => e.kind !== 'load');

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
