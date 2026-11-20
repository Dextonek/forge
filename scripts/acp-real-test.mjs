// One real turn with an installed ACP agent (e.g. opencode) on a game folder. Approvals are allowed.
// Needs Forge on FORGE_PORT (default 4417). Usage: node scripts/acp-real-test.mjs <providerId> <gameDir> "<prompt>"
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
const [providerId, dir, text] = process.argv.slice(2);
let events = [], deltas = 0, done;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d);
  if (m.type === 'delta') deltas++;
  if (m.type !== 'event') return;
  events.push(m.ev);
  if (m.ev.type === 'approval') { console.log(`   approval: ${m.ev.tool} · ${m.ev.summary} → allow`); await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'allow' }); }
  if (m.ev.type === 'result') done?.();
});
const p = await api('/api/projects', 'POST', { path: path.resolve(dir) });
const t = await api('/api/threads', 'POST', { projectId: p.id, provider: providerId });
const t0 = Date.now();
const fin = new Promise((r) => (done = r));
await api(`/api/threads/${t.id}/message`, 'POST', { text });
await Promise.race([fin, new Promise((r) => setTimeout(r, 300_000))]);
ws.close();
console.log(`time: ${((Date.now() - t0) / 1000).toFixed(1)} s · streamed deltas: ${deltas}`);
for (const e of events.filter((x) => x.type === 'info')) console.log('   info:', e.text.replace(/\n/g, ' | ').slice(0, 200));
console.log('   steps:', events.filter((e) => e.type === 'tool').map((e) => `${e.name}${e.summary ? ' (' + e.summary + ')' : ''}`).join(', ') || '-');
for (const e of events.filter((x) => x.type === 'error')) console.log('   ERROR:', e.text.slice(0, 400));
const shot = events.find((e) => e.type === 'shot');
if (shot) console.log(`   Forge check: ${shot.src ? 'screenshot' : 'no screenshot (' + shot.note + ')'} · ${shot.errors} errors`);
const res = events.find((e) => e.type === 'result');
console.log('   reply:', events.filter((e) => e.type === 'text').map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 400));
console.log(`   result: ${res?.text || 'ok'} · changed: ${(res?.changed ?? []).join(', ') || '-'} · context: ${res?.ctx ?? '?'}`);
console.log('   thread:', t.id);
