// Read-only: ask the Blender helper for a viewport screenshot and a description. Approvals are denied.
// Needs Forge on FORGE_PORT (default 4417) and Blender running with the MCP add-on server.
import WebSocket from 'ws';
import path from 'node:path';
const PORT = Number(process.env.FORGE_PORT ?? 4417);
const B = `http://127.0.0.1:${PORT}`;
const H = { Origin: B, 'Content-Type': 'application/json' };
const api = async (u, method = 'GET', body) => {
  const r = await fetch(B + u, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const p = await api('/api/projects', 'POST', { path: path.resolve(process.argv[2] ?? 'sample-game') });
await api(`/api/projects/${p.id}`, 'PATCH', { blender: true });
const t = await api('/api/threads', 'POST', { projectId: p.id, model: 'haiku', effort: 'low', permMode: 'default' });
let events = [], done;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d); if (m.type !== 'event') return; events.push(m.ev);
  if (m.ev.type === 'approval') { console.log(`   DENIED (read-only test): ${m.ev.tool}`); await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'deny' }); }
  if (m.ev.type === 'result' || m.ev.type === 'error') done?.();
});
const fin = new Promise((r) => (done = r));
await api(`/api/threads/${t.id}/message`, 'POST', { text: 'Using Blender: take a screenshot of the Blender window and describe in two sentences what the 3D viewport shows (objects, view angle). Read only: do not change, open or save anything.' });
await fin; ws.close();
console.log('tools:', events.filter((e) => e.type === 'tool').map((e) => (e.sub ? 'sub:' : '') + e.name.replace('mcp__blender__', 'blender:')).join(', '));
console.log('reply:', events.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 500));
const r = events.find((e) => e.type === 'result');
console.log('turn cost: $' + (r?.turn?.cost ?? 0).toFixed(4));
