#!/usr/bin/env node
// Times each agy model on one realistic form step (the worker's own instructions, schema and
// execCLI), interleaved over several rounds so load affects every model alike. Prints the medians
// fastest first and the order to use for the `agy.models` setting / DEFAULT_AGY_MODELS.
//   node tools/agy-bench.mjs [--rounds 3] [model ...]
import {decideAgy,DEFAULT_AGY_MODELS} from '../src/model-fallback.mjs';
import {FORM_AGENT_INSTRUCTIONS} from '../src/application-decision-context.mjs';
import {execCLI} from '../src/dashboard-worker.mjs';

const args=process.argv.slice(2);
const r=args.indexOf('--rounds');const rounds=r>=0?Number(args.splice(r,2)[1]):3;
const models=args.length?args:DEFAULT_AGY_MODELS;
const schema={type:'object',additionalProperties:false,properties:{action:{type:'string',enum:['fill','upload','click','ask','review','human']},control:{type:'string'},fact:{type:'string'},message:{type:'string'}},required:['action','control','fact','message']};
const controls=[['f1','First Name *','text','Pat'],['f2','Last Name *','text','Lee'],['f3','Email *','email',''],['f4','Phone *','tel',''],['f5','LinkedIn Profile','url',''],
 ['f6','Are you legally authorized to work in the United States? *','select',''],['f7','Will you now or in the future require sponsorship? *','select',''],['f8','Resume/CV *','file',''],['f9','Submit application','submit','']]
 .map(([id,label,type,value])=>({id,label,type,value,required:label.includes('*'),...(type==='select'?{options:[{label:'Yes'},{label:'No'}]}:{})}));
const prompt=JSON.stringify({job:{id:1,company:'Acme Robotics',title:'Mechanical Engineer',url:'https://jobs.example/1'},
 confirmedAnswers:{firstName:'Pat',lastName:'Lee',email:'pat@example.test',phone:'555-0100',workAuthorizationUS:'Yes',requiresSponsorship:'No'},
 approvedQuestionAnswers:{},snapshot:{url:'https://jobs.example/1/apply',frames:[{controls}]},history:[{action:'fill',control:'f1'},{action:'fill',control:'f2'}]});

const results={};
for(let round=0;round<rounds;round++)for(const model of models){
 const t=Date.now();let ok=false,answer='';
 try{const d=await decideAgy({model,prompt,system:FORM_AGENT_INSTRUCTIONS,schema,execImpl:execCLI});ok=true;answer=`${d.action.action}:${d.action.control}`;}
 catch(e){answer=`error: ${e.message.slice(0,100)}`;}
 (results[model]??=[]).push({ms:Date.now()-t,ok,answer});
 console.log(`round ${round+1} ${model} ${Date.now()-t} ms ${answer}`);
}
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s[Math.floor(s.length/2)]:Infinity;};
const ranked=Object.entries(results).map(([model,rs])=>({model,median:median(rs.filter(x=>x.ok).map(x=>x.ms)),ok:rs.filter(x=>x.ok).length,runs:rs.length,answers:[...new Set(rs.map(x=>x.answer))]}))
 .sort((a,b)=>(b.ok>0)-(a.ok>0)||a.median-b.median);
console.log('\nfastest first:');
for(const x of ranked)console.log(`${x.model}\tmedian ${x.median===Infinity?'n/a':x.median+' ms'}\t${x.ok}/${x.runs} ok\t${x.answers.join(', ')}`);
console.log('\norder:',JSON.stringify(ranked.map(x=>x.model)));
process.exit(0);
