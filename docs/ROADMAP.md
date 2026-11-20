# Forge — what similar tools do well, and how to beat them (2026-11-19)

Based on four research passes: agent GUIs (T3 Code, Conductor, Claude Code desktop/web, Codex app, Cursor
Cloud Agents, Nimbalyst, Vibe Kanban, opcode, Sculptor, Superset, Happy/Omnara), game-dev AI tools (Rosebud,
Bezi, Unity AI, Coplay, Godot MCPs, Ziva playtest agent, Ludus, Ludo/Scenario/Layer, Meshy/Tripo, Blender MCP),
token/cost techniques, and agent-harness design (Anthropic engineering posts, Manus, Cognition).
Vendor comparisons and marketing numbers are treated as unverified.

## Where the market is
- **Table stakes** for agent GUIs: parallel threads (worktree each), diff review with comments sent back to the
  agent, commit/PR from the app, per-thread status (working / waiting / done), a terminal per workspace.
- **Differentiators**: phone approvals (T3, Happy, Nimbalyst, Claude Dispatch), built-in browser that verifies
  changes with screenshots (Claude Code desktop, Superset, Vibe Kanban), checkpoints + cost analytics (opcode),
  scheduled automations (Codex, Superset).
- **Clever, rare**: mid-thread model hand-off (T3), "design mode" — click a UI element and send it to the agent
  (Superset), per-edit accept/reject (Nimbalyst, Bezi), auto-fix CI and review comments (Claude Code desktop).
- **Gaps / complaints**: many are Mac-only (Conductor, Superset), closed source, or disappearing (Conductor
  acquired and shutting down cloud, Vibe Kanban sunsetting); worktrees don't isolate processes or ports.
- **Game-dev tools** add what generic GUIs lack: run the game and *see* it (screenshots, logs), edit scenes not
  just code, engine-aware context, asset generation in the pipeline, playtest agents with a pass/fail verdict.

## What Forge already has that most don't
Windows-native desktop app · live game preview with runtime-error capture the agent can read · per-turn token and
cost history with a usage dashboard · zero-token model router with cheap helper agents · project brief ·
measured isolation (147k → 16k context over the same 5 turns) · plan / auto / full-access permission modes.

## Important correction from the research
**Per-message model switching fights the prompt cache.** Each model has its own cache, so switching models
mid-thread re-reads the whole history at full price (Anthropic prompt-caching docs; Manus). Forge's router should
pick a model **per task** (first message of a thread, or when the user starts a new task) and only escalate on
failure — not re-route every message.

## Roadmap

### Phase 1 — safety and feel (small, do first)
1. **Permanent home**: move out of the session's temporary folder, make it a git repo.
2. **Checkpoint + Undo per turn**: snapshot changed files before each turn; "Undo this turn" and a restore list.
   Works for games that aren't git repos. (opcode, Nimbalyst, Claude Code rewind)
3. **Live streaming replies** (`includePartialMessages`): text appears as it's written. (T3, every competitor)
4. **"Approve plan & run" button** on plan cards. (Claude Code plan mode, Unity AI Plan mode)

### Phase 2 — a better harness (biggest quality gain) — DONE except item 6's live process (measured ≈1 s start-up, skipped)
5. **Screenshot tool + completion guard** — Forge's edge. The preview already runs inside Forge, so the probe
   can grab the canvas directly (no Playwright). Claude may only say "done" after the game reloaded,
   `game_errors` is empty and a screenshot was taken after the last edit. (Anthropic long-running-agent post:
   browser checks beat unit tests; Ziva playtest agent; Claude Code desktop auto-verify)
6. **One long-lived Claude process per thread** + **cache-aware routing** (per task, escalate on failure) +
   a cache-health readout (hit rate, warning before cache-busting actions). Faster turns, cheaper turns.
7. **Progress file** `FORGE_PROGRESS.json` per project: goals, feature list with `passes` flags, decisions,
   known bugs; read at the start of each turn, updated at the end. **Initializer turn** for new games turns a
   pitch into a feature list + scaffold. (Anthropic "effective harnesses"; Manus "recitation")
8. **Compaction policy**: clear old tool results first (screenshots), then "fresh thread from summary" at a token
   threshold, carrying over the progress file. Never compact a cold cache without warning.
9. **Tool polish**: `game_errors` deduplicated with counts and stack summaries; one powerful `game_eval` probe
   (run JS in the preview: scene object count, FPS, player position) instead of many small tools; trim long
   command output with a hook.

### Phase 3 — things nobody does well for games
10. **Pick-in-game**: click an object in the preview → Forge sends its three.js name, position and source
    location to the chat ("make *this* bigger"). Game version of Superset's design mode.
11. **Playtest agent**: scripted input + screenshots + a pass/fail verdict per feature in the progress file.
12. **Blender + asset pipeline**: Blender MCP (already installed here) for viewport screenshots and exports into
    `models/`; optional Meshy/Tripo generation; Assets tab shows new/changed assets.
13. **Phone approvals** over LAN/Tailscale with push notifications (T3, Happy) — needs auth on the API first.
14. **Inline diff comments + per-edit accept/reject** (Codex, Vibe Kanban, Nimbalyst).
15. **Godot / Unity** through their MCP servers (GDAI MCP, MCP for Unity) with the same screenshot + error gate.

### Cost extras (cheap to add alongside)
- Show cache hit rate per turn and the likely cause of a miss; warn before model/effort switches.
- Estimated cost before sending on Fable or Max effort.
- Router that learns from your overrides.
- Reconcile Forge's cost estimate with real billing (subscription usage vs API prices).

## Sources (main)
- https://github.com/pingdotgg/t3code · https://code.claude.com/docs/en/desktop · https://github.com/superset-sh/superset
- https://github.com/getAsterisk/opcode · https://github.com/Nimbalyst/nimbalyst · https://github.com/BloopAI/vibe-kanban
- https://cursor.com/docs/background-agent · https://developers.openai.com/codex/app/features
- https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://www.anthropic.com/engineering/writing-tools-for-agents · https://claude.com/blog/building-agents-with-the-claude-agent-sdk
- https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus · https://cognition.com/blog/dont-build-multi-agents
- https://code.claude.com/docs/en/costs · https://code.claude.com/docs/en/prompt-caching.md · https://www.anthropic.com/engineering/advanced-tool-use
- https://ziva.sh/blogs/ai-agent-playtest-godot-game · https://github.com/CoplayDev/unity-mcp · https://github.com/3ddelano/gdai-mcp-plugin-godot · https://github.com/ahujasid/blender-mcp
