// Blender connection: a dedicated helper agent gets the Blender MCP server, so its many tools never load
// into the main conversation. Blender is shared state (one open file), so only one thread uses it at a time.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const PORT = Number(process.env.FORGE_BLENDER_PORT ?? 9876); // the Blender MCP add-on listens here

// The Blender MCP server program. FORGE_BLENDER_MCP can point at it; otherwise use the one installed by
// the Claude desktop app's Blender extension.
export function blenderServer() {
  const candidates = [
    process.env.FORGE_BLENDER_MCP,
    path.join(process.env.APPDATA ?? '', 'Claude', 'Claude Extensions', 'ant.dir.gh.blender.blender-mcp', '.venv', 'Scripts', 'blender-mcp.exe'),
  ].filter(Boolean);
  const command = candidates.find((c) => fs.existsSync(c));
  return command ? { type: 'stdio', command, args: [] } : null;
}

// Is Blender running with the add-on's server started? (A plain TCP connect, nothing is sent.)
export function blenderReachable(timeoutMs = 600) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port: PORT });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function blenderStatus() {
  const server = blenderServer();
  if (!server) return { state: 'not-installed', text: 'Blender MCP not found (install the Blender extension in the Claude desktop app, or set FORGE_BLENDER_MCP)' };
  if (!(await blenderReachable())) return { state: 'not-running', text: `Blender is not running with the MCP add-on server (port ${PORT})` };
  return { state: 'ready', text: 'Blender connected' };
}

// One thread at a time.
let holder = null;
export const blenderHolder = () => holder;
export function claimBlender(threadId) { if (holder && holder !== threadId) return false; holder = threadId; return true; }
export function releaseBlender(threadId) { if (holder === threadId) holder = null; }

export const BLENDER_AGENT = (server, gameDir) => ({
  description: 'Works in the user\'s open Blender (via the Blender MCP): inspect the scene and objects, take viewport screenshots, make requested changes to models, and export models for the game. Use it for anything about .blend files or 3D assets.',
  model: 'sonnet',
  tools: ['Read', 'Glob'],
  mcpServers: [{ blender: server }],
  maxTurns: 25,
  background: false,
  prompt: [
    'You operate the user\'s running Blender through the Blender MCP tools. Blender is shared, live state: the user may have unsaved work.',
    '- Inspect first (scene/objects summaries, path info). Prefer the dedicated summary tools over executing Python.',
    '- Never open another .blend file, never discard or revert changes, and never save the .blend file unless the task explicitly says so. If a different file is needed, stop and say which.',
    '- Make only the changes you were asked for. Do not delete objects you were not asked to delete.',
    `- Export models for the game as glTF binary (.glb) into the game folder, normally ${path.join(gameDir, 'models')}, unless told otherwise. Apply transforms only in the export settings, not to the scene.`,
    '- Report briefly: what you looked at or changed, exact output file paths, object names, poly counts when relevant.',
  ].join('\n'),
});
