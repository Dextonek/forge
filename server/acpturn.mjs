// Turns for agents spoken to over ACP (Codex, Gemini, OpenCode, custom). One agent process + session per
// thread, kept alive between turns (an ACP session lives inside the agent process) and closed when idle.
// Mapped onto Forge's chat: streamed text, "Worked for" steps, approval cards, Stop, Undo, and Forge's own
// game check after a turn that changed files (these agents cannot use Forge's tools).
import fs from 'node:fs';
import path from 'node:path';
import { AcpConnection, initialize, isAuthError } from './acp.mjs';
import { getProvider, launchSpec } from './providers.mjs';
import { appendEvent, appendUsage, save, newId, readBrief } from './store.mjs';
import { beginTurn, backupFile, recordOriginal, snapshotProject, snapshotChanges, turnFiles } from './checkpoints.mjs';
import { readProgress, checkGame } from './agent.mjs';
import { formatErrors } from './game.mjs';
import { readShot } from './shots.mjs';
import { lineDiff } from './diff.mjs';
import { engineHint } from './engine.mjs';

const IDLE_MS = 15 * 60_000;
const sessions = new Map(); // threadId -> session
const running = new Map();  // threadId -> { cancelled, done }
const pending = new Map();  // approval reqId -> { resolve, threadId, options }

export const isAcpRunning = (threadId) => running.has(threadId);
export const acpAwaiting = (threadId) => { let n = 0; for (const p of pending.values()) if (p.threadId === threadId) n++; return n; };

function closeSession(threadId) {
  const s = sessions.get(threadId);
  if (!s) return;
  clearTimeout(s.idle);
  sessions.delete(threadId);
  s.conn.close();
}
export function closeAllAcp() { for (const id of [...sessions.keys()]) closeSession(id); }
export const closeAcpThread = closeSession;

const rel = (cwd, p) => { const r = path.relative(cwd, String(p ?? '')); return r && !r.startsWith('..') ? r.split(path.sep).join('/') : String(p ?? ''); };
const textOf = (blocks) => (Array.isArray(blocks) ? blocks : [blocks]).map((b) => b?.type === 'text' ? b.text : b?.type === 'content' ? textOf(b.content) : '').join('');

async function ensureSession(thread, project, emit) {
  let s = sessions.get(thread.id);
  if (s && !s.conn.closed) return s;
  const p = getProvider(thread.provider);
  if (!p) throw new Error('This thread\'s agent is not available any more. Open Providers to add it again.');
  const spec = launchSpec(p);
  if (!spec) throw new Error(`${p.name} is not installed. Open Providers and press Install.`);
  const conn = new AcpConnection(spec.command, spec.args, { cwd: thread.cwd, env: spec.env });
  s = { conn, provider: p, sessionId: null, onUpdate: null, turnId: null };
  conn.onNotification('session/update', (prm) => { if (prm.sessionId === s.sessionId) s.onUpdate?.(prm.update ?? {}); });
  conn.onRequest('session/request_permission', (prm) => askPermission(thread, s, prm, emit));
  conn.onRequest('fs/read_text_file', async ({ path: f, line, limit }) => {
    let text = fs.readFileSync(f, 'utf8');
    if (line || limit) { const lines = text.split('\n'); const from = Math.max(0, (line ?? 1) - 1); text = lines.slice(from, limit ? from + limit : undefined).join('\n'); }
    return { content: text };
  });
  conn.onRequest('fs/write_text_file', async ({ path: f, content }) => {
    if (s.turnId) backupFile(thread.id, s.turnId, thread.cwd, f); // Undo covers writes made through Forge
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    return null;
  });
  conn.onClose = () => { if (sessions.get(thread.id) === s) sessions.delete(thread.id); };

  const init = await initialize(conn);
  s.image = !!init.agentCapabilities?.promptCapabilities?.image;
  let resp = null;
  if (thread.acpSessionId && init.agentCapabilities?.loadSession) {
    try { resp = await conn.request('session/load', { sessionId: thread.acpSessionId, cwd: thread.cwd, mcpServers: [] }, 120_000); s.sessionId = thread.acpSessionId; }
    catch { /* fall back to a new session */ }
  }
  if (!s.sessionId) {
    try { resp = await conn.request('session/new', { cwd: thread.cwd, mcpServers: [] }, 120_000); }
    catch (e) { conn.close(); throw isAuthError(e) ? new Error(`${p.name} is not logged in. Open Providers and press Log in. (${e.message})`) : e; }
    if (thread.acpSessionId) emit({ type: 'info', text: `${p.name} could not resume the earlier conversation, so this is a fresh session (it does not remember earlier turns).` });
    s.sessionId = resp.sessionId; s.fresh = true;
    thread.acpSessionId = resp.sessionId; save();
  }
  const modes = resp?.modes;
  if (modes?.availableModes?.length) {
    thread.acpModes = modes.availableModes.map((m) => ({ id: m.id, name: m.name, description: m.description ?? '' }));
    thread.acpMode = modes.currentModeId;
    if (thread.wantMode && thread.wantMode !== modes.currentModeId && thread.acpModes.some((m) => m.id === thread.wantMode)) {
      try { await conn.request('session/set_mode', { sessionId: s.sessionId, modeId: thread.wantMode }, 30_000); thread.acpMode = thread.wantMode; } catch { /* keep agent default */ }
    }
    save();
  }
  sessions.set(thread.id, s);
  return s;
}

function askPermission(thread, s, prm, emit) {
  return new Promise((resolve) => {
    const reqId = newId();
    pending.set(reqId, { resolve, threadId: thread.id, options: prm.options ?? [] });
    const tc = prm.toolCall ?? {};
    const d = (tc.content ?? []).find((c) => c.type === 'diff');
    emit({ type: 'approval', reqId, tool: tc.title || tc.kind || 'Action', summary: [tc.kind, ...(tc.locations ?? []).map((l) => rel(thread.cwd, l.path))].filter(Boolean).join(' · '),
      input: JSON.stringify(tc.rawInput ?? tc, null, 2).slice(0, 4000), diff: d ? lineDiff(d.oldText ?? null, d.newText, 2) : null,
      options: (prm.options ?? []).map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })) });
  });
}

// Forge's approval card answer -> the agent's matching option.
export function answerAcpApproval(reqId, decision) {
  const p = pending.get(reqId);
  if (!p) return null;
  pending.delete(reqId);
  const want = { allow: ['allow_once', 'allow_always'], always: ['allow_always', 'allow_once'], deny: ['reject_once', 'reject_always'] }[decision] ?? ['reject_once'];
  const opt = want.map((k) => p.options.find((o) => o.kind === k)).find(Boolean);
  p.resolve(opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
  appendEvent(p.threadId, { type: 'approval_done', reqId, decision, t: Date.now() });
  return p.threadId;
}

export async function setAcpMode(thread, modeId) {
  thread.wantMode = modeId; save();
  const s = sessions.get(thread.id);
  if (s && !s.conn.closed) { await s.conn.request('session/set_mode', { sessionId: s.sessionId, modeId }, 30_000); thread.acpMode = modeId; save(); }
}

export async function interruptAcp(threadId) {
  const r = running.get(threadId), s = sessions.get(threadId);
  if (!r || !s) return false;
  r.cancelled = true;
  s.conn.notify('session/cancel', { sessionId: s.sessionId });
  for (const [id, p] of pending) if (p.threadId === threadId) { pending.delete(id); p.resolve({ outcome: { outcome: 'cancelled' } }); }
  setTimeout(() => { if (running.get(threadId) === r) closeSession(threadId); }, 10_000); // agent ignored cancel: stop it
  return true;
}

function intro(project, s) {
  const brief = readBrief(project.id), progress = readProgress(project.id);
  return [
    `[Forge: you are working on a game project in ${project.path}. Engine: ${project.engine}. ${engineHint(project.engine)} Keep replies short: what changed, where, and what the user should check. Forge reloads the game preview and checks it for runtime errors after you change files.]`,
    brief && `[Forge: project brief]\n${brief}`,
    progress && `[Forge: project progress notes]\n${progress}`,
  ].filter(Boolean).join('\n\n');
}

export async function runAcpTurn({ thread, project, text, attachments = [], broadcast, onTurnEnd }) {
  if (running.has(thread.id)) throw new Error('thread is already running');
  const emit = (ev) => { ev.t = Date.now(); appendEvent(thread.id, ev); broadcast({ type: 'event', threadId: thread.id, ev }); };
  const r = { cancelled: false };
  running.set(thread.id, r);
  broadcast({ type: 'running', threadId: thread.id, running: true });
  const turnId = beginTurn(thread.id, thread.cwd);
  const p = getProvider(thread.provider);
  emit({ type: 'user', text, tier: 'standard', reason: 'chosen by you', model: p?.name ?? thread.provider, turnId, provider: true,
    picks: attachments.filter((a) => a?.kind === 'pick').map((a) => ({ src: `/api/shots/${thread.id}/${a.file}`, label: a.objects?.[0]?.type ?? `point ${a.x},${a.y}` })) });
  const t0 = Date.now();
  let s, ctx = null, stopReason = 'error', errorText = '';
  const snap = snapshotProject(thread.cwd);
  if (!snap) emit({ type: 'info', text: 'This project is too large for Forge to snapshot, so Undo only covers files the agent writes through Forge in this turn.' });
  try {
    s = await ensureSession(thread, project, emit);
    s.turnId = turnId;
    clearTimeout(s.idle);
    emit({ type: 'info', text: `${s.provider.name}${thread.acpMode ? ` · mode ${thread.acpModes?.find((m) => m.id === thread.acpMode)?.name ?? thread.acpMode}` : ''}` });
    // Streamed text is kept per message and shown as one block when the agent moves on.
    let buf = '';
    const flush = () => { if (buf.trim()) emit({ type: 'text', text: buf }); buf = ''; };
    const seen = new Set();
    let lastPlan = '';
    s.onUpdate = (u) => {
      switch (u.sessionUpdate) {
        case 'agent_message_chunk': { const t = textOf(u.content); if (t) { buf += t; broadcast({ type: 'delta', threadId: thread.id, text: t }); } break; }
        case 'tool_call': flush(); seen.add(u.toolCallId);
          emit({ type: 'tool', id: u.toolCallId, name: u.title || u.kind || 'tool', summary: [u.kind, ...(u.locations ?? []).map((l) => rel(thread.cwd, l.path))].filter(Boolean).join(' · ') }); break;
        case 'tool_call_update':
          if (!seen.has(u.toolCallId) && (u.title || u.kind)) { seen.add(u.toolCallId); emit({ type: 'tool', id: u.toolCallId, name: u.title || u.kind, summary: (u.locations ?? []).map((l) => rel(thread.cwd, l.path)).join(' · ') }); }
          if (u.status === 'completed' || u.status === 'failed') {
            const out = (u.content ?? []).map((c) => c.type === 'diff' ? `diff ${rel(thread.cwd, c.path)}` : c.type === 'content' ? textOf(c.content) : c.type === 'terminal' ? `terminal ${c.terminalId}` : '').filter(Boolean).join('\n');
            emit({ type: 'tool_result', id: u.toolCallId, text: (out || u.status).slice(0, 3000), isError: u.status === 'failed' });
          }
          break;
        case 'plan': { const p2 = (u.entries ?? []).map((e) => `${e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '…' : '○'} ${e.content}`).join('\n'); if (p2 && p2 !== lastPlan) { lastPlan = p2; emit({ type: 'info', text: `Plan:\n${p2}` }); } break; }
        case 'usage_update': ctx = u.used ?? ctx; break;
        case 'current_mode_update': thread.acpMode = u.currentModeId; save(); broadcast({ type: 'state' }); break;
        default: break; // thoughts, commands, notices: not shown
      }
    };
    const prompt = [];
    const first = s.fresh || !thread.usage?.turns;
    s.fresh = false;
    const preamble = first ? intro(project, s) : '';
    const note = thread.pendingNote; if (note) { delete thread.pendingNote; save(); }
    const picks = attachments.filter((a) => a?.kind === 'pick' && readShot(thread.id, String(a.file ?? '')));
    prompt.push({ type: 'text', text: [preamble, note && `[Forge note: ${note}]`, ...picks.map((a) => `[The user clicked ${a.x},${a.y} px on the ${a.w}x${a.h} game canvas (red crosshair in the screenshot)${a.objects?.[0] ? `; object under the click, as reported by the game page: ${a.objects[0].type} ${a.objects[0].name ?? ''}` : ''}.]`), text].filter(Boolean).join('\n\n') });
    if (s.image) for (const a of picks) prompt.push({ type: 'image', mimeType: 'image/jpeg', data: readShot(thread.id, a.file).toString('base64') });
    const resp = await s.conn.request('session/prompt', { sessionId: s.sessionId, prompt }, 0);
    flush();
    stopReason = resp?.stopReason ?? 'end_turn';
  } catch (e) {
    errorText = String(e?.message ?? e);
    if (r.cancelled) stopReason = 'cancelled';
  }
  // Undo: also record files the agent changed on its own (not through Forge).
  if (snap) for (const c of snapshotChanges(snap, thread.cwd)) recordOriginal(thread.id, turnId, thread.cwd, c.path, c.before);
  const changed = turnFiles(thread.id, turnId);
  // Forge's own check of a browser game after a turn that changed files.
  if (!r.cancelled && !errorText && project.web && changed.length) {
    try {
      const c = await checkGame(thread, emit);
      if (c.notVerified) emit({ type: 'info', text: 'Forge could not check the game after this turn: open the Play tab (or use the desktop app) and look at it.' });
      else if (c.nErr) emit({ type: 'checkErrors', text: formatErrors(c.errs).slice(0, 3000), agent: s?.provider?.name ?? 'the agent' });
    } catch { /* best effort */ }
  }
  // Usage: these subscriptions report no prices; count the turn, cost 0.
  const usage = (thread.usage ??= { costUsd: 0, ifAllOpusUsd: 0, byModel: {} });
  usage.turns = (usage.turns ?? 0) + 1;
  const name = `${p?.name ?? thread.provider} (subscription)`;
  const m = (usage.byModel[name] ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const rec = { t: Date.now(), kind: 'turn', threadId: thread.id, projectId: thread.projectId, tier: 'standard', provider: thread.provider,
    perModel: { [name]: { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }, cost: 0, ifOpus: 0, ctx, ms: Date.now() - t0, error: stopReason !== 'end_turn' };
  void m; appendUsage(rec);
  if (ctx != null) thread.lastContextTokens = ctx;
  thread.updated = Date.now(); save();
  if (errorText && !r.cancelled) emit({ type: 'error', text: errorText });
  emit({ type: 'result', isError: stopReason !== 'end_turn' && stopReason !== 'max_turn_requests', text: stopReason === 'cancelled' ? 'error_during_execution' : stopReason,
    turnMs: Date.now() - t0, usage: thread.usage, turn: rec, ctx, turnId, changed, provider: p?.name });
  if (s) { s.turnId = null; s.onUpdate = null; s.idle = setTimeout(() => closeSession(thread.id), IDLE_MS); }
  running.delete(thread.id);
  broadcast({ type: 'running', threadId: thread.id, running: false });
  try { onTurnEnd?.(); } catch { /* best effort */ }
}
