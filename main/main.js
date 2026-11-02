'use strict';

const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  Tray,
  nativeImage,
  Notification,
  clipboard,
  powerSaveBlocker,
  screen,
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { DownloadEngine, categoryFor } = require('./engine');
const { createBridge } = require('./api');
const { VideoService, isYouTubeUrl, summarizePlan } = require('./video');
const { readJsonSync, writeJson, writeJsonSync } = require('./store');

const APP_ID = 'com.smileyapps.downloadmanager';
// Windows takes the taskbar button and the Task Manager icon from the shortcut whose path is
// the window's AppUserModelID, so the app claims the shortcut that launches this executable.
// The bare application id resolves to nothing here and leaves the process image icon, which is
// the Electron atom in a source run and a stale entry for an installed one.
const identity = windowsIdentity();
if (identity) app.setAppUserModelId(identity);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

const DEFAULT_SETTINGS = {
  defaultDir: path.join(app.getPath('downloads') || path.join(process.env.USERPROFILE || '', 'Downloads'), 'Smiley Download Manager'),
  maxConcurrent: 3,
  connections: 16,
  speedLimitKB: 0,
  autoCategorize: false,
  autoResume: true,
  closeToTray: true,
  startWithWindows: false,
  watchClipboard: false,
  notifyOnComplete: true,
  showPopup: true,
  apiPort: 6389,
  schedule: [],
  // Video downloads: the free yt-dlp resolver only *looks up* stream links; Smiley downloads them.
  videoEnabled: true,
  videoKeepParts: false,
  videoAskQuality: true,
  videoHelperPath: '',
  ffmpegPath: '',
};

let win = null;
let progressWin = null;
let tray = null;
let pendingFocusId = null;
let popupDismissed = false;
let popupHideTimer = null;
// A browser-sent video waiting for a quality pick stays in the mini popup, so the full window
// never opens just to ask which format to download.
let popupPlan = null;
let lastPopupComplete = 0;
let engine = null;
let bridge = null;
let video = null;
let settings = { ...DEFAULT_SETTINGS };
let token = '';
let isQuitting = false;
let savesPending = false;
let saveTimer = null;
let clipboardTimer = null;
let lastClipboard = '';
let schedulerTimer = null;
let powerBlocker = 0;
const userData = app.getPath('userData');
const downloadsFile = path.join(userData, 'downloads.json');
const settingsFile = path.join(userData, 'settings.json');
const tokenFile = path.join(userData, 'token.txt');
const windowStateFile = path.join(userData, 'window.json');
const partsDir = path.join(userData, 'parts');

function ensureDirs() {
  for (const dir of [userData, settings.defaultDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {}
  }
}

// Segments are written into the destination folder now, so the old part cache is dead weight.
function pruneLegacyPartsDir() {
  fs.promises.rm(partsDir, { recursive: true, force: true }).catch(() => {});
}

function loadSettings() {
  const loaded = readJsonSync(settingsFile, {});
  settings = { ...DEFAULT_SETTINGS, ...(loaded && typeof loaded === 'object' ? loaded : {}) };
  settings.schedule = Array.isArray(settings.schedule) ? settings.schedule : [];
  if (!settings.defaultDir || typeof settings.defaultDir !== 'string') settings.defaultDir = DEFAULT_SETTINGS.defaultDir;
}

function loadToken() {
  try {
    const t = fs.readFileSync(tokenFile, 'utf8').trim();
    if (t && t.length >= 16) return t;
  } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(userData, { recursive: true });
    fs.writeFileSync(tokenFile, t, 'utf8');
  } catch {}
  return t;
}

async function saveSettings() {
  await writeJson(settingsFile, settings);
}

function scheduleSaveDownloads() {
  if (saveTimer) return;
  savesPending = true;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    savesPending = false;
    await writeJson(downloadsFile, engine ? engine.serialize() : []);
  }, 400);
}

function saveDownloadsNow() {
  if (!engine) return;
  writeJsonSync(downloadsFile, engine.serialize());
}

function extensionDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'browser-extension');
  return path.join(app.getAppPath(), 'extension');
}

function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function shortcutCandidates() {
  const programs = [
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  ];
  const desktops = [
    path.join(process.env.USERPROFILE || '', 'Desktop'),
    path.join(process.env.Public || 'C:\\Users\\Public', 'Desktop'),
  ];
  const names = ['Smiley Download Manager', 'smiley-download-manager'];
  const dirs = [];
  for (const base of programs) {
    dirs.push(base);
    for (const n of names) dirs.push(path.join(base, n));
  }
  dirs.push(...desktops);
  const out = [];
  for (const dir of dirs) {
    for (const n of names) out.push(path.join(dir, `${n}.lnk`));
  }
  return out;
}

// A shortcut only counts when it launches this very executable; the target is stored as UTF-16.
function shortcutForUs(file) {
  try {
    return fs.readFileSync(file).includes(Buffer.from(process.execPath, 'utf16le'));
  } catch {
    return false;
  }
}

function windowsIdentity() {
  if (process.platform !== 'win32') return '';
  for (const file of shortcutCandidates()) {
    if (shortcutForUs(file)) return file;
  }
  if (app.isPackaged) return APP_ID;
  return devShortcutIdentity();
}

// Windows accepts the path of a Start Menu shortcut as the identity of a taskbar button and
// takes the button's icon from that shortcut, which is how a source run gets a stable icon.
// Returns the id to claim, or '' when the shortcut is missing or being (re)written now.
function devShortcutIdentity() {
  if (process.platform !== 'win32') return '';
  const root = app.getAppPath();
  const icon = path.join(root, 'assets', 'icon.ico');
  if (!fs.existsSync(icon)) return '';
  const lnk = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Smiley Download Manager (dev).lnk');
  let stale = true;
  try {
    stale = fs.statSync(lnk).mtimeMs < fs.statSync(icon).mtimeMs;
  } catch {}
  if (!stale) return lnk;
  const script = [
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)})`,
    `$s.TargetPath = ${psQuote(process.execPath)}`,
    `$s.Arguments = ${psQuote(JSON.stringify(root))}`,
    `$s.WorkingDirectory = ${psQuote(root)}`,
    `$s.IconLocation = ${psQuote(`${icon},0`)}`,
    '$s.Save()',
  ].join('; ');
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], () => {});
  return '';
}

function iconCandidates() {
  const base = app.getAppPath();
  return [
    path.join(process.resourcesPath || '', 'icon.ico'),
    path.join(base, 'assets', 'icon.ico'),
    path.join(__dirname, '..', 'assets', 'icon.ico'),
    path.join(process.resourcesPath || '', 'icon.png'),
    path.join(base, 'assets', 'icon.png'),
    path.join(__dirname, '..', 'assets', 'icon.png'),
  ];
}

// createFromPath misses asar-packed files, so read the bytes as a fallback.
function imageFromFile(file) {
  try {
    const img = nativeImage.createFromPath(file);
    if (!img.isEmpty()) return img;
    return nativeImage.createFromBuffer(fs.readFileSync(file));
  } catch {
    return nativeImage.createEmpty();
  }
}

let iconCache;
function appIcon() {
  if (iconCache !== undefined) return iconCache;
  for (const p of iconCandidates()) {
    const img = p ? imageFromFile(p) : null;
    if (img && !img.isEmpty()) {
      iconCache = img;
      return img;
    }
  }
  iconCache = nativeImage.createEmpty();
  return iconCache;
}

function appIconFile() {
  return iconCandidates().find((p) => {
    try {
      return p && fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function windowIconOption() {
  const img = appIcon();
  return img && !img.isEmpty() ? img : undefined;
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  hideProgressPopup();
  // Hidden window + pending quality pick: hand the list to the window the user just opened.
  if (popupPlan) {
    const payload = popupPlan;
    clearPopupPlan();
    sendEvent('video-plan', payload);
  }
}

// A fixed 1200x760 request is most of the screen on a small or scaled display, so the
// default is a share of the current work area instead of an absolute size.
function compactBounds() {
  const area = screen.getPrimaryDisplay().workArea;
  const minWidth = Math.min(760, Math.max(560, area.width - 60));
  const minHeight = Math.min(460, Math.max(400, area.height - 60));
  const width = Math.round(Math.min(1080, Math.max(minWidth, area.width * 0.66)));
  const height = Math.round(Math.min(700, Math.max(minHeight, area.height * 0.835)));
  return {
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + (area.height - height) / 2),
    width,
    height,
    minWidth,
    minHeight,
  };
}

function windowBounds() {
  const compact = compactBounds();
  const fallback = { x: compact.x, y: compact.y, width: compact.width, height: compact.height };
  const saved = readJsonSync(windowStateFile, null);
  const x = Number(saved?.x);
  const y = Number(saved?.y);
  const width = Number(saved?.width);
  const height = Number(saved?.height);
  if (![x, y, width, height].every(Number.isFinite)) return fallback;
  if (width < compact.minWidth || height < compact.minHeight) return fallback;
  // The last windowed size is the compact size: it is restored on every launch and reused
  // after an update or reinstall, while a maximized window still comes back at that size.
  const display = screen.getAllDisplays().find((d) => {
    const a = d.bounds;
    return x < a.x + a.width - 60 && x + width > a.x + 60 && y < a.y + a.height - 60 && y + height > a.y + 60;
  });
  if (!display) return fallback;
  const area = display.workArea;
  const w = Math.min(width, area.width - 20);
  const h = Math.min(height, area.height - 20);
  return {
    x: Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - w)),
    y: Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - h)),
    width: w,
    height: h,
  };
}

let normalBounds = null;
let boundsTimer = null;

function persistWindowState() {
  if (!win || win.isDestroyed()) return;
  if (!win.isMaximized()) normalBounds = win.getBounds();
  writeJson(windowStateFile, normalBounds || win.getBounds()).catch(() => {});
}

function scheduleWindowStateSave() {
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistWindowState, 600);
}

function createWindow() {
  const bounds = windowBounds();
  const compact = compactBounds();
  win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: Math.min(compact.minWidth, bounds.width),
    minHeight: Math.min(compact.minHeight, bounds.height),
    backgroundColor: '#eef1f5',
    title: 'Smiley Download Manager',
    icon: windowIconOption(),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null);
  const icon = windowIconOption();
  if (icon) win.setIcon(icon);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (process.argv.includes('--start-minimized') && tray) {
      win.hide();
    } else {
      hideProgressPopup();
    }
  });
  for (const event of ['resize', 'move', 'maximize', 'unmaximize']) {
    win.on(event, scheduleWindowStateSave);
  }
  win.webContents.on('did-finish-load', () => {
    if (pendingFocusId) {
      sendEvent('focus-download', { id: pendingFocusId });
      pendingFocusId = null;
    }
  });

  win.on('close', (e) => {
    persistWindowState();
    if (!isQuitting && settings.closeToTray) {
      e.preventDefault();
      win.hide();
      if (tray && !win._trayHintShown) {
        win._trayHintShown = true;
        try {
          tray.displayBalloon?.({
            title: 'Smiley Download Manager is still running',
            content: 'Downloads keep going in the background. Right-click the tray smiley to exit.',
            iconType: 'info',
          });
        } catch {}
      }
    }
  });

  win.on('hide', () => {
    if (engine && engine.active.size > 0 && settings.showPopup) showProgressPopup();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
}

function popupBounds(mode = 'progress') {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const planMode = mode === 'plan';
  const width = Math.min(planMode ? 424 : 390, area.width - 24);
  const height = Math.min(planMode ? 416 : 176, area.height - 24);
  return {
    x: Math.round(area.x + area.width - width - 16),
    y: Math.round(area.y + area.height - height - 12),
    width,
    height,
  };
}

function createProgressPopup() {
  if (progressWin && !progressWin.isDestroyed()) return progressWin;
  const b = popupBounds();
  progressWin = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    show: false,
    icon: windowIconOption(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  progressWin.setAlwaysOnTop(true, 'floating');
  progressWin.loadFile(path.join(__dirname, '..', 'renderer', 'popup.html'));
  progressWin.on('closed', () => {
    progressWin = null;
  });
  progressWin.webContents.on('did-finish-load', () => {
    progressWin.webContents.send('sdm:event', { type: 'popup-open' });
    if (popupPlan) progressWin.webContents.send('sdm:event', { type: 'video-plan', payload: popupPlan });
  });
  progressWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  progressWin.webContents.on('will-navigate', (e) => e.preventDefault());
  return progressWin;
}

function sendPopupEvent(type, payload) {
  if (progressWin && !progressWin.isDestroyed()) {
    progressWin.webContents.send('sdm:event', { type, payload });
  }
}

function showProgressPopup() {
  if (!settings.showPopup) return;
  if (popupHideTimer) {
    clearTimeout(popupHideTimer);
    popupHideTimer = null;
  }
  popupDismissed = false;
  const p = createProgressPopup();
  if (!p) return;
  p.setBounds(popupBounds(popupPlan ? 'plan' : 'progress'));
  if (!p.isVisible()) {
    p.showInactive();
  }
  p.webContents.send('sdm:event', { type: 'popup-open' });
  if (popupPlan) p.webContents.send('sdm:event', { type: 'video-plan', payload: popupPlan });
}

function showPopupPlan(payload) {
  popupPlan = { ...payload, ts: Date.now() };
  showProgressPopup();
  if (progressWin && !progressWin.isDestroyed()) {
    progressWin.setBounds(popupBounds('plan'));
    sendPopupEvent('video-plan', popupPlan);
  }
}

function clearPopupPlan() {
  popupPlan = null;
  if (progressWin && !progressWin.isDestroyed()) {
    if (progressWin.isVisible()) progressWin.setBounds(popupBounds());
    sendPopupEvent('video-plan', null);
  }
}

function hideProgressPopup() {
  if (progressWin && !progressWin.isDestroyed() && progressWin.isVisible()) progressWin.hide();
}

function schedulePopupHide(delay = 5000) {
  if (popupHideTimer) clearTimeout(popupHideTimer);
  popupHideTimer = setTimeout(() => {
    popupHideTimer = null;
    if (!engine || engine.active.size > 0) return;
    // Freshly finished downloads keep their popup so Open file / Open folder stay reachable.
    if (lastPopupComplete && Date.now() - lastPopupComplete < 10 * 60 * 1000) return;
    hideProgressPopup();
  }, delay);
}

function focusDownload(id) {
  pendingFocusId = id || null;
  showWindow();
  if (win && !win.isDestroyed() && !win.webContents.isLoading() && pendingFocusId) {
    sendEvent('focus-download', { id: pendingFocusId });
    pendingFocusId = null;
  }
}

function createTray() {
  const trayFile = path.join(__dirname, '..', 'assets', 'tray.png');
  const img = imageFromFile(trayFile);
  const icon = img.isEmpty() ? appIcon() : img;
  if (!icon || icon.isEmpty()) return;
  tray = new Tray(icon.resize({ width: 20, height: 20 }));
  tray.setToolTip('Smiley Download Manager');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Smiley Download Manager', click: showWindow },
    { type: 'separator' },
    { label: 'Start all downloads', click: () => engine?.startAll() },
    { label: 'Pause all downloads', click: () => engine?.pauseAll() },
    { type: 'separator' },
    {
      label: 'Exit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', showWindow);
  tray.on('click', showWindow);
}

function sendEvent(type, payload) {
  if (win && !win.isDestroyed()) win.webContents.send('sdm:event', { type, payload });
}

function notifyComplete(dl) {
  lastPopupComplete = Date.now();
  const mainHidden = !win || win.isDestroyed() || !win.isVisible();
  if (settings.showPopup && mainHidden && !popupDismissed) showProgressPopup();
  if (!settings.notifyOnComplete || !Notification.isSupported()) {
    sendEvent('download-completed', dl);
    return;
  }
  try {
    const n = new Notification({
      title: 'Download complete',
      body: dl.filename,
      icon: appIconFile(),
      silent: false,
    });
    n.on('click', () => {
      showWindow();
      if (dl.filePath) shell.showItemInFolder(dl.filePath);
    });
    n.show();
  } catch {}
  sendEvent('download-completed', dl);
}

async function openFolderFor(id) {
  const dl = engine.get(id);
  if (!dl) throw new Error('Download not found');
  if (dl.filePath && fs.existsSync(dl.filePath)) {
    shell.showItemInFolder(dl.filePath);
    return true;
  }
  const dir = dl.filePath ? path.dirname(dl.filePath) : dl.dir;
  fs.mkdirSync(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) throw new Error(err);
  return true;
}

// Quality lists hold signed stream links, so they are kept here and referenced by a token
// instead of round-tripping URLs through the renderer.
const pendingPlans = new Map();
const PLAN_TTL = 30 * 60 * 1000;

function prunePlans() {
  const cutoff = Date.now() - PLAN_TTL;
  for (const [token, entry] of pendingPlans) {
    if (entry.ts < cutoff) pendingPlans.delete(token);
  }
  if (popupPlan && popupPlan.ts < cutoff) clearPopupPlan();
}

function videoDirFor(filename) {
  if (!settings.autoCategorize) return settings.defaultDir;
  const category = categoryFor(filename);
  return path.join(settings.defaultDir, category === 'Other' ? 'Video' : category);
}

async function refreshVideoStatus() {
  try {
    sendEvent('video-status-changed', await video.status());
  } catch {}
}

async function handleCompleted(dl) {
  const raw = engine.get(dl.id);
  if (!raw) return;
  let owned = { owned: false };
  try {
    owned = await video.onDownloadCompleted(raw);
  } catch (e) {
    console.error('[Smiley] helper install failed:', e);
    sendEvent('video-install-error', e?.message || String(e));
  }
  if (owned.kind) {
    // A resolver or FFmpeg archive landed; no need to announce it as a download.
    await refreshVideoStatus();
    return;
  }
  // A split video/audio track is deleted after FFmpeg combines it, so only the combined
  // file is worth a completion notice.
  if (video?.isMergeInput?.(dl.id)) return;
  if (owned.merge) {
    try {
      await video.cleanupMergeInputs(raw);
    } catch (e) {
      console.error('[Smiley] merge cleanup:', e);
    }
  }
  notifyComplete(dl);
}

// Ask the resolver what this video offers. The answer holds signed, short-lived stream links,
// so it stays in the main process and the UI refers to it by token.
async function resolveVideo(url) {
  if (!settings.videoEnabled) throw new Error('Video downloads are switched off in Options → Video.');
  const clean = String(url || '').trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error('Give the full web address of the video.');
  const plan = await video.resolve(clean);
  const ffmpegInstalled = await video.hasFfmpeg();
  prunePlans();
  const tokenPlan = crypto.randomBytes(6).toString('hex');
  pendingPlans.set(tokenPlan, { plan, ts: Date.now() });
  return { token: tokenPlan, plan: summarizePlan(plan), dir: videoDirFor(`${plan.title}.mp4`), ffmpegInstalled };
}

async function startVideo(tokenPlan, pickKey, { filename, dir } = {}) {
  const entry = pendingPlans.get(tokenPlan);
  if (!entry) throw new Error('That quality list expired. Open the video again to refresh it.');
  const pick =
    entry.plan.picks.find((p) => p.key === pickKey) ||
    entry.plan.picks.find((p) => p.recommended) ||
    entry.plan.picks[0];
  if (!pick) throw new Error(entry.plan.blockedReason || 'This video has no downloadable format.');
  if (pick.merge && !(await video.hasFfmpeg())) {
    throw new Error(
      'That quality is split into a video track and an audio track, which need FFmpeg to be combined into one file. Install FFmpeg in Options → Video, or pick a single-file quality.'
    );
  }
  const target = dir ? path.resolve(String(dir)) : videoDirFor(`${filename || entry.plan.title}.mp4`);
  fs.mkdirSync(target, { recursive: true });
  const result = video.startFromPlan(entry.plan, pick.key, {
    filename: String(filename || entry.plan.title),
    dir: target,
    description: entry.plan.webpageUrl || entry.plan.title,
  });
  pendingPlans.delete(tokenPlan);
  // The quality list in the popup turns into the progress card for this download.
  if (popupPlan && popupPlan.token === tokenPlan) clearPopupPlan();
  if (!win || !win.isVisible()) showProgressPopup();
  return result;
}

// The browser button lands here: pick in Smiley, or take the best quality straight away.
async function videoFromPage(url) {
  const { token, plan, dir, ffmpegInstalled } = await resolveVideo(url);
  if (settings.videoAskQuality === false) {
    // Without FFmpeg a merged quality would end in an error after downloading both tracks,
    // so fall back to the best single-file format when one exists.
    const best =
      plan.picks.find((p) => p.recommended && (!p.merge || ffmpegInstalled)) ||
      plan.picks.find((p) => !p.merge) ||
      plan.picks[0];
    if (!best) throw new Error(plan.blockedReason || 'This video has no downloadable format.');
    const started = await startVideo(token, best.key, { filename: plan.title, dir });
    return { started: true, plan: summarizePlan(plan), ...started };
  }
  const payload = { token, plan: summarizePlan(plan), dir, ffmpegInstalled };
  if (settings.showPopup) {
    // The picker lives in the corner popup, so a browser download never pulls up the full window.
    showPopupPlan(payload);
  } else {
    showWindow();
    sendEvent('video-plan', payload);
  }
  return { started: false, dialog: true };
}

function setupEngine() {
  engine = new DownloadEngine({
    partsDir,
    merger: (dl, inputs, ctx) => video.merge(dl, inputs, ctx),
    settings: {
      maxConcurrent: settings.maxConcurrent,
      connections: settings.connections,
      speedLimitBytes: Math.max(0, Number(settings.speedLimitKB) || 0) * 1024,
      defaultDir: settings.defaultDir,
      autoCategorize: settings.autoCategorize,
    },
  });

  const list = readJsonSync(downloadsFile, []);
  engine.load(list);

  engine.on('persist', scheduleSaveDownloads);
  engine.on('changed', () => {
    sendEvent('state-changed');
    const active = engine.active.size;
    if (active > 0 && !powerBlocker) {
      try {
        powerBlocker = powerSaveBlocker.start('prevent-app-suspension');
      } catch {}
    } else if (active === 0 && powerBlocker) {
      try {
        powerSaveBlocker.stop(powerBlocker);
      } catch {}
      powerBlocker = 0;
    }
    if (active > 0) {
      const mainHidden = !win || win.isDestroyed() || !win.isVisible();
      if (settings.showPopup && !popupDismissed && mainHidden) showProgressPopup();
    } else {
      schedulePopupHide();
    }
  });
  engine.on('completed', (dl) => handleCompleted(dl).catch((e) => console.error('[Smiley] completion:', e)));
  engine.on('error', (dl) => sendEvent('download-error', dl));

  video = new VideoService({
    toolsDir: path.join(userData, 'tools'),
    engine,
    settingsProvider: () => settings,
    onProgressChange: () => sendEvent('video-status-changed'),
  });
  // An install interrupted by a crash leaves a half-written archive behind; drop it and start clean.
  for (const row of engine.downloads.filter((d) => d.kind === 'tool')) {
    engine.remove(row.id, { deleteFile: true });
  }
  video.status().catch(() => {});

  if (settings.autoResume) {
    const resumeIds = engine.downloads.filter((d) => d._wasActive).map((d) => d.id);
    for (const id of resumeIds) engine.start(id);
  }
}

function startBridge() {
  bridge = createBridge({
    engine,
    getToken: () => token,
    getInfo: () => ({ version: app.getVersion(), platform: process.platform, video: !!settings.videoEnabled }),
    video: {
      status: () => video.status(),
      resolve: (url) => resolveVideo(url),
      start: (planToken, pick, opts) => startVideo(planToken, pick, opts),
      add: (url) => videoFromPage(url),
      install: (kind) => (kind === 'resolver' ? video.installHelper() : video.installFfmpeg()),
      cancelInstall: () => video.cancelInstall(),
    },
    openFolder: (id) => openFolderFor(id),
    onActivity: (type, payload) => {
      // Browser downloads stay in the corner popup; the full window only opens for actions that
      // ask for it explicitly (for example revealing a finished file).
      if (['add', 'add-batch', 'video-add', 'video-start'].includes(type)) showProgressPopup();
      else showWindow();
      sendEvent('bridge-activity', { type, payload });
    },
    startPort: Number(settings.apiPort) || 6389,
  });
  bridge.start().then((port) => {
    if (port) console.log(`[Smiley] Browser bridge listening on http://127.0.0.1:${port}`);
    sendEvent('bridge-ready', { port });
  });
}

function publicSettings() {
  return { ...settings };
}

function statePayload() {
  const snap = engine.snapshot();
  let completed = 0;
  let unfinished = 0;
  for (const d of snap.downloads) {
    if (d.status === 'completed') completed++;
    else unfinished++;
  }
  return {
    ...snap,
    settings: publicSettings(),
    info: {
      version: app.getVersion(),
      apiPort: bridge ? bridge.port : 0,
      extensionDir: extensionDir(),
      dataDir: userData,
      defaultDir: settings.defaultDir,
      completed,
      unfinished,
      platform: process.platform,
      electron: process.versions.electron,
    },
  };
}

function sanitizeSettingsPatch(patch) {
  const allowed = [
    'defaultDir',
    'maxConcurrent',
    'connections',
    'speedLimitKB',
    'autoCategorize',
    'autoResume',
    'closeToTray',
    'startWithWindows',
    'watchClipboard',
    'notifyOnComplete',
    'showPopup',
    'apiPort',
    'schedule',
    'videoEnabled',
    'videoKeepParts',
    'videoAskQuality',
    'videoHelperPath',
    'ffmpegPath',
  ];
  const out = {};
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    const v = patch[key];
    switch (key) {
      case 'defaultDir':
        if (typeof v === 'string' && v.trim()) out.defaultDir = path.resolve(v.trim());
        break;
      case 'maxConcurrent':
        out.maxConcurrent = Math.min(16, Math.max(1, parseInt(v, 10) || 3));
        break;
      case 'connections':
        out.connections = Math.min(32, Math.max(1, parseInt(v, 10) || 8));
        break;
      case 'speedLimitKB':
        out.speedLimitKB = Math.min(1024 * 1024, Math.max(0, parseInt(v, 10) || 0));
        break;
      case 'apiPort':
        out.apiPort = Math.min(65535, Math.max(1024, parseInt(v, 10) || 6389));
        break;
      case 'videoHelperPath':
      case 'ffmpegPath':
        // Optional override: an existing yt-dlp.exe or ffmpeg.exe the user already owns.
        out[key] = typeof v === 'string' && v.trim() && v.length < 500 ? path.resolve(v.trim()) : '';
        break;
      case 'schedule':
        if (Array.isArray(v)) {
          out.schedule = v
            .filter((t) => t && /^\d{2}:\d{2}$/.test(String(t.time || '')) && ['start', 'pause'].includes(t.action))
            .slice(0, 20)
            .map((t) => ({
              id: t.id || crypto.randomBytes(4).toString('hex'),
              time: String(t.time),
              action: t.action,
              enabled: t.enabled !== false,
              lastFired: t.lastFired || '',
            }));
        }
        break;
      default:
        if (typeof v === 'boolean') out[key] = v;
    }
  }
  return out;
}

async function applyRuntimeSettings(prev = {}) {
  ensureDirs();
  engine.setSettings({
    maxConcurrent: settings.maxConcurrent,
    connections: settings.connections,
    speedLimitBytes: Math.max(0, Number(settings.speedLimitKB) || 0) * 1024,
    defaultDir: settings.defaultDir,
    autoCategorize: settings.autoCategorize,
  });
  if (!settings.showPopup) hideProgressPopup();
  if (prev.startWithWindows !== settings.startWithWindows) {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!settings.startWithWindows,
        args: ['--start-minimized'],
      });
    } catch {}
  }
  if (prev.apiPort !== settings.apiPort && bridge) {
    await bridge.stop();
    startBridge();
  }
}

function probeWithTimeout(url, extra = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  const probe = engine.probe(url, { ...extra, signal: controller.signal });
  return probe.finally(() => clearTimeout(timer));
}

const DOWNLOAD_EXT =
  /\.(zip|rar|7z|tar|gz|iso|exe|msi|msix|apk|pdf|epub|docx?|xlsx?|pptx?|mp3|wav|flac|aac|ogg|m4a|mp4|mkv|avi|mov|webm|flv|wmv|m4v|ts|jpg|jpeg|png|gif|webp|svg|bin|dmg|pkg)(\?|#|$)/i;

function looksLikeDownloadLink(text) {
  if (!text || /\s/.test(text.trim())) return false;
  const t = text.trim();
  return /^https?:\/\//i.test(t) && DOWNLOAD_EXT.test(t);
}

function startClipboardWatcher() {
  if (clipboardTimer) return;
  clipboardTimer = setInterval(() => {
    if (!settings.watchClipboard) return;
    let text = '';
    try {
      text = clipboard.readText().trim();
    } catch {}
    if (!text || text === lastClipboard) return;
    lastClipboard = text;
    if (looksLikeDownloadLink(text)) {
      showWindow();
      sendEvent('clipboard-url', { url: text });
    }
  }, 1200);
}

function startScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = setInterval(async () => {
    const tasks = settings.schedule || [];
    if (!tasks.length) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const key = `${now.toISOString().slice(0, 10)} ${hhmm}`;
    let changed = false;
    for (const task of tasks) {
      if (!task.enabled || task.time !== hhmm) continue;
      if (task.lastFired === key) continue;
      task.lastFired = key;
      changed = true;
      if (task.action === 'start') engine.startAll();
      else engine.pauseAll();
      sendEvent('scheduler-fired', { action: task.action, time: task.time });
    }
    if (changed) await saveSettings();
  }, 15000);
  schedulerTimer.unref?.();
}

function handleArgsForUrls(argv) {
  const url = argv.find((a) => /^https?:\/\//i.test(a));
  if (!url) return;
  try {
    const dl = engine.add({ url, startNow: true });
    showProgressPopup();
    sendEvent('bridge-activity', { type: 'add', payload: dl });
  } catch {}
}

async function handleCall(method, payload = {}) {
  switch (method) {
    case 'getState':
      return statePayload();
    case 'addUrl': {
      const dl = engine.add({
        url: payload.url,
        dir: payload.dir,
        filename: payload.filename,
        startNow: payload.startNow !== false,
        description: payload.description,
        referer: payload.referer,
        cookie: payload.cookie,
      });
      return dl;
    }
    case 'addBatch': {
      const urls = Array.isArray(payload.urls) ? payload.urls : [];
      const added = [];
      const errors = [];
      for (const raw of urls) {
        try {
          added.push(
            engine.add({
              url: raw,
              dir: payload.dir,
              startNow: payload.startNow !== false,
              description: payload.description,
            })
          );
        } catch (e) {
          errors.push({ url: raw, error: e.message });
        }
      }
      return { added: added.length, errors };
    }
    case 'start':
      return engine.start(payload.id);
    case 'pause':
      return engine.pause(payload.id);
    case 'remove':
      return engine.remove(payload.id, { deleteFile: !!payload.deleteFile });
    case 'pauseAll':
      await engine.pauseAll();
      return true;
    case 'startAll':
      engine.startAll();
      return true;
    case 'retry':
      engine.start(payload.id);
      return true;
    case 'removeCompleted':
      return engine.removeCompleted({ deleteFiles: !!payload.deleteFiles });
    case 'openFile': {
      const dl = engine.get(payload.id);
      if (!dl || !dl.filePath) throw new Error('File not found');
      if (!fs.existsSync(dl.filePath)) throw new Error('The file has been moved or deleted');
      const err = await shell.openPath(dl.filePath);
      if (err) throw new Error(err);
      return true;
    }
    case 'openFolder':
      return openFolderFor(payload.id);
    case 'showItem': {
      const dl = engine.get(payload.id);
      if (dl?.filePath && fs.existsSync(dl.filePath)) shell.showItemInFolder(dl.filePath);
      return true;
    }
    case 'probeUrl': {
      const url = String(payload.url || '').trim();
      if (!url) throw new Error('Enter a URL first');
      const info = await probeWithTimeout(url);
      return {
        ...info,
        category: categoryFor(info.filename),
        suggestedDir: settings.autoCategorize
          ? path.join(settings.defaultDir, categoryFor(info.filename))
          : settings.defaultDir,
      };
    }
    case 'chooseFolder': {
      const result = await dialog.showOpenDialog(win, {
        title: 'Choose download folder',
        defaultPath: payload.current || settings.defaultDir,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || !result.filePaths.length) return { canceled: true };
      return { path: result.filePaths[0] };
    }
    case 'videoStatus':
      return await video.status();
    case 'videoInfo':
      return await resolveVideo(payload.url);
    case 'videoStart':
      return await startVideo(payload.token, payload.pick, payload);
    case 'videoInstallHelper':
      return await video.installHelper();
    case 'videoInstallFfmpeg':
      return await video.installFfmpeg();
    case 'videoCancelInstall':
      return await video.cancelInstall();
    case 'popupVideoPlan': {
      if (!popupPlan) return null;
      if (Date.now() - popupPlan.ts > PLAN_TTL) {
        clearPopupPlan();
        return null;
      }
      return popupPlan;
    }
    case 'popupDismissPlan': {
      if (popupPlan) {
        pendingPlans.delete(popupPlan.token);
        clearPopupPlan();
      }
      return true;
    }
    case 'getToken':
      return token;
    case 'regenerateToken': {
      token = crypto.randomBytes(24).toString('hex');
      try {
        fs.writeFileSync(tokenFile, token, 'utf8');
      } catch {}
      return token;
    }
    case 'saveSettings': {
      const prev = { ...settings };
      const patch = sanitizeSettingsPatch(payload || {});
      settings = { ...settings, ...patch };
      await saveSettings();
      await applyRuntimeSettings(prev);
      sendEvent('settings-changed', settings);
      return publicSettings();
    }
    case 'openExtensionFolder': {
      const dir = extensionDir();
      try {
        fs.accessSync(dir);
      } catch {
        throw new Error('Extension folder not found');
      }
      const err = await shell.openPath(dir);
      if (err) throw new Error(err);
      return dir;
    }
    case 'copyText':
      clipboard.writeText(String(payload.text || ''));
      return true;
    case 'readClipboard':
      return clipboard.readText();
    case 'openExternal': {
      const url = String(payload.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened');
      await shell.openExternal(url);
      return true;
    }
    case 'focusDownload':
      focusDownload(payload.id);
      return true;
    case 'hidePopup':
      popupDismissed = true;
      hideProgressPopup();
      return true;
    case 'openMain':
      showWindow();
      return true;
    case 'quitApp':
      isQuitting = true;
      app.quit();
      return true;
    case 'minimizeToTray':
      win?.hide();
      return true;
    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

ipcMain.handle('sdm:call', async (_event, { method, payload } = {}) => {
  try {
    const data = await handleCall(method, payload);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

app.on('second-instance', (_e, argv) => {
  showWindow();
  if (engine) handleArgsForUrls(argv);
});

app.on('before-quit', () => {
  isQuitting = true;
  persistWindowState();
  saveDownloadsNow();
});

app.on('window-all-closed', () => {
  if (isQuitting) app.quit();
});

app.whenReady().then(async () => {
  loadSettings();
  ensureDirs();
  pruneLegacyPartsDir();
  token = loadToken();
  setupEngine();
  createWindow();
  createTray();
  startBridge();
  startClipboardWatcher();
  startScheduler();
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.startWithWindows,
      args: ['--start-minimized'],
    });
  } catch {}

  setTimeout(() => handleArgsForUrls(process.argv), 800);
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else showWindow();
});

process.on('uncaughtException', (err) => {
  console.error('[Smiley] uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[Smiley] unhandled rejection:', err);
});
