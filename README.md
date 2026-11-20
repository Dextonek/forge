# Forge

A desktop workbench for building games with AI coding agents — in the spirit of T3 Code, specialised for game
development and built to spend as few tokens as possible.

Forge runs Claude (through the Claude Agent SDK, with your own Claude login) and, optionally, other agents that
use your own subscriptions — **OpenAI Codex**, **Google Gemini**, **OpenCode** (open-source models) or any agent
that speaks the Agent Client Protocol (ACP). It shows your game running next to the chat, lets the agent check its
own work with screenshots and playtests, and keeps every change undoable.

Windows desktop app (Electron). Everything runs locally on `127.0.0.1`.

## Highlights

- **T3-style workspace** — projects and thread sessions in a sidebar, live streaming replies, tool steps collapsed
  into "Worked for …", approval cards, plan mode, a model menu and a permissions menu.
- **Game-dev tools**
  - Live **Play** tab with live reload and runtime-error capture.
  - Claude **verifies its own changes** (reload + errors + screenshot) and is sent back once if it forgets.
  - **Playtest**: scripted keys/clicks/reads in a hidden preview, with a pass/fail verdict.
  - **Pick in game**: click an object in the running game to talk about it.
  - **Assets** tab with a **3D model viewer** (glTF, animations, skeleton-only files).
  - **Blender helper** that works in your open Blender (inspect, screenshot, export `.glb` into the game).
- **Safe changes** — Undo per turn, a Changes tab with per-file Reject and line comments, git commit limited to
  the game folder, optional git worktree per thread.
- **Token saving (measured)** — price-aware model router (Haiku / Sonnet / Opus), cheap helper agents, cached
  project brief, isolation from your global Claude setup (147k → 16k tokens of context over the same 5 turns),
  fresh thread from a summary, per-turn usage and a Usage page.
- **Other agents** — an Agents page to install, log in to, test and remove Codex, Gemini, OpenCode or your own
  ACP agent; each thread picks its agent.

## Install

- **Installer:** `release\Forge Setup 0.1.0.exe` (after `npm run dist`), or the portable `release\Forge 0.1.0.exe`.
  The builds are unsigned, so Windows SmartScreen warns on first start (More info → Run anyway).
- **Requirements:** Windows 10/11; a Claude login (Claude Code / Claude subscription); Node.js + npm only if you
  want to add other agents from the Agents page; Blender with its MCP add-on only for the Blender helper.

## Run from source

```powershell
npm ci
npm run app      # desktop app
npm start        # server only, open http://127.0.0.1:4317 in a browser
npm run dist     # build release\Forge Setup 0.1.0.exe and release\Forge 0.1.0.exe
```

If `node_modules\electron\dist\electron.exe` is missing after `npm ci`, run `node node_modules/electron/install.js`.
If Claude says the login expired: `node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe auth login`.

## Documentation

| Document | For |
|---|---|
| [docs/USER-GUIDE.md](docs/USER-GUIDE.md) | Using Forge: every screen and feature |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it is built: modules, data, security, token saving |
| [docs/HANDOVER.md](docs/HANDOVER.md) | Picking up the work: setup, testing, releasing, accounts, pitfalls, open items |
| [docs/ROADMAP.md](docs/ROADMAP.md) | What is done and what comes next |
| [docs/STATUS.md](docs/STATUS.md) | Current state in short |
| [docs/CHANGELOG.md](docs/CHANGELOG.md) | What changed, by milestone |
