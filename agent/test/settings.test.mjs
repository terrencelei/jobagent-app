import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {modelSetting, setting} from '../src/settings.mjs';

test('reads the effective values JobAgent publishes and falls back to the default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-'));
  const path = join(dir, 'settings.json');
  assert.equal(setting('workday.mail_lookup_tries', 4, path), 4);
  await writeFile(path, JSON.stringify({effective: {'workday.mail_lookup_tries': 7, 'workday.mail_model': 'sonnet'}, models: {sonnet: 'sonnet', haiku: 'claude-haiku-4-5-20251001'}}));
  assert.equal(setting('workday.mail_lookup_tries', 4, path), 7);
  assert.equal(modelSetting('workday.mail_model', 'haiku', path), 'sonnet');
  assert.equal(setting('worker.max_rejected_steps', 5, path), 5);
});
