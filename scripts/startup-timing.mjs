// Measures how long a fresh Claude process takes per turn (start -> init -> first token -> result).
import { query } from '@anthropic-ai/claude-agent-sdk';

for (let run = 1; run <= 3; run++) {
  const t0 = Date.now(); let init, first;
  async function* input() { yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Reply with just: ok' } }; }
  for await (const m of query({ prompt: input(), options: {
    model: 'haiku', effort: 'low', settingSources: [], strictMcpConfig: true, settings: { disableClaudeAiConnectors: true },
    tools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep', 'Write', 'Task'], permissionMode: 'dontAsk', includePartialMessages: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
  } })) {
    if (m.type === 'system' && m.subtype === 'init' && !init) init = Date.now() - t0;
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && !first) first = Date.now() - t0;
    if (m.type === 'result') { console.log(`run ${run}: init ${init} ms · first token ${first} ms · done ${Date.now() - t0} ms`); break; }
  }
}
