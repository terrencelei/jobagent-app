// Native date inputs accept ISO calendar dates, regardless of their displayed locale.
// Convert only the saved US numeric format; never guess from free-form date prose.
export function nativeInputValue(type, value) {
  if (type === 'month') {
    // <input type=month> takes YYYY-MM.
    const text = String(value).trim();
    const my = /^(\d{1,2})[\/-](\d{4})$/.exec(text), ym = /^(\d{4})-(\d{1,2})$/.exec(text);
    if (!my && !ym) return value;
    const month = Number(my ? my[1] : ym[2]), year = my ? my[2] : ym[1];
    if (month < 1 || month > 12) throw new Error('Saved date is not a valid calendar date');
    return `${year}-${String(month).padStart(2, '0')}`;
  }
  if (type !== 'date') return value;
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  // Work history is confirmed to the month (["6","2026"] → "6/2026"); date inputs need a day.
  const my = /^(\d{1,2})[\/-](\d{4})$/.exec(text);
  const ym = /^(\d{4})-(\d{1,2})$/.exec(text);
  if (my || ym) {
    const month = Number(my ? my[1] : ym[2]), year = my ? my[2] : ym[1];
    if (month < 1 || month > 12) throw new Error('Saved date is not a valid calendar date');
    return `${year}-${String(month).padStart(2, '0')}-01`;
  }
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
  if (!match) return value;
  const [, month, day, year] = match;
  const m = Number(month), d = Number(day), y = Number(year);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > days[m - 1]) {
    throw new Error('Saved date is not a valid calendar date');
  }
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}
