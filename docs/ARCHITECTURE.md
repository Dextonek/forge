# Forge architecture

## Overview

```
Electron main (electron/main.mjs)
 ├─ imports the Forge server in-process (server/index.mjs)
 │   ├─ UI + API server       127.0.0.1:4317  (FORGE_PORT)      ← the window loads this
 │   └─ game preview server   127.0.0.1:4318  (FORGE_PORT + 1)  ← games run here (separate origin)
 ├─ main window (public/index.html, app.js, style.css, viewer.js)
 └─ hidden offscreen preview windows (verify / playtest fallback)

Claude turns  → Claude Agent SDK query() per turn (resume), Forge MCP tools in-process
Other agents  → ACP over stdio, one agent process + session per thread
```

Plain ES modules, no build step for the code. Electron only wraps the same server that `npm start` runs.

## Modules

| File | Role |
|---|---|
| `server/index.mjs` | HTTP API, WebSocket events, static UI, game server, probe sockets, engine watch, shutdown |
| `server/agent.mjs` | Claude turns: options, isolation, helper agents, Forge MCP tools (verify_game, playtest, game_eval, list_assets, progress), done-check Stop hook, edit-backup PreToolUse hook, usage per turn, handoff summary, brief |
| `server/acp.mjs` | Minimal ACP client: JSON-RPC 2.0, newline-delimited over the agent's stdio; kill by PID |
| `server/acpturn.mjs` | Turns for ACP agents: session per thread, update mapping, permissions, fs read/write through Forge, Undo snapshot, Forge's own game check, idle close |
| `server/providers.mjs` | Built-in agent list (fixed packages), install with `npm --prefix`, entry-point resolution, test, login, custom agents |
| `server/router.mjs` | Zero-token model router (also served to the browser for the route hint) |
| `server/models.mjs` | Models from the SDK (`supportedModels()`), price ratios, tier of a model |
| `server/game.mjs` | Game serving with the injected probe, per-thread error buffer, probe commands, asset listing |
| `server/checkpoints.mjs` | Per-turn file backups, Undo, Reject, thread changes, project snapshot for agents that edit themselves |
| `server/diff.mjs` | LCS line diff (Changes tab, approval cards) |
| `server/shots.mjs` | Screenshot files |
| `server/blender.mjs` | Blender MCP discovery, reachability, one-thread lock, Blender helper agent definition |
| `server/stats.mjs` | Usage aggregation for the Usage page |
| `server/store.mjs` | `state.json`, thread event logs, usage history, briefs |
| `server/engine.mjs` | Engine detection and hints, binary-read deny rules, ignore folders |
| `server/git.mjs` | Repo detection, worktrees, diff/commit limited to the game folder |
| `public/app.js` | The whole UI (sidebar, chat rendering, menus, panel tabs, Usage and Agents pages) |
| `public/viewer.js` | three.js glTF viewer (three is served from `node_modules` at `/vendor/three`) |

## Data

The desktop app keeps data in `%APPDATA%\forge\data`; `npm start` uses `./data`; `FORGE_DATA` overrides both.

```
state.json                         projects and threads
threads/<thread>.jsonl             chat events (what the UI renders)
usage.jsonl                        one record per turn / brief / handoff
briefs/<project>.md                project brief
progress/<project>.md              progress notes
checkpoints/<thread>/<turn>/       manifest.json + file backups (Undo, Reject, Changes)
shots/<thread>/*.jpg|png           screenshots (verify, pick, playtest, tool images)
worktrees/<thread>/                git worktrees (optional)
models.json                        cached model list
providers/<id>/                    installed agents (npm --prefix) ; providers/providers.json (custom agents, test results)
```

Nothing is written into game folders except by the agents themselves.

## Claude turns

- One `query()` per user turn with `resume` (process start ≈1 s, measured; a live process per thread was not worth
  the complexity).
- **Isolation** (`ISOLATION` in agent.mjs): `settingSources: []`, `strictMcpConfig`,
  `settings.disableClaudeAiConnectors`, background tasks off. Without it, claude.ai connectors were re-announced
  every turn (147k tokens of context after 5 small turns).
- Tools: 7 core tools (+ web tools when enabled, + ExitPlanMode in plan mode) and the in-process `forge` MCP server.
- Helper agents: `scout`, `runner`, `mechanic` (Haiku) and, when enabled, `blender` (Sonnet, with the Blender MCP
  inline so its tools never reach the main conversation).
- Hooks: PreToolUse backs up files before Edit/Write/MultiEdit/NotebookEdit; Stop is the done-check.
- Routing: per message for Auto, price-aware sticky rule within a thread (no Opus→Sonnet downgrade once a thread
  has history; switching down to Haiku stays allowed).
- Context for the model: engine hint + brief in the system prompt (stable, cached); progress notes, undo/reject
  notes, picks and new-project hints in the user message.

## Other agents (ACP)

- Protocol v1 (`@agentclientprotocol/sdk` types). Client capabilities: `fs.readTextFile`, `fs.writeTextFile`; no
  terminal.
- Agents run directly (Node script via `process.execPath`, `ELECTRON_RUN_AS_NODE=1` in the app), never via a shell.
- One process + session per thread; `session/load` when the agent offers it; idle close after 15 min; all closed on
  quit (`globalThis.forgeShutdown`).
- Updates → Forge events: message chunks (streamed), tool calls and updates, plans, usage (context size), mode
  changes. Permissions → approval cards with the agent's options. Stop → `session/cancel`, then kill after 10 s.
- Undo: writes through Forge are backed up; a pre-turn snapshot of text files (≤1 MB each, ≤25 MB total) records
  files the agent changed on its own.

## Game preview and probe

Games are served from the second port so game code cannot call Forge's API. Every served page gets a probe that:
reports errors/warnings per thread (beacon), keeps WebGL buffers readable, counts frames, hooks three.js through
`__THREE_DEVTOOLS__` (scene, renderer, camera) and opens a WebSocket back to Forge for commands: `shot`, `eval`,
`reload`, `pick`, `key`, `mouse`, `read`. Sockets have a role: `visible` (Play tab) or `hidden` (offscreen window,
`?forge=hidden`).

## Security

- Both servers bind to 127.0.0.1. The API rejects other Origins/Hosts (DNS rebinding) and non-JSON POSTs; the
  WebSocket requires Forge's own Origin; probe sockets require the game server's Origin.
- Paths are checked against their root (no traversal).
- `game_eval` and running Python in Blender always ask in Ask mode; playtest only allows plain-path reads.
- Agent installs come from a fixed server-side list; custom agents need a full path to an existing program; no API
  keys or env vars are stored by Forge — logins stay with each CLI.
- Text from game pages (pick results) is truncated and passed to the model as labelled data.

## Building

`npm run dist` → electron-builder, `asar: false`, files `server/**`, `public/**`, `electron/**`, production
`node_modules` (incl. the Claude Agent SDK's bundled `claude.exe` and three.js). Output in `release\` (git-ignored).
