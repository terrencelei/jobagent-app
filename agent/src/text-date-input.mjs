// Some text date pickers parse input immediately using their declared format.
// Preserve the exact approved calendar date rather than letting an ISO value
// be interpreted as keystrokes against the picker's default date.
export async function textDateInputValue(locator,type,value) {
 if(type!=='text'||typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return value;
 const date=new Date(value+'T00:00:00Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==value)return value;
 const format=await locator.evaluate(el=>{
  try{return window.jQuery?.(el).data('DateTimePicker')?.format();}catch{return null;}
 });
 if(format!=='MM/DD/YYYY')return value;
 // Opening a previously empty picker can insert today's default on focus.
 // Let that normal focus handler run before Playwright selects and replaces it.
 await locator.focus();
 return `${value.slice(5,7)}/${value.slice(8,10)}/${value.slice(0,4)}`;
}

const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
// A saved month and year ("6/2026" or [6, 2026]) for a single month field ("From"/"To" on Cisco's Phenom form).
export function monthYearPair(value){
 const text=typeof value==='string'&&/^(\d{1,2})\/(\d{4})$/.exec(value.trim());
 if(!text&&!(Array.isArray(value)&&value.length===2))return null;
 const month=Number(text?text[1]:value[0]),year=String(text?text[2]:value[1]);
 return Number.isInteger(month)&&month>=1&&month<=12&&/^\d{4}$/.test(year)?{month,year}:null;
}
// Phenom month pickers open a popup with a year <select> and Jan…Dec cells and ignore typed text.
// Pick the year and month there; otherwise type the saved value. Returns the value the field now shows.
export async function fillMonthYear(locator,{month,year},typed=`${String(month).padStart(2,'0')}/${year}`){
 await locator.click({timeout:3000}).catch(()=>{});
 await locator.page().waitForTimeout(300);
 const picked=await locator.evaluate((el,{label,year})=>{
  const visible=n=>{const r=n.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(n).visibility!=='hidden';};
  const near=n=>{const a=el.getBoundingClientRect(),b=n.getBoundingClientRect();return Math.abs(b.top-a.bottom)<400&&Math.abs(b.left-a.left)<400;};
  const select=[...document.querySelectorAll('select')].filter(s=>visible(s)&&near(s)&&[...s.options].some(o=>o.text.trim()===year)).sort((x,y)=>Math.abs(x.getBoundingClientRect().top-el.getBoundingClientRect().bottom)-Math.abs(y.getBoundingClientRect().top-el.getBoundingClientRect().bottom))[0];
  if(!select)return false;
  select.value=[...select.options].find(o=>o.text.trim()===year).value;select.dispatchEvent(new Event('change',{bubbles:true}));
  let box=select.parentElement;while(box&&![...box.querySelectorAll('*')].some(n=>n.children.length===0&&n.textContent.trim()===label))box=box.parentElement;
  const cell=box&&[...box.querySelectorAll('*')].find(n=>n.children.length===0&&n.textContent.trim()===label&&visible(n));
  if(!cell)return false;cell.click();return true;
 },{label:MONTHS[month-1],year}).catch(()=>false);
 if(!picked||!(await locator.inputValue()).includes(year))await locator.fill(typed);
 return locator.inputValue();
}
