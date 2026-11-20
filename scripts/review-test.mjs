// Review test with real turns: Ask-mode approval carries a diff; Changes lists net diffs; Reject restores.
// Needs Forge on FORGE_PORT (default 4417). Usage: node scripts/review-test.mjs <gameDir>
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
const dir = path.resolve(process.argv[2] ?? 'sample-game');
const file = path.join(dir, 'index.html');
const before = fs.readFileSync(file, 'utf8');
let events = [], waiters = [], approvalDiff = null;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d); if (m.type !== 'event') return; events.push(m.ev);
  if (m.ev.type === 'approval') { approvalDiff ??= m.ev.diff; await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'allow' }); }
  if (m.ev.type === 'result' || m.ev.type === 'error') waiters.splice(0).forEach((w) => w(m.ev));
});
const turn = async (id, text) => { events = []; const done = new Promise((r) => waiters.push(r)); await api(`/api/threads/${id}/message`, 'POST', { text }); await done; };

const p = await api('/api/projects', 'POST', { path: dir });
const t = await api('/api/threads', 'POST', { projectId: p.id, model: 'haiku', effort: 'low', permMode: 'default' });
await turn(t.id, 'Set the cube SPEED constant to 2.5. Skip verify_game for this test.');
console.log('approval diff:', approvalDiff ? `+${approvalDiff.added} −${approvalDiff.removed} ` + JSON.stringify(approvalDiff.hunks[0]?.filter((o) => o.t !== ' ').map((o) => o.t + o.text.trim())) : 'none');
let ch = await api(`/api/threads/${t.id}/changes`);
console.log('changes:', ch.files.map((f) => `${f.file} +${f.added} −${f.removed}`).join(', '), '· repo:', ch.repo);
await api(`/api/threads/${t.id}/reject`, 'POST', { file: 'index.html' });
console.log('file restored after reject:', fs.readFileSync(file, 'utf8') === before);
ch = await api(`/api/threads/${t.id}/changes`);
console.log('changes after reject:', ch.files.length);
ws.close();
