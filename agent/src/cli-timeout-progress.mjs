// A timeout must retain evidence of activity without logging model output,
// commands, tool arguments, applicant facts or arbitrary stderr text.
const EVENT_TYPES=new Set(['thread.started','turn.started','item.started','item.completed','turn.completed','turn.failed','error','system','assistant','user','result']);
const CLAUDE_TRANSPORT_SUBTYPES=new Set(['api_retry','status']);
const ITEM_TYPES=new Set(['command_execution','mcp_tool_call','web_search','reasoning','agent_message']);
export function cliTimeoutProgress(){
 let stdoutBytes=0,stderrBytes=0,events=0,lastStage='none',pending='',lifecycleOnly=true,lifecycleStage=0;
 return {
  stdout(chunk){
   stdoutBytes+=Buffer.byteLength(chunk);
   const lines=(pending+chunk.toString()).split('\n');pending=lines.pop();
   // Ignore oversized/non-JSON lines rather than retaining an unbounded copy.
   if(pending.length>16384){pending='';lifecycleOnly=false;}
   for(const line of lines){
    if(line.length>16384){lifecycleOnly=false;continue;}
    if(!line.trim())continue;
    let event;try{event=JSON.parse(line);}catch{lifecycleOnly=false;continue;}
    if(lifecycleStage===0&&event?.type==='thread.started')lifecycleStage=1;
    else if(lifecycleStage===1&&event?.type==='turn.started')lifecycleStage=2;
    // Claude stream-json opens with one system init event before any model or tool output.
    else if(lifecycleStage===0&&event?.type==='system'&&event.subtype==='init')lifecycleStage=2;
    // After init, API retry/status notices and rate-limit notices are still pre-model transport (job 11394).
    else if(lifecycleStage===2&&event?.type==='system'&&CLAUDE_TRANSPORT_SUBTYPES.has(event.subtype));
    else if(lifecycleStage===2&&event?.type==='rate_limit_event');
    else lifecycleOnly=false;
    if(!EVENT_TYPES.has(event?.type))continue;
    events++;lastStage=event.type;
    if(ITEM_TYPES.has(event.item?.type))lastStage+=`:${event.item.type}`;
   }
  },
  stderr(chunk){stderrBytes+=Buffer.byteLength(chunk);},
  summary(){return {stdoutBytes,stderrBytes,events,lastStage,replaySafe:lifecycleOnly&&lifecycleStage===2&&stderrBytes===0&&!pending.trim()};},
  describe(){return `CLI progress: ${stdoutBytes} stdout bytes, ${stderrBytes} stderr bytes, ${events} recognized events, last stage ${lastStage}`;},
 };
}
