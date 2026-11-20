// New game from an empty folder, one turn: progress notes first, game built, checked in the same turn.
// Needs the desktop app on FORGE_PORT (default 4417). Usage: node scripts/new-game-test.mjs <emptyDir> <outDir>
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
const PORT = Number(process.env.FORGE_PORT ?? 4417);
const B = `http://127.0.0.1:${PORT}`;
const H = { Origin: B, 'Content-Type': 'application/json' };
const api = async (u, method = 'GET', body) => {
  const r = await fetch(B + u, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${u}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const [dir, out] = process.argv.slice(2);
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
let events = [], done;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'state') console.log('   (state broadcast: engine may have changed)'); if (m.type !== 'event') return; events.push(m.ev); if (m.ev.type === 'result' || m.ev.type === 'error') done?.(); });
const p = await api('/api/projects', 'POST', { path: path.resolve(dir) });
console.log('engine when added:', p.engine);
const t = await api('/api/threads', 'POST', { projectId: p.id, model: 'haiku', effort: 'medium', permMode: 'acceptEdits' });
const fin = new Promise((r) => (done = r));
await api(`/api/threads/${t.id}/message`, 'POST', { text: 'Make a tiny snake game in a single index.html with plain canvas: arrow keys or WASD, food, growing tail, score, game over and restart with Enter. Keep it under 200 lines.' });
await fin; await new Promise((r) => setTimeout(r, 500));
console.log('tools:', events.filter((e) => e.type === 'tool').map((e) => e.name.replace('mcp__forge__', 'forge:')).join(', '));
console.log('done-check fired:', events.some((e) => e.type === 'info' && /Done-check/.test(e.text)));
const shot = events.find((e) => e.type === 'shot');
if (shot?.src) { const r = await fetch(B + shot.src, { headers: { Origin: B } }); const f = path.join(out, 'new-game.jpg'); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); console.log('verify screenshot saved', f, `(${shot.errors} errors)`); }
else console.log('verify:', shot ? 'no screenshot ' + shot.note : 'not called');
const st = (await api('/api/state')).projects.find((x) => x.id === p.id);
console.log('engine right after the turn:', st.engine, 'web=' + st.web);
const notes = path.join(process.env.FORGE_DATA ?? 'data', 'progress', `${p.id}.md`);
console.log('progress notes:', fs.existsSync(notes) ? fs.readFileSync(notes, 'utf8').split('\n').filter(Boolean).slice(0, 5).join(' | ') : 'none');
console.log('reply:', events.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 300));
console.log('turn cost: $' + (events.find((e) => e.type === 'result')?.turn?.cost ?? 0).toFixed(4));
ws.close();
