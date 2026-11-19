# Forge — a minimal, token-frugal agent workbench for game dev

A local web app (in the spirit of T3 Code) that runs Claude on your game projects through the
Claude Agent SDK, using your own Claude login. Server and UI bind to `127.0.0.1` only.

**Desktop app (like T3 Code):** run `release\Forge Setup 0.1.0.exe` (installer) or `release\Forge 0.1.0.exe`
(portable, no install). Data lives in `%APPDATA%\forge\data`.

```
npm install
npm run app        # desktop app from source (Electron)
npm run dist       # build release\Forge Setup 0.1.0.exe + portable Forge 0.1.0.exe
npm start          # server only, use in a browser at http://127.0.0.1:4317
```

If a turn fails with "OAuth session expired", log in once with the bundled CLI:
`node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe auth login`

**Status:** tested end to end with real model turns (`scripts/e2e.mjs`); see `docs/STATUS.md`.

## Workspace (like T3 Code)
- **Projects and thread sessions** in the sidebar: collapsible projects, threads sorted by last activity with
  cost, turns and route, inline rename, delete, and search. Every thread keeps its full chat history.
- **Token usage per turn** in the chat, a **context meter** per thread, and a **Today** total in the sidebar.
- **Usage page**: today / 7 / 30 days / all time, cost per day, and breakdowns by model, route, project and
  thread, plus the last 100 turns. Click a row to open that thread.

## Game-dev features
- **Engine detection** (three.js, Phaser, Pixi, plain web, Godot, Unity, Unreal) with a short engine hint in the prompt.
- **Play tab**: browser games are served from the thread's folder with **live reload** on file changes.
- **Runtime error capture**: a small probe injected into served pages reports errors, rejections and
  console errors/warnings. The agent reads them with the `forge:game_errors` tool, which is far cheaper than screenshots.
- **Assets tab** with image thumbnails; the agent gets `forge:list_assets` instead of globbing.
- **Git (optional)**: diff + commit, and an opt-in worktree per thread. Forge never runs `git init` for you.

## Token-saving design
| Mechanism | Where | What it saves |
|---|---|---|
| **Zero-token model router**: Quick→Haiku/low, Standard→Sonnet/medium, Deep→Opus/high, picked by heuristics (no LLM call); override per message | `server/router.mjs` | Small tweaks run on Haiku (~40× cheaper than Opus) |
| **Sticky routing**: no downgrade once a thread is >25k tokens, because the cache is per model | `router.mjs` | Avoids re-reading the whole thread uncached |
| **Cheap helper agents**: `scout` (search), `runner` (commands), `mechanic` (mechanical edits) on Haiku; the main model gets summaries only | `server/agent.mjs` | Keeps the expensive model's context small |
| **Project brief**: one Haiku pass writes ~250 words, sent (cached) every turn | Brief tab | The expensive model stops re-exploring |
| **Trimmed tool set**: 7 core + 2 Forge tools instead of ~30; web tools opt-in | `agent.mjs` | Thousands of tool-definition tokens per request |
| **Isolation**: no CLAUDE.md/plugins/hooks, no claude.ai connectors, only Forge's MCP tools | `agent.mjs` | Measured: 147k → 16k tokens of context over the same 5 turns |
| **Binary read deny rules** (`Read(**/*.glb)`, png, blend, …) | `engine.mjs` | Stops accidental huge reads |
| **Usage meter**: session cost, cache hit % per model, "saved vs all-Opus" | header | Makes waste visible |
| **Budget cap** per thread (`maxBudgetUsd`) | header | Hard stop |

Data (threads, briefs, worktrees) lives in `./data`, never inside your game folders.
