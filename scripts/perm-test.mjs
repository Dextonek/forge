// Tests model/effort/permission-mode settings with real (cheap, Haiku) turns. Needs `npm start` running.
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const B = 'http://127.0.0.1:4317';
const H = { Origin: B, 'Content-Type': 'application/json' };
const api = async (u, method = 'GET', body) => {
  const r = await fetch(B + u, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${u}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const game = path.resolve('sample-game');
const file = path.join(game, 'index.html');
const speed = () => fs.readFileSync(file, 'utf8').match(/const SPEED = ([\d.]+);/)?.[1];

let events = [], waiters = [];
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d);
  if (m.type !== 'event') return;
  events.push(m.ev);
  if (m.ev.type === 'approval') { console.log(`   ASKED: ${m.ev.tool} ${m.ev.summary} -> allow`); await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'allow' }); }
  if (m.ev.type === 'result' || m.ev.type === 'error') waiters.splice(0).forEach((w) => w(m.ev));
});
async function turn(id, text) {
  events = [];
  const done = new Promise((r) => waiters.push(r));
  await api(`/api/threads/${id}/message`, 'POST', { text });
  const end = await done;
  const u = events.find((e) => e.type === 'user');
  console.log(`   ran: model=${u?.model} effort=${u?.effort} perm=${u?.permissionMode} · tools: ${events.filter((e) => e.type === 'tool').map((e) => e.name).join(', ') || '-'} · ${end.type}${end.isError ? ' ' + end.text : ''} · models ${Object.keys(end.turn?.perModel ?? {}).join(',')}`);
}

const project = await api('/api/projects', 'POST', { path: game });
const cases = [
  { name: 'Fixed Haiku 5.5, effort low, Ask', patch: { model: 'haiku', effort: 'low', permMode: 'default' }, text: 'set the cube SPEED constant to 1.1', expect: '1.1' },
  { name: 'Auto-accept edits', patch: { model: 'haiku', effort: 'low', permMode: 'acceptEdits' }, text: 'set the cube SPEED constant to 1.2', expect: '1.2' },
  { name: 'Auto (classifier)', patch: { model: 'haiku', effort: 'low', permMode: 'auto' }, text: 'set the cube SPEED constant to 1.3', expect: '1.3' },
  { name: 'Plan only (must not edit)', patch: { model: 'haiku', effort: 'low', permMode: 'plan' }, text: 'set the cube SPEED constant to 9.9', expect: 'unchanged' },
  { name: 'Full access', patch: { model: 'haiku', effort: 'low', permMode: 'bypassPermissions' }, text: 'set the cube SPEED constant to 1.4', expect: '1.4' },
  { name: 'Fable 5.2, medium', patch: { model: 'fable', effort: 'medium', permMode: 'acceptEdits' }, text: 'set the cube SPEED constant to 1.0', expect: '1.0' },
];
for (const c of cases) {
  const before = speed();
  const t = await api('/api/threads', 'POST', { projectId: project.id });
  await api(`/api/threads/${t.id}`, 'PATCH', { ...c.patch, title: c.name });
  console.log(`\n${c.name}`);
  await turn(t.id, c.text);
  const after = speed();
  const ok = c.expect === 'unchanged' ? after === before : after === c.expect;
  console.log(`   SPEED ${before} -> ${after}  ${ok ? 'OK' : 'UNEXPECTED'}`);
}
ws.close();
