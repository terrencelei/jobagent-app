// Normalize standalone web links, never prose, email addresses, or credentials.
export function normalizeApplicationLink(value) {
  if (typeof value !== 'string') return value;
  const raw = value.trim();
  if (!/^(?:(?:https?:)?\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:[/?#][^\s]*)?$/i.test(raw)) return value;
  const text = raw.replace(/^(?:https?:)?\/\//i, '');
  let url;
  try { url = new URL(`https://${text}`); } catch { return value; }
  // LinkedIn's canonical public host is accepted by strict employer validators.
  if (url.hostname === 'linkedin.com') url.hostname = 'www.linkedin.com';
  return `https://${url.host}${url.pathname === '/' && !text.includes('/') ? '' : url.pathname}${url.search}${url.hash}`;
}

export async function normalizeExistingLinks(scope) {
  const inputs = scope.locator('input[type="text"], input[type="url"], input:not([type])');
  for (let i = 0; i < await inputs.count(); i++) {
    const input = inputs.nth(i);
    if (!await input.isVisible() || !await input.isEditable()) continue;
    const value = await input.inputValue();
    const normalized = normalizeApplicationLink(value);
    if (normalized === value) continue;
    await input.fill(normalized);
    await input.press('Tab');
    if (await input.inputValue() !== normalized) throw new Error('Application link did not retain its HTTPS format');
  }
}
