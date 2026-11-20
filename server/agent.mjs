// Runs Claude (via the Claude Agent SDK) for a thread, with all the token-saving defaults.
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, save, newId, readBrief, briefPath, appendUsage, DATA_DIR } from './store.mjs';
import { engineHint, BINARY_GLOBS } from './engine.mjs';
import { TIERS, routeMessage } from './router.mjs';
import { assetSummary, getErrors, formatErrors, probeConnected, probeCommand, waitForLoad } from './game.mjs';
import { opusRatio, tierOf } from './models.mjs';
import { beginTurn, backupFile, turnFiles } from './checkpoints.mjs';

// Permission modes offered in the UI (Claude Agent SDK names).
export const PERM_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];

// Only the tools a game-dev thread needs. Every tool definition is sent on every request,
// so the ~30 default tools would cost thousands of tokens per turn for nothing.
const CORE_TOOLS = ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
// Auto-allowed. game_eval is deliberately NOT here: it runs code in the game, so Ask mode asks.
const READ_ONLY = ['Read', 'Glob', 'Grep', 'mcp__forge__list_assets', 'mcp__forge__verify_game', 'mcp__forge__progress'];

// Isolation from the user's own Claude setup. Measured: without this, every claude.ai connector
// (Drive, Netlify, Docs, ...) is announced again in each turn's history, ~10-15k tokens per turn.
const ISOLATION = {
  settingSources: [],                                  // no CLAUDE.md / plugins / hooks from disk
  strictMcpConfig: true,                               // only the MCP servers Forge passes
  settings: { disableClaudeAiConnectors: true },       // no claude.ai cloud connectors
  env: { ...process.env, CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' }, // helpers finish inside the turn
};

// Cheap helper agents. The main (expensive) model delegates reading-heavy or mechanical work to
// these and only gets a short summary back, which keeps its own context small.
const HELPERS = {
  scout: {
    description: 'Cheap explorer. Use for any search or reading that spans more than ~3 files: finding where something is defined, how systems connect, what a folder contains. Returns paths, line numbers and short excerpts.',
    model: 'haiku', tools: ['Read', 'Glob', 'Grep'], maxTurns: 15, background: false,
    prompt: 'You explore a game codebase for another agent. Answer exactly what was asked with file paths, line numbers and only the shortest relevant excerpts. At most ~200 words. Never read binary assets (images, models, audio).',
  },
  runner: {
    description: 'Cheap command runner. Use to run builds, tests, linters, export or asset scripts whose output may be long. Returns pass/fail and the relevant error lines only.',
    model: 'haiku', tools: ['Bash', 'Read'], maxTurns: 10, background: false,
    prompt: 'Run the commands you are given in the project. Report: success or failure, the few relevant error lines (with file:line), and a one-line summary. Never paste full logs. Do not edit files.',
  },
  mechanic: {
    description: 'Cheap editor for fully specified mechanical edits: renames across files, changing constants or values, adding a field everywhere, moving code exactly as described. Do not use it for anything needing design judgement.',
    model: 'haiku', tools: ['Read', 'Edit', 'Glob', 'Grep'], maxTurns: 20, background: false,
    prompt: 'Apply exactly the edits described, nothing more. Reply with the list of files changed (one line each). If the instruction is ambiguous, stop and say what is unclear instead of guessing.',
  },
};

const GAME_BASE = `http://127.0.0.1:${Number(process.env.FORGE_PORT ?? 4317) + 1}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const txt = (text) => ({ type: 'text', text });

// Makes sure a page of this thread's game is connected: the visible Play tab, or (desktop app) a hidden preview.
async function ensurePreview(thread) {
  if (probeConnected(thread.id)) return true;
  globalThis.forgeEnsurePreview?.(`${GAME_BASE}/play/${thread.id}/`);
  await waitForLoad(thread.id, 0, 12_000);
  return probeConnected(thread.id);
}

// Project progress notes live in Forge's data folder (never in the game folder, never in the system prompt).
export const progressPath = (projectId) => path.join(DATA_DIR, 'progress', `${projectId}.md`);
export const readProgress = (projectId) => { try { return fs.readFileSync(progressPath(projectId), 'utf8'); } catch { return ''; } };

function forgeTools(project, thread, turn, emit) {
  const tools = [
    tool('list_assets', 'List the game\'s asset files (images, models, audio, scenes) grouped by kind with sizes. Use this instead of globbing for assets.', {},
      async () => ({ content: [txt(assetSummary(project.path))] }), { annotations: { readOnlyHint: true } }),
    tool('progress', 'Read or replace this project\'s progress notes (goals, features with done/todo, decisions, known bugs). Stored by Forge, not in the game folder. Keep them under ~60 lines.',
      { action: z.enum(['read', 'write']), text: z.string().max(6000).optional().describe('Full new notes when action is write') },
      async ({ action, text }) => {
        if (action === 'read') return { content: [txt(readProgress(project.id) || '(no progress notes yet)')] };
        if (!text?.trim()) return { content: [txt('Nothing written: pass the full notes in `text`.')], isError: true };
        fs.mkdirSync(path.dirname(progressPath(project.id)), { recursive: true });
        fs.writeFileSync(progressPath(project.id), text.trim() + '\n');
        emit({ type: 'info', text: 'Progress notes updated' });
        return { content: [txt('Progress notes saved.')] };
      }),
  ];
  if (project.web) {
    tools.push(
      tool('verify_game', 'Reload the live game preview, wait for it, and return its runtime errors plus a screenshot of the main canvas. Call this after changing the game and before saying you are done. HTML menus/HUD outside the canvas are not in the screenshot.', {},
        async () => {
          turn.verifiedAt = Date.now();
          if (!(await ensurePreview(thread))) return { content: [txt('NOT VERIFIED: no game preview is open for this thread. Tell the user to open the Play tab (or use the Forge desktop app) and check the game.')] };
          const t0 = Date.now();
          await probeCommand(thread.id, 'reload');
          if (!(await waitForLoad(thread.id, t0, 12_000))) return { content: [txt('NOT VERIFIED: the preview did not reload within 12 s.')] };
          await sleep(1500); // let the first frames run and errors arrive
          let shot = await probeCommand(thread.id, 'shot');
          if (['no canvas on the page', 'not drawing frames'].includes(shot.error) && globalThis.forgeEnsurePreview) {
            // The visible preview may be collapsed (narrow window) or not drawing (minimized):
            // use the hidden, always-rendering preview instead.
            const t1 = Date.now();
            globalThis.forgeEnsurePreview(`${GAME_BASE}/play/${thread.id}/`, { fresh: true });
            if (await waitForLoad(thread.id, t1, 12_000)) { await sleep(1500); shot = await probeCommand(thread.id, 'shot'); }
          }
          if (shot.error === 'no canvas on the page') shot.error = 'no visible canvas (the game draws nothing, or the Play panel is collapsed because the window is narrow)';
          if (shot.error === 'not drawing frames') shot.error = 'the preview is not drawing frames (window minimized or in the background)';
          const errs = getErrors(thread.id);
          const nErr = errs.filter((e) => e.kind !== 'warn').length, nWarn = errs.length - nErr;
          emit({ type: 'shot', image: shot.image ?? null, errors: nErr, warnings: nWarn, note: shot.error ?? '' });
          const content = [txt(errs.length ? `After reload: ${nErr} error(s), ${nWarn} warning(s):\n${formatErrors(errs)}` : 'No runtime errors or warnings after reload.')];
          if (shot.image) content.push({ type: 'image', data: shot.image.split(',')[1], mimeType: 'image/jpeg' }, txt(`Screenshot of the main canvas, ${shot.w}x${shot.h} (canvas ${shot.canvas}).`));
          else content.push(txt(`No screenshot: ${shot.error ?? 'unknown reason'}.`));
          return { content };
        }, { annotations: { readOnlyHint: true } }),
      tool('game_eval', 'Run a JavaScript expression inside the live game page and return its JSON value (max 4000 chars). Use it to inspect state (object counts, positions, FPS, globals) instead of guessing. Do not use it to change the game permanently; edit the files for that.',
        { code: z.string().max(4000) },
        async ({ code }) => {
          if (!(await ensurePreview(thread))) return { content: [txt('No game preview is open for this thread.')], isError: true };
          const r = await probeCommand(thread.id, 'eval', { code });
          return r.error ? { content: [txt(`Error: ${r.error}`)], isError: true } : { content: [txt(r.value)] };
        }),
    );
  }
  return createSdkMcpServer({ name: 'forge', tools });
}

function systemAppend(project) {
  const brief = readBrief(project.id);
  return [
    `You are working on a game project. Engine: ${project.engine}. ${engineHint(project.engine)}`,
    'Token discipline (this tool is optimised for low token use):',
    `- ${brief ? 'The project brief below replaces exploring: open only the files you need.' : 'There is no project brief yet; explore only as much as the task needs.'}`,
    '- Delegate searches across more than ~3 files to the `scout` agent, long-output commands to `runner`, and fully specified mechanical edits to `mechanic`. They run on a cheaper model and return summaries.',
    '- Never Read binary assets; use mcp__forge__list_assets.',
    project.web ? '- After changing the game, call mcp__forge__verify_game (reloads the preview, returns runtime errors and a screenshot) and fix what it shows before you finish. Use mcp__forge__game_eval to inspect live state instead of guessing.' : '',
    '- Project progress notes are kept with mcp__forge__progress (not in the game folder). Read them at the start of a new task if they are not already in the conversation; after finishing a feature or making a decision, write the updated notes.',
    '- If the project is nearly empty and has no progress notes, first write a short feature list with mcp__forge__progress, scaffold the game, then build the features one at a time.',
    '- Keep replies short: what changed, where, and anything the user must check.',
    brief ? `\n## Project brief\n${brief}` : '',
  ].filter(Boolean).join('\n');
}

// --- running turns ---------------------------------------------------------------------------

const running = new Map();   // threadId -> { q, finish }
const pending = new Map();   // approval reqId -> { resolve, threadId, suggestions, toolName }

// Price ratio vs Opus 5.5 (input and output scale the same way), used for the "saved" estimate.

function summarizeTool(name, input, cwd) {
  const i = input ?? {};
  let v = String(i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.description ?? i.prompt ?? '');
  if (cwd) v = v.split(cwd + '\\').join('').split(cwd + '/').join('').split(cwd).join('.'); // show project-relative paths
  return v.replace(/\s+/g, ' ').slice(0, 160);
}
const resultText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => b.text ?? '').join('') : '');

// Number of tool approvals a thread is waiting on (drives the "Approval" badge in the sidebar).
export function awaitingCount(threadId) { let n = 0; for (const p of pending.values()) if (p.threadId === threadId) n++; return n; }

// A turn counts as running until its result arrives; the SDK process may linger a moment after that.
// The SDK reports usage cumulatively per session. Turn it into per-turn deltas, add them to the
// thread's lifetime totals, and append one record per turn to the usage history.
const FIELDS = ['in', 'out', 'cacheRead', 'cacheWrite', 'cost'];
function recordTurnUsage(thread, m, { tier, ctx, kind = 'turn' }) {
  const cur = {};
  for (const [model, u] of Object.entries(m.modelUsage ?? {})) {
    cur[model] = { in: u.inputTokens ?? 0, out: u.outputTokens ?? 0, cacheRead: u.cacheReadInputTokens ?? 0, cacheWrite: u.cacheCreationInputTokens ?? 0, cost: u.costUSD ?? 0 };
  }
  const prev = thread.sessionTotals?.sessionId === m.session_id ? thread.sessionTotals.byModel : {};
  const perModel = {};
  for (const [model, c] of Object.entries(cur)) {
    const p = prev[model] ?? {};
    const restarted = c.cost < (p.cost ?? 0);              // new session: totals started over
    const d = Object.fromEntries(FIELDS.map((f) => [f, restarted ? c[f] : Math.max(0, c[f] - (p[f] ?? 0))]));
    if (FIELDS.some((f) => d[f] > 0)) perModel[model] = d;
  }
  thread.sessionTotals = { sessionId: m.session_id, byModel: cur };

  const usage = (thread.usage ??= { costUsd: 0, ifAllOpusUsd: 0, byModel: {} });
  let cost = 0, ifOpus = 0;
  for (const [model, d] of Object.entries(perModel)) {
    const t = (usage.byModel[model] ??= { in: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    for (const f of FIELDS) t[f] += d[f];
    cost += d.cost; ifOpus += d.cost * opusRatio(model);
  }
  usage.costUsd += cost; usage.ifAllOpusUsd += ifOpus;
  usage.turns = (usage.turns ?? 0) + 1;
  const rec = { t: Date.now(), kind, threadId: thread.id, projectId: thread.projectId, tier, perModel, cost, ifOpus, ctx, ms: m.duration_ms, error: !!m.is_error };
  appendUsage(rec);
  return rec;
}

export function isRunning(threadId) { const r = running.get(threadId); return !!r && !r.resultSeen; }

export async function runTurn({ thread, project, text, override, broadcast, onTurnEnd }) {
  const prev = running.get(thread.id);
  if (prev && !prev.resultSeen) throw new Error('thread is already running');
  if (prev) await Promise.race([prev.ended, new Promise((r) => setTimeout(r, 20_000))]); // let the old process exit
  const emit = (ev) => { ev.t = Date.now(); appendEvent(thread.id, ev); broadcast({ type: 'event', threadId: thread.id, ev }); };

  // maxBudgetUsd counts only spend since this query() started, and every turn is a new query(),
  // so pass what is left of the thread's budget.
  let budgetLeft;
  if (thread.budgetUsd) {
    budgetLeft = thread.budgetUsd - (thread.usage?.costUsd ?? 0);
    if (budgetLeft <= 0) throw new Error(`Thread budget of $${thread.budgetUsd} is used up (≈ $${(thread.usage?.costUsd ?? 0).toFixed(3)}). Raise it to continue.`);
  }

  // Model: a model picked in the menu wins; otherwise the zero-token router picks per message.
  const fixedModel = thread.model && thread.model !== 'auto' ? thread.model : null;
  const route = fixedModel
    ? { tier: tierOf(fixedModel), reason: 'chosen by you' }
    : routeMessage(text, { override, lastTier: thread.lastTier, lastContextTokens: thread.lastContextTokens ?? 0 });
  const tier = TIERS[route.tier];
  const model = fixedModel ?? tier.model;
  const effort = thread.effort && thread.effort !== 'auto' ? thread.effort : tier.effort;
  const permissionMode = PERM_MODES.includes(thread.permMode) ? thread.permMode : thread.autoEdits ? 'acceptEdits' : 'default';
  const turnId = beginTurn(thread.id, thread.cwd); // file checkpoint for "Undo this turn"
  emit({ type: 'user', text, tier: route.tier, reason: route.reason, model, effort, permissionMode, turnId });

  // If the user undid earlier turns, tell Claude once, so it doesn't assume its old edits are still there.
  const note = thread.pendingNote;
  if (note) { delete thread.pendingNote; save(); }
  // First message of a thread: hand over the project's progress notes in the message itself
  // (not the system prompt, which would invalidate the cache whenever the notes change).
  const progress = !thread.sessionId ? readProgress(project.id) : '';
  const modelText = [note && `[Forge note: ${note}]`, progress && `[Forge: project progress notes]\n${progress}`, text].filter(Boolean).join('\n\n');

  // Per-turn state for the done-check.
  const turn = { editedAt: 0, verifiedAt: 0, interrupted: false, guarded: false };

  let finish;
  const done = new Promise((r) => { finish = r; });
  async function* input() {
    yield { type: 'user', session_id: thread.sessionId ?? '', parent_tool_use_id: null, message: { role: 'user', content: modelText } };
    await done; // keep the input stream open so interrupt() works, until the turn ends
  }

  const canUseTool = (toolName, toolInput, { signal, suggestions }) => new Promise((resolve) => {
    // Plan mode: Claude hands in its plan with ExitPlanMode. Show it as a plan card and end the
    // turn there; the user switches permissions and says "go ahead" to carry it out.
    if (toolName === 'ExitPlanMode') {
      let plan = toolInput?.plan;
      if (!plan && toolInput?.planFilePath) { try { plan = fs.readFileSync(toolInput.planFilePath, 'utf8'); } catch { /* unreadable */ } }
      emit({ type: 'plan', text: String(plan ?? '(empty plan)') });
      resolve({ behavior: 'deny', message: 'The plan is now shown to the user, who will decide whether to go ahead. End your turn now: no more tool calls, no summary of the plan.' });
      return;
    }
    const reqId = newId();
    pending.set(reqId, { resolve, threadId: thread.id, suggestions, toolName, entry });
    emit({ type: 'approval', reqId, tool: toolName, summary: summarizeTool(toolName, toolInput, thread.cwd), input: JSON.stringify(toolInput, null, 2).slice(0, 4000) });
    signal?.addEventListener('abort', () => { if (pending.delete(reqId)) resolve({ behavior: 'deny', message: 'aborted' }); });
  });

  const abortController = new AbortController();
  const q = query({
    prompt: input(),
    options: {
      cwd: thread.cwd,
      model,
      effort,
      resume: thread.sessionId ?? undefined,
      ...ISOLATION,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemAppend(project) },
      tools: [...CORE_TOOLS, ...(thread.web ? WEB_TOOLS : []), ...(permissionMode === 'plan' ? ['ExitPlanMode'] : [])],
      disallowedTools: BINARY_GLOBS,
      allowedTools: [...READ_ONLY, ...(thread.allowRules ?? [])],
      permissionMode,
      ...(permissionMode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool,
      agents: HELPERS,
      mcpServers: { forge: forgeTools(project, thread, turn, emit) },
      ...(budgetLeft ? { maxBudgetUsd: budgetLeft } : {}),
      abortController,
      includePartialMessages: true, // stream text as it is written
      hooks: {
        // Back up every file right before Claude (or a helper agent) edits it.
        PreToolUse: [{
          matcher: 'Edit|Write|MultiEdit|NotebookEdit',
          hooks: [async (hin) => {
            try { backupFile(thread.id, turnId, thread.cwd, hin.tool_input?.file_path ?? hin.tool_input?.notebook_path); }
            catch (e) { console.warn('checkpoint failed:', e.message); }
            turn.editedAt = Date.now();
            return {};
          }],
        }],
        // Done-check: after editing a browser game, Claude may only finish once it has checked the
        // result with verify_game. Blocks at most once per turn, never after Stop, in Plan mode,
        // for non-web projects, or when nothing was edited.
        Stop: [{
          hooks: [async (hin) => {
            if (hin.stop_hook_active || turn.guarded || turn.interrupted || !project.web || permissionMode === 'plan') return {};
            if (!turn.editedAt || turn.verifiedAt > turn.editedAt) return {};
            turn.guarded = true;
            emit({ type: 'info', text: 'Done-check: Claude changed the game without checking it, so it was asked to verify first.' });
            return { decision: 'block', reason: 'You changed game files in this turn but did not check the result. Call mcp__forge__verify_game once now. If it reports errors or the screenshot looks wrong, fix that; then finish with a short summary.' };
          }],
        }],
      },
    },
  });
  let markEnded;
  const entry = { q, finish, abortController, turn, resultSeen: false, ended: new Promise((r) => { markEnded = r; }) };
  running.set(thread.id, entry);
  let gotResult = false;
  broadcast({ type: 'running', threadId: thread.id, running: true });

  try {
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        emit({ type: 'info', text: `${m.model} · effort ${effort} · ${m.tools.length} tools` });
      } else if (m.type === 'stream_event') {
        // Live text for the main agent only; not saved (the finished text block is).
        const e = m.event;
        if (m.parent_tool_use_id == null && e?.type === 'content_block_delta' && e.delta?.type === 'text_delta') {
          broadcast({ type: 'delta', threadId: thread.id, text: e.delta.text });
        }
      } else if (m.type === 'assistant') {
        const sub = m.parent_tool_use_id != null;
        if (!sub && m.message.usage) {
          const u = m.message.usage;
          thread.lastContextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
        if (m.error) continue; // the result message reports it once
        for (const b of m.message.content ?? []) {
          if (b.type === 'text' && b.text.trim()) emit({ type: 'text', text: b.text, sub });
          else if (b.type === 'tool_use' && b.name !== 'ExitPlanMode') emit({ type: 'tool', id: b.id, name: b.name, summary: summarizeTool(b.name, b.input, thread.cwd), sub });
        }
      } else if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (b.type === 'tool_result') emit({ type: 'tool_result', id: b.tool_use_id, text: resultText(b.content).slice(0, 3000), isError: !!b.is_error, sub: m.parent_tool_use_id != null });
        }
      } else if (m.type === 'result') {
        const turnUsage = recordTurnUsage(thread, m, { tier: route.tier, ctx: thread.lastContextTokens });
        thread.lastTier = route.tier;
        // Remember the session only once a turn really ran; always keep the latest id.
        if (m.session_id && !m.is_error) thread.sessionId = m.session_id;
        thread.updated = Date.now();
        save();
        emit({ type: 'result', isError: m.is_error, text: m.is_error ? (m.result ?? m.subtype) : '', turnMs: m.duration_ms, usage: thread.usage, turn: turnUsage, ctx: thread.lastContextTokens, turnId, changed: turnFiles(thread.id, turnId) });
        gotResult = true;
        entry.resultSeen = true;
        broadcast({ type: 'running', threadId: thread.id, running: false });
        finish();
      }
    }
  } catch (err) {
    if (!gotResult) emit({ type: 'error', text: String(err?.message ?? err) });
  } finally {
    finish();
    for (const [id, p] of pending) if (p.entry === entry) { pending.delete(id); p.resolve({ behavior: 'deny', message: 'turn ended' }); }
    if (running.get(thread.id) === entry) running.delete(thread.id);
    markEnded();
    try { onTurnEnd?.(); } catch { /* best effort */ }
    broadcast({ type: 'running', threadId: thread.id, running: isRunning(thread.id) });
  }
}

// Returns the thread id the approval belonged to, or null if it was unknown/expired.
export function answerApproval(reqId, decision, findThread) {
  const p = pending.get(reqId);
  if (!p) return null;
  pending.delete(reqId);
  const thread = findThread(p.threadId);
  if (decision === 'deny') p.resolve({ behavior: 'deny', message: 'The user denied this action.' });
  else {
    if (decision === 'always' && thread) {
      // Remember as allow rules for later turns of this thread (each turn is a fresh process).
      const rules = (p.suggestions ?? []).flatMap((s) => s.rules ?? []).map((r) => (r.ruleContent ? `${r.toolName}(${r.ruleContent})` : r.toolName));
      thread.allowRules = [...new Set([...(thread.allowRules ?? []), ...(rules.length ? rules : p.toolName === 'Bash' ? [] : [p.toolName])])]; // never blanket-allow all Bash
      save();
    }
    p.resolve({ behavior: 'allow', updatedPermissions: decision === 'always' ? p.suggestions : undefined });
  }
  appendEvent(p.threadId, { type: 'approval_done', reqId, decision, t: Date.now() });
  return p.threadId;
}

export async function interrupt(threadId) {
  const r = running.get(threadId);
  if (!r) return false;
  r.turn.interrupted = true; // the done-check never fights the Stop button
  await r.q.interrupt().catch(() => {});
  // If the SDK doesn't wrap up on its own, hard-stop so the thread can't stay "running" forever.
  setTimeout(() => { if (running.get(threadId) === r) { r.abortController.abort(); r.finish(); } }, 10_000);
  return true;
}

// "Fresh thread from summary": one cheap Haiku call turns a long thread's log into a handoff note,
// so work can continue in a new thread with a small context instead of re-reading the whole history.
export async function summarizeThread(project, oldThread, events) {
  const lines = [];
  for (const e of events) {
    if (e.type === 'user') lines.push(`USER: ${e.text}`);
    else if (e.type === 'text' && !e.sub) lines.push(`ASSISTANT: ${e.text}`);
    else if (e.type === 'plan') lines.push(`PLAN: ${e.text}`);
    else if (e.type === 'result' && e.changed?.length) lines.push(`(files changed: ${e.changed.join(', ')})`);
    else if (e.type === 'undone') lines.push(`(user undid changes to: ${(e.files ?? []).join(', ')})`);
  }
  const log = lines.join('\n').slice(-24_000); // most recent part if very long
  const q = query({
    prompt: `Write a handoff note (at most 200 words) for a fresh coding agent continuing this game-dev conversation: the goal, what has been done (with file names), the current state, and the open issues or next steps. Output only the note.\n\n${log}`,
    options: { cwd: project.path, model: 'haiku', effort: 'low', ...ISOLATION, maxTurns: 1, tools: [], permissionMode: 'dontAsk' },
  });
  for await (const m of q) {
    if (m.type === 'result') {
      if (m.is_error) throw new Error(m.result ?? m.subtype);
      recordTurnUsage({ id: oldThread.id, projectId: project.id }, m, { tier: 'quick', ctx: 0, kind: 'handoff' });
      return { note: m.result.trim(), costUsd: m.total_cost_usd };
    }
  }
  throw new Error('no result');
}

// One cheap Haiku pass that writes a ~250-word project brief. Every later turn gets the brief
// in its (cached) system prompt, so the expensive model stops re-exploring the project.
export async function buildBrief(project) {
  const q = query({
    prompt: `Write a project brief for another coding agent, at most 250 words of markdown: engine/framework, how to run it, entry points, a file map (key source files, one line each), main systems and how they connect, conventions. Output only the brief.\n\nAsset files (do not read them):\n${assetSummary(project.path)}`,
    options: {
      cwd: project.path, model: 'haiku', effort: 'low', ...ISOLATION, maxTurns: 25,
      tools: ['Read', 'Glob', 'Grep'], allowedTools: ['Read', 'Glob', 'Grep'], disallowedTools: BINARY_GLOBS, permissionMode: 'dontAsk',
    },
  });
  for await (const m of q) {
    if (m.type === 'result') {
      if (m.is_error) throw new Error(m.result ?? m.subtype);
      fs.writeFileSync(briefPath(project.id), m.result.trim());
      // Briefs count in the usage history too (attributed to the project, no thread).
      recordTurnUsage({ id: null, projectId: project.id }, m, { tier: 'quick', ctx: 0, kind: 'brief' });
      return { brief: m.result.trim(), costUsd: m.total_cost_usd };
    }
  }
  throw new Error('no result');
}
