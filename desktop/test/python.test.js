'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePython } = require('../python');

const none = () => false;

test('JOBAGENT_PYTHON wins over everything', () => {
  const r = resolvePython({ platform: 'darwin', env: { JOBAGENT_PYTHON: '/opt/py/bin/python3' }, engineDir: '/e', exists: () => true });
  assert.deepEqual(r, { command: '/opt/py/bin/python3', source: 'env' });
});

test('blank JOBAGENT_PYTHON is ignored', () => {
  const r = resolvePython({ platform: 'linux', env: { JOBAGENT_PYTHON: '  ' }, engineDir: '/e', exists: none });
  assert.equal(r.source, 'path');
});

test('venv python on macOS/Linux', () => {
  const seen = [];
  const r = resolvePython({ platform: 'darwin', env: {}, engineDir: '/app/engine', exists: (p) => { seen.push(p); return true; } });
  assert.deepEqual(r, { command: '/app/engine/.venv/bin/python', source: 'venv' });
  assert.deepEqual(seen, ['/app/engine/.venv/bin/python']);
});

test('venv python on Windows', () => {
  const r = resolvePython({ platform: 'win32', env: {}, engineDir: 'C:\\JobAgent\\engine', exists: (p) => p.endsWith('python.exe') });
  assert.deepEqual(r, { command: 'C:\\JobAgent\\engine\\.venv\\Scripts\\python.exe', source: 'venv' });
});

test('falls back to PATH: python3 first on POSIX, python first on Windows', () => {
  assert.deepEqual(resolvePython({ platform: 'darwin', env: {}, engineDir: '/e', exists: none }), { command: 'python3', source: 'path' });
  assert.deepEqual(resolvePython({ platform: 'win32', env: {}, engineDir: 'C:\\e', exists: none }), { command: 'python', source: 'path' });
});

test('PATH lookup picks the first candidate that exists', () => {
  const r = resolvePython({ platform: 'linux', env: {}, engineDir: '/e', exists: none, onPath: (c) => c === 'python' });
  assert.equal(r.command, 'python');
  const w = resolvePython({ platform: 'win32', env: {}, engineDir: 'C:\\e', exists: none, onPath: (c) => c === 'python3' });
  assert.equal(w.command, 'python3');
});
