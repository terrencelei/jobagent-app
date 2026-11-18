// A local fixture probe: no employer page, account, credentials or application.
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import { applicationChromium } from '../src/captcha-vendor.mjs';
const chromium = await applicationChromium();  // the CAPTCHA package's stealth.js launch
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const fixture=await mkdtemp(join(tmpdir(),'jobagent-capability-'));
let browser;
try{
 await writeFile(join(fixture,'check.txt'),'capability fixture');
 const outsideWorkspaceWrite=await readFile(join(fixture,'check.txt'),'utf8')==='capability fixture';
 await readFile(join(root,'package.json'));await readFile(join(dirname(root),'jobagent/pyproject.toml'));
 browser=await chromium.launch({headless:true});const page=await browser.newPage();
 await page.setContent('<main id="fixture">Browser capability fixture</main>');
 const browserAccess=await page.locator('#fixture').innerText()==='Browser capability fixture';
 console.log(JSON.stringify({outsideWorkspaceWrite,browserAccess,applicationRepo:true,jobagentRepo:true}));
}finally{await browser?.close();await rm(fixture,{recursive:true,force:true});}
