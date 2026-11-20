// A fake ACP agent for testing Forge without any account or cost. It speaks ACP v1 over stdio:
// initialize, session/new (with modes), session/prompt that streams text, makes a tool call, asks for
// permission, writes a file through the client (fs/write_text_file) AND one directly to disk, reports
// usage, and honours session/cancel. Prompt keywords: "slow" makes it wait 20 s (to test Stop),
// "login" makes session/new fail with auth_required.
import fs from 'node:fs';
import path from 'node:path';

let buf = '', nextId = 1000, cwd = process.cwd(), cancelled = false;
const waiting = new Map();
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method, params }); });
const update = (sessionId, u) => notify('session/update', { sessionId, update: u });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const needLogin = process.env.FAKE_ACP_NEEDS_LOGIN === '1';

async function prompt(id, { sessionId, prompt }) {
  cancelled = false;
  const text = prompt.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
  const images = prompt.filter((b) => b.type === 'image').length;
  for (const w of `Fake agent here. I got your message (${text.length} chars${images ? `, ${images} image(s)` : ''}).`.split(' ')) {
    update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: w + ' ' } }); await sleep(15);
  }
  update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Read the game', priority: 'high', status: 'completed' }, { content: 'Write fake.txt', priority: 'medium', status: 'in_progress' }] });
  if (/slow/i.test(text)) { for (let i = 0; i < 200 && !cancelled; i++) await sleep(100); if (cancelled) return send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } }); }
  const target = path.join(cwd, 'fake.txt');
  update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Write fake.txt', kind: 'edit', status: 'pending', locations: [{ path: target }] });
  const perm = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 't1', title: 'Write fake.txt', kind: 'edit' },
    options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }] });
  const allowed = perm?.outcome?.outcome === 'selected' && perm.outcome.optionId !== 'no';
  if (cancelled || perm?.outcome?.outcome === 'cancelled') return send({ jsonrpc: '2.0', id, result: { stopReason: 'cancelled' } });
  if (allowed) {
    await ask('fs/write_text_file', { sessionId, path: target, content: `written via client at ${new Date().toISOString()}\n` });
    fs.writeFileSync(path.join(cwd, 'fake-direct.txt'), `written directly at ${new Date().toISOString()}\n`); // like agents that edit on their own
    update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'diff', path: target, oldText: null, newText: 'written via client' }] });
  } else update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'rejected by user' } }] });
  update(sessionId, { sessionUpdate: 'usage_update', used: 4321, size: 200000 });
  update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: allowed ? 'Done: wrote fake.txt and fake-direct.txt.' : 'Skipped the write.' } });
  send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk; let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && !m.method) { waiting.get(m.id)?.(m.result); waiting.delete(m.id); continue; }
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1, agentInfo: { name: 'fake-agent', version: '1.0.0' },
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true } }, authMethods: [{ id: 'fake-login', name: 'Fake login' }] } });
    else if (m.method === 'authenticate') send({ jsonrpc: '2.0', id: m.id, result: {} });
    else if (m.method === 'session/new') {
      if (needLogin) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required' } }); continue; }
      cwd = m.params.cwd;
      send({ jsonrpc: '2.0', id: m.id, result: { sessionId: 'fake-session', modes: { currentModeId: 'ask', availableModes: [{ id: 'ask', name: 'Ask', description: 'Ask before edits' }, { id: 'auto', name: 'Auto', description: 'Edit without asking' }] } } });
    } else if (m.method === 'session/set_mode') send({ jsonrpc: '2.0', id: m.id, result: {} });
    else if (m.method === 'session/prompt') prompt(m.id, m.params);
    else if (m.method === 'session/cancel') cancelled = true;
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } });
  }
});
process.stdin.on('end', () => process.exit(0));
