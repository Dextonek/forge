// Real-turn test of verify_game, the hidden preview and the done-check. Needs Forge (desktop app)
// running with FORGE_PORT (default 4417). Usage: node scripts/verify-test.mjs [outDir]
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.FORGE_PORT ?? 4417);
const B = `http://127.0.0.1:${PORT}`;
const H = { Origin: B, 'Content-Type': 'application/json' };
const out = process.argv[2] ?? '.';
const api = async (u, method = 'GET', body) => {
  const r = await fetch(B + u, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${u}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
let events = [], waiters = [];
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d);
  if (m.type !== 'event') return;
  events.push(m.ev);
  if (m.ev.type === 'approval') await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'allow' });
  if (m.ev.type === 'result' || m.ev.type === 'error') waiters.splice(0).forEach((w) => w(m.ev));
});
async function turn(id, text) {
  events = [];
  const done = new Promise((r) => waiters.push(r));
  await api(`/api/threads/${id}/message`, 'POST', { text });
  const end = await done;
  return { end, events: [...events] };
}

const project = await api('/api/projects', 'POST', { path: path.resolve('sample-game') });
const cases = [
  { name: 'verify via hidden preview', text: 'Make the cube green (0x22cc55).' },
  { name: 'done-check forces verify', text: 'Set the cube SPEED constant to 3. Do not call verify_game or any checking tool; just make the edit and finish.' },
];
let i = 0;
for (const c of cases) {
  const t = await api('/api/threads', 'POST', { projectId: project.id, model: 'haiku', effort: 'low', permMode: 'acceptEdits' });
  const { end, events: ev } = await turn(t.id, c.text);
  const tools = ev.filter((e) => e.type === 'tool').map((e) => e.name.replace('mcp__forge__', 'forge:'));
  const shots = ev.filter((e) => e.type === 'shot');
  const guard = ev.some((e) => e.type === 'info' && /Done-check/.test(e.text));
  console.log(`\n${c.name}\n   tools: ${tools.join(', ')}\n   done-check fired: ${guard} · shots: ${shots.length} · ${end.type}${end.isError ? ' ' + end.text : ''}`);
  for (const s of shots) {
    if (s.image) { const f = path.join(out, `verify-${++i}.jpg`); fs.writeFileSync(f, Buffer.from(s.image.split(',')[1], 'base64')); console.log(`   screenshot saved: ${f} (${s.errors} errors)`); }
    else console.log(`   no screenshot: ${s.note}`);
  }
  const reply = ev.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 220);
  console.log(`   reply: ${reply}`);
  // put the sample back for the next case
  await api(`/api/threads/${t.id}/undo`, 'POST', { turnId: ev.find((e) => e.type === 'user').turnId }).catch((e) => console.log('   undo:', e.message));
}
ws.close();
