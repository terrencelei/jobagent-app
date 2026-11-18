'use strict';
// Pure resolver for the Python interpreter that runs the engine.
// Everything platform-specific is passed in, so it is testable on any OS.
const path = require('path');

/**
 * @param {object} o
 * @param {string} o.platform   process.platform value ('darwin' | 'win32' | 'linux' ...)
 * @param {object} o.env        environment variables
 * @param {string} o.engineDir  directory holding the engine and its .venv
 * @param {(p: string) => boolean} o.exists  file existence check
 * @param {(cmd: string) => boolean} [o.onPath] whether a command is on PATH (optional)
 * @returns {{ command: string, source: 'env'|'venv'|'path' }}
 */
function resolvePython({ platform, env = {}, engineDir, exists, onPath }) {
  const fromEnv = env.JOBAGENT_PYTHON && String(env.JOBAGENT_PYTHON).trim();
  if (fromEnv) return { command: fromEnv, source: 'env' };

  const isWin = platform === 'win32';
  const p = isWin ? path.win32 : path.posix;
  if (engineDir) {
    const venvPython = isWin
      ? p.join(engineDir, '.venv', 'Scripts', 'python.exe')
      : p.join(engineDir, '.venv', 'bin', 'python');
    if (exists(venvPython)) return { command: venvPython, source: 'venv' };
  }

  const candidates = isWin ? ['python', 'python3'] : ['python3', 'python'];
  const found = onPath ? candidates.find((c) => onPath(c)) : undefined;
  return { command: found || candidates[0], source: 'path' };
}

module.exports = { resolvePython };
