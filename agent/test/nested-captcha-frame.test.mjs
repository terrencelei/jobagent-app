import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {visibleApplicationChallenge} from '../src/application-challenge.mjs';
import {captchaCheckboxVisible} from '../src/captcha-handoff.mjs';

test('a CAPTCHA inside an embedded application iframe is seen (iCIMS, Rivian 12058)',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    const inner=`<form><input type=email></form><iframe title="Main content of the hCaptcha challenge" src="about:blank#hcaptcha-frame=challenge" style="width:400px;height:580px;border:0"></iframe>`;
    await page.setContent(`<h1>Rivian careers</h1><iframe id="icims_content_iframe" style="width:900px;height:800px" srcdoc='${inner}'></iframe>`);
    await page.frameLocator('#icims_content_iframe').locator('form').waitFor();
    assert.equal(await visibleApplicationChallenge(page),true);
    const box=`<iframe src="https://newassets.hcaptcha.com/captcha/v1/x/static/hcaptcha.html#frame=checkbox" style="width:303px;height:78px;border:0"></iframe>`;
    await page.setContent(`<iframe id="icims_content_iframe" style="width:900px;height:800px" srcdoc='${box}'></iframe>`);
    await page.waitForTimeout(200);
    assert.equal(await captchaCheckboxVisible(page),true);
    await page.setContent('<iframe style="width:900px;height:800px" srcdoc="<form><input></form>"></iframe>');
    assert.equal(await visibleApplicationChallenge(page),false);
  }finally{await browser.close();}
});
