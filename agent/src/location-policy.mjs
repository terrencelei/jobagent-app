// Employer location chooses the user's explicitly saved application location.
const BAY=/\b(?:bay area|san francisco|south san francisco|santa clara|campbell|san jose|sunnyvale|mountain view|palo alto|menlo park|redwood city|san mateo|san carlos|belmont|foster city|fremont|newark|milpitas|cupertino|oakland|berkeley|pleasanton|livermore|san bruno|burlingame|san rafael|novato|petaluma|santa rosa|napa|walnut creek|concord|san ramon|dublin|daly city|pacifica|union city|hayward|alameda)\b/i;
const SOUTH=/\b(?:southern california|socal|goleta|santa barbara|los angeles|el segundo|hawthorne|torrance|long beach|carson|irvine|costa mesa|orange county|anaheim|santa ana|san diego|carlsbad|oceanside|ventura|oxnard|camarillo|thousand oaks|pasadena|burbank|riverside|san bernardino|palmdale|lancaster|mojave|redondo beach|manhattan beach|santa monica|culver city|fullerton|buena park|brea|tustin|garden grove|huntington beach|fountain valley|newport beach|lake forest|mission viejo|aliso viejo|cypress|gardena|inglewood|chatsworth|valencia|santa clarita|simi valley|ontario|rancho cucamonga|temecula|escondido|poway|chula vista)\b/i;
export function locationRegion(job={}){
 const location=Array.isArray(job.location)?job.location.join('; '):String(job.location??'');
 const bay=BAY.test(location),south=SOUTH.test(location);
 return bay&&!south?'bayArea':south&&!bay?'southernCalifornia':null;
}
export function regionalProfile(profile={},job={}){
 const rule=profile.answers?.applicationLocationRule;
 if(!rule)return profile;
 const region=locationRegion(job),place=rule[region??rule.defaultRegion];
 if(!place)return profile;
 const answers={...profile.answers};
 for(const key of ['addressLine1','addressLine2','addressZip'])delete answers[key];
 Object.assign(answers,{city:`${place.city}, California, United States`,citySearch:place.city,leverLocation:`${place.city}, CA, USA`,addressCity:place.city,addressState:'CA',country:'United States'},place.address??{});
 return {...profile,answers,regionalLocation:{region,city:place.city}};
}
function compoundAddressQuestion(label){
 // A bounded address request may be followed by explanatory employer prose.
 // Its component list describes one answer, not separate city/state/ZIP fields.
 return /^(?:please (?:provide|enter|list) your |what is your )?(?:current |home |mailing |permanent )?address\s*\(city,\s*state,\s*(?:and\s+)?(?:zip(?: code)?|postal code)\)\s*(?:[.?*]|$)/i.test(String(label).trim());
}
export function locationQuestion(label){
 // Intuitive 12315 (lesson 429): "What is your postal code?" and "What is your State or Province?" are the regional
 // ZIP and state too; the question prefix applies to every wording, not only to addresses.
 return compoundAddressQuestion(label)||/^(?:please (?:provide|enter|list) your |what is your )?(?:current |home |mailing |permanent )?(?:(?:street )?address(?: line ?[12])?|street number and name(?: or p\.?\s?o\.? box)?|(?:city|location)(?: and state)?|city\/town:?|in which city and state are you located|(?:postal|zip) code|zip(?: or postal code)?|postal(?: or zip)? code|state(?: or province|\/province)?)(?:\s*[?*])*\s*$/i.test(String(label).trim());
}
export function regionalAnswer(label,profile,job={}){
 const selected=regionalProfile(profile,job);
 if(!selected.regionalLocation||!locationQuestion(label))return undefined;
 const q=String(label).trim().replace(/(?:\s*[?*])+$/,'').trim().toLowerCase().replace(/^(?:please (?:provide|enter|list) your |what is your )(?:current |home |mailing |permanent )?/,''),a=selected.answers;
 let value;
 if(compoundAddressQuestion(label)){
  if(a.addressCity&&a.addressState&&a.addressZip)value=`${a.addressCity}, ${a.addressState} ${a.addressZip}`;
 }else if(/^street number and name/.test(q)){
  // Oracle's own wording for address line 1 (Ford 12635).
  value=a.addressLine1;
 }else if(/address/.test(q)){
  if(/line ?2$/.test(q))value=a.addressLine2;
  else if(/line ?1$/.test(q)||q==='street address')value=a.addressLine1;
  else if(a.addressLine1&&a.addressZip)value=[a.addressLine1,a.addressLine2,a.addressCity,`${a.addressState} ${a.addressZip}`].filter(Boolean).join(', ');
 }else if(/postal|zip/.test(q))value=a.addressZip;
 else if(/^state/.test(q))value='CA';
 else if(q==='city'||q==='current city'||q==='city/town:'||q==='city/town')value=a.addressCity;
 else value=a.city;
 return {value,key:'applicationLocationRule',candidates:value===undefined?[]:[value,...(value==='CA'?['California']:[])]};
}
