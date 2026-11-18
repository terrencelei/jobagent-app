import test from 'node:test';
import assert from 'node:assert/strict';
import {pathPoints,humanClick} from '../src/human-input.mjs';

const seeded=()=>{let x=7;return()=>(x=(x*16807)%2147483647)/2147483647;};

test('the pointer path is curved, many-stepped and ends exactly on the target',()=>{
 const pts=pathPoints(100,100,700,400,{random:seeded()});
 assert.ok(pts.length>=12);
 assert.deepEqual(pts.at(-1).map(Math.round),[700,400]);
 // not a straight line: some point is well off the chord
 const off=pts.map(([x,y])=>Math.abs((400-100)*x-(700-100)*y+700*100-400*100)/Math.hypot(300,600));
 assert.ok(Math.max(...off)>5);
});

test('humanClick moves in many events, then presses and releases inside the element',async()=>{
 const events=[];
 const page={viewportSize:()=>({width:1280,height:900}),waitForTimeout:async()=>{},
  mouse:{move:async(x,y)=>events.push(['move',x,y]),down:async()=>events.push(['down']),up:async()=>events.push(['up'])}};
 const locator={scrollIntoViewIfNeeded:async()=>{},boundingBox:async()=>({x:500,y:600,width:200,height:40}),click:()=>assert.fail('no fallback')};
 await humanClick(page,locator,{random:seeded()});
 const moves=events.filter(e=>e[0]==='move');
 assert.ok(moves.length>=10);
 const [,x,y]=moves.at(-1);assert.ok(x>500&&x<700&&y>600&&y<640);
 assert.deepEqual(events.slice(-2),[['down'],['up']]);
});

test('installHumanTyping types text inputs key by key and leaves other controls to fill',async()=>{
 const {installHumanTyping}=await import('../src/human-input.mjs');
 const typed=[];const filled=[];
 class FakeLocator{constructor(kind){this.kind=kind;}
  async fill(v){filled.push([this.kind,v]);}
  async focus(){} async inputValue(){return typed.join('');}
  async evaluate(){return this.kind;}
  page(){return {viewportSize:()=>({width:800,height:600}),waitForTimeout:async()=>{},keyboard:{down:async c=>typed.push(c),up:async()=>{},insertText:async c=>typed.push(c)},mouse:{move:async()=>{},down:async()=>{},up:async()=>{}}};}
  async scrollIntoViewIfNeeded(){} async boundingBox(){return {x:10,y:10,width:100,height:20};}
  async pressSequentially(){assert.fail('short text is typed per key');}}
 installHumanTyping(FakeLocator,{random:()=>.5});
 await new FakeLocator('email').fill('a@b');
 assert.equal(typed.join(''),'a@b');assert.deepEqual(filled,[['email','']]);
 await new FakeLocator('date').fill('2026-11-01');
 assert.deepEqual(filled.at(-1),['date','2026-11-01']);
});

test('a setInputFiles timeout with the requested file already in the input counts as set (lesson 454)',async()=>{
 const {installTrustedInput}=await import('../src/human-input.mjs');
 const timeout=()=>{const e=new Error('locator.setInputFiles: Timeout 10000ms exceeded.');e.name='TimeoutError';return e;};
 class Loc{constructor(held){this.held=held;this._frame={};}page(){return {mainFrame:()=>null};}
  async evaluate(fn){return fn({files:this.held.map(name=>({name})),setAttribute(){},removeAttribute(){}});}
  async setInputFiles(){throw timeout();}}
 installTrustedInput(Loc);
 await new Loc(['Alex_Resume.pdf']).setInputFiles('/tmp/x/Alex_Resume.pdf');
 await assert.rejects(new Loc([]).setInputFiles('/tmp/x/Alex_Resume.pdf'),/Timeout/);
 await assert.rejects(new Loc(['other.pdf']).setInputFiles('/tmp/x/Alex_Resume.pdf'),/Timeout/);
});

test('long text typed key by key gets a timeout that scales with its length (Hadrian 12334)',async()=>{
 const {installHumanTyping}=await import('../src/human-input.mjs');
 const seen=[];const value='x'.repeat(720);
 class Loc{async fill(){} async focus(){} async inputValue(){return value;} async evaluate(){return 'textarea';}
  page(){return {viewportSize:()=>({width:800,height:600}),waitForTimeout:async()=>{},mouse:{move:async()=>{},down:async()=>{},up:async()=>{}}};}
  async scrollIntoViewIfNeeded(){} async boundingBox(){return {x:10,y:10,width:100,height:20};}
  async pressSequentially(v,o){seen.push(o);}}
 installHumanTyping(Loc,{random:()=>.5});
 await new Loc().fill(value);
 assert.equal(seen[0].delay,12);
 assert.ok(seen[0].timeout>=value.length*12*2&&seen[0].timeout>10000);
});
