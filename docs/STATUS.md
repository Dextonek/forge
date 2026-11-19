# Forge — status (2026-11-19)

Location: `C:\projectG\Forge` (git, branch `main`, no remote yet). After a fresh clone or copy run
`npm ci`; if `node_modules\electron\dist\electron.exe` is missing, run `node node_modules/electron/install.js`.
Builds go to `release\` (git-ignored); rebuild with `npm run dist`.

## Next step
Phase 2 of docs/ROADMAP.md, starting with item 5: screenshot tool + completion guard.

## Done and verified
- Desktop app (Electron): `npm run app` and the packaged `release\win-unpacked\Forge.exe` start, show the native
  window with the "Open game folder…" picker, render the game in the Play tab and reopen the last thread.
  `npm run dist` builds `Forge Setup 0.1.0.exe` (installer) and `Forge 0.1.0.exe` (portable). Both unsigned
  (SmartScreen warns on first run). The installer itself has not been run.
- Real model turns (`npm start` + `node scripts/e2e.mjs`, after `claude.exe auth login`):
  - Router: "change the cube speed to 2" → Haiku, edit made, ≈ $0.004 for the turn.
  - Approvals: Allow, Always (stored as `Edit` rule), Deny (Bash) all behave.
  - Resume: second turn reuses the same session; cost meter is cumulative.
  - Scout helper runs in the foreground (Haiku) for a Sonnet turn and returns a short answer.
  - Stop: interrupt ends the turn in ~4 s; UI shows "Stopped."
  - Brief: Haiku writes ~1.5k chars for ≈ $0.001.
  - Budget: a used-up budget refuses the next turn.
  - Binary deny rule: `Read(**/*.png)` returns a permission error (`node scripts/deny-test.mjs`).
- UI, preview, live reload, error probe, assets, git worktree/diff/commit, security checks (earlier tests).
- T3-style workspace: projects (collapsible, remove), thread sessions (sorted by last activity, cost/turns/route
  per thread, rename inline or by double-clicking the title, delete, search), full chat history per thread.
- Token usage: per-turn line in the chat (per model: input incl. cache, cache hit %, output, cost, context),
  context meter in the thread header, thread totals, sidebar "Today" box.
- Usage page: Today / 7 / 30 days / all-time cards, cost-per-day chart, tables by model, route, project and
  thread, and the last 100 turns. History lives in `data/usage.jsonl` and survives thread deletion.
  Verified with real turns: 7 records (6 turns + brief), totals match.

- Phase 1 of docs/ROADMAP.md (verified with real Haiku turns in the browser UI):
  - Undo per turn: PreToolUse hook backs up files before Edit/Write/MultiEdit/NotebookEdit into
    `data/checkpoints/<thread>/<turn>/`; "Undo" restores that turn and all later ones; Claude gets a note on the
    next message (it then correctly said the earlier edits were undone). Bash-made changes are not covered.
  - Live streaming text (`includePartialMessages`), replaced by the finished block.
  - Plan card buttons "Approve & run" (switches to Auto-accept edits and sends "implement it") and
    "Run, but ask before each change".
- Model menu (account models from `supportedModels()`, effort) and permission menu (Ask, Auto-accept edits,
  Auto classifier, Plan, Full access) — each tested with a real turn (`node scripts/perm-test.mjs`).

## Token findings (measured)
- Base context per turn ≈ 12k tokens (Claude Code system prompt + 9 tools).
- Without isolation, the user's claude.ai connectors (Drive, Netlify, Docs, …) were re-announced every turn:
  context reached 147k tokens after 5 tiny turns and one Sonnet upgrade cost ≈ $1.04.
  Fixed with `strictMcpConfig` + `settings.disableClaudeAiConnectors` → same test: 15.7k tokens, $0.074 total.
- Background tasks disabled (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`) so helpers finish inside the turn.

## Next ideas (not started)
- Keep one Claude process per thread instead of one per turn (faster turns, fewer re-announcements);
  needs live model switching for the router.
- Phone access over Tailscale (needs auth on the API first).
- Headless screenshot tool for visual checks (only if headless Edge renders WebGL).
- Godot/Unity launch buttons once those engines are installed.
- App icon and code signing for the installer.
