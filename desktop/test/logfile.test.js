'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RotatingLog } = require('../logfile');

test('rotates when the file would exceed maxBytes and keeps N old files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobagent-log-'));
  const file = path.join(dir, 'logs', 'engine.log');
  const log = new RotatingLog(file, { maxBytes: 100, keep: 2 });
  for (let i = 0; i < 10; i++) log.write('x'.repeat(40));
  assert.ok(fs.statSync(file).size <= 100);
  assert.ok(fs.existsSync(path.join(dir, 'logs', 'engine.1.log')));
  assert.ok(fs.existsSync(path.join(dir, 'logs', 'engine.2.log')));
  assert.ok(!fs.existsSync(path.join(dir, 'logs', 'engine.3.log')));
  fs.rmSync(dir, { recursive: true, force: true });
});
