const canonical = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const currentQuestion = label => /^is current position\?\s*$/i.test(label);

function confirmedRow(profile, company, title) {
  const rows = (profile.workHistory ?? []).map((row,index) => ({...row,index})).filter(row => canonical(row.company) === canonical(company));
  // Employer-wide status cannot identify separate past/current roles at one company.
  if (rows.length !== 1 || title && canonical(rows[0].title) !== canonical(title)) return null;
  const flags = (profile.answers?.confirmedEmploymentCompanies ?? []).filter(row => canonical(row.company) === canonical(company));
  if (flags.length !== 1 || typeof flags[0].current !== 'boolean') return null;
  return {index:rows[0].index,value:flags[0].current ? 'Yes' : 'No'};
}

export function historyCurrentFacts(profile) {
  const facts = {};
  for (const row of profile.workHistory ?? []) {
    const confirmed = confirmedRow(profile,row.company,row.title);
    if (confirmed) facts[`workHistory.${confirmed.index}.current`] = confirmed.value;
  }
  return facts;
}

export function confirmedCurrentPosition(control, profile) {
  if (!currentQuestion(control.historyQuestion ?? control.label)) return undefined;
  const confirmed = control.historyCompany && confirmedRow(profile,control.historyCompany,control.historyTitle);
  if (!confirmed) throw new Error('Current-position question needs an identified employment row and explicit saved status');
  return confirmed.value;
}

export async function annotateCurrentPositions(frame, controls) {
  const contexts = await frame.evaluate(known => {
    const fields = new Map(known.map(control => [control.id,control]));
    const result = {};
    for (const control of known.filter(c => /^is current position\?\s*$/i.test(c.label))) {
      const el = document.querySelector(`[data-ja-control="${control.id}"]`);
      for (let parent=el?.parentElement; parent && parent.tagName!=='FORM'; parent=parent.parentElement) {
        const row=[...parent.querySelectorAll('[data-ja-control]')].map(node=>fields.get(node.getAttribute('data-ja-control'))).filter(Boolean);
        if (row.length>16 || row.some(c=>/^(?:email|phone|first name|last name|street address)\b/i.test(c.label))) break;
        const companies=row.filter(c=>/^(?:company|employer)\s*[*?]*$/i.test(c.label));
        const titles=row.filter(c=>/^job title\s*[*?]*$/i.test(c.label));
        if (companies.length===1 && companies[0].value?.trim()) {
          result[control.id]={historyQuestion:control.label,historyCompany:companies[0].value.trim(),historyTitle:titles.length===1?titles[0].value.trim():undefined};
          break;
        }
      }
    }
    return result;
  },controls.map(({id,label,value})=>({id,label,value})));
  for (const control of controls) if (contexts[control.id]) {
    Object.assign(control,contexts[control.id]);
    control.label=`${control.historyQuestion} — ${control.historyCompany}${control.historyTitle ? ` (${control.historyTitle})` : ''}`;
  }
}
