// End-to-end test of Forge's ACP turns against the fake agent (no accounts, no cost).
// Needs a Forge server on FORGE_PORT (default 4417) started with FORGE_DEV_FAKE_AGENT=<path to fake-acp-agent.mjs>.
// Usage: node scripts/acp-fake-test.mjs <gameDir>
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
const ok = (c, msg) => console.log(c ? 'PASS' : 'FAIL', msg);
const dir = path.resolve(process.argv[2]);
for (const f of ['fake.txt', 'fake-direct.txt']) fs.rmSync(path.join(dir, f), { force: true });

let events = [], deltas = 0, waiter = null, decision = 'allow';
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d);
  if (m.type === 'delta') deltas++;
  if (m.type !== 'event') return;
  events.push(m.ev);
  if (m.ev.type === 'approval') await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision });
  if (m.ev.type === 'result') { waiter?.(); waiter = null; }
});
const turn = async (id, text, during) => { events = []; deltas = 0; const done = new Promise((r) => (waiter = r)); await api(`/api/threads/${id}/message`, 'POST', { text }); if (during) await during(); await done; return events; };

const providers = await api('/api/providers');
const fake = providers.find((p) => p.id === 'fake');
ok(fake?.installed, 'fake agent listed and installed');
const test = await api('/api/providers/fake/test', 'POST', {});
ok(test.state === 'ready' && test.modes?.length === 2, `Test → ${test.state}, modes ${test.modes?.map((m) => m.name).join('/')}`);

const p = await api('/api/projects', 'POST', { path: dir });
const t = await api('/api/threads', 'POST', { projectId: p.id, provider: 'fake' });
let ev = await turn(t.id, 'please write the file');
ok(deltas > 5, `streamed ${deltas} text deltas`);
ok(ev.some((e) => e.type === 'tool') && ev.some((e) => e.type === 'tool_result' && !e.isError), 'tool step + result shown');
ok(ev.some((e) => e.type === 'approval' && e.options?.length === 3), 'approval card with the agent\'s 3 options');
ok(ev.some((e) => e.type === 'info' && /^Plan:/.test(e.text)), 'plan shown');
const res = ev.find((e) => e.type === 'result');
ok(!res.isError && res.ctx === 4321, `result ok, context ${res.ctx}`);
ok(fs.existsSync(path.join(dir, 'fake.txt')) && fs.existsSync(path.join(dir, 'fake-direct.txt')), 'both files written');
ok((res.changed ?? []).sort().join(',') === 'fake-direct.txt,fake.txt', `Undo covers both: ${(res.changed ?? []).join(', ')}`);
const ch = await api(`/api/threads/${t.id}/changes`);
ok(ch.files.length === 2, `Changes tab lists ${ch.files.length} files`);
await api(`/api/threads/${t.id}/undo`, 'POST', { turnId: res.turnId });
ok(!fs.existsSync(path.join(dir, 'fake.txt')) && !fs.existsSync(path.join(dir, 'fake-direct.txt')), 'Undo removed both new files');

decision = 'deny';
ev = await turn(t.id, 'again please');
ok(ev.some((e) => e.type === 'tool_result' && e.isError) && !fs.existsSync(path.join(dir, 'fake.txt')), 'Decline → agent skipped the write');

decision = 'allow';
const t0 = Date.now();
ev = await turn(t.id, 'slow one', async () => { await new Promise((r) => setTimeout(r, 1500)); await api(`/api/threads/${t.id}/interrupt`, 'POST', {}); });
const r2 = ev.find((e) => e.type === 'result');
ok(r2.text === 'error_during_execution' && Date.now() - t0 < 8000, `Stop ended the turn in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

await api(`/api/threads/${t.id}`, 'PATCH', { acpMode: 'auto' });
const st = (await api('/api/state')).threads.find((x) => x.id === t.id);
ok(st.acpMode === 'auto' && st.acpModes?.length === 2, `agent mode switched to ${st.acpMode}`);
const sw = await fetch(`${B}/api/threads/${t.id}`, { method: 'PATCH', headers: H, body: JSON.stringify({ provider: 'claude' }) });
ok(sw.status === 409, 'switching agent mid-thread is refused (409)');
const u = await api('/api/usage');
ok(u.byModel.some((m) => /subscription/.test(m.model)), `usage recorded as "${u.byModel.find((m) => /subscription/.test(m.model))?.model}"`);
ws.close();
