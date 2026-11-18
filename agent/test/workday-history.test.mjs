import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {planHistory,historyProblems,reconcileWorkdayHistory,readWorkdayHistory,validateHistory,ensureWorkdayEducationRows} from '../src/workday-history.mjs';

const history=[
 {company:'Fixture Labs',title:'Engineering Intern',location:'Example City',from:['6','2025'],to:['9','2025'],description:'Built the confirmed fixture.'},
 {company:'Fixture University',title:'Research Assistant',location:'Example Campus',from:['1','2026'],to:null,description:'Maintains the confirmed experiment.'},
];
const row=(id,entry,overrides={})=>({id,title:entry.title,company:entry.company,location:entry.location,description:entry.description,fromMonth:entry.from[0],fromYear:entry.from[1],toMonth:entry.to?.[0]??'',toYear:entry.to?.[1]??'',current:entry.to===null,present:['title','company','location','description','fromMonth','fromYear','toMonth','toYear','current'],...overrides});

test('saved employer capitalization does not trigger repair, while actual history changes still block',()=>{
 const saved=[row('1',history[0],{company:history[0].company.toUpperCase()}),row('2',history[1])];
 assert.deepEqual(historyProblems(saved,history),[]);
 assert.ok(historyProblems([{...saved[0],company:'Another Employer'},saved[1]],history).some(p=>p.includes('company differs')));
 assert.ok(historyProblems([{...saved[0],description:history[0].description.toUpperCase()},saved[1]],history).some(p=>p.includes('description differs')));
 assert.ok(historyProblems([{...saved[0],fromYear:'2024'},saved[1]],history).some(p=>p.includes('start date differs')));
 assert.ok(historyProblems([saved[0]],history).some(p=>p.includes('missing rows')));
});

test('history matching keeps the best real row and replaces parser inventions and duplicates',()=>{
 const rows=[row('1',history[0],{company:'garbled'}),row('2',history[0]),row('3',history[0],{fromYear:'2012'})];
 assert.deepEqual(planHistory(rows,history),{keep:[{id:'2',index:0}],remove:['1','3'],missing:[1]});
});
test('same-month jobs are matched by employer rather than the first date match',()=>{
 const second={...history[1],from:history[0].from};
 assert.deepEqual(planHistory([row('4',second),row('5',history[0])],[history[0],second]).missing,[]);
 assert.equal(planHistory([row('6',second,{company:'unidentified'})],[history[0],second]).remove.length,1);
});
test('an exact known employer and title permit correcting a garbled start date',()=>{
 const rows=[row('1',history[0],{fromMonth:'2'}),row('2',history[1])];
 assert.deepEqual(planHistory(rows,history).missing,[]);
 assert.ok(historyProblems(rows,history).some(p=>p.includes('start date differs')));
});
test('distinct titles at one employer in the same month remain distinct confirmed jobs',()=>{
 const second={...history[0],title:'Test Technician'};
 assert.deepEqual(planHistory([row('1',history[0]),row('2',second)],[history[0],second]).missing,[]);
});
test('dates, current employment and exact descriptions are verified',()=>{
 const problems=historyProblems([row('1',history[0],{toYear:'2024',description:'invented',current:true}),row('2',history[1])],history);
 assert.ok(problems.some(p=>p.includes('end date')));
 assert.ok(problems.some(p=>p.includes('description')));
 assert.ok(problems.some(p=>p.includes('current-employment')));
 assert.throws(()=>validateHistory([{...history[0],to:undefined}]),/incomplete/);
 assert.throws(()=>validateHistory([]),/missing/);
 assert.throws(()=>validateHistory([history[0],history[0]]),/ambiguous duplicate/);
 assert.ok(historyProblems([row('1',history[0],{present:['fromMonth','fromYear']}),row('2',history[1])],history).some(p=>p.includes('control is missing')));
});

function fixture(rows) {
 return `<h2>My Experience</h2><section id="work"><h3>Work Experience</h3><div id="rows"></div><button data-automation-id="add-button" onclick="add()">Add Another</button></section>
 <section><h3>Education</h3><input id="education-90--schoolName" value="Keep this school"><button onclick="throw Error('wrong section')">Delete</button><button data-automation-id="add-button" onclick="throw Error('wrong section')">Add Another</button></section>
 <section><h3>Websites</h3><button onclick="throw Error('wrong section')">Delete</button><button data-automation-id="add-button">Add Another</button></section>
 <script>
 let next=100;let saved=${JSON.stringify(rows)};
 const names={title:'jobTitle',company:'companyName',location:'location',description:'roleDescription',fromMonth:'startDate-dateSectionMonth-input',fromYear:'startDate-dateSectionYear-input',toMonth:'endDate-dateSectionMonth-input',toYear:'endDate-dateSectionYear-input'};
 function render(){document.querySelector('#rows').innerHTML='';for(const r of saved){const div=document.createElement('div');div.className='row';const del=document.createElement('button');del.textContent='Delete';del.onclick=()=>{saved=saved.filter(x=>x!==r);saved.forEach(x=>x.id=String(next++));render();};div.append(del);for(const [key,suffix] of Object.entries(names)){const input=document.createElement(key==='description'?'textarea':'input');input.id='workExperience-'+r.id+'--'+suffix;input.value=r[key]||'';input.oninput=()=>r[key]=input.value;div.append(input);}const cb=document.createElement('input');cb.type='checkbox';cb.id='workExperience-'+r.id+'--currentlyWorkHere';cb.checked=r.current;cb.onchange=()=>r.current=cb.checked;div.append(cb);document.querySelector('#rows').append(div);}}
 function add(){setTimeout(()=>{saved.push({id:String(next++),current:false});render();},30);}
 function reloadSaved(){render();}
 render();
 </script>`;
}

test('browser repairs extra and missing rows despite ID changes, preserves other sections and is idempotent',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(fixture([row('1',history[0],{title:'parser garbage',toYear:'2015'}),row('2',history[0],{company:'duplicate'}),row('3',history[0],{fromYear:'2010'})]));
  const events=[];
  await reconcileWorkdayHistory(page,history,{wait:ms=>page.waitForTimeout(ms),onEvent:e=>events.push(e)});
  assert.ok(events.some(e=>e.startsWith('Removed')));
  assert.ok(events.some(e=>e.startsWith('Added')));
  assert.equal(await page.locator('#education-90--schoolName').inputValue(),'Keep this school');
  await page.evaluate(()=>reloadSaved());
  assert.deepEqual(historyProblems(await readWorkdayHistory(page),history),[]);
  const before=await readWorkdayHistory(page);events.length=0;
  await reconcileWorkdayHistory(page,history,{onEvent:e=>events.push(e)});
  assert.deepEqual(await readWorkdayHistory(page),before);
  assert.equal(events.filter(e=>/^(Added|Removed)/.test(e)).length,0);
 }finally{await browser.close();}
});

test('browser rebuilds an empty manually prepared work history',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.setContent(fixture([]));
  await reconcileWorkdayHistory(page,history);
  assert.deepEqual(historyProblems(await readWorkdayHistory(page),history),[]);
 }finally{await browser.close();}
});

test('a long role description is not cut off by the default action timeout',async()=>{
 // Generac 12872: an 872-character description typed at 20 ms/key outlasted the 20 s timeout.
 const long=[{...history[0],description:'Designed and tested fixtures. '.repeat(20)},history[1]];
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();page.setDefaultTimeout(3000);await page.setContent(fixture([]));
  await reconcileWorkdayHistory(page,long);
  assert.deepEqual(historyProblems(await readWorkdayHistory(page),long),[]);
 }finally{await browser.close();}
});

test('browser stops if a reactive control discards a confirmed value',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.setContent(fixture([row('1',history[0]),row('2',history[1])]));
  await page.locator('[id="workExperience-1--companyName"]').evaluate(el=>{el.value='wrong';el.onblur=()=>{el.value='wrong';};});
  await assert.rejects(reconcileWorkdayHistory(page,history),/did not retain companyName/);
 }finally{await browser.close();}
});

test('rebuilding dates navigates a composite widget that redirects Year focus to Month',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.setContent(fixture([]));
  await page.evaluate(()=>{
   let navigating=false;
   document.addEventListener('focusin',event=>{
    if(!navigating&&event.target.id.endsWith('-dateSectionYear-input'))document.getElementById(event.target.id.replace('dateSectionYear-input','dateSectionMonth-input')).focus();
   });
   document.addEventListener('keydown',event=>{
    if(event.key==='ArrowRight'&&event.target.id.endsWith('-dateSectionMonth-input')){
     navigating=true;document.getElementById(event.target.id.replace('dateSectionMonth-input','dateSectionYear-input')).focus();navigating=false;
    }
   });
  });
  await reconcileWorkdayHistory(page,history);
  assert.deepEqual(historyProblems(await readWorkdayHistory(page),history),[]);
 }finally{await browser.close();}
});

test('manual education preparation creates exactly the confirmed rows in its own section',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.setContent(`<section><h3>Work Experience</h3><input id="workExperience-1--jobTitle" value="Keep this work"><button data-automation-id="add-button">Add</button></section><section id="education"><h3>Education</h3><div id="edu-rows"></div><button data-automation-id="add-button" onclick="const e=document.createElement('input');e.id='education-'+document.querySelectorAll('#edu-rows input').length+'--schoolName';document.querySelector('#edu-rows').append(e)">Add</button></section>`);
  const entry={school:'Fixture University',degree:"Bachelor's Degree",field:'Engineering',from:['8','2023'],to:['6','2027']};
  const ids=await ensureWorkdayEducationRows(page,[entry,entry]);assert.equal(ids.length,2);
  assert.deepEqual(await ensureWorkdayEducationRows(page,[entry,entry]),ids);
  assert.equal(await page.locator('[id="workExperience-1--jobTitle"]').inputValue(),'Keep this work');
  await assert.rejects(ensureWorkdayEducationRows(page,[entry]),/extra unconfirmed/);
 }finally{await browser.close();}
});

test('an undeletable blank starter row is filled with confirmed history instead of removed',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.setContent(fixture([{id:'5',current:false}]));
  await page.locator('#rows button').evaluate(el=>el.remove());
  await reconcileWorkdayHistory(page,history);
  assert.deepEqual(historyProblems(await readWorkdayHistory(page),history),[]);
  assert.equal((await readWorkdayHistory(page))[0].id,'5');
 }finally{await browser.close();}
});

test('education degree mismatch flags a row overwritten after its confirmed choice', async () => {
 const {educationDegreeMismatches} = await import('../src/workday-history.mjs');
 assert.deepEqual(educationDegreeMismatches(["General Education Development Diploma (GED)", "Bachelor's Degree"], ["Bachelor's Degree", "Bachelor's Degree"]), [0]);
 assert.deepEqual(educationDegreeMismatches(["Bachelor's  degree", "Bachelor's Degree"], ["Bachelor's Degree", "Bachelor's Degree"]), []);
 assert.deepEqual(educationDegreeMismatches(["GED", null], [undefined, "Bachelor's Degree"]), [1]);
});
