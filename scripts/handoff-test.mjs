// Real-turn test of progress notes and "fresh thread from summary". Needs Forge on FORGE_PORT (default 4417).
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
let events = [], waiters = [];
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', (d) => { const m = JSON.parse(d); if (m.type !== 'event') return; events.push(m.ev); if (m.ev.type === 'result' || m.ev.type === 'error') waiters.splice(0).forEach((w) => w(m.ev)); });
async function turn(id, text) { events = []; const done = new Promise((r) => waiters.push(r)); await api(`/api/threads/${id}/message`, 'POST', { text }); await done; return [...events]; }
const reply = (ev) => ev.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 300);

const project = await api('/api/projects', 'POST', { path: path.resolve('sample-game') });
const t = await api('/api/threads', 'POST', { projectId: project.id, model: 'haiku', effort: 'low', permMode: 'acceptEdits' });

console.log('1) progress notes');
let ev = await turn(t.id, 'Write the project progress notes now: goal "spinning cube demo", features: spin (done), colour change (done), bounce (todo), and a known bug "none". Use the progress tool. Do not edit any game files.');
console.log('   tools:', ev.filter((e) => e.type === 'tool').map((e) => e.name).join(', '));
const notesFile = path.join(process.env.FORGE_DATA ?? 'data', 'progress', `${project.id}.md`);
console.log('   notes file exists:', fs.existsSync(notesFile), '\n   ' + (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8').split('\n').slice(0, 6).join(' | ') : ''));

console.log('2) fresh thread from summary');
const nt = await api(`/api/threads/${t.id}/handoff`, 'POST', {});
const hev = (await api(`/api/threads/${nt.id}/events`)).find((e) => e.type === 'handoff');
console.log(`   new thread "${nt.title}" · note cost $${hev.costUsd.toFixed(4)}\n   note: ${hev.note.replace(/\s+/g, ' ').slice(0, 240)}`);
ev = await turn(nt.id, 'In two sentences: what is this project about and what is still to do? Do not use any tools.');
console.log('   reply in new thread:', reply(ev));
const ctx = (await api('/api/state')).threads.find((x) => x.id === nt.id).lastContextTokens;
console.log('   context in new thread:', ctx);
ws.close();
