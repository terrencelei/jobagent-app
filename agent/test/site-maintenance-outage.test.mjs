import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {siteMaintenanceOutage} from '../src/posting-availability.mjs';

// Hyundai HATCI 15771: careers-americas.hyundai.com served "Site Maintenance / We will be back soon" at its root
// while every /hatci/ path, the posting included, answered a bare 404. The worker read the 404 as a removed posting
// and asked him for a working URL; it is a site-wide outage and belongs on the queue's cooldown path.
const maintenance='<!DOCTYPE html><html><head><title>Site Maintenance</title></head><body><div class="box"><h1>Site Maintenance</h1><p>We will be back soon.</p></div></body></html>';
const careersHome='<html><head><title>Careers at Fixture Motors</title></head><body><nav>Search jobs</nav><h1>Join us</h1>'+
 '<ul>'+Array.from({length:40},(_,i)=>`<li><a href="/job/${i}">${i%7===0?'Site Maintenance Technician':'Body Structures Engineer'} ${i}</a> Ann Arbor, MI</li>`).join('')+'</ul>'+
 '<p>Our plants run scheduled maintenance programs led by skilled technicians.</p><footer>Privacy</footer></body></html>';

test('a posting 404 under a careers root in maintenance is a site-wide outage; a normal root or a non-404 posting is not',async()=>{
 let root={status:200,body:maintenance};const requests=[];
 const server=createServer((req,res)=>{
  requests.push(req.url);
  if(req.url==='/'){res.writeHead(root.status,{'content-type':'text/html'});return res.end(root.body);}
  res.writeHead(404,{'content-type':'text/html'});res.end('');
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 let browser;
 try {
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage();
  const local=`http://127.0.0.1:${server.address().port}`;
  // The probe only ever fetches the posting's own origin root; the fixture stands in for it.
  const fetch=url=>{assert.ok(/^https:\/\/careers\.fixture\.test\/$/.test(url),url);return page.request.get(`${local}/`,{maxRedirects:3,timeout:15000});};
  const job={url:'https://careers.fixture.test/hatci/job/Ann-Arbor-Body-Structures-Engineer-MI-48108/1408543600/',title:'Body Structures Engineer',company:'Fixture Motors'};
  const response=await page.goto(`${local}/hatci/job/Ann-Arbor-Body-Structures-Engineer-MI-48108/1408543600/`);
  assert.equal(response.status(),404);
  assert.equal(await page.locator('input,button,select,textarea').count(),0);
  const outage=await siteMaintenanceOutage(job,{status:response.status(),fetch});
  assert.match(outage,/^careers\.fixture\.test shows a maintenance page \("Site Maintenance"\) on its home page and answers this posting with 404 \(site-wide outage\)\.$/);
  assert.ok(`Site unavailable: ${outage} The queue will retry after a cooldown.`.startsWith('Site unavailable:'));
  // A notice without a <title> still counts when the page is a short notice.
  root={status:200,body:'<html><body><p>We will be back soon.</p></body></html>'};
  assert.match(await siteMaintenanceOutage(job,{status:404,fetch}),/\("We will be back soon"\)/);
  // The root itself failing (5xx) is the same outage.
  root={status:503,body:'Service Unavailable'};
  assert.match(await siteMaintenanceOutage(job,{status:404,fetch}),/HTTP 503 and this posting with 404/);
  // A working careers home page makes the 404 a real missing posting: no outage claim, even with maintenance jobs listed.
  root={status:200,body:careersHome};
  assert.equal(await siteMaintenanceOutage(job,{status:404,fetch}),null);
  // Only a 404 posting document triggers the probe; a served page, a 403 or a 200 never does.
  root={status:200,body:maintenance};const before=requests.length;
  for(const status of [200,403,429,500,undefined]) assert.equal(await siteMaintenanceOutage(job,{status,fetch}),null,String(status));
  assert.equal(requests.length,before);
  // A posting on http, with credentials or a port is never probed; a failing fetch is not an outage claim.
  assert.equal(await siteMaintenanceOutage({url:'http://careers.fixture.test/job/1'},{status:404,fetch}),null);
  assert.equal(await siteMaintenanceOutage({url:'https://careers.fixture.test:8443/job/1'},{status:404,fetch}),null);
  assert.equal(await siteMaintenanceOutage(job,{status:404,fetch:async()=>{throw new Error('offline');}}),null);
  assert.equal(await siteMaintenanceOutage(job,{status:404}),null);
 } finally {await browser?.close();await new Promise(r=>server.close(r));}
});
