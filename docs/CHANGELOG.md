# Changelog

All on `main` (fast-forward merges from feature branches). Dates are 2026-11.

## 52d14eb — Other agents over ACP (11-20)
Agents page (install / log in / test / remove; Codex, Gemini, OpenCode, custom ACP agents), per-thread agent,
ACP client and turn engine, Undo snapshot for agents that edit on their own, Forge's game check after their turns.

## 0ad4d65 — 3D model viewer and Blender export (11-20)
glTF viewer in Assets (animations, skeleton-only files), "View … in 3D" cards, three.js served locally, Claude
confirms Blender exports with list_assets.

## b08542f — Blender helper (11-20)
Per-project Blender helper agent with the Blender MCP inline, one-thread lock, read-only tools auto-allowed, tool
images shown in the chat.

## 8fc045d — New games checked in the turn that creates them (11-20)
Game tools for "unknown" projects, engine re-detection, feature-list hint in the message, playtest field-name tip.

## 910da92 — Phase 3 (11-20)
Pick in game, Changes tab with Reject and line comments, diffs in approval cards, Playtest, screenshots as files,
git diff/commit limited to the game folder.

## ea4fec3 — Phase 2 (11-20)
verify_game with screenshots and hidden preview, done-check, game_eval, price-aware sticky routing, progress notes,
fresh thread from summary, engine re-detection, test hooks (FORGE_PROFILE, FORGE_DATA).

## d3585aa — Forge (11-19)
Desktop app with T3-style projects and threads, live game preview and error capture, model and permission menus,
router and helper agents, project brief, usage history and Usage page, Undo per turn, streaming, plan approval.
