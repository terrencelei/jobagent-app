'use strict';
// Pure decision logic for the tray status line and desktop notifications.
// No Electron imports here, so it can be unit-tested with `node --test`.

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Normalise a GET /api/applications payload into the fields the shell cares about. */
function snapshot(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const counts = payload.counts && typeof payload.counts === 'object' ? payload.counts : {};
  return {
    running: Boolean(payload.running),
    active: num(counts.active),
    completed: num(counts.completed),
    approvals: num(counts.approvals),
    help: num(counts.help),
  };
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Status line for the tray menu, e.g. "Applying · 2 active · 14 submitted".
 * `state` is a snapshot (or raw payload); `opts.error` marks an unreachable engine.
 */
function statusLine(state, opts = {}) {
  if (opts.error) return 'Engine not responding';
  const s = state && 'counts' in state ? snapshot(state) : state;
  if (!s) return 'Starting engine…';
  const parts = [s.running ? 'Applying' : 'Paused'];
  if (s.running || s.active) parts.push(`${s.active} active`);
  parts.push(`${s.completed} submitted`);
  const needs = s.approvals + s.help;
  if (needs) parts.push(`${needs} need${needs === 1 ? 's' : ''} you`);
  return parts.join(' · ');
}

/**
 * Compare two successive polls and return the notifications to show.
 * The first poll (prev == null) only sets a baseline; counts going down
 * (items handled, history pruned) never notify.
 * Returns [{ kind: 'submitted'|'needs-you', title, body, path? }].
 */
function decideNotifications(prev, next) {
  const a = prev && 'counts' in prev ? snapshot(prev) : prev;
  const b = next && 'counts' in next ? snapshot(next) : next;
  if (!a || !b) return [];
  const out = [];
  const submitted = b.completed - a.completed;
  if (submitted > 0) {
    out.push({
      kind: 'submitted',
      title: 'Application submitted',
      body: submitted === 1
        ? '1 new application was submitted.'
        : `${submitted} new applications were submitted.`,
      path: '/',
    });
  }
  const approvals = Math.max(0, b.approvals - a.approvals);
  const help = Math.max(0, b.help - a.help);
  if (approvals || help) {
    const bits = [];
    if (approvals) bits.push(`${plural(approvals, 'answer', 'answers')} to approve`);
    if (help) bits.push(`${plural(help, 'application', 'applications')} need${help === 1 ? 's' : ''} help`);
    out.push({
      kind: 'needs-you',
      title: 'JobAgent needs you',
      body: `${bits.join(' and ')}.`,
      path: '/approvals',
    });
  }
  return out;
}

module.exports = { snapshot, statusLine, decideNotifications };
