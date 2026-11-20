# Forge user guide

## 1. First start

1. Start Forge (`Forge.exe`, or `npm run app`).
2. Click the **folder-plus** icon next to *Search* and pick your game folder (for example
   `C:\projectG\games\HorseWar`). Forge detects the engine (three.js, Phaser, PixiJS, plain web, Godot, Unity,
   Unreal) and creates a first thread.
3. Type what you want in the message box and press **Ctrl+Enter** (or the round send button).

A folder added while empty is fine: Forge re-detects the engine as soon as the game has an `index.html`.

## 2. The screen

| Area | What it is |
|---|---|
| Left sidebar | Search, *group by project*, *open game folder*, *new thread*; the thread list; Usage and Agents buttons at the bottom; today's cost |
| Top bar | `project / thread` (double-click the title to rename), open folder in Explorer, show/hide the right panel |
| Middle | The chat |
| Right panel | **Play**, **Assets**, **Changes**, **Brief** |

### Thread list
Each row shows the project badge and name, the thread title and a third line with the agent/model, cost and turns.
On the right: the time of the last activity, or a status — **Approval** (yellow, the agent waits for you),
**Working** (spinner) or **Done** (green, finished while you were elsewhere). Hover a row to rename or delete it.
Deleting a thread keeps its usage history; a worktree folder stays on disk.

### The chat
- Your messages are grey bubbles; under each: the model, why it was chosen, and the time.
- The agent's tool steps fold into one line: **Worked for 4.6s · 3 steps ›** (click to expand). Screenshots it
  took and playtest logs appear inside.
- Text streams in as it is written.
- Under each reply: tokens in (and how much came from the cache), tokens out, cost, and context size.
- **Approval cards** ask before an action: *Allow once*, *Allow for this thread*, *Decline*. Edits are shown as a
  red/green diff. Once answered, a card shrinks to one line.
- **N files changed · Undo** puts the files back as they were before that turn (and undoes later turns too).
  Changes made by shell commands are not covered.

## 3. Choosing the agent, model and permissions

The two buttons next to *Send*:

**Model menu** (✳)
- **Agent** — *Claude* (built in) plus every agent that passed its Test on the Agents page. Fixed once a thread
  has started; to switch, start a new thread or a fresh thread from a summary.
- **Model** (Claude) — *Auto* picks Haiku for small tweaks, Sonnet for normal work, Opus for hard problems
  (cheapest). Or pick Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5, or older models under *More models*.
- **Effort** (Claude) — Auto, Low … Max. Higher effort thinks longer and costs more.

**Permissions** (lock)
- *Ask every time* — asks before each edit and command.
- *Auto-accept edits* — edits run, commands still ask.
- *Auto* — a safety classifier approves routine actions and asks when unsure.
- *Plan only* — read-only; the agent writes a plan. The plan card has **Approve & run** and
  **Run, but ask before each change**.
- *Full access* — never asks (red; asks you to confirm first).

For other agents the permission menu lists **that agent's own modes**.

**Options** (sliders, bottom left): Blender helper (per project), web tools, a dollar budget per thread, this
thread's usage, and **Start a fresh thread from a summary**. When the context gets large, a *start fresh* link
appears next to the context size.

## 4. Game tools

### Play tab
Your browser game runs here (served from a separate local port). It reloads when files change. **Runtime errors**
lists errors and warnings since the last reload (repeats are counted).

### Claude checks its own work
After changing a browser game, Claude calls `verify_game`: Forge reloads the preview, collects errors and takes a
screenshot (shown in the chat). If Claude tries to finish without checking, Forge sends it back once. If the Play
tab is collapsed or minimised, the desktop app uses a hidden preview instead.

For other agents, Forge does this check itself after a turn that changed files and offers
**Send these errors to <agent>** when it finds problems.

### Playtest
Ask for it in words ("playtest the jump: start a run, hold Space, check the player's y"). Claude writes a script
of key presses, holds, clicks, waits, value reads (`G.p.x`) and screenshots; Forge plays it in a hidden preview
and Claude gives a verdict. Needs the desktop app. Value reads work for top-level variables of classic scripts.

### Pick in game
Click **Pick**, then click something in the Play tab (Esc cancels). Forge attaches a screenshot with a red
crosshair and, for three.js games, the object under the click (type, colour, position, size). It is sent with your
next message only.

### Assets and the 3D viewer
The Assets tab lists images, models, audio and scenes. Click a `.glb`/`.gltf` to orbit it, see triangles, meshes,
materials, textures and size, and play its animations. Skeleton-only files show their bones. When a turn writes
models, the chat shows **View … in 3D**.

### Blender helper
Options → **Blender helper** (per project). Requires Blender running with the Blender MCP add-on server
(port 9876) and the Blender extension of the Claude desktop app. A separate helper works in your open Blender:
inspect the scene, screenshot the viewport, change models, export `.glb` into the game's `models` folder. It never
opens other files or saves your `.blend` unless you ask. Read-only actions run without asking; running Python in
Blender asks first. One thread uses Blender at a time. Files Blender writes are not covered by Undo.

## 5. Reviewing changes

**Changes** tab: every file the thread changed, as a diff against the original (works without git).
- **Reject** puts one file back as it was before the thread (and a later Undo cannot bring it back).
- Click a line to comment on it — the comment is added to your message box.
- If the project is a git repository: commit (limited to the game folder).

## 6. Project knowledge

- **Brief** tab: a ~250-word summary of the project, written once by Haiku (fractions of a cent) and sent with every
  turn so the agent stops re-exploring.
- **Progress notes**: goals, features done/to-do, decisions and bugs. Claude keeps them with its `progress` tool
  (stored in Forge's data folder, not in your game). A new thread gets them with its first message. New, empty
  projects start with a feature list.

## 7. Usage

**Usage** page (chart icon): today / 7 days / 30 days / all time, cost per day, and tables by model, route, project
and thread, plus the last 100 turns (click to open the thread). Costs are estimates from the Claude Agent SDK; on a
subscription they are notional API prices. Other agents are counted as "(subscription)" with cost 0.

## 8. Agents (Codex, Gemini, OpenCode, your own)

**Agents** page (plug icon):
1. **Install** — installs the agent into Forge's own folder (needs Node.js/npm).
2. **Log in** — buttons for the agent's own sign-in methods (Codex: ChatGPT or API key; Gemini: Log in with
   Google, API key …). OpenCode works without a login (its default models) or with providers you set up in OpenCode.
3. **Test** — starts the agent and opens a session without sending anything. **Ready** means you can pick it.
4. **Remove** — deletes it from Forge's folder (your login with that service stays).

**Add your own agent**: name, full path to the program, and arguments (any ACP agent over stdio).

Local open-source models: OpenCode finds Ollama (127.0.0.1:11434) and LM Studio (127.0.0.1:1234) automatically.
They need a strong GPU; on integrated graphics they are slow and weak for agent work.

What other agents can't use: Claude's model router, effort, helper agents, Blender, web tools and the dollar budget.

## 9. Troubleshooting

| Problem | Fix |
|---|---|
| "OAuth session expired" / Claude login errors | `node_modules\@anthropic-ai\claude-agent-sdk-win32-x64\claude.exe auth login` (in the Forge folder) |
| No live preview | The engine is not a browser game, or the folder had no game yet; open the thread again after `index.html` exists |
| Screenshot says "not drawing frames" | The Play panel is collapsed or the window minimised; the desktop app falls back to a hidden preview |
| Blender helper: "not running" | Start Blender and start the MCP add-on's server (port 9876) |
| Agent shows "needs login" | Press its Log in button, finish the sign-in in the browser, press Test |
| "thread is busy" | Wait for the turn to finish or press Stop |
| SmartScreen warning on start | The build is unsigned: More info → Run anyway |
