// Pick test: asks the visible preview for a pick, simulates the user's click on the overlay, then sends a
// message with the pick to Claude (Haiku). Needs the desktop app on FORGE_PORT with the thread open.
// Usage: node scripts/pick-test.mjs <threadId> <outDir>
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
const PORT = Number(process.env.FORGE_PORT ?? 4417);
const B = `http://127.0.0.1:${PORT}`;
const H = { Origin: B, 'Content-Type': 'application/json' };
const api = async (u, method = 'GET', body) => {
  const r = await fetch(B + u, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${u}: ${r.status} ${JSON.stringify(j)}`);
  return j;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [threadId, out = '.'] = process.argv.slice(2);

// 1) start pick mode, 2) click the middle of the canvas (where the cube is) on the overlay
const pending = api(`/api/threads/${threadId}/pick`, 'POST', {});
await sleep(800);
const clicked = await api(`/api/threads/${threadId}/eval`, 'POST', { role: 'visible', code: `(() => { const ov = [...document.querySelectorAll('div')].find(d => d.style.cursor === 'crosshair'); if (!ov) return 'no overlay'; const c = document.querySelector('canvas').getBoundingClientRect(); ov.dispatchEvent(new MouseEvent('mousedown', { clientX: c.left + c.width / 2, clientY: c.top + c.height / 2, bubbles: true })); return 'clicked'; })()` });
console.log('overlay:', clicked.value ?? clicked.error);
const pick = await pending;
console.log('pick:', JSON.stringify({ ...pick, src: pick.src }).slice(0, 400));
if (pick.src) {
  const img = await fetch(B + pick.src, { headers: { Origin: B } });
  const f = path.join(out, 'pick.jpg'); fs.writeFileSync(f, Buffer.from(await img.arrayBuffer())); console.log('saved', f);
}
// 3) send it with a message and read Claude's answer
let done; const fin = new Promise((r) => (done = r)); const evs = [];
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'event' && m.threadId === threadId) { evs.push(m.ev); if (m.ev.type === 'result' || m.ev.type === 'error') done(); } });
await api(`/api/threads/${threadId}/message`, 'POST', { text: 'What did I click on? Answer in one sentence; do not use tools or change anything.', attachments: [{ kind: 'pick', ...pick }] });
await fin; ws.close();
console.log('user event picks:', JSON.stringify(evs.find((e) => e.type === 'user')?.picks));
console.log('reply:', evs.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' '));
