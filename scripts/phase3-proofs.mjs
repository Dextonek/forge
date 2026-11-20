// Phase 3 feasibility checks against a running Forge (desktop app, FORGE_PORT, default 4417):
//  1. three.js sample: does __THREE_DEVTOOLS__ give us the scene/renderer/camera (for click-to-pick)?
//  2. 2D canvas game copy: is state reachable, and do dispatched key/mouse events move the player?
// Usage: node scripts/phase3-proofs.mjs <sampleGameDir> <canvasGameDir>
const PORT = Number(process.env.FORGE_PORT ?? 4417);
const B = `http://127.0.0.1:${PORT}`;
const H = { Origin: B, 'Content-Type': 'application/json' };
const api = async (u, method = 'GET', body) => {
  const r = await fetch(B + u, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${u}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [sampleDir, canvasDir] = process.argv.slice(2);

async function threadFor(dir) {
  const p = await api('/api/projects', 'POST', { path: dir });
  const t = await api('/api/threads', 'POST', { projectId: p.id });
  return { p, t };
}
// Opens the thread in the hidden (always drawing) preview via a verify-style warm-up: use the shot endpoint
// after asking the server to open a hidden preview through the eval route of an open page is not possible,
// so these checks rely on the desktop window's visible Play tab OR the hidden preview opened by /preview.
const ev = async (t, code) => (await api(`/api/threads/${t.id}/eval`, 'POST', { code }));

const a = await threadFor(sampleDir);
await api(`/api/threads/${a.t.id}/preview`, 'POST', {});
await sleep(4000);
console.log('1) three.js sample (', a.p.engine, ')');
console.log('  ', JSON.stringify(await ev(a.t, `(() => { const T = window.__forgeThree; return { scenes: T.scenes.length, renderers: T.renderers.length, camera: T.camera && T.camera.type, children: T.scenes[0] && T.scenes[0].children.map(o => o.type + (o.name ? ':' + o.name : '')) }; })()`)));

const b = await threadFor(canvasDir);
await api(`/api/threads/${b.t.id}/preview`, 'POST', {});
await sleep(4000);
console.log('2) 2D canvas game (', b.p.engine, ')');
console.log('   globals:', JSON.stringify(await ev(b.t, `(() => { const names = ['player','P','game','state','enemies','level','paused','mode','scene']; const out = {}; for (const n of names) { try { const v = (0, eval)(n); out[n] = typeof v === 'object' && v ? Object.keys(v).slice(0, 12) : typeof v; } catch { } } return out; })()`)));
const pos = async () => (await ev(b.t, `(() => { try { const S = (0, eval)('S'), G = (0, eval)('G'); return { screen: S, x: G && Math.round(G.p.x), y: G && Math.round(G.p.y), hp: G && G.p.hp }; } catch (e) { return String(e); } })()`)).value;
console.log('   on menu:', await pos());
await ev(b.t, `dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true })); dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', key: 'Enter', bubbles: true })); 'enter'`);
await sleep(500);
console.log('   after Enter:', await pos());
await ev(b.t, `dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', key: 'd', bubbles: true })); 'down'`);
await sleep(1000);
await ev(b.t, `dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyD', key: 'd', bubbles: true })); 'up'`);
console.log('   player after holding D for 1 s:', await pos());
