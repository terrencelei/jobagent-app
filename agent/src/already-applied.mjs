// An employer page saying the applicant already applied for this posting (Hyundai HATCI's
// "You already applied for this position.") replaces the form. It is not a job-bound receipt
// for this run, so the worker parks the role for him instead of clicking a vanished control.
const NOTICE = /(^|[^a-z])(?<!\bif )(?<!\bwhether )(you(?:'ve| have)?|our records show (?:that )?you(?: have)?) already (?:applied|submitted an application) (?:for|to) this (?:position|job|role|opening|requisition|posting)\b[^.\n]*\.?/i;

export function alreadyAppliedNotice(text) {
  const m = String(text || '').match(NOTICE);
  return m ? m[0].replace(/^[^A-Za-z]/, '').trim() : null;
}
