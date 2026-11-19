import { query } from '@anthropic-ai/claude-agent-sdk';
import { BINARY_GLOBS } from '../server/engine.mjs';
async function* input(){ yield {type:'user',session_id:'',parent_tool_use_id:null,message:{role:'user',content:'Call the Read tool on assets/pixel.png exactly once, then report the raw tool result.'}}; }
for await (const m of query({prompt:input(),options:{cwd:'sample-game',model:'haiku',effort:'low',settingSources:[],strictMcpConfig:true,settings:{disableClaudeAiConnectors:true},tools:['Read'],allowedTools:['Read'],disallowedTools:BINARY_GLOBS,permissionMode:'dontAsk',maxTurns:3}})) {
  if (m.type==='user' && Array.isArray(m.message.content)) for (const b of m.message.content) if (b.type==='tool_result') console.log('TOOL RESULT:', JSON.stringify(b.content).slice(0,300), 'is_error=', b.is_error);
  if (m.type==='result') { console.log('denials:', JSON.stringify(m.permission_denials)); break; }
}
