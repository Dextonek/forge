// Playtest test with a real turn on a 2D canvas game. Needs the desktop app on FORGE_PORT (default 4417).
// Usage: node scripts/playtest-test.mjs <gameDir> <outDir>
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
const [dir, out = '.'] = process.argv.slice(2);
const before = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
let events = [], done;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d); if (m.type !== 'event') return; events.push(m.ev);
  if (m.ev.type === 'approval') { console.log('   ASKED for', m.ev.tool); await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'allow' }); }
  if (m.ev.type === 'result' || m.ev.type === 'error') done?.();
});
const p = await api('/api/projects', 'POST', { path: path.resolve(dir) });
const t = await api('/api/threads', 'POST', { projectId: p.id, model: 'haiku', effort: 'low', permMode: 'default' });
const fin = new Promise((r) => (done = r));
await api(`/api/threads/${t.id}/message`, 'POST', { text: 'Playtest the movement: start a run from the menu, hold D for one second, and check with a read step whether the player moved to the right. The game state is in the top-level variables S (screen) and G (G.p is the player). Take one screenshot during the run. Do not change any files. Give a one-line PASS/FAIL verdict.' });
await fin; ws.close();
const pt = events.find((e) => e.type === 'playtest');
console.log('tools:', events.filter((e) => e.type === 'tool').map((e) => e.name.replace('mcp__forge__', 'forge:')).join(', '));
console.log('playtest log:\n  ' + (pt?.steps ?? ['(no playtest)']).join('\n  '));
for (const [i, s] of (pt?.shots ?? []).entries()) {
  const img = await fetch(B + s.src, { headers: { Origin: B } });
  const f = path.join(out, `playtest-${i + 1}.jpg`); fs.writeFileSync(f, Buffer.from(await img.arrayBuffer())); console.log('saved', f, `"${s.label}"`);
}
console.log('reply:', events.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 300));
console.log('game file unchanged:', fs.readFileSync(path.join(dir, 'index.html'), 'utf8') === before);
