// Diagnostic HTML dumps (artifacts/<job>/<step>-fields.json) copy each form field's outerHTML.
// React mirrors a controlled input's current value into its value attribute, so a sign-in
// snapshot taken after fillWorkdaySignInCredentials carried the typed password in plain text
// (Boeing 11181, 2026-10-17). The password must never be shown or logged; blank it wherever a
// password input, or any input whose automation id names a password, appears in dumped HTML.
const INPUT_TAG=/<input\b[^>]*>/gi;
const PASSWORD_INPUT=/\btype\s*=\s*["']?password\b|data-automation-id\s*=\s*["'][^"']*password[^"']*["']|\bautocomplete\s*=\s*["']?(?:current|new)-password\b/i;
const VALUE_ATTR=/\bvalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

export function redactPasswordValues(html){
  if(typeof html!=='string') return html;
  return html.replace(INPUT_TAG,tag=>PASSWORD_INPUT.test(tag)?tag.replace(VALUE_ATTR,'value="[redacted]"'):tag);
}

// Applies to the structures snapshot() writes: arrays of HTML strings or of {aid, html} records.
export function redactPasswordDump(entries){
  return (entries??[]).map(e=>typeof e==='string'?redactPasswordValues(e):e&&typeof e.html==='string'?{...e,html:redactPasswordValues(e.html)}:e);
}
