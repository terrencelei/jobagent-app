import test from 'node:test';
import assert from 'node:assert/strict';
import {rebindControl} from '../src/control-identity.mjs';

test('duplicate Apply now links retain the selected node after ordinal IDs change',()=>{
 const top={id:'f0c15',nodeKey:'node15',type:'a',label:'Apply now »',href:'https://example.com/apply'};
 const bottom={...top,id:'f0c20',nodeKey:'node20'};
 const fresh=[{...top,id:'f0c16'},{...bottom,id:'f0c21'}];
 assert.equal(rebindControl(top,fresh),fresh[0]);
 assert.equal(rebindControl(bottom,fresh),fresh[1]);
});

test('replaced controls need a unique identity and unchanged navigation target',()=>{
 const old={id:'f0c1',nodeKey:'node1',type:'a',label:'Apply now',href:'https://example.com/apply'};
 assert.equal(rebindControl(old,[{...old,nodeKey:'node2'},{...old,nodeKey:'node3'}]),null);
 assert.equal(rebindControl(old,[{...old,href:'https://other.example/apply'}]),null);
 const replaced={...old,nodeKey:'node4',domId:'apply'};
 assert.equal(rebindControl({...old,domId:'apply'},[replaced]),replaced);
 assert.equal(rebindControl(old,[]),null);
});
