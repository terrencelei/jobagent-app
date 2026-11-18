import test from 'node:test';
import assert from 'node:assert/strict';
import {sentResumeSkills} from '../src/workday-controls.mjs';

test('skills come from the Technical line of the sent resume, exact terms only', () => {
 const resume={sections:[{kind:'skills',lines:[{label:'Technical',text:'MS Office (Excel), SQL, SolidWorks, NX, SQL'},{label:'Programming',text:'Python'}]}]};
 assert.deepEqual(sentResumeSkills(resume),['SQL','SolidWorks','NX']);
 assert.deepEqual(sentResumeSkills(null),[]);
});
