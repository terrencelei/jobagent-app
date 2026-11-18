#!/usr/bin/env node
// Runs the Relay control panel (src/captcha-relay.mjs) on 127.0.0.1:8787. The agent starts it on
// demand; run it by hand to watch requests: node tools/captcha-relay.mjs
import {appendFileSync,mkdirSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRelay,RELAY_PORT} from '../src/captcha-relay.mjs';

const logFile=join(dirname(fileURLToPath(import.meta.url)),'..','state','captcha-vendor','relay.log');
mkdirSync(dirname(logFile),{recursive:true});
const log=line=>{const s=`${new Date().toISOString()} ${line}\n`;try{appendFileSync(logFile,s);}catch{}if(process.stdout.isTTY)process.stdout.write(s);};
const server=createRelay({log});
server.on('error',e=>{log(`relay could not listen: ${e.message}`);process.exit(e.code==='EADDRINUSE'?0:1);});
server.listen(RELAY_PORT,'127.0.0.1',()=>log(`relay panel on 127.0.0.1:${RELAY_PORT}`));
