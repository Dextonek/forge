# Forge — status (2026-11-19)

Location: `C:\projectG\Forge` (git, branch `main`, no remote yet). After a fresh clone or copy run
`npm ci`; if `node_modules\electron\dist\electron.exe` is missing, run `node node_modules/electron/install.js`.
Builds go to `release\` (git-ignored); rebuild with `npm run dist`.

## Phase 2 (branch `feat/phase-2-harness`) — done and tested with real Haiku turns
- `verify_game`: reloads the thread's preview, waits for the new load, returns errors/warnings (deduplicated,
  counted) and a JPEG of the main canvas (~280 tokens). Probe + error buffer are keyed by **thread**.
  If the visible preview has no size or isn't drawing, the desktop app uses a hidden offscreen preview.
  Test: `node scripts/verify-test.mjs` → screenshot showed the green cube Claude had just made.
- Done-check (Stop hook): after editing a web game without verifying, Claude is sent back once to call
  `verify_game`. Never after Stop, in Plan mode, for non-web projects, or when nothing was edited. Tested.
- `game_eval`: runs JS in the live game (asks in Ask mode).
- Price-aware sticky routing (`scripts/router-sticky-test.mjs`): switches down to Haiku freely, stays on Opus
  instead of Opus→Sonnet once a thread has history.
- Progress notes (`progress` tool, stored in `data/progress/<project>.md`, given with a thread's first message,
  never in the system prompt or the game folder). Test: `node scripts/handoff-test.mjs`.
- "Start a fresh thread from a summary" (options menu, or the "start fresh" link at >60k context): Haiku writes a
  handoff note (≈$0.0005); the new thread started at 14k context and knew the open task.
- Regression: `scripts/e2e.mjs` and `scripts/perm-test.mjs` pass.
- Engine re-detection at turn start/end and when a thread opens (found on the user's RougeLikeSurvival project,
  added while empty and stuck on "unknown"; tested on a copy of the real data → now "web").
- New build run once against a copy of the user's real data: project, thread and usage load correctly.
- Skipped on purpose: one live process per thread. Measured start-up ≈1 s per turn (`scripts/startup-timing.mjs`),
  not worth the risk.
- Testing uses `FORGE_PORT=4417`, `FORGE_DATA=.testdata`, `FORGE_PROFILE=.testprofile` (all git-ignored).

Phase 2 is merged into `main`.

## Phase 3 (branch `feat/phase-3-game-tools`) — done and tested with real Haiku turns
- Probe sockets have a role: `visible` (Play tab) or `hidden` (offscreen preview, URL `?forge=hidden`).
- Pick in game: "Pick" button → click in the Play tab (Esc cancels) → chip with a crosshair-marked screenshot and,
  for three.js, the objects under the click (via three's `__THREE_DEVTOOLS__` hook). Sent only with your next
  message, as labelled data. Test: `scripts/pick-test.mjs` → "Mesh, BoxGeometry, #ff7a1a at the origin".
- Review: Changes tab built on Forge's checkpoints (works without git): net diff per file, Reject per file
  (also blocks later Undo from bringing it back — `scripts/reject-test.mjs`), click a line to comment into the
  message. Ask-mode approval cards show Edit/Write/MultiEdit as a diff. Git diff/commit limited to the game
  folder (`-- .`). Test: `scripts/review-test.mjs`.
- Playtest tool (hidden preview, desktop app only, auto-allowed: keys, holds, clicks, waits, plain-path reads,
  ≤4 screenshots). Test on a copy of the user's RougeLikeSurvival: Enter → S "play", hold D 1 s → G.p.x 0 → 190,
  verdict PASS (`scripts/playtest-test.mjs`).
- Screenshots are stored as files (`data/shots/<thread>/`) and served at `/api/shots/...`.
- Regression (perm-test, verify-test, reject-test, router test) pass.

## Tryout after Phase 3 (branch `fix/new-game-checks`)
- `scripts/tryout.mjs` (longer playtest, real change + review + undo, new game) and `scripts/new-game-test.mjs`.
- Fixed: a game created in an empty folder was not checked in the turn that created it (tools only existed for
  web projects). Game tools now also exist for "unknown" projects and re-detect the engine when used; the
  done-check re-detects too; the engine refresh runs right at the result.
- Fixed: progress notes were skipped for new games; the hint now goes into the message itself.
- Playtest tool tells Claude to read a whole object first to learn field names.
- Result: snake game from an empty folder in one Haiku turn ($0.006): notes → build → verify (it saw the start
  text overlapping the snake and fixed it) → playtest → notes updated.
- The done-check is a nudge: when the user explicitly says "don't check", Claude may decline once and stop.
- The release build is NOT rebuilt with this fix yet (the user's open Forge locks the release folder).

## Blender helper (branch `feat/blender-helper`) — built and tested live (read-only)
- Live tests with Blender 5.2.2 LTS (default scene): `scripts/blender-test.mjs` (file + objects via the helper,
  read-only tools auto-allowed, $0.033) and `scripts/blender-shot-test.mjs` (viewport screenshot, $0.016).
  Blender stayed unchanged (is_dirty false). Images that any non-Forge tool returns (e.g. Blender screenshots
  seen by the helper) are now saved and shown in the chat.
- Export tested (`scripts/blender-export-test.mjs`, branch `feat/model-viewer`): the helper exported the default
  Cube as `models/cube.glb` (1,936 bytes) after one approval of execute_blender_code; it restored the selection;
  Blender stayed unchanged (is_dirty false). Claude now confirms exports with list_assets.
- Files written by Blender are not in Forge's Undo checkpoints (they are not Edit/Write).

## 3D model viewer (branch `feat/model-viewer`)
- Assets tab: click a .glb/.gltf to orbit it (three.js 0.170 served locally from node_modules at /vendor/three).
  Shows triangles, meshes, materials, textures, size, and plays animation clips. Animation-only files show the
  skeleton. Turns that write models show a "View … in 3D" card in the chat.
- Tested on copies of HorseWar models: horse_lod0.glb (7,000 triangles), horse_anim.glb (28 bones, Gallop/Stand/Down).

## GitHub
- Remote `origin` = https://Dextonek@github.com/Dextonek/forge.git (PUBLIC). Pushes go as **Dextonek** through a
  repo-local credential helper that asks `gh auth token --user Dextonek` at push time (no token stored). The global
  gh active account stays penkert-adus. (The SSH key on this machine is penkert-adus, which only has read access.)
- `main` pushed at b08542f (Blender helper). Branch `feat/model-viewer` is local and uncommitted.
- Uses the Blender MCP from the Claude desktop app's Blender extension
  (`%APPDATA%\Claude\Claude Extensions\ant.dir.gh.blender.blender-mcp\.venv\Scripts\blender-mcp.exe`, or
  `FORGE_BLENDER_MCP`). Blender's add-on server listens on localhost:9876 (`FORGE_BLENDER_PORT`).
- Per-project switch (options menu → "Blender helper", or the hint in Assets when .blend files exist).
- A `blender` helper agent (Sonnet) gets the Blender MCP server inline, so its tools never load into the main
  conversation. One thread at a time (Blender is shared state). Read-only Blender tools auto-allowed;
  execute_blender_code asks in Ask mode. The helper must not open other files or save the .blend unless asked;
  exports go to `<game>/models/*.glb`.
- Tested: "Blender not running" path with a real turn (`scripts/blender-test.mjs`) → clear message, no changes.
- NOT tested yet: a live Blender session (Blender was not running; blender.exe not found in Program Files/PATH).

## Not started (needs the user's decision: other systems / network)
- Phone approvals (LAN/Tailscale, needs API auth), Godot/Unity via MCP.

## Next step
Commit Phase 3 on `feat/phase-3-game-tools` after the user's OK.

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
