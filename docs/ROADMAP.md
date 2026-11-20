# Forge roadmap

## Done

| Milestone | Highlights |
|---|---|
| Foundation | Claude Agent SDK turns, projects/threads, Play tab with live reload and error capture, assets, git worktrees, usage tracking, local-only security |
| Token saving | Zero-token router, Haiku helpers, project brief, trimmed tools, isolation from claude.ai connectors (147k → 16k context) |
| Desktop app | Electron, native folder picker, frameless T3-style UI, installer + portable build |
| Workspace | T3-style sidebar/threads, model and permission menus (all account models, effort, Ask/Auto-edit/Auto/Plan/Full access), Usage page |
| Phase 1 | Undo per turn, live streaming, Approve & run for plans, repo in `C:\projectG\Forge` |
| Phase 2 | `verify_game` with screenshots, done-check, `game_eval`, price-aware sticky routing, progress notes, fresh thread from summary |
| Phase 3 | Pick in game, Changes tab with Reject + line comments, diffs in approvals, Playtest |
| Blender | Blender helper agent (inspect, screenshot, export .glb), tool images shown in the chat |
| 3D viewer | glTF viewer in Assets with animations and skeleton-only files |
| Agents | ACP: Codex, Gemini, OpenCode, custom agents; Agents page; per-thread agent; Undo + Forge check for their turns |

Skipped on purpose: a long-lived Claude process per thread (start-up measured at ≈1 s; not worth the risk).

## Next — highest value first

1. **Validate Codex and Gemini with real turns** once the user has logged in; fix what shows up (permission
   modes, plan mode, images, session resume).
2. **Forge's game tools for other agents.** Expose `verify_game`, `playtest`, `list_assets` and `progress` to ACP
   agents through a local MCP endpoint (per-session token; HTTP where the agent supports it, a small stdio bridge
   otherwise). Leave `game_eval` out. Today Forge checks the game for them after each turn instead.
3. **Model choice for other agents.** Use the agents' session config options / model switching where offered;
   show which model OpenCode is using.
4. **Automated tests in CI.** Make `npm test` run the no-cost tests (reject, diff, router, fake ACP agent) and add
   a GitHub Actions workflow on `windows-latest`.
5. **Release polish.** App icon, version numbers, auto-update (electron-updater) and code signing (removes the
   SmartScreen warning).
6. **Undo for Blender exports.** Snapshot the models folder before a Blender helper turn so exported files can be
   undone too.

## Later

7. **Godot and Unity** through their MCP servers (e.g. GDAI MCP for Godot, MCP for Unity), with the same
   screenshot + error check and a run button.
8. **Phone / remote approvals** over LAN or Tailscale (as in T3 Code). Needs authentication and device pairing
   before the API leaves 127.0.0.1.
9. **Playtest v2.** Assertion steps, record a manual play session and replay it, GIF/video of runs, a playtest
   verdict per feature written to the progress notes.
10. **Asset generation** (Meshy / Tripo / Ludo-style) feeding the Blender helper and the 3D viewer.
11. **Live scene inspector for three.js.** Pick an object, edit its properties live, write the change back to code.
12. **Hand a thread to another agent** mid-way (via an automatic summary), as T3 Code does.
13. **Smarter cost control.** Learn routing from the user's overrides, estimate cost before expensive turns, show
    cache hit rate and the likely cause of a cache miss.
14. **macOS and Linux builds.**

## Principles (from the research behind Forge)

- Check the game like a player would (screenshots, playtests), not only with code checks.
- Keep the prompt prefix stable and switch models rarely; prompt caching is the biggest saving.
- Use helpers only for narrow, reading-heavy or mechanical work; one agent writes code at a time.
- Keep notes outside the context window (progress notes, brief) and start fresh threads from summaries.
- Never trust page or tool content as instructions; ask before running code in the game or in Blender.

Sources for these choices: Anthropic engineering posts on long-running agent harnesses, context engineering and
tool design; Manus and Cognition posts on context and multi-agent design; T3 Code, Claude Code desktop, Conductor,
Superset, opcode, Nimbalyst and Vibe Kanban for workspace features; Unity AI, Coplay, Godot MCPs, Ziva and
Blender MCP for game-dev tooling.
