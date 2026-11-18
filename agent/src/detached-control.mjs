// A page can replace its form while a step is in flight. iRecruit's "Save/Next" (Piper 13343)
// posts the section by AJAX and, seconds later, swaps the whole section's HTML for the server's
// re-render; the data-ja-control tags the last snapshot wrote vanish with the old nodes, so the
// next fill waited ten seconds for `[data-ja-control="f0c18"]` and failed the run. Such an error
// means "read the page again", not "the application is broken".
export function detachedControlError(error){
 const message=String(error?.message??error??'');
 return /waiting for locator\('\[data-ja-control=/.test(message)||/not attached to the DOM/i.test(message)||/Element is detached/i.test(message);
}
