// Proof: can an SDK MCP tool return an image the model actually sees, and what does it cost?
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import zlib from 'node:zlib';

// Build a 320x200 PNG: left half red, right half blue (so the answer is checkable).
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      if (x < w / 2) { raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30; } else { raw[o] = 30; raw[o + 1] = 60; raw[o + 2] = 220; }
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const shot = tool('screenshot', 'Screenshot of the game preview.', {}, async () => ({
  content: [{ type: 'image', data: png(320, 200).toString('base64'), mimeType: 'image/png' }, { type: 'text', text: 'Captured 320x200.' }],
}));

async function* input() { yield { type: 'user', session_id: '', parent_tool_use_id: null, message: { role: 'user', content: 'Call the screenshot tool once, then tell me in one line which colours you see on the left and right half.' } }; }
let lastCtx = 0;
for await (const m of query({ prompt: input(), options: {
  model: 'haiku', effort: 'low', settingSources: [], strictMcpConfig: true, settings: { disableClaudeAiConnectors: true },
  tools: [], allowedTools: ['mcp__probe__screenshot'], permissionMode: 'dontAsk', maxTurns: 4,
  mcpServers: { probe: createSdkMcpServer({ name: 'probe', tools: [shot] }) },
} })) {
  if (m.type === 'assistant' && m.message.usage) {
    const u = m.message.usage; const ctx = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
    console.log(`request context ${ctx} tokens (+${ctx - lastCtx})`); lastCtx = ctx;
  }
  if (m.type === 'result') { console.log('ANSWER:', m.result, '· cost $' + m.total_cost_usd.toFixed(5)); break; }
}
