// Runs Claude (via the Claude Agent SDK) for a thread, with all the token-saving defaults.
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import { appendEvent, save, newId, readBrief, briefPath, appendUsage } from './store.mjs';
import { engineHint, BINARY_GLOBS } from './engine.mjs';
import { TIERS, routeMessage } from './router.mjs';
import { assetSummary, getErrors } from './game.mjs';
import { opusRatio, tierOf } from './models.mjs';
import { beginTurn, backupFile, turnFiles } from './checkpoints.mjs';

// Permission modes offered in the UI (Claude Agent SDK names).
export const PERM_MODES = ['default', 'acceptEdits', 'auto', 'plan', 'bypassPermissions'];

// Only the tools a game-dev thread needs. Every tool definition is sent on every request,
// so the ~30 default tools would cost thousands of tokens per turn for nothing.
const CORE_TOOLS = ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'];
const WEB_TOOLS = ['WebSearch', 'WebFetch'];
const READ_ONLY = ['Read', 'Glob', 'Grep', 'mcp__forge__list_assets', 'mcp__forge__game_errors'];

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

function forgeTools(project) {
  return createSdkMcpServer({
    name: 'forge',
    tools: [
      tool('list_assets', 'List the game\'s asset files (images, models, audio, scenes) grouped by kind with sizes. Use this instead of globbing for assets.', {},
        async () => ({ content: [{ type: 'text', text: assetSummary(project.path) }] }), { annotations: { readOnlyHint: true } }),
      tool('game_errors', 'Runtime errors/warnings reported by the running web game in the Forge Play tab since its last reload. Call after changing a web game to verify it runs.', {},
        async () => {
          const errs = getErrors(project.id);
          const text = errs.length ? errs.map((e) => `[${e.kind}] ${e.msg}`).join('\n') : 'No runtime errors reported (the game must be open in the Play tab for errors to be captured).';
          return { content: [{ type: 'text', text }] };
        }, { annotations: { readOnlyHint: true } }),
    ],
  });
}

function systemAppend(project) {
  const brief = readBrief(project.id);
  return [
    `You are working on a game project. Engine: ${project.engine}. ${engineHint(project.engine)}`,
    'Token discipline (this tool is optimised for low token use):',
    `- ${brief ? 'The project brief below replaces exploring: open only the files you need.' : 'There is no project brief yet; explore only as much as the task needs.'}`,
    '- Delegate searches across more than ~3 files to the `scout` agent, long-output commands to `runner`, and fully specified mechanical edits to `mechanic`. They run on a cheaper model and return summaries.',
    '- Never Read binary assets; use mcp__forge__list_assets.',
    project.web ? '- After changing the game, call mcp__forge__game_errors to check for runtime errors.' : '',
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

export async function runTurn({ thread, project, text, override, broadcast }) {
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
  const modelText = note ? `[Forge note: ${note}]\n\n${text}` : text;

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
      mcpServers: { forge: forgeTools(project) },
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
            return {};
          }],
        }],
      },
    },
  });
  let markEnded;
  const entry = { q, finish, abortController, resultSeen: false, ended: new Promise((r) => { markEnded = r; }) };
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
  await r.q.interrupt().catch(() => {});
  // If the SDK doesn't wrap up on its own, hard-stop so the thread can't stay "running" forever.
  setTimeout(() => { if (running.get(threadId) === r) { r.abortController.abort(); r.finish(); } }, 10_000);
  return true;
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
