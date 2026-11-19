// Smoke test: proves the Agent SDK can authenticate and shows the message shapes.
import { query } from '@anthropic-ai/claude-agent-sdk';

async function* input() {
  yield { type: 'user', session_id: '', parent_tool_use_id: null,
    message: { role: 'user', content: 'Reply with just the word PONG. Do not use tools.' } };
}

const q = query({
  prompt: input(),
  options: { model: 'haiku', settingSources: [], tools: [], maxTurns: 1,
    canUseTool: async () => ({ behavior: 'deny', message: 'no tools in smoke test' }) },
});
for await (const m of q) {
  const s = JSON.stringify(m);
  console.log(m.type, m.subtype ?? '', m.type==='assistant' ? JSON.stringify(m.message.content)+' err='+m.error : (m.type==='result'? s.slice(-700): ''));
  if (m.type === 'result') break;
}

