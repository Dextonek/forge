// Minimal Agent Client Protocol (ACP) connection: JSON-RPC 2.0, newline-delimited, over the agent's
// stdio. Field and method names follow @agentclientprotocol/sdk v1 (PROTOCOL_VERSION 1).
import { spawn, execFile } from 'node:child_process';

export const ACP_PROTOCOL_VERSION = 1;

export class AcpConnection {
  // command/args are run directly (never through a shell), so stopping it kills the real agent process.
  constructor(command, args = [], { cwd, env } = {}) {
    this.proc = spawn(command, args, { cwd, env: env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    this.nextId = 1;
    this.pending = new Map();      // id -> { resolve, reject, timer }
    this.handlers = new Map();     // incoming request method -> async (params) => result
    this.listeners = new Map();    // incoming notification method -> (params) => void
    this.stderr = [];              // last lines, for error messages
    this.closed = false;
    this.exitInfo = null;
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (line) this.#onLine(line);
      }
    });
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (d) => { // always drained, so the agent never blocks on a full pipe
      for (const l of String(d).split(/\r?\n/)) if (l.trim()) this.stderr.push(l.slice(0, 500));
      if (this.stderr.length > 60) this.stderr.splice(0, this.stderr.length - 60);
    });
    this.proc.on('error', (e) => this.#fail(e));
    this.proc.on('exit', (code, signal) => { this.exitInfo = { code, signal }; this.#fail(new Error(`agent exited (code ${code}${signal ? ', ' + signal : ''})${this.stderrTail() ? ': ' + this.stderrTail() : ''}`)); });
    this.proc.stdin.on('error', () => { /* agent gone; reported via exit */ });
  }

  stderrTail(n = 4) { return this.stderr.slice(-n).join(' | ').slice(0, 600); }

  #fail(err) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    this.onClose?.(err);
  }

  #send(msg) { if (!this.closed) this.proc.stdin.write(JSON.stringify(msg) + '\n'); }

  async #onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON output
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id); clearTimeout(p.timer);
      if (msg.error) { const e = new Error(msg.error.message || 'agent error'); e.code = msg.error.code; e.data = msg.error.data; p.reject(e); }
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id !== undefined) {           // request from the agent
      const h = this.handlers.get(msg.method);
      if (!h) return this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `method not supported: ${msg.method}` } });
      try { this.#send({ jsonrpc: '2.0', id: msg.id, result: (await h(msg.params ?? {})) ?? null }); }
      catch (e) { this.#send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e?.message ?? e) } }); }
      return;
    }
    if (msg.method) this.listeners.get(msg.method)?.(msg.params ?? {}); // notification
  }

  request(method, params, timeoutMs = 120_000) {
    if (this.closed) return Promise.reject(new Error('agent is not running'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }
  notify(method, params) { this.#send({ jsonrpc: '2.0', method, params }); }
  onRequest(method, handler) { this.handlers.set(method, handler); return this; }
  onNotification(method, handler) { this.listeners.set(method, handler); return this; }

  // Stops the agent and anything it started (by PID, never by process name). Resolves once it exited
  // (or after 5 s).
  close() {
    const exited = new Promise((resolve) => {
      if (this.proc.exitCode !== null || this.proc.signalCode !== null) return resolve();
      this.proc.once('exit', () => resolve());
      setTimeout(resolve, 5000);
    });
    if (this.proc.exitCode === null && this.proc.signalCode === null) {
      try { this.proc.stdin.end(); } catch { /* ignore */ }
      const pid = this.proc.pid;
      if (process.platform === 'win32' && pid) execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
      else this.proc.kill();
    }
    this.#fail(new Error('closed'));
    return exited;
  }
}

// Handshake helper: initialize with the capabilities Forge offers (file read/write through Forge).
export async function initialize(conn) {
  return conn.request('initialize', {
    protocolVersion: ACP_PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
    clientInfo: { name: 'forge', title: 'Forge', version: '0.1.0' },
  }, 60_000);
}

// Error codes/messages agents use when a login is needed (ACP: auth_required, -32000).
export const isAuthError = (e) => e?.code === -32000 || /auth|login|sign.?in|credential|api.?key|unauthor/i.test(String(e?.message ?? ''));
