/* Shared interaction feedback. Background polling never claims a user action. */
(() => {
  'use strict';
  let activation = null, toast, timer;
  const pending = new WeakSet();
  function notify(message, error = false) {
    if (!message) return;
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'uiFeedback'; toast.className = 'ui-feedback';
      document.body.append(toast);
    }
    clearTimeout(timer);
    toast.textContent = message;
    toast.dataset.error = String(error);
    toast.setAttribute('role', error ? 'alert' : 'status');
    toast.hidden = false;
    timer = setTimeout(() => { toast.hidden = true; }, error ? 9000 : 5000);
  }
  function activate(event) {
    const control = event.type === 'submit'
      ? event.submitter || event.target.querySelector('button[type="submit"],button:not([type])')
      : event.target.closest('button,input[type="checkbox"],select');
    if (!control) return;
    if (pending.has(control)) {
      event.preventDefault(); event.stopImmediatePropagation(); return;
    }
    const token = {control};
    activation = token;
    // Only a request initiated by this event receives feedback, not subsequent polls.
    setTimeout(() => { if (activation === token) activation = null; }, 0);
  }
  for (const type of ['click', 'change', 'submit']) document.addEventListener(type, activate, true);
  async function track(operation, {mutation = false} = {}) {
    const control = activation?.control;
    activation = null;
    if (!control) return operation();
    pending.add(control);
    const before = control.getAttribute('aria-busy');
    control.setAttribute('aria-busy', 'true');
    control.dataset.uiPending = 'true';
    delete control.dataset.uiResult;
    const label = (control.getAttribute('aria-label') || control.textContent || 'Changes').trim();
    try {
      const result = await operation();
      control.dataset.uiResult = 'success';
      if (mutation) notify('Request completed.');
      return result;
    } catch (error) {
      control.dataset.uiResult = 'error';
      notify(`${label}: ${error.message || 'Request failed. Please try again.'}`, true);
      throw error;
    } finally {
      pending.delete(control);
      delete control.dataset.uiPending;
      if (before === null) control.removeAttribute('aria-busy');
      else control.setAttribute('aria-busy', before);
      setTimeout(() => { if (!pending.has(control)) delete control.dataset.uiResult; }, 2500);
    }
  }
  window.UIFeedback = {notify, track};
})();
