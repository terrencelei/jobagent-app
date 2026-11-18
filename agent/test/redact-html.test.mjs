import test from 'node:test';
import assert from 'node:assert/strict';
import {redactPasswordValues,redactPasswordDump} from '../src/redact-html.mjs';

// Shape of the saved Boeing 11181 signin-fields.json entry, with a stand-in secret.
const field=secret=>`<div data-automation-id="formField-password"><label for="input-15"><span>Password</span></label><input type="password" data-automation-id="password" id="input-15" aria-required="true" autocomplete="current-password" class="css-7bthjn" value="${secret}" style=""></div>`;

test('a password input value never reaches a diagnostic dump',()=>{
  const out=redactPasswordValues(field('s3cret-Value!'));
  assert.ok(!out.includes('s3cret-Value!'));
  assert.ok(out.includes('value="[redacted]"'));
  assert.ok(out.includes('data-automation-id="password"'),'the rest of the markup is kept');
});

test('email and other inputs keep their values',()=>{
  const html='<input type="text" data-automation-id="email" value="applicant@example.edu"><input type="password" data-automation-id="password" value="x"><input data-automation-id="verifyPassword" type=\'password\' value=\'y\'>';
  const out=redactPasswordValues(html);
  assert.ok(out.includes('value="applicant@example.edu"'));
  assert.equal((out.match(/\[redacted\]/g)||[]).length,2);
  assert.ok(!/value="x"|value='y'/.test(out));
});

test('attribute order and quoting do not matter',()=>{
  for(const tag of ['<input value="pw1" type=password>','<input autocomplete="new-password" value=\'pw1\'>','<input value=pw1 data-automation-id="password">'])
    assert.ok(!redactPasswordValues(tag).includes('pw1'),tag);
  assert.equal(redactPasswordValues('<input type="text" value="pw1">'),'<input type="text" value="pw1">');
});

test('dump arrays of strings and {aid,html} records are redacted in place',()=>{
  const dump=redactPasswordDump([{aid:'formField-password',html:field('abc')},'<input type="password" value="abc">',null]);
  assert.ok(!JSON.stringify(dump).includes('abc'));
  assert.equal(dump[0].aid,'formField-password');
  assert.equal(dump[2],null);
});
