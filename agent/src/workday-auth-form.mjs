// Authentication modals may overlay a mounted Create Account form. Never target
// that background form merely because it is first in document order.
export async function workdayAuthScope(page) {
 const dialogs=page.locator('[role="dialog"]:visible,[aria-modal="true"]:visible');
 const candidates=[];
 for(let i=0;i<await dialogs.count();i++){
  const dialog=dialogs.nth(i);
  if(await dialog.locator('[data-automation-id="email"]:visible,button:has-text("with email"):visible').count())candidates.push(dialog);
 }
 if(candidates.length>1)throw new Error('Workday authentication dialog is ambiguous; no credentials were entered');
 return candidates[0]??page;
}

export async function fillWorkdaySignInCredentials(page,credentials) {
 const scope=await workdayAuthScope(page);
 const verify=scope.locator('[data-automation-id="verifyPassword"]:visible');
 const email=scope.locator('[data-automation-id="email"]:visible');
 const password=scope.locator('[data-automation-id="password"]:visible');
 if(await verify.count()||await email.count()!==1||await password.count()!==1)throw new Error('Workday Sign In fields are not uniquely identified; no credentials were entered');
 await email.fill(credentials.email);
 await password.fill(credentials.password);
 return scope;
}

export async function submitWorkdaySignIn(scope) {
 const filter=scope.locator('div[data-automation-id="click_filter"][aria-label="Sign In"]:visible');
 if(await filter.count()===1){await filter.click();return true;}
 const button=scope.locator('button[data-automation-id="signInSubmitButton"]:visible');
 if(await button.count()!==1)return false;
 await button.click({force:true});return true;
}

// Some tenants return to a clean Sign In form after registering instead of
// signing the new account in. Continue once; never loop back into registration.
// afterRejectedSignIn: the tenant just refused his shared credential. Workday then answers a
// registration for that same email by returning silently to the Sign In chooser (no alert, no
// verification mail: KLA 10182, ASML 9067), which means the account exists with another password.
export async function completeWorkdayAccountCreation(page,{signedIn,signIn,afterRejectedSignIn=false}) {
 if(await signedIn())return 'ok';
 const text=await page.locator('body').innerText();
 if(/already (exists|in use|registered)/i.test(text))return 'exists';
 if(/verify|verification/i.test(text))return 'needs_verification';
 const scope=await workdayAuthScope(page);
 const alerts=await scope.locator('[role="alert"]:visible,[data-automation-id*="rror"]:visible').allInnerTexts();
 if(alerts.some(t=>t.trim())||/captcha|unusual traffic|too many|something went wrong|access denied|invalid|incorrect|does not (?:meet|match)/i.test(text))return 'unknown';
 if(await scope.locator('[data-automation-id="verifyPassword"]:visible').count())return 'unknown';
 if(afterRejectedSignIn&&await returnedToSignInChooser(scope))return 'exists';
 if(await scope.locator('[data-automation-id="email"]:visible').count()!==1||await scope.locator('[data-automation-id="password"]:visible').count()!==1)return 'unknown';
 if(await scope.locator('button[data-automation-id="signInSubmitButton"]:visible').count()!==1)return 'unknown';
 return signIn();
}

// The chooser offers "Sign in with email" (plus SSO buttons) and mounts no credential field.
async function returnedToSignInChooser(scope) {
 const chooser=scope.locator('button[data-automation-id="SignInWithEmailButton"]:visible,button:has-text("with email"):visible');
 if(!await chooser.count())return false;
 return await scope.locator('[data-automation-id="email"]:visible,[data-automation-id="password"]:visible,[data-automation-id="verifyPassword"]:visible').count()===0;
}

// Older tenants mount accountSettingsButton once signed in. Newer headers (Firefly 12692) show
// "Settings | <account email>" in the utility bar instead, so the account's own email there, with
// no Sign In button left, also counts. Candidate Home naming the email remains a third signal.
export async function workdaySignedIn(page,email) {
 if(await page.locator('[data-automation-id="accountSettingsButton"]').count())return true;
 const want=String(email??'').trim().toLowerCase();
 if(!want)return false;
 const bar=page.locator('[data-automation-id="utilityButtonBar"]:visible');
 if(await bar.count()&&!await page.locator('[data-automation-id="utilityButtonSignIn"]:visible').count()){
  const text=(await bar.allInnerTexts()).join(' ').toLowerCase();
  if(text.includes(want))return true;
 }
 const body=await page.locator('body').innerText().catch(()=>'');
 return /Candidate Home/.test(body)&&body.toLowerCase().includes(want);
}
