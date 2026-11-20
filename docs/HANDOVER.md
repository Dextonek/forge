# Forge handover

Everything needed to pick up the work — for a person or a new Claude session. Read this, then
[STATUS.md](STATUS.md), then [ROADMAP.md](ROADMAP.md).

## 1. Where things are

| What | Where |
|---|---|
| Code | `C:\projectG\Forge` (git, branch `main`) |
| GitHub | https://github.com/Dextonek/forge (public) |
| Built app | `C:\projectG\Forge\release\` (`Forge Setup 0.1.0.exe`, `Forge 0.1.0.exe`, `win-unpacked\`) — git-ignored |
| The user's real Forge data | `%APPDATA%\forge\data` (do not delete or overwrite) |
| Dev data (`npm start`) | `C:\projectG\Forge\data` (git-ignored) |
| The user's games | `C:\projectG\games\` (e.g. `HorseWar`, `RougeLikeSurvival`) — only work on copies in tests |
| Docs | `README.md`, `docs/` |

## 2. Set up

```powershell
cd C:\projectG\Forge
npm ci
node node_modules/electron/install.js   # only if node_modules\electron\dist\electron.exe is missing
npm run app
```

Claude login (used by the SDK's bundled CLI): if a turn says the OAuth session expired, run
`node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe auth login`.

## 3. Git and GitHub

- Remote `origin` = `https://Dextonek@github.com/Dextonek/forge.git`. This repo pushes **as Dextonek** through a
  repo-local credential helper that asks `gh auth token --user Dextonek` at push time (no token stored):
  `git config --local --get-all credential.https://github.com.helper`.
- The global `gh` active account stays **penkert-adus**; Dextonek is logged in to `gh` as a second account.
- The SSH key on this machine belongs to penkert-adus (read-only on this repo), so SSH is not used here.
- The user's rules: push only when asked; branch before editing (each feature had its own branch, then a
  fast-forward merge into `main`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Write the message to a file
  and use `git commit -F` (PowerShell here-strings piped to git failed).

## 4. Testing

Never test against the user's running Forge or real data. Use a separate instance:

```powershell
$env:FORGE_PORT='4417'                      # API 4417, games 4418
$env:FORGE_DATA='C:\projectG\Forge\.testdata'
$env:FORGE_PROFILE='C:\projectG\Forge\.testprofile'   # Electron window size / localStorage
$env:FORGE_DEV_FAKE_AGENT=(Resolve-Path scripts\fake-acp-agent.mjs).Path   # adds the fake ACP agent
Start-Process node_modules\electron\dist\electron.exe -ArgumentList '.'      # or: node server/index.mjs
```

`.testdata/` and `.testprofile/` are git-ignored; delete them afterwards. Stop only processes you started (by PID).
Real-turn tests cost money (mostly Haiku; a few cents per script). Test on copies of games.

| Script | Checks | Needs |
|---|---|---|
| `scripts/acp-fake-test.mjs <dir>` | ACP turns end to end (16 checks) | server with FORGE_DEV_FAKE_AGENT |
| `scripts/reject-test.mjs`, `diff-test.mjs`, `router-test.mjs`, `router-sticky-test.mjs` | unit-level, no server | — |
| `scripts/e2e.mjs` | routing, approvals, resume, Stop, brief, budget | server, Claude login |
| `scripts/perm-test.mjs` | all permission modes, Fable | server, Claude login |
| `scripts/verify-test.mjs <out>` | verify_game + hidden preview + done-check | desktop app |
| `scripts/playtest-test.mjs <gameCopy> <out>` | playtest on a canvas game | desktop app |
| `scripts/pick-test.mjs <thread> <out>` | pick in the visible preview | desktop app with the thread open |
| `scripts/review-test.mjs`, `handoff-test.mjs`, `new-game-test.mjs`, `tryout.mjs` | review, handoff, new game, mixed | server/desktop app |
| `scripts/blender-test.mjs`, `blender-shot-test.mjs`, `blender-export-test.mjs` | Blender helper (read-only / export) | Blender running with the MCP add-on |
| `scripts/providers-proof.mjs`, `acp-handshake.mjs`, `acp-real-test.mjs` | agent installs, handshakes, real agent turns | FORGE_DATA test folder |

`npm test` is still a placeholder; there is no CI yet (see the roadmap).

## 5. Releasing a build

1. Close the Forge that runs from `release\win-unpacked` (it locks the folder) — ask the user first.
2. `Remove-Item -Recurse -Force data` (keep dev data out), then `npm run dist` (≈10 min).
3. Start `release\win-unpacked\Forge.exe` and check `GET http://127.0.0.1:4317/api/state`; once, run the build
   against a copy of the user's real data (`FORGE_DATA` pointing to a copy).

## 6. Pitfalls learned the hard way

- **Windows `.cmd` shims**: Node 24 won't spawn them without a shell, and with a shell `kill()` only stops cmd.exe.
  Run JS entry points with Node directly; kill trees with `taskkill /pid <pid> /T /F`.
- **claude.ai connectors** load into SDK sessions unless isolated (`ISOLATION` in agent.mjs) — 10–15k tokens per turn.
- **Model switches break the prompt cache** (per model). The router is sticky and price-aware for that reason.
- **The SDK process lingers after `result`**: a turn counts as done at `result`; the next turn waits for the old
  process.
- **WebGL screenshots** need `preserveDrawingBuffer` (the probe patches `getContext`) and frames being drawn;
  background browser panes don't draw — use the desktop app or the hidden offscreen window.
- **`preview_start` in Claude Code** kept starting the old `.claude/launch.json` entry; start test servers yourself.
- **Status badge CSS**: don't reuse class names like `approval` for small elements (it picked up card styles).
- **Engine detection** used to run only on add; it now re-runs per turn and when a thread opens.
- **Rebuilding while Forge runs** fails (locked files).
- **PowerShell**: `$B` and `$b` are the same variable; `-replace` replacement strings are literal (no `` `n ``).

## 7. Accounts and external tools

| Thing | State |
|---|---|
| Claude | logged in via the SDK's `claude.exe` (OAuth); used by all Claude turns |
| GitHub | gh: penkert-adus (active), penksTestAi, Dextonek |
| Blender | Blender 5.2.2 LTS + MCP add-on (port 9876), MCP server from the Claude desktop Blender extension |
| Codex / Gemini / OpenCode in the user's app | not installed yet — the user installs and logs in from the Agents page |
| Hardware | Intel UHD 630, 32 GB RAM, no dedicated GPU → local models not recommended |

## 8. Open items

- The user still has to install and log in to Codex and Gemini (Agents page); their real turns are untested.
- OpenCode's default model is not shown in Forge.
- Not started: Godot/Unity via MCP, phone/remote approvals (needs API auth), app icon, code signing, CI.
- See [ROADMAP.md](ROADMAP.md) for the full list and order.
