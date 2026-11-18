import test from 'node:test';
import assert from 'node:assert/strict';
import {streetLineLabel} from '../src/dashboard-worker.mjs';

test('street-line labels get the keyed map-search fallback; other address fields do not',()=>{
 for(const label of ['Street Number and Name or P.O. Box *','Address Line 1','Street Address *'])assert.equal(streetLineLabel(label),true,label);
 for(const label of ['City *','ZIP Code *','Apartment or Unit Number','Address Line 2'])assert.equal(streetLineLabel(label),false,label);
});
