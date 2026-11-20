// Broader real-turn tryout against a running Forge desktop app (FORGE_PORT, default 4417).
// Usage: node scripts/tryout.mjs <canvasGameCopyDir> <emptyDir> <outDir>
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const [gameDir, emptyDir, out] = process.argv.slice(2);
let events = [], waiter = null;
const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { Origin: B } });
await new Promise((r) => ws.on('open', r));
ws.on('message', async (d) => {
  const m = JSON.parse(d); if (m.type !== 'event') return; events.push(m.ev);
  if (m.ev.type === 'approval') { console.log(`   (approved ${m.ev.tool} ${m.ev.summary})`); await api(`/api/approvals/${m.ev.reqId}`, 'POST', { decision: 'allow' }); }
  if (m.ev.type === 'result' || m.ev.type === 'error') { waiter?.(m.ev); waiter = null; }
});
async function turn(id, text, extra = {}) {
  events = [];
  const done = new Promise((r) => (waiter = r));
  await api(`/api/threads/${id}/message`, 'POST', { text, ...extra });
  const end = await Promise.race([done, sleep(600_000).then(() => ({ type: 'timeout' }))]);
  const tools = events.filter((e) => e.type === 'tool').map((e) => e.name.replace('mcp__forge__', 'forge:'));
  const res = events.find((e) => e.type === 'result');
  console.log(`   tools: ${tools.join(', ') || '-'}`);
  if (events.some((e) => e.type === 'info' && /Done-check/.test(e.text))) console.log('   done-check fired');
  for (const e of events.filter((x) => x.type === 'playtest')) console.log('   playtest:\n     ' + e.steps.join('\n     '));
  for (const e of events.filter((x) => x.type === 'shot')) console.log(`   verify: ${e.src ? 'screenshot' : 'no screenshot (' + e.note + ')'} · ${e.errors} errors, ${e.warnings ?? 0} warnings`);
  console.log(`   reply: ${events.filter((e) => e.type === 'text' && !e.sub).map((e) => e.text).join(' ').replace(/\s+/g, ' ').slice(0, 400)}`);
  console.log(`   end: ${end.type}${end.isError ? ' ' + end.text : ''} · turn $${res?.turn?.cost?.toFixed(4) ?? '?'} · context ${res?.ctx ?? '?'} · changed: ${(res?.changed ?? []).join(', ') || '-'}`);
  return { end, events: [...events], res };
}
const save = async (src, name) => { const r = await fetch(B + src, { headers: { Origin: B } }); const f = path.join(out, name); fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); return f; };

// ---- A: pick on a 2D canvas game (no three.js) ------------------------------------------------
const g = await api('/api/projects', 'POST', { path: path.resolve(gameDir) });
const tA = await api('/api/threads', 'POST', { projectId: g.id, model: 'haiku', effort: 'low', permMode: 'acceptEdits' });
console.log(`\nA) pick on a 2D canvas game (engine ${g.engine}) — thread ${tA.id}`);
console.log('   (opening the visible preview needs the thread open in the window; using the hidden preview to check the pick payload shape instead)');
await api(`/api/threads/${tA.id}/preview`, 'POST', {}); await sleep(4000);
const picked = api(`/api/threads/${tA.id}/eval`, 'POST', { role: 'hidden', code: `(() => { const c = document.querySelector('canvas').getBoundingClientRect(); return [c.width, c.height]; })()` });
console.log('   hidden canvas size:', (await picked).value);

// ---- B: longer playtest ------------------------------------------------------------------------
console.log('\nB) longer playtest (about 15 s of play)');
let r = await turn(tA.id, 'Playtest a short survival run: start from the menu, then for about 12 seconds move in a square (hold W, D, S, A about 3 s each), then read the player HP, level, XP and the number of enemies if you can find it, and take one screenshot at the end. The state is in the top-level variables S and G (G.p is the player). Do not change files. Give a short verdict.');
for (const [i, e] of r.events.filter((x) => x.type === 'playtest').entries()) for (const [j, s] of (e.shots ?? []).entries()) console.log('   saved', await save(s.src, `try-B-${i}-${j}.jpg`));

// ---- C: real change + verify + review + undo ---------------------------------------------------
console.log('\nC) real change with verify, review and undo');
const before = fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8');
r = await turn(tA.id, 'Make the dash recharge twice as fast. Keep the change minimal.');
const ch = await api(`/api/threads/${tA.id}/changes`);
console.log('   Changes tab:', ch.files.map((f) => `${f.file} +${f.added} −${f.removed}: ${f.hunks.flat().filter((o) => o.t !== ' ').map((o) => o.t + o.text.trim().slice(0, 90)).join(' | ')}`).join('; ') || 'none');
if (r.res?.turnId) { await api(`/api/threads/${tA.id}/undo`, 'POST', { turnId: r.res.turnId }); console.log('   undo restored the file:', fs.readFileSync(path.join(gameDir, 'index.html'), 'utf8') === before); }

// ---- D: brand-new game from an empty folder ----------------------------------------------------
console.log('\nD) new game from an empty folder');
fs.mkdirSync(emptyDir, { recursive: true });
const n = await api('/api/projects', 'POST', { path: path.resolve(emptyDir) });
console.log(`   engine when added: ${n.engine}`);
const tD = await api('/api/threads', 'POST', { projectId: n.id, model: 'haiku', effort: 'medium', permMode: 'acceptEdits' });
r = await turn(tD.id, 'Make a tiny breakout game in a single index.html with plain canvas: paddle with arrow keys or A/D, ball, a few rows of bricks, score, and a game over / win message. Keep it under 200 lines.');
const st = (await api('/api/state')).projects.find((p) => p.id === n.id);
console.log(`   engine after the turn: ${st.engine} (web=${st.web}) · files: ${fs.readdirSync(emptyDir).join(', ')}`);
const notes = path.join(process.env.FORGE_DATA ?? 'data', 'progress', `${n.id}.md`);
console.log(`   progress notes written: ${fs.existsSync(notes)}${fs.existsSync(notes) ? ' — ' + fs.readFileSync(notes, 'utf8').split('\n').slice(0, 4).join(' | ') : ''}`);
console.log('\nD2) second turn on the new game (now a web project, so verify/playtest are available)');
r = await turn(tD.id, 'Playtest it briefly: hold the right key for 1 second and check with a read step that the paddle moved, then take a screenshot. Do not change files unless something is broken.');
for (const e of r.events.filter((x) => x.type === 'playtest')) for (const [j, s] of (e.shots ?? []).entries()) console.log('   saved', await save(s.src, `try-D-${j}.jpg`));

const u = await api('/api/usage');
console.log(`\nTotal for this tryout: $${u.totals.all.cost.toFixed(4)} over ${u.totals.all.turns} turns`);
ws.close();
