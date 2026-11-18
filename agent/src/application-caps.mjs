// Employer limits on how many applications one person may send ("you may apply to up to 10
// positions in a 30-day period"). The same patterns as JobAgent's processing/application_caps.py:
// a page stating one stops the run until he allows applying to that employer (the limit is then
// enforced through policy.applicationCaps) or declines.
const WORDS = {'a single': 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, sixty: 60, ninety: 90};
const NUM = '(?:\\d{1,3}|a single|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)';
const UNIT = '(?:applications?|positions?|roles?|jobs?|requisitions?|openings?|opportunities)';
const PERIOD = '(?:(?:\\d{1,3}|thirty|sixty|ninety|twelve|six|one)[\\s-]*(?:days?|weeks?|months?|years?)|calendar year|year|month)';
const ABOUT = /\bapply\b|\bapplying\b|\bapplications?\b|\bsubmit\b|\bsubmissions?\b/i;
const LIMIT = new RegExp(`\\b(?:up to|no more than|maximum of|max(?:imum)?\\.? of|a maximum of|limit(?:ed)? (?:of|to)|only)\\s+(${NUM})\\s+(?:\\w+\\s+){0,2}?${UNIT}\\b`
  + `|\\b(${NUM})\\s+${UNIT}\\s+(?:per|every|within|in (?:a|any|each))\\s+(?:[a-z]+\\s+){0,2}?(${PERIOD})`, 'i');
const PERIOD_RE = new RegExp(`\\b(?:per|every|within|in (?:a|any|each|the same)|during (?:a|any))\\s+(?:[a-z]+\\s+){0,2}?(${PERIOD})`, 'i');
const NOT_A_CAP = /\b(?:we are hiring|we have|openings available|positions available|travel|%|hours|team of|years of experience)\b/i;

const number = text => { text = String(text ?? '').trim().toLowerCase(); return /^\d+$/.test(text) ? Number(text) : WORDS[text] ?? null; };
function days(period) {
  if (!period) return null;
  period = period.toLowerCase();
  if (period.includes('calendar year')) return 365;
  const m = period.match(/^(\d+|thirty|sixty|ninety|twelve|six|one)?[\s-]*(day|week|month|year)/);
  if (!m) return null;
  return (m[1] ? number(m[1]) : 1) * {day: 1, week: 7, month: 30, year: 365}[m[2]];
}

// The first sentence stating a per-applicant limit: {quote, max, days}, or null.
export function detectCap(text) {
  for (const sentence of String(text ?? '').split(/(?<=[.!?])\s+|\n+/)) {
    if (sentence.length > 400 || !ABOUT.test(sentence) || NOT_A_CAP.test(sentence)) continue;
    const m = sentence.match(LIMIT);
    if (!m) continue;
    const stated = sentence.match(PERIOD_RE);
    return {quote: sentence.trim().slice(0, 400), max: number(m[1] ?? m[2]), days: days(m[3] ?? stated?.[1])};
  }
  return null;
}

// Whether he already allowed applying to this employer under its limit.
export const capAllowed = (company, approved = {}) => Object.keys(approved).some(c => c.toLowerCase() === String(company).toLowerCase());
