import {homedir} from 'node:os';
import {join,delimiter,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Shared runtime profile for full-capability subscription agents. Task-specific
// instructions still determine which actions are authorized for the current role.
export const CODEX_CAPABILITIES=['-c','sandbox_mode="danger-full-access"','-c','approval_policy="never"','-c','web_search="live"'];
export const CLAUDE_CAPABILITIES=['--permission-mode','bypassPermissions','--tools','default'];
export const CAPABILITY_CONTEXT=`You have the normal signed-in coding agent toolset: shell, files, browser automation through installed Playwright, web research, installed skills and configured MCP/apps. Use those tools when needed to inspect artifacts, diagnose a form, research an employer, or consult the other engine. Read AGENTS.md, CLAUDE.md and the private agent-coordination.md before editing shared work. Never claim a tool is unavailable before inspecting the available tools/configuration. Tools available in one client's UI may require a configured connector in another; report any actual missing connection accurately. Never print credentials, send mail or contact employers without authorization, invent personal facts, overwrite another agent's work, or change durable queue/submission evidence directly. For this form step, return one final JSON action matching the schema; the worker applies it and retains validation, approval and one-submission checks. Do not create a competing application worker or submit directly from a tool.`;

let loginPath;
export function agentPath(existing=''){
 if(loginPath===undefined){
  const result=spawnSync('/bin/zsh',['-lc','print -rn -- "$PATH"'],{encoding:'utf8',timeout:5000,env:{...process.env,PATH:existing}});
  loginPath=result.status===0?result.stdout.trim().split('\n').at(-1):'';
 }
 const runtimeVenv=fileURLToPath(new URL('../../jobagent/.venv/bin',import.meta.url));
 // setup-node and other version managers install Node outside system directories.
 // Keep the running runtime available even without a login shell or inherited PATH.
 return [...new Set([...String(loginPath).split(delimiter),dirname(process.execPath),join(homedir(),'.local/bin'),'/opt/homebrew/bin',...existing.split(delimiter)].filter(p=>p&&resolve(p)!==runtimeVenv))].join(delimiter);
}
