// Forge server: HTTP API + WebSocket events + static UI + game preview. Local only (127.0.0.1).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { getState, save, newId, readEvents, readBrief, deleteThreadLog, appendEvent } from './store.mjs';
import { undoFrom, deleteCheckpoints, threadChanges, rejectFile } from './checkpoints.mjs';
import { lineDiff } from './diff.mjs';
import { blenderStatus, blenderHolder } from './blender.mjs';
import { usageStats } from './stats.mjs';
import { saveShot, shotUrl, readShot, deleteShots } from './shots.mjs';
import { detectEngine, isWebEngine, IGNORE_DIRS, refreshEngine } from './engine.mjs';
import { repoRoot, createWorktree, diff, commit } from './git.mjs';
import { serveGame, listAssets, pushError, getErrors, safeJoin, attachProbe, probeCommand } from './game.mjs';
import { runTurn, answerApproval, interrupt, buildBrief, isRunning, awaitingCount, PERM_MODES, summarizeThread } from './agent.mjs';
import { getModels } from './models.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.FORGE_PORT ?? 4317);
const GAME_PORT = PORT + 1;
// Resolve files relative to this module, not the working directory (the packaged app runs from anywhere).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, '..', 'public');

const state = getState();
const findProject = (id) => state.projects.find((p) => p.id === id);
const findThread = (id) => state.threads.find((t) => t.id === id);

// --- websocket broadcast ---------------------------------------------------------------------
let wss;
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const c of wss?.clients ?? []) if (c.readyState === 1) c.send(s); };

// --- live reload: watch web game folders ---------------------------------------------------------
const watched = new Map();
function watchDir(dir, projectId) {
  if (watched.has(dir)) return;
  try {
    let timer = null;
    const w = fs.watch(dir, { recursive: true }, (_ev, file) => {
      if (!file || file.split(/[\\/]/).some((part) => IGNORE_DIRS.has(part))) return;
      clearTimeout(timer);
      timer = setTimeout(() => broadcast({ type: 'reload', projectId, dir }), 300);
    });
    watched.set(dir, w);
  } catch (e) { console.warn('watch failed', dir, e.message); }
}
for (const p of state.projects) if (p.web) watchDir(p.path, p.id);
for (const t of state.threads) { const p = findProject(t.projectId); if (p?.web && t.cwd !== p.path) watchDir(t.cwd, p.id); }

// --- helpers ---------------------------------------------------------------------------------------
const json = (res, code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
async function body(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 1e6) throw new Error('body too large'); }
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
// Re-detects the engine (e.g. an empty folder that now holds index.html) and turns on preview + watching.
function checkEngine(project) {
  if (!project || !refreshEngine(project)) return;
  save();
  if (project.web) {
    watchDir(project.path, project.id);
    for (const t of state.threads) if (t.projectId === project.id && t.cwd !== project.path) watchDir(t.cwd, project.id);
  }
  broadcast({ type: 'state' });
}
const publicThread = (t) => ({ ...t, running: isRunning(t.id), awaiting: awaitingCount(t.id) });

// --- routes ----------------------------------------------------------------------------------------
async function api(req, res, parts) {
  const [a, id, b] = parts; // /api/<a>/<id>/<b>
  const m = req.method;

  if (a === 'state' && m === 'GET') return json(res, 200, { projects: state.projects, threads: state.threads.map(publicThread), gamePort: GAME_PORT });
  if (a === 'usage' && m === 'GET') return json(res, 200, usageStats(state));
  if (a === 'models' && m === 'GET') return json(res, 200, await getModels(id === 'refresh'));
  if (a === 'blender' && m === 'GET') {             // is Blender reachable, and which thread is using it
    const s = await blenderStatus();
    return json(res, 200, { ...s, holder: blenderHolder() });
  }
  if (a === 'shots' && id && b && m === 'GET') {   // stored screenshots (verify, pick, playtest)
    const buf = readShot(id, b);
    if (!buf) return res.writeHead(404).end();
    return res.writeHead(200, { 'Content-Type': b.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'max-age=86400' }).end(buf);
  }

  if (a === 'projects' && !id && m === 'POST') {
    const { path: dir } = await body(req);
    const full = path.resolve(String(dir ?? ''));
    if (!dir || !fs.existsSync(full) || !fs.statSync(full).isDirectory()) return json(res, 400, { error: 'folder not found' });
    const existing = state.projects.find((p) => p.path.toLowerCase() === full.toLowerCase());
    if (existing) return json(res, 200, existing);
    const engine = detectEngine(full);
    const project = { id: newId(), name: path.basename(full), path: full, engine, web: isWebEngine(engine), repo: await repoRoot(full) };
    state.projects.push(project); save();
    if (project.web) watchDir(full, project.id);
    return json(res, 200, project);
  }

  if (a === 'projects' && id) {
    const project = findProject(id);
    if (!project) return json(res, 404, { error: 'no project' });
    if (!b && m === 'DELETE') {          // forget the project in Forge; files on disk are not touched
      if (state.threads.some((t) => t.projectId === id && isRunning(t.id))) return json(res, 409, { error: 'a thread of this project is running' });
      for (const t of state.threads.filter((x) => x.projectId === id)) { deleteThreadLog(t.id); deleteCheckpoints(t.id); deleteShots(t.id); }
      state.threads = state.threads.filter((t) => t.projectId !== id);
      state.projects = state.projects.filter((p) => p.id !== id);
      watched.get(project.path)?.close(); watched.delete(project.path);
      save(); broadcast({ type: 'state' });
      return json(res, 200, { ok: true });
    }
    if (b === 'assets' && m === 'GET') return json(res, 200, listAssets(project.path));
    if (!b && m === 'PATCH') {                    // project settings (currently: the Blender switch)
      const patch = await body(req);
      if ('blender' in patch) project.blender = !!patch.blender;
      save(); broadcast({ type: 'state' });
      return json(res, 200, project);
    }
    if (b === 'brief' && m === 'GET') return json(res, 200, { brief: readBrief(id) });
    if (b === 'brief' && m === 'POST') {
      try { return json(res, 200, await buildBrief(project)); } catch (e) { return json(res, 500, { error: e.message }); }
    }
  }

  if (a === 'threads' && !id && m === 'POST') {
    const { projectId, title, worktree, model, effort, permMode } = await body(req);
    const project = findProject(projectId);
    if (!project) return json(res, 400, { error: 'no project' });
    const tid = newId();
    let cwd = project.path;
    if (worktree) {
      if (!project.repo) return json(res, 400, { error: 'project is not a git repo' });
      try { cwd = await createWorktree(project.path, project.repo, tid); } catch (e) { return json(res, 500, { error: e.message }); }
      if (project.web) watchDir(cwd, project.id);
    }
    const thread = { id: tid, projectId, title: title || 'New thread', cwd, worktree: !!worktree, created: Date.now(), web: false, budgetUsd: null,
      // New threads start with the model/effort/permissions the user last picked (sent by the UI).
      model: typeof model === 'string' ? model : 'auto', effort: typeof effort === 'string' ? effort : 'auto',
      permMode: PERM_MODES.includes(permMode) ? permMode : 'default' };
    state.threads.push(thread); save();
    return json(res, 200, publicThread(thread));
  }

  if (a === 'threads' && id) {
    const thread = findThread(id);
    if (!thread) return json(res, 404, { error: 'no thread' });
    const project = findProject(thread.projectId);
    if (!b && m === 'PATCH') {
      const patch = await body(req);
      for (const k of ['title', 'web', 'budgetUsd', 'model', 'effort']) if (k in patch) thread[k] = patch[k];
      if ('permMode' in patch) {
        if (!PERM_MODES.includes(patch.permMode)) return json(res, 400, { error: 'unknown permission mode' });
        thread.permMode = patch.permMode; delete thread.autoEdits;
      }
      save(); broadcast({ type: 'thread', thread: publicThread(thread) });
      return json(res, 200, publicThread(thread));
    }
    if (!b && m === 'DELETE') {          // removes the thread and its chat log; a worktree folder is left on disk
      if (isRunning(id)) return json(res, 409, { error: 'thread is running' });
      deleteThreadLog(id); deleteCheckpoints(id); deleteShots(id);
      state.threads = state.threads.filter((t) => t.id !== id);
      save(); broadcast({ type: 'state' });
      return json(res, 200, { ok: true, worktreeLeft: thread.worktree ? thread.cwd : null });
    }
    if (b === 'events' && m === 'GET') { checkEngine(project); return json(res, 200, readEvents(id)); }
    if (b === 'errors' && m === 'GET') return json(res, 200, getErrors(id));
    if (b === 'shot' && m === 'POST') { const { role } = await body(req); return json(res, 200, await probeCommand(id, 'shot', {}, 8000, role ?? null)); }
    if (b === 'eval' && m === 'POST') { const { code, role } = await body(req); return json(res, 200, await probeCommand(id, 'eval', { code: String(code ?? '') }, 8000, role ?? null)); }
    if (b === 'pick' && m === 'POST') {           // let the user click something in the visible game preview
      const r = await probeCommand(id, 'pick', {}, 65_000, 'visible');
      if (r.cancelled || r.error) return json(res, 200, r);
      const file = saveShot(id, r.image);
      // Everything below came from the game page: keep it small and plain.
      const objects = (Array.isArray(r.objects) ? r.objects : []).slice(0, 3).map((o) => ({
        name: String(o.name ?? '').slice(0, 60), type: String(o.type ?? '').slice(0, 30), path: String(o.path ?? '').slice(0, 200),
        geometry: String(o.geometry ?? '').slice(0, 40), color: /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : null,
        position: Array.isArray(o.position) ? o.position.slice(0, 3).map(Number) : null, size: Number(o.size) || null,
      }));
      return json(res, 200, { x: Number(r.x), y: Number(r.y), fx: Number(r.fx), fy: Number(r.fy), w: Number(r.w), h: Number(r.h), three: !!r.three, objects, file, src: shotUrl(id, file) });
    }
    if (b === 'unpick' && m === 'POST') return json(res, 200, await probeCommand(id, 'unpick', {}, 3000, 'visible'));
    if (b === 'preview' && m === 'POST') {        // open the hidden, always-drawing preview (desktop app only)
      if (!globalThis.forgeEnsurePreview) return json(res, 400, { error: 'hidden preview needs the desktop app' });
      globalThis.forgeEnsurePreview(`http://127.0.0.1:${GAME_PORT}/play/${id}/?forge=hidden`);
      return json(res, 200, { ok: true });
    }
    if (b === 'message' && m === 'POST') {
      const { text, tier, attachments } = await body(req);
      if (!text?.trim()) return json(res, 400, { error: 'empty message' });
      if (isRunning(id)) return json(res, 409, { error: 'thread is busy' });
      if (thread.title === 'New thread') { thread.title = text.trim().slice(0, 48); save(); broadcast({ type: 'thread', thread: publicThread(thread) }); }
      checkEngine(project);
      runTurn({ thread, project, text: text.trim(), attachments: Array.isArray(attachments) ? attachments.slice(0, 4) : [], override: tier ?? 'auto', broadcast, onTurnEnd: () => checkEngine(project) })
        .catch((e) => broadcast({ type: 'event', threadId: id, ev: { type: 'error', text: e.message } }))
        .finally(() => broadcast({ type: 'thread', thread: publicThread(thread) }));
      return json(res, 202, { ok: true });
    }
    if (b === 'interrupt' && m === 'POST') return json(res, 200, { ok: await interrupt(id) });
    if (b === 'handoff' && m === 'POST') {        // new thread that starts from a summary of this one
      if (isRunning(id)) return json(res, 409, { error: 'wait until the thread is idle' });
      try {
        const { note, costUsd } = await summarizeThread(project, thread, readEvents(id));
        const nt = { id: newId(), projectId: thread.projectId, title: `↳ ${thread.title}`.slice(0, 60), cwd: thread.cwd, worktree: thread.worktree,
          created: Date.now(), web: thread.web, budgetUsd: thread.budgetUsd, model: thread.model, effort: thread.effort, permMode: thread.permMode,
          pendingNote: `This thread continues an earlier one ("${thread.title}"). Handoff note:\n${note}` };
        state.threads.push(nt); save();
        const ev = { type: 'handoff', from: thread.title, note, costUsd, t: Date.now() };
        appendEvent(nt.id, ev);
        broadcast({ type: 'state' });
        return json(res, 200, publicThread(nt));
      } catch (e) { return json(res, 500, { error: e.message }); }
    }
    if (b === 'changes' && m === 'GET') {         // net changes of this thread per file, as diffs
      const files = threadChanges(id).map((c) => ({ file: c.rel, isNew: !c.existed, deleted: c.current === null, ...lineDiff(c.original, c.current) }));
      return json(res, 200, { files, repo: !!project.repo });
    }
    if (b === 'reject' && m === 'POST') {          // put one file back as it was before this thread
      if (isRunning(id)) return json(res, 409, { error: 'wait until the thread is idle' });
      const { file } = await body(req);
      try {
        rejectFile(id, String(file ?? ''));
        thread.pendingNote = [thread.pendingNote, `The user rejected your changes to ${file}; it is back to how it was before this thread. Re-read it before changing it again.`].filter(Boolean).join(' ');
        save();
        const ev = { type: 'rejected', file, t: Date.now() };
        appendEvent(id, ev); broadcast({ type: 'event', threadId: id, ev });
        return json(res, 200, { ok: true });
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (b === 'undo' && m === 'POST') {           // restore files to how they were before a turn
      if (isRunning(id)) return json(res, 409, { error: 'wait until the thread is idle' });
      const { turnId } = await body(req);
      try {
        const r = undoFrom(id, String(turnId ?? ''));
        thread.pendingNote = `The user undid ${r.turns.length} turn(s) of your changes. These files are back to their earlier state: ${r.files.join(', ') || '(none)'}. Do not assume those edits exist; re-read files before changing them.`;
        save();
        const ev = { type: 'undone', turnId, turns: r.turns, files: r.files, t: Date.now() };
        appendEvent(id, ev); broadcast({ type: 'event', threadId: id, ev });
        return json(res, 200, r);
      } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (b === 'diff' && m === 'GET') {
      if (!project.repo) return json(res, 200, { noRepo: true });
      return json(res, 200, await diff(thread.cwd));
    }
    if (b === 'commit' && m === 'POST') {
      const { message } = await body(req);
      try { return json(res, 200, { out: await commit(thread.cwd, message || thread.title) }); } catch (e) { return json(res, 500, { error: e.message }); }
    }
  }

  if (a === 'approvals' && id && m === 'POST') {
    const { decision } = await body(req);
    const threadId = answerApproval(id, decision, findThread);
    if (threadId) broadcast({ type: 'event', threadId, ev: { type: 'approval_done', reqId: id, decision } });
    return json(res, threadId ? 200 : 404, { ok: !!threadId });
  }

  return json(res, 404, { error: 'unknown route' });
}

// Security: the API can approve tool calls, so only Forge's own page may use it. Game code runs on
// a different port (a different origin), and requests from other sites or rebound hostnames are rejected.
const OK_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const OK_ORIGINS = new Set([...OK_HOSTS].map((h) => `http://${h}`));
const trusted = (req) => OK_HOSTS.has(req.headers.host) && (!req.headers.origin || OK_ORIGINS.has(req.headers.origin));

const server = http.createServer(async (req, res) => {
  try {
    if (!trusted(req)) return res.writeHead(403).end('forbidden origin');
    const url = new URL(req.url, `http://${HOST}`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') {
      if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return res.writeHead(415).end();
      return await api(req, res, parts.slice(1));
    }
    // three.js for the model viewer, served from node_modules (only its build and example modules).
    if (url.pathname.startsWith('/vendor/three/')) {
      const rel = url.pathname.slice('/vendor/three/'.length);
      const f = /^(build|examples\/jsm)\//.test(rel) && safeJoin(path.join(HERE, '..', 'node_modules', 'three'), rel);
      if (!f) return res.writeHead(404).end();
      return fs.readFile(f, (err, buf) => (err ? res.writeHead(404).end() : res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'max-age=86400' }).end(buf)));
    }
    // The router is shared with the browser so the UI can preview which model a message will use.
    const file = url.pathname === '/router.mjs' ? path.join(HERE, 'router.mjs')
      : safeJoin(PUBLIC, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!file) return res.writeHead(403).end();
    fs.readFile(file, (err, buf) => {
      if (err) return res.writeHead(404).end('not found');
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(file)] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type }).end(buf);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

wss = new WebSocketServer({ server, path: '/ws', verifyClient: ({ req }) => trusted(req) && !!req.headers.origin });

// --- game server: separate port = separate origin, so game code cannot reach the API -----------
const gameServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === '__errors' && parts[1] && req.method === 'POST') {   // beacon from the injected probe
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e5) req.destroy(); });
    req.on('end', () => {
      try { if (findThread(parts[1])) { const e = JSON.parse(raw); pushError(parts[1], e); broadcast({ type: 'gameError', threadId: parts[1], e }); } } catch { /* junk */ }
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405).end();
  if (parts[0] === 'play' && parts[1]) {         // /play/<threadId>/... serves that thread's working folder
    const thread = findThread(parts[1]);
    if (!thread) return res.writeHead(404).end();
    if (parts.length === 2 && !url.pathname.endsWith('/')) return res.writeHead(302, { Location: url.pathname + '/' }).end();
    return serveGame(res, thread.cwd, thread.id, parts.slice(2).join('/'));
  }
  if (parts[0] === 'files' && parts[1]) {        // raw asset files for thumbnails (no probe)
    const project = findProject(parts[1]);
    if (!project) return res.writeHead(404).end();
    // Forge's own page (the model viewer) may fetch asset files; game pages are same-origin anyway.
    if (OK_ORIGINS.has(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    return serveGame(res, project.path, project.id, parts.slice(2).join('/'), false);
  }
  res.writeHead(404).end();
});

// Probe sockets from game pages (/__probe/<threadId>?load=<ms>). Only pages served by this game
// server can connect: the Origin must be the game server itself.
const GAME_ORIGINS = new Set([`http://127.0.0.1:${GAME_PORT}`, `http://localhost:${GAME_PORT}`]);
const probeWss = new WebSocketServer({ noServer: true });
gameServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}`);
  const m = url.pathname.match(/^\/__probe\/([a-f0-9]+)$/);
  if (!m || !findThread(m[1]) || !GAME_ORIGINS.has(req.headers.origin)) { socket.destroy(); return; }
  const role = url.searchParams.get('role') === 'hidden' ? 'hidden' : 'visible';
  probeWss.handleUpgrade(req, socket, head, (ws) => attachProbe(m[1], ws, Number(url.searchParams.get('load')) || Date.now(), role));
});

// Resolves once both servers listen; the desktop app awaits this before opening its window.
const listen = (s, port) => new Promise((resolve, reject) => { s.once('error', reject); s.listen(port, HOST, resolve); });
export const ready = Promise.all([listen(server, PORT), listen(gameServer, GAME_PORT)]).then(() => {
  console.log(`Forge running at http://${HOST}:${PORT} (games on :${GAME_PORT})`);
  return { url: `http://${HOST}:${PORT}` };
});
