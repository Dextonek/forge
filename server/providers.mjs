// Agent providers besides Claude, spoken to over ACP. Built-in entries come from this fixed list only
// (the API can never name a package to install). Each is installed into Forge's data folder with
// `npm install --prefix`, and its JS entry point is run with Node directly (no .cmd shims, no shell),
// so stopping an agent really stops it and Remove is clean.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, newId } from './store.mjs';
import { AcpConnection, initialize, isAuthError } from './acp.mjs';

export const BUILTIN = [
  {
    id: 'codex', name: 'OpenAI Codex', vendor: 'OpenAI', account: 'ChatGPT subscription (Plus/Pro) or OpenAI API key',
    pkg: '@agentclientprotocol/codex-acp', bin: null, args: [],
    login: { how: 'acp' }, // the adapter offers "Sign in with ChatGPT" through the protocol
    note: 'Codex through its official ACP adapter (it includes the Codex CLI).',
  },
  {
    id: 'gemini', name: 'Google Gemini', vendor: 'Google', account: 'Google account (Gemini plan) or Gemini API key',
    pkg: '@google/gemini-cli', bin: 'gemini', args: ['--acp'],
    login: { how: 'acp' }, // offers "Log in with Google" through the protocol (opens the browser)
    note: 'Google says some free and Google One accounts were moved to "Antigravity CLI" in June 2026; whether yours works shows up in Test.',
  },
  {
    id: 'opencode', name: 'OpenCode (open-source models)', vendor: 'Open source', account: 'Any provider you set up in OpenCode, incl. local Ollama / LM Studio',
    pkg: 'opencode-ai', bin: 'opencode', args: ['acp'],
    login: { how: 'terminal', args: ['auth', 'login'] },
    note: 'Runs open models hosted or local. Local models need a strong GPU; on integrated graphics they are slow and weak for agent work.',
  },
];
if (process.env.FORGE_DEV_FAKE_AGENT) {
  BUILTIN.push({ id: 'fake', name: 'Test agent (fake)', vendor: 'Forge', account: 'none', local: path.resolve(process.env.FORGE_DEV_FAKE_AGENT), args: [], login: { how: 'acp' }, note: 'Development only.' });
}

const ROOT = path.join(DATA_DIR, 'providers');
const CONFIG = path.join(ROOT, 'providers.json');
fs.mkdirSync(ROOT, { recursive: true });
let config = { custom: [], tests: {} };
try { config = { custom: [], tests: {}, ...JSON.parse(fs.readFileSync(CONFIG, 'utf8')) }; } catch { /* first run */ }
const saveConfig = () => fs.writeFileSync(CONFIG, JSON.stringify(config, null, 1));

export const getProvider = (id) => BUILTIN.find((p) => p.id === id) ?? config.custom.find((p) => p.id === id) ?? null;

// Node for running agent scripts: plain node in development; inside the desktop app, Forge.exe itself
// acting as Node (ELECTRON_RUN_AS_NODE).
function nodeRunner() {
  return process.versions.electron
    ? { command: process.execPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
    : { command: process.execPath, env: { ...process.env } };
}

// The installed entry point of a built-in provider, or null.
function entryPoint(p) {
  if (p.local) return fs.existsSync(p.local) ? p.local : null;
  const pkgDir = path.join(ROOT, p.id, 'node_modules', ...p.pkg.split('/'));
  let pj;
  try { pj = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')); } catch { return null; }
  const bin = typeof pj.bin === 'string' ? pj.bin : pj.bin?.[p.bin ?? Object.keys(pj.bin ?? {})[0]];
  if (!bin) return null;
  const f = path.join(pkgDir, bin);
  return fs.existsSync(f) ? f : null;
}
const version = (p) => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, p.id, 'node_modules', ...p.pkg.split('/'), 'package.json'), 'utf8')).version; } catch { return null; } };

// How to start a provider: { command, args, env } or null if not installed.
export function launchSpec(p, extraArgs = p.args ?? []) {
  if (p.custom) return { command: p.command, args: p.cmdArgs ?? [], env: { ...process.env } };
  const entry = entryPoint(p);
  if (!entry) return null;
  // JS entry points (including extension-less scripts with a node shebang) run with Node; anything else directly.
  const isJs = /\.(c|m)?js$/i.test(entry) || (!path.extname(entry) && /^#!.*\bnode\b/.test(fs.readFileSync(entry, 'utf8').slice(0, 100)));
  const node = nodeRunner();
  return isJs ? { command: node.command, args: [entry, ...extraArgs], env: node.env } : { command: entry, args: extraArgs, env: node.env };
}

export function listProviders() {
  const all = [...BUILTIN, ...config.custom];
  return all.map((p) => ({
    id: p.id, name: p.name, vendor: p.vendor ?? 'Custom', account: p.account ?? '', note: p.note ?? '', custom: !!p.custom,
    command: p.custom ? [p.command, ...(p.cmdArgs ?? [])].join(' ') : null,
    installed: p.custom ? true : !!entryPoint(p), version: p.custom ? null : version(p),
    test: config.tests[p.id] ?? null, loginHow: p.login?.how ?? 'acp',
  }));
}

// npm install into Forge's data folder (fixed package name from BUILTIN). Streams output to onLine.
export function install(id, onLine = () => {}) {
  const p = BUILTIN.find((x) => x.id === id && x.pkg);
  if (!p) return Promise.reject(new Error('unknown provider'));
  const dir = path.join(ROOT, p.id);
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(path.join(dir, 'package.json'))) fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"forge-provider","private":true}');
  return new Promise((resolve, reject) => {
    // npm is a .cmd on Windows, so this one command runs through the shell; every part is fixed or quoted.
    const cmd = `npm install --prefix "${dir}" ${p.pkg}@latest --no-fund --no-audit --loglevel=error`;
    const child = spawn(cmd, { shell: true, windowsHide: true, env: process.env });
    const out = (d) => String(d).split(/\r?\n/).filter(Boolean).forEach((l) => onLine(l.slice(0, 300)));
    child.stdout.on('data', out); child.stderr.on('data', out);
    child.on('error', (e) => reject(new Error(`npm could not start (${e.message}). Forge needs Node.js/npm installed to add providers.`)));
    child.on('exit', (code) => (code === 0 && entryPoint(p) ? resolve({ version: version(p) }) : reject(new Error(`npm install failed (exit ${code})`))));
  });
}

export function uninstall(id) {
  const c = config.custom.findIndex((x) => x.id === id);
  if (c >= 0) { config.custom.splice(c, 1); delete config.tests[id]; saveConfig(); return; }
  const p = BUILTIN.find((x) => x.id === id && x.pkg);
  if (!p) throw new Error('unknown provider');
  fs.rmSync(path.join(ROOT, p.id), { recursive: true, force: true });
  delete config.tests[id]; saveConfig();
}

export function addCustom({ name, command, args }) {
  name = String(name ?? '').trim().slice(0, 60);
  command = String(command ?? '').trim();
  if (!name || !command) throw new Error('name and command are required');
  if (!fs.existsSync(command)) throw new Error('command must be the full path to an existing program (e.g. C:\\tools\\my-agent.exe)');
  const cmdArgs = String(args ?? '').trim() ? String(args).trim().split(/\s+/).slice(0, 20) : [];
  const p = { id: 'c' + newId(), name, command, cmdArgs, custom: true, vendor: 'Custom', login: { how: 'none' }, note: 'Your own ACP agent.' };
  config.custom.push(p); saveConfig();
  return p;
}

// Test = start the agent, initialize, and create a session in a temp folder. "Ready" only after that works.
export async function testProvider(id) {
  const p = getProvider(id);
  if (!p) throw new Error('unknown provider');
  const spec = launchSpec(p);
  if (!spec) throw new Error('not installed');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-acp-test-'));
  const conn = new AcpConnection(spec.command, spec.args, { cwd: tmp, env: spec.env });
  const result = { t: Date.now(), state: 'error' };
  try {
    const init = await initialize(conn);
    result.agent = init.agentInfo ? `${init.agentInfo.name ?? ''} ${init.agentInfo.version ?? ''}`.trim() : null;
    result.authMethods = (init.authMethods ?? []).map((m) => ({ id: m.id, name: m.name, type: m.type ?? 'agent' }));
    result.image = !!init.agentCapabilities?.promptCapabilities?.image;
    result.loadSession = !!init.agentCapabilities?.loadSession;
    try {
      const s = await conn.request('session/new', { cwd: tmp, mcpServers: [] }, 90_000);
      result.state = 'ready';
      result.modes = s.modes?.availableModes?.map((m) => ({ id: m.id, name: m.name, description: m.description ?? '' })) ?? [];
      result.mode = s.modes?.currentModeId ?? null;
    } catch (e) {
      result.state = isAuthError(e) ? 'needs-login' : 'error';
      result.error = String(e.message).slice(0, 300);
    }
  } catch (e) {
    result.error = `${String(e.message).slice(0, 300)}`;
  } finally {
    await conn.close();
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* temp folder; Windows may still hold it */ }
  }
  config.tests[id] = result; saveConfig();
  return result;
}

// Log in: through the protocol when the agent offers an "agent" auth method (e.g. Codex: Sign in with
// ChatGPT opens the browser), otherwise in a console window running the CLI's own login.
export async function login(id, methodId) {
  const p = getProvider(id);
  if (!p) throw new Error('unknown provider');
  if (p.login?.how === 'terminal') {
    const spec = launchSpec(p, p.login.args);
    if (!spec) throw new Error('not installed');
    const q = (s) => `"${String(s).replace(/"/g, '')}"`;
    // A visible console window the user types into; Forge does not read or store anything typed there.
    const line = `${q(spec.command)} ${spec.args.map(q).join(' ')}`;
    spawn('cmd.exe', ['/c', 'start', `"${p.name} login"`, 'cmd', '/k', line], { detached: true, windowsHide: false, env: spec.env, shell: false, windowsVerbatimArguments: true }).unref();
    return { opened: 'console' };
  }
  const spec = launchSpec(p);
  if (!spec) throw new Error('not installed');
  const conn = new AcpConnection(spec.command, spec.args, { cwd: os.tmpdir(), env: spec.env });
  try {
    const init = await initialize(conn);
    const methods = init.authMethods ?? [];
    const m = methods.find((x) => x.id === methodId) ?? methods.find((x) => (x.type ?? 'agent') === 'agent');
    if (!m) throw new Error('this agent offers no sign-in through Forge; use its own CLI to log in');
    await conn.request('authenticate', { methodId: m.id }, 5 * 60_000); // the browser sign-in can take a while
    return { method: m.name };
  } finally { await conn.close(); }
}
