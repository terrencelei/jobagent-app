// Expansion reveals fields for normal validation; it never authorizes a submit.
export function safeSectionExpand(control, pageURL) {
  if (!['button','a'].includes(control.type) || control.download ||
      control.target && control.target !== '_self') return false;
  const label = control.label.trim().replace(/^[+＋]\s*/, '');
  const expandAll = /^expand all sections$/i.test(label);
  const collapsedPanel = control.ariaExpanded === 'false' && control.controlsSection === true;
  if (!expandAll && !collapsedPanel) return false;
  if (/\b(submit|apply|send|finish|complete|delete|remove|withdraw)\b/i.test(label)) return false;
  if (!control.href) return control.type === 'button';
  if (/^javascript:\s*(?:void\(0\)|;)\s*;?$/i.test(control.href)) return true;
  try {
    const target = new URL(control.href, pageURL), current = new URL(pageURL);
    return /^https?:$/.test(target.protocol) && target.origin === current.origin &&
      target.pathname === current.pathname && target.search === current.search &&
      !target.hash && (control.href.endsWith('#') || control.hrefAttr === '');
  } catch { return false; }
}
