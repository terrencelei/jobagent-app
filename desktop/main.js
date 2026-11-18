'use strict';
// JobAgent desktop shell: keeps the local engine running in the background,
// shows it in a window, and lives in the tray / menu bar.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  app, BrowserWindow, Tray, Menu, Notification, nativeImage, shell, dialog,
} = require('electron');

const { resolvePython } = require('./python');
const { RotatingLog } = require('./logfile');
const { statusLine, decideNotifications, snapshot } = require('./status');
const engine = require('./engine');

const DEFAULT_PORT = 8000;
const POLL_MS = 60_000;
const MAX_RESTARTS = 5;
const STABLE_MS = 5 * 60_000; // uptime after which the restart budget resets
const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

// ---------------------------------------------------------------- single instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// ---------------------------------------------------------------- state
const state = {
  port: null,
  child: null,          // engine process we own (null when reusing an external engine)
  owned: false,
  win: null,
  tray: null,
  last: null,           // last applications snapshot
  pollError: false,
  restarts: 0,
  restartTimer: null,
  startedAt: 0,
  quitting: false,
  cleanedUp: false,
  pollTimer: null,
};

let log;
let settingsFile;
let settings = { openAtLogin: true, firstRunDone: false };

function engineDir() {
  if (process.env.JOBAGENT_ENGINE_DIR) return path.resolve(process.env.JOBAGENT_ENGINE_DIR);
  return app.isPackaged
    ? path.join(process.resourcesPath, 'engine')
    : path.resolve(__dirname, '..', 'engine');
}

function asset(name) {
  return path.join(__dirname, 'assets', name);
}

function baseUrl() {
  return engine.engineUrl(state.port);
}

// ---------------------------------------------------------------- settings
function loadSettings() {
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  try { settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) }; } catch { /* first run */ }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2)); } catch (e) { log.line(`settings save failed: ${e.message}`); }
}

function applyLoginItem() {
  // Registering the dev Electron binary as a login item would be surprising, so only do it when packaged.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: settings.openAtLogin, args: ['--hidden'] });
}

function openedAtLogin() {
  if (process.argv.includes('--hidden')) return true;
  try { return isMac && app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; }
}

// ---------------------------------------------------------------- python / engine
function onPath(cmd) {
  try {
    execFileSync(isWin ? 'where' : 'which', [cmd], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

async function startEngine() {
  if (await engine.isJobAgentEngine(DEFAULT_PORT)) {
    state.port = DEFAULT_PORT;
    state.owned = false;
    log.line(`reusing JobAgent engine already running at ${baseUrl()}`);
    return;
  }
  const dir = engineDir();
  const py = resolvePython({ platform: process.platform, env: process.env, engineDir: dir, exists: fs.existsSync, onPath });
  const port = state.port && await engine.portIsFree(state.port) ? state.port : await engine.findFreePort(DEFAULT_PORT);
  log.line(`starting engine: ${py.command} (${py.source}) in ${dir} on port ${port}`);

  // The student's profile, search, database and logs live in a per-user folder, never inside the app.
  const home = process.env.JOBAGENT_HOME || path.join(app.getPath('userData'), 'home');
  fs.mkdirSync(home, { recursive: true });
  const env = { ...process.env, JOBAGENT_HOME: home };
  if (!env.JOBAGENT_APPLICATION_AGENT_DIR && app.isPackaged) env.JOBAGENT_APPLICATION_AGENT_DIR = path.join(process.resourcesPath, 'agent');
  const child = engine.spawnEngine({ python: py.command, engineDir: dir, port, env });
  state.child = child;
  state.owned = true;
  state.port = port;
  child.stdout.on('data', (d) => log.write(d));
  child.stderr.on('data', (d) => log.write(d));
  child.on('error', (e) => log.line(`engine spawn error: ${e.message}`));
  child.on('exit', (code, signal) => onEngineExit(child, code, signal));

  await engine.waitForReady(port, { child });
  state.startedAt = Date.now();
  log.line(`engine ready at ${baseUrl()}`);
}

function onEngineExit(child, code, signal) {
  log.line(`engine exited (code ${code}, signal ${signal})`);
  if (child !== state.child) return;
  state.child = null;
  if (state.quitting) return;
  if (state.startedAt && Date.now() - state.startedAt > STABLE_MS) state.restarts = 0;
  scheduleRestart();
}

function scheduleRestart() {
  if (state.restartTimer || state.quitting) return;
  if (state.restarts >= MAX_RESTARTS) {
    notify('JobAgent stopped', `The engine stopped ${MAX_RESTARTS} times. Open the logs or quit and reopen JobAgent.`);
    state.pollError = true;
    refreshTray();
    return;
  }
  state.restarts += 1;
  const delay = Math.min(1000 * 2 ** (state.restarts - 1), 30_000);
  log.line(`restarting engine in ${delay} ms (attempt ${state.restarts}/${MAX_RESTARTS})`);
  state.restartTimer = setTimeout(async () => {
    state.restartTimer = null;
    const before = state.port;
    try {
      await startEngine();
      notify('JobAgent restarted', 'The engine stopped unexpectedly and was restarted.');
      if (state.win && !state.win.isDestroyed() && state.port !== before) state.win.loadURL(baseUrl());
      poll();
    } catch (e) {
      log.line(`restart failed: ${e.message}`);
      if (state.child) { await engine.killTree(state.child); state.child = null; }
      scheduleRestart();
    }
  }, delay);
}

// ---------------------------------------------------------------- window
function showDock() {
  if (!isMac || !app.dock) return;
  const p = app.dock.show();
  if (p && typeof p.catch === 'function') p.catch(() => {});
}

function hideDock() {
  if (isMac && app.dock) app.dock.hide();
}

function createWindow(url = baseUrl()) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    show: false,
    title: 'JobAgent',
    backgroundColor: '#ffffff',
    icon: isMac ? undefined : asset('icon.png'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  const sameOrigin = (url) => { try { return new URL(url).origin === new URL(baseUrl()).origin; } catch { return false; } };
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!sameOrigin(url)) shell.openExternal(url);
    return { action: sameOrigin(url) ? 'allow' : 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!sameOrigin(url)) { e.preventDefault(); shell.openExternal(url); }
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* aborted */) return;
    log.line(`window load failed (${code} ${desc}) for ${url}; retrying`);
    setTimeout(() => { if (!win.isDestroyed()) win.loadURL(url || baseUrl()); }, 2000);
  });

  win.on('close', (e) => {
    if (state.quitting) return;
    e.preventDefault(); // keep running in the background
    win.hide();
  });
  win.on('hide', hideDock);
  win.on('show', showDock);
  win.once('ready-to-show', () => win.show());

  win.loadURL(url); // a fresh install redirects / to /setup itself
  return win;
}

function openWindow(pathname = '/') {
  if (!state.port) return;
  const target = new URL(pathname, baseUrl()).toString();
  if (!state.win || state.win.isDestroyed()) {
    state.win = createWindow(target);
    return;
  }
  if (pathname !== '/' && state.win.webContents.getURL() !== target) state.win.loadURL(target);
  showDock();
  if (state.win.isMinimized()) state.win.restore();
  state.win.show();
  state.win.focus();
}

// ---------------------------------------------------------------- notifications
function notify(title, body, pathname) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => openWindow(pathname || '/'));
  n.show();
}

// ---------------------------------------------------------------- polling
async function poll() {
  if (!state.port) return;
  try {
    const next = snapshot(await engine.getApplications(state.port));
    for (const n of decideNotifications(state.last, next)) notify(n.title, n.body, n.path);
    state.last = next;
    state.pollError = false;
  } catch (e) {
    state.pollError = true;
    log.line(`status poll failed: ${e.message}`);
  }
  refreshTray();
}

async function control(action) {
  try {
    await engine.controlApplications(state.port, action);
  } catch (e) {
    log.line(`control ${action} failed: ${e.message}`);
    notify('JobAgent', `Could not ${action === 'start' ? 'start' : 'pause'} applying: ${e.message}`);
  }
  await poll();
}

// ---------------------------------------------------------------- tray
function trayImage() {
  if (isMac) {
    const img = nativeImage.createFromPath(asset('trayTemplate.png'));
    img.setTemplateImage(true);
    return img;
  }
  return nativeImage.createFromPath(asset('tray.png'));
}

function refreshTray() {
  if (!state.tray) return;
  const line = statusLine(state.last, { error: state.pollError || !state.port });
  const running = Boolean(state.last && state.last.running);
  const menu = Menu.buildFromTemplate([
    { label: line, enabled: false },
    { type: 'separator' },
    { label: 'Open JobAgent', click: () => openWindow('/'), enabled: Boolean(state.port) },
    running
      ? { label: 'Pause applying', click: () => control('stop'), enabled: !state.pollError }
      : { label: 'Start applying', click: () => control('start'), enabled: Boolean(state.port) && !state.pollError },
    { type: 'separator' },
    {
      label: 'Launch at login',
      type: 'checkbox',
      checked: settings.openAtLogin,
      click: (item) => { settings.openAtLogin = item.checked; saveSettings(); applyLoginItem(); },
    },
    { label: 'Show logs', click: () => shell.openPath(path.join(app.getPath('userData'), 'logs')) },
    { type: 'separator' },
    { label: 'Quit JobAgent', accelerator: isMac ? 'Command+Q' : undefined, click: () => app.quit() },
  ]);
  state.tray.setContextMenu(menu);
  state.tray.setToolTip(`JobAgent — ${line}`);
}

function createTray() {
  state.tray = new Tray(trayImage());
  if (!isMac) state.tray.on('click', () => openWindow('/'));
  refreshTray();
}

// ---------------------------------------------------------------- shutdown
async function shutdown() {
  clearInterval(state.pollTimer);
  clearTimeout(state.restartTimer);
  if (!state.owned) return; // an engine we did not start is left alone
  if (state.child) {
    try { await engine.controlApplications(state.port, 'stop'); } catch (e) { log.line(`stop on quit failed: ${e.message}`); }
    await engine.killTree(state.child);
    log.line('engine stopped');
  }
}

app.on('before-quit', (e) => {
  state.quitting = true;
  if (state.cleanedUp) return;
  e.preventDefault();
  shutdown().finally(() => { state.cleanedUp = true; app.quit(); });
});

app.on('second-instance', () => openWindow('/'));
app.on('activate', () => openWindow('/'));
app.on('window-all-closed', () => { /* stay alive in the tray */ });

// ---------------------------------------------------------------- boot
app.whenReady().then(async () => {
  log = new RotatingLog(path.join(app.getPath('userData'), 'logs', 'engine.log'));
  log.line(`JobAgent desktop ${app.getVersion()} starting (${process.platform}/${process.arch})`);
  loadSettings();
  if (!settings.firstRunDone) {
    settings.firstRunDone = true;
    settings.openAtLogin = true;
    saveSettings();
  }
  applyLoginItem();

  const hidden = openedAtLogin();
  if (hidden) hideDock();
  if (isMac) app.setAboutPanelOptions?.({ applicationName: 'JobAgent' });
  createTray();

  try {
    await startEngine();
  } catch (e) {
    log.line(`engine failed to start: ${e.message}`);
    if (state.child) { await engine.killTree(state.child); state.child = null; }
    state.pollError = true;
    refreshTray();
    const choice = await dialog.showMessageBox({
      type: 'error',
      title: 'JobAgent',
      message: 'JobAgent could not start its engine.',
      detail: `${e.message}\n\nThe log is in ${path.join(app.getPath('userData'), 'logs')}.`,
      buttons: ['Show logs', 'Quit'],
      defaultId: 0,
    });
    if (choice.response === 0) shell.openPath(path.join(app.getPath('userData'), 'logs'));
    else app.quit();
    return;
  }

  if (!hidden) state.win = createWindow();
  await poll();
  state.pollTimer = setInterval(poll, POLL_MS);
});
