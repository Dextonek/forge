import { query } from '@anthropic-ai/claude-agent-sdk';
let release; const hold = new Promise((r) => (release = r));
async function* input() { await hold; }
const q = query({ prompt: input(), options: { settingSources: [], strictMcpConfig: true, settings: { disableClaudeAiConnectors: true } } });
const models = await q.supportedModels();
console.log(JSON.stringify(models, null, 1));
release(); q.close?.();
process.exit(0);
