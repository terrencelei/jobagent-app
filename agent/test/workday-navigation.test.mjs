import test from 'node:test';import assert from 'node:assert/strict';
import {sameStep,waitForStep,goBackWorkday} from '../src/workday-navigation.mjs';
test('renumbered steps advance by name as well as number',()=>{
 assert.equal(sameStep({n:1,name:'Autofill with Resume'},{n:1,name:'My Information'}),false);
 assert.equal(sameStep({n:2,name:'My Information'},{n:2,name:'My Information'}),true);
});
test('save waits through loading until the delayed next step appears',async()=>{
 let reads=0,waits=0;
  const page={locator:selector=>({innerText:async()=>++reads<3?'Loading':reads<5?'current step 2 of 7\nMy Information':'current step 3 of 7\nMy Experience',allInnerTexts:async()=>[],isVisible:async()=>reads>=7,isEnabled:async()=>true})};
 assert.match(await waitForStep(page,{n:2,name:'My Information'},{wait:async()=>{waits++;}}),/My Experience/);
 assert.equal(waits,7);
});
test('a visible disabled footer does not mark a loading experience form ready',async()=>{
 let reads=0,waits=0;
 const page={locator:()=>({innerText:async()=>{reads++;return 'current step 3 of 6\nMy Experience';},allInnerTexts:async()=>[],isVisible:async()=>true,isEnabled:async()=>reads>=4})};
 await waitForStep(page,{n:2,name:'My Information'},{wait:async()=>{waits++;}});
 assert.equal(waits,4);
});
test('a briefly enabled stale footer is not mistaken for a settled new page',async()=>{
 let reads=0,waits=0;
 const page={locator:()=>({innerText:async()=>{reads++;return 'current step 3 of 6\nMy Experience';},allInnerTexts:async()=>[],isVisible:async()=>true,isEnabled:async()=>reads===1||reads>=4})};
 await waitForStep(page,{n:2,name:'My Information'},{wait:async()=>{waits++;}});
 assert.equal(waits,4);
});
test('Back retries an ignored ordinary click once with a DOM click and verifies the new step',async()=>{
 let step='current step 3 of 6\nApplication Questions',clicks=0,domClicks=0;
 const page={locator:()=>({innerText:async()=>step,allInnerTexts:async()=>[],isVisible:async()=>true,isEnabled:async()=>true,scrollIntoViewIfNeeded:async()=>{},click:async()=>{clicks++;},evaluate:async()=>{domClicks++;step='current step 2 of 6\nMy Experience';}})};
 assert.match(await goBackWorkday(page,{n:3,name:'Application Questions'},{wait:async()=>{}}),/My Experience/);
 assert.equal(clicks,1);assert.equal(domClicks,1);
});
test('history save waits for another page rather than a renumbering of My Experience',async()=>{
 let reads=0,waits=0;
 const page={locator:()=>({innerText:async()=>++reads<4?'current step 3 of 6\nMy Experience':'current step 4 of 6\nApplication Questions',allInnerTexts:async()=>[],isVisible:async()=>true,isEnabled:async()=>true})};
 assert.match(await waitForStep(page,{n:2,name:'My Experience'},{leaveName:true,wait:async()=>{waits++;}}),/Application Questions/);
 assert.equal(waits,4);
});
