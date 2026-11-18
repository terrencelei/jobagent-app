// Tag repeated history fields separately from the applicant's contact address.
export async function annotateHistoryControls(frame, controls) {
  const sections = await frame.evaluate(knownControls => {
    const result = {};
    const labels = new Map(knownControls.map(c => [c.id,c.label]));
    const clean = text => text.replace(/[\uE000-\uF8FF]/g, '').trim();
    const kind = text => /^(?:work (?:experience|history)|employment (?:experience|history)|previous employment)\s*[:*]?$/i.test(clean(text)) ? 'workHistory'
      : /^(?:education|education history|formal education)\s*[:*]?$/i.test(clean(text)) ? 'education' : undefined;
    for (const el of document.querySelectorAll('[data-ja-control]')) {
      let section, titledGroup = false;
      // A local labelled group wins over page-level headings.
      for (let parent = el.parentElement; parent && parent.tagName !== 'FORM'; parent = parent.parentElement) {
        const datasetTitle = parent.matches('.MultipleDatasetEntryFormField,.datasetField') ? parent.querySelector(':scope > .tc_formLabel') : null;
        const datasetLabel = datasetTitle?.querySelector('label')?.textContent || datasetTitle?.textContent;
        const labelled = (parent.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' ');
        const controller = parent.id && [...document.querySelectorAll('[aria-controls][aria-expanded]')].find(c => c.getAttribute('aria-controls') === parent.id);
        const title = parent.getAttribute('aria-label') || labelled.trim() || parent.querySelector(':scope > legend')?.textContent || datasetLabel || controller?.textContent;
        if (title?.trim() && (kind(title) || /^(?:(?:personal|contact) information|(?:home|current|mailing) address|references)\s*[:*]?$/i.test(title.trim()))) {
          section = kind(title); titledGroup = true; break;
        }
        // Repeated rows often have no heading at all. A bounded local row with
        // employer/school fields is evidence; a mixed contact form is not.
        if (/^(?:location|city|city and state)\s*[*?]*$/i.test(labels.get(el.getAttribute('data-ja-control')) || '')) {
          const row = [...parent.querySelectorAll('[data-ja-control]')].map(c => labels.get(c.getAttribute('data-ja-control')) || '');
          const contact = row.some(label => /^(?:e-?mail|phone|first name|last name|street address|postal code)\b/i.test(label));
          if (contact) { titledGroup = true; break; }
          if (row.length >= 2 && row.length <= 16) {
            const work = row.some(label => /^(?:company|employer|job title)\s*[*?]*$/i.test(label));
            const education = row.some(label => /^(?:school|university|degree|major)\s*[*?]*$/i.test(label));
            if (work !== education) { section = work ? 'workHistory' : 'education'; titledGroup = true; break; }
          }
        }
      }
      if (!titledGroup) {
        const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading],.FormHeader,[aria-controls][aria-expanded]')]
          .filter(h => h.getClientRects().length && (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
        // Use only the nearest heading, so a following personal section resets history.
        section = kind(headings.at(-1)?.textContent || '');
      }
      if (section) result[el.getAttribute('data-ja-control')] = section;
    }
    return result;
  }, controls.map(({id,label}) => ({id,label})));
  for (const control of controls) if (sections[control.id]) control.historySection = sections[control.id];
  // A country selector labelled Job Location belongs to its employer row, not
  // the applicant's address. Scope approvals before repeated rows lose context.
  const countries = await frame.evaluate(known => {
    const byId = new Map(known.map(c => [c.id,c]));
    const result = {};
    for (const el of document.querySelectorAll('[data-ja-control]')) {
      const c = byId.get(el.getAttribute('data-ja-control'));
      if (c?.historySection !== 'workHistory' || !/^job location\s*[*?]*$/i.test(c.label.trim()) ||
          ['United States','Canada','Mexico'].filter(name => c.options?.some(o => o.label === name)).length < 2) continue;
      let company = '';
      for (let parent = el.parentElement; parent && parent.tagName !== 'FORM'; parent = parent.parentElement) {
        const employers = [...parent.querySelectorAll('[data-ja-control]')].map(e => byId.get(e.getAttribute('data-ja-control')))
          .filter(v => v && /^(?:company(?: name)?|employer(?: name)?)\s*[*?]*$/i.test(v.label.replace(/^[*\s]+/, '').trim()));
        if (employers.length === 1) { company = employers[0].value?.trim() || ''; break; }
        if (employers.length > 1) break;
      }
      result[c.id] = company;
    }
    return result;
  }, controls);
  for (const c of controls) if (Object.hasOwn(countries,c.id)) {
    c.historyCountry = true;
    c.historyCompany = countries[c.id];
    c.label = `Job Location (country) — ${c.historyCompany || 'unidentified employer'}`;
  }
}

export const historyLocation = control => !!control.historySection && /^(?:location|city|city and state)\s*[*?]*$/i.test(control.label);

export function confirmedHistoryLocation(action, control, profile) {
  if (control.historyCountry) {
    const match = /^workHistory\.(\d+)\.location$/.exec(action.fact || '');
    const norm = v => String(v ?? '').trim().toLowerCase().replace(/\s+/g,' ');
    const row = match && profile.workHistory?.[Number(match[1])];
    const matches = profile.workHistory?.filter(h => norm(h.company) === norm(control.historyCompany)) || [];
    if (!control.historyCompany || !row || matches.length !== 1 || norm(row.company) !== norm(control.historyCompany))
      throw new Error('History country needs the matching unique confirmed employer location');
    if (/(?:^|,)\s*(?:USA|United States(?: of America)?)\s*$/i.test(row.location || '')) return 'United States';
    throw new Error('History country is not explicit in the confirmed employer location');
  }
  if (!historyLocation(control)) return undefined;
  const match = /^(workHistory|education)\.(\d+)\.location$/.exec(action.fact || '');
  const value = match && match[1] === control.historySection ? profile[match[1]]?.[Number(match[2])]?.location : undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error('History location needs the matching confirmed history fact');
  return value;
}

export function safeHistoryAdd(control, pageURL) {
  const label = control.label.trim().replace(/^[\uE000-\uF8FF+＋]\s*/u, '');
  const scopedAdd = /^add$/i.test(label) && ['workHistory','education'].includes(control.historySection);
  // Phenom (Cisco 12281) renders its history add buttons as type=submit with a fixed array id.
  // Its step is headed "My experience", which the section scan may not tag, so the id and
  // label alone identify the add button; they must name the same dataset.
  const phenomAdd = control.type === 'submit' && !control.href && control.inForm &&
    /^add (?:experience|education)$/i.test(label) &&
    control.domId === `array-button-add-${label.split(/\s+/)[1].toLowerCase()}Data`;
  if (phenomAdd) return true;
  if (!control.inForm || !['button','a'].includes(control.type) ||
      !(scopedAdd || /^add (?:another entry to |another )?(?:work experience|employment history|education)\s*[+]?$/i.test(label))) return false;
  if (!control.href) return control.type === 'button';
  if (control.download || control.target && control.target !== '_self') return false;
  // Only inert script targets or a fragment on this exact document are add actions.
  if (/^javascript:\s*(?:void\(0\)|;)\s*;?$/i.test(control.href)) return true;
  try {
    const target = new URL(control.href, pageURL), current = new URL(pageURL);
    return /^https?:$/.test(target.protocol) && target.origin === current.origin &&
      target.pathname === current.pathname && target.search === current.search &&
      !target.hash && (control.href.endsWith('#') || control.hrefAttr === '');
  } catch { return false; }
}
