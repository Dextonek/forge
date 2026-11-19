// The models this Claude account can use, read from the SDK (cached in data/models.json).
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './store.mjs';

const CACHE = path.join(DATA_DIR, 'models.json');
const FALLBACK = [
  { value: 'fable', resolvedModel: 'claude-fable-5-2', displayName: 'Fable 5.2', description: 'Most capable for your hardest and longest-running tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', description: 'Best for everyday, complex tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', description: 'Efficient for routine tasks', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', resolvedModel: 'claude-haiku-5-5', displayName: 'Haiku 5.5', description: 'Fastest for quick answers', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
];

let cached = null;
try { cached = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { /* not fetched yet */ }

async function fetchModels() {
  let release;
  const hold = new Promise((r) => (release = r));
  async function* input() { await hold; } // no prompt: we only ask for the model list
  const q = query({ prompt: input(), options: { settingSources: [], strictMcpConfig: true, settings: { disableClaudeAiConnectors: true } } });
  try {
    const list = await Promise.race([q.supportedModels(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30_000))]);
    return list.filter((m) => m.value !== 'default'); // "default" just repeats Opus
  } finally { release(); q.close?.(); }
}

export async function getModels(refresh = false) {
  if (cached && !refresh) return cached;
  try {
    cached = await fetchModels();
    fs.writeFileSync(CACHE, JSON.stringify(cached, null, 1));
  } catch (e) {
    console.warn('model list unavailable, using fallback:', e.message);
    cached ??= FALLBACK;
  }
  return cached;
}

// Rough price relative to Opus 5.5 (input and output scale alike), for the "saved vs all-Opus" figure.
const INPUT_PRICE = [[/haiku-5/, 0.1], [/haiku-4/, 1], [/sonnet-4/, 3], [/sonnet/, 2], [/opus-5-5/, 4], [/opus/, 5], [/fable-5-2|mythos-5-2/, 8], [/fable|mythos/, 10]];
export const opusRatio = (model) => 4 / (INPUT_PRICE.find(([re]) => re.test(model))?.[1] ?? 4);

// Which route bucket a fixed model belongs to (for colours and the usage table).
export const tierOf = (model) => (/haiku/i.test(model) ? 'quick' : /sonnet/i.test(model) ? 'standard' : 'deep');
