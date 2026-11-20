// End-to-end test against a running Forge server (npm start). Uses real model turns (costs a little).
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';

const B = `http://127.0.0.1:${process.env.FORGE_PORT ?? 4317}`;
const H = { Origin: B, 'Content-Type': 'application/json' };
const api = async (u, method = 'GET', body) => {
  const r = await fetch(B + u, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${u}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const game = path.resolve('sample-game');
const log = (...a) => console.log(...a);

// Approval policy per turn: function(ev) -> 'allow' | 'always' | 'deny'
let policy = () => 'allow';
let events = [];
let waiters = [];
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d);
  if (m.type !== 'event') return;
  events.push(m.ev);
  if (m.ev.type === 'approval') {
    const decision = policy(m.ev);
    log(`   approval: ${m.ev.tool} ${m.ev.summary} -> ${decision}`);
    await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision });
  }
  if (m.ev.type === 'result' || m.ev.type === 'error') waiters.splice(0).forEach((w) => w(m.ev));
});

async function turn(threadId, text, tier = 'auto', onStart) {
  events = [];
  const done = new Promise((r) => waiters.push(r));
  await api(`/api/threads/${threadId}/message`, 'POST', { text, tier });
  if (onStart) onStart();
  const end = await Promise.race([done, new Promise((r) => setTimeout(() => r({ type: 'timeout' }), 240_000))]);
  const user = events.find((e) => e.type === 'user');
  const tools = events.filter((e) => e.type === 'tool').map((e) => `${e.sub ? 'sub:' : ''}${e.name}`);
  const texts = events.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').slice(0, 300);
  log(`   routed: ${user?.tier} (${user?.reason})`);
  log(`   tools: ${tools.join(', ') || '-'}`);
  log(`   reply: ${texts.replace(/\s+/g, ' ')}`);
  const th = (await api('/api/state')).threads.find((x) => x.id === threadId);
  log(`   context after turn: ${th?.lastContextTokens ?? '?'} tokens`);
  log(`   end: ${end.type}${end.isError ? ' ERROR ' + end.text : ''}${end.usage ? ` · session $${end.usage.costUsd?.toFixed(4)} · models ${Object.keys(end.usage.byModel).join(',')}` : ''}${end.text && end.type === 'error' ? ' ' + end.text : ''}`);
  return { end, events };
}
const state = async () => api('/api/state');

// --- setup -------------------------------------------------------------------------------
fs.writeFileSync(path.join(game, 'assets', 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
const project = await api('/api/projects', 'POST', { path: game });
const t = await api('/api/threads', 'POST', { projectId: project.id });
log(`project ${project.name} engine=${project.engine}; thread ${t.id}`);

log('\n1) Quick edit, approve once');
policy = () => 'allow';
await turn(t.id, 'change the cube speed to 2');
log(`   file now has SPEED = 2: ${/SPEED = 2(\.0)?;/.test(fs.readFileSync(path.join(game, 'index.html'), 'utf8'))}`);
const s1 = (await state()).threads.find((x) => x.id === t.id);
log(`   sessionId ${s1.sessionId}`);

log('\n2) Second turn same thread, approve "always"');
policy = () => 'always';
await turn(t.id, 'set the cube colour to 0x3366ff');
const s2 = (await state()).threads.find((x) => x.id === t.id);
log(`   same session: ${s1.sessionId === s2.sessionId} · cost grew: ${s2.usage.costUsd > s1.usage.costUsd} · allowRules ${JSON.stringify(s2.allowRules)}`);

log('\n3) Deny: a Bash command');
policy = (ev) => (ev.tool === 'Bash' ? 'deny' : 'allow');
await turn(t.id, 'run `git --version` with the Bash tool and tell me the output', 'quick');

log('\n4) Binary read rule');
await turn(t.id, 'This is a test of Forge\'s permission rules, so ignore the advice about binaries: call the Read tool on assets/pixel.png once and tell me exactly what the tool returned (or the error).', 'quick');

log('\n5) Scout helper (standard tier)');
policy = () => 'allow';
await turn(t.id, 'Use the scout agent to find where the WebGL renderer is created and how resize is handled. Then summarise in two lines.', 'standard');

log('\n6) Stop mid-turn');
const t2 = await api('/api/threads', 'POST', { projectId: project.id });
const started = Date.now();
await turn(t2.id, 'Write a detailed 1500-word essay about game loop architectures. Do not use tools.', 'quick', () => setTimeout(() => api(`/api/threads/${t2.id}/interrupt`, 'POST', {}), 4000));
const s6 = (await state()).threads.find((x) => x.id === t2.id);
log(`   stopped after ${((Date.now() - started) / 1000).toFixed(1)}s · still running: ${s6.running}`);

log('\n7) Project brief');
const br = await api(`/api/projects/${project.id}/brief`, 'POST', {});
log(`   brief ${br.brief.length} chars, cost $${br.costUsd?.toFixed(4)}\n   ${br.brief.slice(0, 200).replace(/\n/g, ' | ')}`);

log('\n8) Budget used up');
await api(`/api/threads/${t.id}`, 'PATCH', { budgetUsd: 0.0001 });
await turn(t.id, 'say hi', 'quick');

ws.close();
fs.rmSync(path.join(game, 'assets', 'pixel.png'));
log('\nDONE');
