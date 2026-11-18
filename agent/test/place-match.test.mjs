import test from 'node:test';
import assert from 'node:assert/strict';
import {samePlace,placeOption} from '../src/place-match.mjs';

// His request (lesson 438): pick "Springfield, CA, USA" when the worker means "Springfield, California, United States".
test('the same place in other wording matches; a different state or city does not',()=>{
 assert.ok(samePlace('Springfield, CA, USA','Springfield, California, United States'));
 assert.ok(samePlace('Springfield, CA, US','Springfield, California, United States'));
 assert.ok(samePlace('Springfield, California','Springfield, CA, United States of America'));
 assert.equal(samePlace('Springfield, OH, USA','Springfield, California, United States'),false);
 assert.equal(samePlace('San Jose, CA, USA','Springfield, California, United States'),false);
 assert.equal(samePlace('Yes','Yes'),false);
 assert.equal(placeOption(['Springfield, CA, USA','Springfield, OH, USA','Springfield, FL, USA'],'Springfield, California, United States'),'Springfield, CA, USA');
 assert.equal(placeOption(['Springfield, CA, USA','Springfield, California'],'Springfield, California, United States'),null,'two equally good options: no guess');
});
