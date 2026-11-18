// Same place, different wording (his request, 2026-11-02, lesson 438): when the worker means "Springfield, California,
// United States" and the menu offers "Springfield, CA, USA", that option is his answer. Typing his own wording again
// and again never matches a location typeahead.
import {US_STATE_NAMES} from './profile-facts.mjs';

const STATE_CODE=Object.fromEntries(Object.entries(US_STATE_NAMES).map(([code,name])=>[name.toLowerCase(),code.toLowerCase()]));
const US=new Set(['us','usa','u.s.','u.s.a.','united states','united states of america','america']);
const canon=part=>{
 const p=String(part??'').toLowerCase().replace(/\s+/g,' ').replace(/^\s+|\s+$/g,'').replace(/\.$/,'');
 if(US.has(p))return 'us';
 return STATE_CODE[p]??p;
};
const parts=text=>String(text??'').split(/[,|•·]|\s[-–]\s/).map(canon).filter(Boolean);

// True when a and b name the same place: the first part (city) is equal and every part of the shorter one appears in
// the longer one ("Springfield, CA" ~ "Springfield, California, United States"; "Springfield, OH" is not).
export function samePlace(a,b){
 const x=parts(a),y=parts(b);
 if(x.length<2&&y.length<2)return false;  // plain words are not places; ordinary option matching handles them
 if(!x.length||!y.length||x[0]!==y[0])return false;
 const [short,long]=x.length<=y.length?[x,y]:[y,x];
 return short.slice(1).every(p=>long.slice(1).includes(p));
}

// The one offered option that is the same place as value, else null (none, or ambiguous).
export function placeOption(options,value){
 const hits=(options??[]).filter(o=>samePlace(o,value));
 return hits.length===1?hits[0]:null;
}
