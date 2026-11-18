// A required explanation can be inapplicable even when Greenhouse always displays it.
// Require both a retained selection and the exact approved office choice.
export function inactiveLocationExplanation(controls, approvedLocation) {
 if(typeof approvedLocation!=='string'||!approvedLocation.trim())return null;
 const fields=controls.filter(c=>/^If ["“]N\/A Other Location["”] selected above, please explain\s*\*?$/i.test(c.label)&&c.required&&!c.value);
 if(fields.length!==1)return null;
 const groups=new Map();
 for(const c of controls){
  if(c.type!=='checkbox'||!c.name||!/^Please select the office location\(s\) you are applying to work from\s*\*?$/i.test(c.label))continue;
  if(!groups.has(c.name))groups.set(c.name,[]);
  groups.get(c.name).push(c);
 }
 if(groups.size!==1)return null;
 const group=[...groups.values()][0];
 const other=group.filter(c=>/^N\/A\s*-?\s*Other Location$/i.test(c.optionLabel??''));
 const selected=group.filter(c=>c.value==='true');
 if(other.length!==1||other[0].value!=='false'||selected.length!==1||selected[0].optionLabel!==approvedLocation)return null;
 return {control:fields[0],value:'N/A'};
}
