// A page's alert/confirm/beforeunload dialog with no listener is closed by Playwright's server side
// with an uncaught promise: when the dialog is already gone ("No dialog is showing"), Node exits and
// the run dies as "Worker exited" (RV Tech 13331 on Ashby). A context-level listener routes every
// dialog to the client, where it is closed here with the same default (accept beforeunload, dismiss
// the rest) and a dialog that has already closed is ignored.
export function closeDialog(dialog){
 const close=dialog.type()==='beforeunload'?dialog.accept():dialog.dismiss();
 return Promise.resolve(close).catch(()=>{});
}
// onMessage sees an alert/confirm/prompt's text: Phenom (Genentech 14640) reports a missing resume only in an alert.
export function guardDialogs(context,onMessage){context.on('dialog',dialog=>{if(onMessage&&dialog.type()!=='beforeunload'){try{onMessage(dialog.message());}catch{}}return closeDialog(dialog);});return context;}
