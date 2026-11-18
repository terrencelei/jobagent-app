// Lean page steps (his choice, 2026-11-01). A page step only has to pick one action from the snapshot, but each one
// ran as a full coding-agent session: every tool, every MCP server, CLAUDE.md and memory, and an invitation to read
// run logs and screenshots. Measured on one trivial step: ~34k input tokens that way against ~3k tool-free, same
// action; real steps averaged 100-250k because each extra tool turn resends everything. Steps now run tool-free and
// get the full agent back only while the run is stuck, which is when diagnosing with tools pays for itself.
import {setting} from './settings.mjs';

export const LEAN_CLAUDE_ARGS=['--tools','','--strict-mcp-config','--setting-sources','','--no-session-persistence'];
export const LEAN_CODEX_ARGS=['--ignore-user-config','--sandbox','read-only','--disable','shell_tool','--disable','unified_exec','--disable','multi_agent','-c','web_search="disabled"'];

// Stuck: two refused actions, or one action repeated three times, among the last eight steps.
export function stuckStep(history=[]){
 const recent=history.slice(-8),counts=new Map();
 let rejected=0;
 for(const item of recent){
  if(item?.action==='rejected'){rejected++;continue;}
  if(typeof item?.action==='string'&&item.control){const key=`${item.action}\u0000${item.control}`;counts.set(key,(counts.get(key)??0)+1);}
 }
 return rejected>=2||[...counts.values()].some(n=>n>=3);
}

export function leanStep(history=[],{enabled=setting('worker.lean_steps',true)}={}){
 return enabled!==false&&!stuckStep(history);
}
