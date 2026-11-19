// Measures how many tokens a single "hi" costs under different option sets (base context size).
import { query } from '@anthropic-ai/claude-agent-sdk';

const base = { model: 'haiku', effort: 'low', settingSources: [], maxTurns: 1, tools: ['Task', 'Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'], permissionMode: 'dontAsk' };
const variants = {
  'preset prompt (current)': { ...base, systemPrompt: { type: 'preset', preset: 'claude_code', append: 'x' } },
  'preset, no Task tool': { ...base, tools: base.tools.filter((t) => t !== 'Task'), systemPrompt: { type: 'preset', preset: 'claude_code' } },
  'preset + strictMcpConfig + no skills': { ...base, systemPrompt: { type: 'preset', preset: 'claude_code' }, strictMcpConfig: true, skills: [], plugins: [] },
  'short custom prompt': { ...base, systemPrompt: 'You are a coding agent working on a game project.' },
};

for (const [name, options] of Object.entries(variants)) {
  async function* input() { yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Reply with just: hi' } }; }
  let init, usage, cost;
  try {
    for await (const m of query({ prompt: input(), options })) {
      if (m.type === 'system' && m.subtype === 'init') init = m;
      if (m.type === 'assistant' && !usage) usage = m.message.usage;
      if (m.type === 'result') { cost = m.total_cost_usd; break; }
    }
  } catch (e) { console.log(name, 'ERROR', e.message); continue; }
  const ctx = (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0);
  console.log(`${name.padEnd(38)} context ${String(ctx).padStart(6)} tok · tools ${init?.tools.length} · agents ${init?.agents?.length} · slash ${init?.slash_commands?.length} · mcp ${init?.mcp_servers?.length} · $${cost?.toFixed(5)}`);
}
