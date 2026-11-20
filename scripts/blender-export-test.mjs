// Blender export test: Claude (via the Blender helper) exports a model from the open Blender scene into a
// game folder as .glb. Approvals are logged and allowed (the export runs Python in Blender).
// Needs Forge on FORGE_PORT (default 4417) and Blender with the MCP add-on server.
// Usage: node scripts/blender-export-test.mjs <gameDir>
import WebSocket from 'ws';
import fs from 'node:fs';
import path from 'node:path';
const PORT = Number(process.env.FORGE_PORT ?? 4417);
const B = `http://127.0.0.1:${PORT}`;
const H = { Origin: B, 'Content-Type': 'application/json' };
const api = async (u, method = 'GET', body) => (await fetch(B + u, { method, headers: H, body: body ? JSON.stringify(body) : undefined })).json();
const dir = path.resolve(process.argv[2]);
const p = await api('/api/projects', 'POST', { path: dir });
await api(`/api/projects/${p.id}`, 'PATCH', { blender: true });
const t = await api('/api/threads', 'POST', { projectId: p.id, model: 'haiku', effort: 'low', permMode: 'default' });
let events = [], done;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d); if (m.type !== 'event') return; events.push(m.ev);
  if (m.ev.type === 'approval') {
    console.log(`   APPROVAL ${m.ev.tool}:\n     ${m.ev.input.replace(/\\n/g, '\n     ').slice(0, 900)}`);
    await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'allow' });
  }
  if (m.ev.type === 'result' || m.ev.type === 'error') done?.();
});
const fin = new Promise((r) => (done = r));
await api(`/api/threads/${t.id}/message`, 'POST', { text: 'Using Blender: export the object "Cube" from the open scene as a glTF binary to models/cube.glb in this game folder (export only that object). Do not change the scene, do not open other files, do not save the .blend. Then tell me the exported file size.' });
await fin; ws.close();
console.log('tools:', events.filter((e) => e.type === 'tool').map((e) => (e.sub ? 'sub:' : '') + e.name.replace('mcp__blender__', 'blender:')).join(', '));
console.log('reply:', events.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 400));
const f = path.join(dir, 'models', 'cube.glb');
console.log('file:', fs.existsSync(f) ? `${f} (${fs.statSync(f).size} bytes, magic ${fs.readFileSync(f).subarray(0, 4).toString()})` : 'NOT CREATED');
const r = events.find((e) => e.type === 'result');
console.log('turn cost: $' + (r?.turn?.cost ?? 0).toFixed(4), '· changed:', (r?.changed ?? []).join(', ') || '-');
console.log('thread:', t.id, 'project:', p.id);
