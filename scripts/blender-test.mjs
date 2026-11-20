// Blender connection test (read-only in Blender). Needs Forge on FORGE_PORT (default 4417).
// Usage: node scripts/blender-test.mjs <gameDir>
import WebSocket from 'ws';
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
console.log('status:', JSON.stringify(await api('/api/blender')));
const p = await api('/api/projects', 'POST', { path: dir });
await api(`/api/projects/${p.id}`, 'PATCH', { blender: true });
const t = await api('/api/threads', 'POST', { projectId: p.id, model: 'haiku', effort: 'low', permMode: 'default' });
let events = [], done;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d); if (m.type !== 'event') return; events.push(m.ev);
  if (m.ev.type === 'approval') { console.log(`   DENIED (test is read-only): ${m.ev.tool} ${m.ev.summary.slice(0, 120)}`); await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'deny' }); }
  if (m.ev.type === 'result' || m.ev.type === 'error') done?.();
});
const fin = new Promise((r) => (done = r));
await api(`/api/threads/${t.id}/message`, 'POST', { text: 'Using Blender: tell me which .blend file is open in Blender and list the objects in its scene (names and types). Read only: do not change, open or save anything.' });
await fin; ws.close();
console.log('tools:', events.filter((e) => e.type === 'tool').map((e) => (e.sub ? 'sub:' : '') + e.name).join(', ') || '-');
console.log('reply:', events.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 500));
const r = events.find((e) => e.type === 'result');
console.log('turn cost: $' + (r?.turn?.cost ?? 0).toFixed(4), '· models:', Object.keys(r?.turn?.perModel ?? {}).join(', '));
