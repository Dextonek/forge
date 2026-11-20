// Prints an ACP agent's handshake: initialize, then session/new in a temp folder (no prompt, no cost).
// Usage: node scripts/acp-handshake.mjs <command> [args...]
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { AcpConnection, initialize, isAuthError } from '../server/acp.mjs';

const [command, ...args] = process.argv.slice(2);
const conn = new AcpConnection(command, args, { cwd: os.tmpdir() });
try {
  const init = await initialize(conn);
  console.log('initialize:', JSON.stringify({ protocolVersion: init.protocolVersion, agentInfo: init.agentInfo, agentCapabilities: init.agentCapabilities, authMethods: init.authMethods }, null, 1));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-acp-'));
  try {
    const s = await conn.request('session/new', { cwd: dir, mcpServers: [] }, 60_000);
    console.log('session/new: OK', JSON.stringify({ sessionId: s.sessionId, modes: s.modes, configOptions: s.configOptions?.map((o) => ({ id: o.id, name: o.name })) }, null, 1));
  } catch (e) {
    console.log(`session/new FAILED (${isAuthError(e) ? 'needs login' : 'error'}): code ${e.code} ${e.message}`);
  }
} catch (e) {
  console.log('handshake FAILED:', e.message, '· stderr:', conn.stderrTail());
} finally { conn.close(); setTimeout(() => process.exit(0), 300); }
