'use strict';
// Engine process helpers: health probe, free-port search, spawn, readiness wait,
// process-tree shutdown. No Electron imports.
const net = require('net');
const { spawn, execFile } = require('child_process');

const HOST = '127.0.0.1';
const APP_HEADER = { 'X-JobAgent-Application': '1' };

function engineUrl(port) {
  return `http://${HOST}:${port}`;
}

async function fetchJson(url, { method = 'GET', body, headers = {}, timeoutMs = 3000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      redirect: 'manual',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** True when a JobAgent engine answers /api/setup with JSON containing `needed`. */
async function isJobAgentEngine(port, timeoutMs = 1500) {
  try {
    const data = await fetchJson(`${engineUrl(port)}/api/setup`, { timeoutMs });
    return Boolean(data && typeof data === 'object' && 'needed' in data);
  } catch {
    return false;
  }
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.unref();
    srv.once('error', () => resolve(false));
    srv.listen({ port, host: HOST, exclusive: true }, () => srv.close(() => resolve(true)));
  });
}

async function findFreePort(start = 8000, attempts = 100) {
  for (let port = start; port < start + attempts; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`No free port in ${start}-${start + attempts - 1}`);
}

/** Spawn `python -m jobagent.cli serve` with its own process group (POSIX) and hidden console (Windows). */
function spawnEngine({ python, engineDir, port, env = process.env }) {
  const isWin = process.platform === 'win32';
  return spawn(python, ['-m', 'jobagent.cli', 'serve'], {
    cwd: engineDir,
    env: { ...env, JOBAGENT_SERVER_PORT: String(port), PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: !isWin, // new process group so the whole tree can be signalled
  });
}

/** Poll /api/setup with exponential backoff until it answers, the child exits, or time runs out. */
async function waitForReady(port, { child, timeoutMs = 90_000, startDelay = 250, maxDelay = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let delay = startDelay;
  let exited = false;
  const onExit = () => { exited = true; };
  if (child) child.once('exit', onExit);
  try {
    while (Date.now() < deadline) {
      if (exited) throw new Error('Engine exited before it became ready');
      if (await isJobAgentEngine(port, 1500)) return true;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, maxDelay);
    }
    throw new Error(`Engine did not answer on port ${port} within ${Math.round(timeoutMs / 1000)} s`);
  } finally {
    if (child) child.removeListener('exit', onExit);
  }
}

/** End the engine and everything it started (workers, browsers). */
function killTree(child, { graceMs = 5000 } = {}) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const pid = child.pid;
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
    child.once('exit', finish);
    if (process.platform === 'win32') {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      try { process.kill(-pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
    }
    const timer = setTimeout(() => {
      if (process.platform !== 'win32') {
        try { process.kill(-pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
      }
      setTimeout(finish, 500);
    }, graceMs);
  });
}

function getApplications(port) {
  return fetchJson(`${engineUrl(port)}/api/applications`, { headers: APP_HEADER, timeoutMs: 5000 });
}

function controlApplications(port, action) {
  return fetchJson(`${engineUrl(port)}/api/applications/control`, {
    method: 'POST', body: { action }, headers: APP_HEADER, timeoutMs: 10_000,
  });
}

module.exports = {
  HOST, engineUrl, isJobAgentEngine, portIsFree, findFreePort, spawnEngine, waitForReady,
  killTree, getApplications, controlApplications,
};
