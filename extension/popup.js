'use strict';

const $ = (id) => document.getElementById(id);
const YOUTUBE = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i;

let activeTab = null;
let currentStatus = null;
let media = [];
let sent = new Set();
let settings = {};
let toastTimer = null;
let pollTimer = null;
let mediaTimer = null;

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)} ${units[i]}`;
}

function showToast(text, isError = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast${isError ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
}

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res) throw new Error('The extension background worker did not respond.');
  if (res.ok === false) throw new Error(res.error || 'Request failed');
  return res;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function loadSettings() {
  const res = await send('get-settings');
  settings = res.settings || {};
  $('catchDownloads').checked = settings.catchDownloads !== false;
  $('autoMedia').checked = !!settings.autoMedia;
}

async function loadStatus() {
  try {
    const res = await send('status');
    currentStatus = res;
  } catch (e) {
    currentStatus = { connected: false, paired: false };
  }
  const dot = $('dot');
  const text = $('statusText');
  const offline = $('offlineBanner');
  const pair = $('pairBanner');
  if (!currentStatus.connected) {
    dot.className = 'dot bad';
    text.textContent = 'Smiley isn’t running';
    offline.classList.remove('hidden');
    pair.classList.add('hidden');
  } else if (!currentStatus.paired) {
    dot.className = 'dot warn';
    text.textContent = 'Connected · not paired';
    offline.classList.add('hidden');
    pair.classList.remove('hidden');
  } else {
    dot.className = 'dot ok';
    const speed = currentStatus.totalSpeed ? ` · ${fmtBytes(currentStatus.totalSpeed)}/s` : '';
    text.textContent = `Connected${speed}`;
    offline.classList.add('hidden');
    pair.classList.add('hidden');
  }
  renderRecent();
}

function renderRecent() {
  const section = $('recentSection');
  const list = $('recentList');
  const recent = currentStatus?.recent || [];
  if (!currentStatus?.paired || !recent.length) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  $('speedLabel').textContent = currentStatus.totalSpeed ? `${fmtBytes(currentStatus.totalSpeed)}/s` : '';
  list.replaceChildren();
  for (const d of recent.slice(0, 4)) {
    const row = document.createElement('div');
    row.className = 'recent-item';
    const name = document.createElement('span');
    name.className = 'rname';
    name.textContent = d.filename;
    name.title = d.filename;
    const st = document.createElement('span');
    st.className = `rstatus ${d.status}`;
    st.textContent =
      d.status === 'completed'
        ? 'Complete'
        : d.status === 'downloading'
        ? d.size
          ? `${Math.round((d.downloaded / d.size) * 100)}%`
          : 'Downloading'
        : d.status === 'paused'
        ? 'Paused'
        : d.status === 'error'
        ? 'Error'
        : d.status;
    row.append(name, st);
    list.appendChild(row);
  }
}

async function loadMedia() {
  if (!activeTab?.id) return;
  try {
    const res = await send('get-media', { tabId: activeTab.id });
    media = res.media || [];
  } catch {
    media = [];
  }
  renderMedia();
}

function renderMedia() {
  const list = $('mediaList');
  list.replaceChildren();
  const isYt = YOUTUBE.test(hostOf(activeTab?.url || ''));
  $('ytNote').classList.toggle('hidden', !isYt);
  $('sendAll').classList.toggle('hidden', media.length < 2);
  if (!media.length) {
    const empty = document.createElement('div');
    empty.className = 'media-empty';
    empty.textContent = isYt
      ? 'Play the video, then reopen this popup. YouTube streams stay protected; direct links only.'
      : 'Play a video or open an audio file on the page, then reopen this popup. Detected files appear here.';
    list.appendChild(empty);
    return;
  }
  for (const item of media) {
    const row = document.createElement('div');
    row.className = 'media-item';
    const kind = document.createElement('span');
    kind.className = `media-kind ${item.mime?.startsWith('audio') ? 'audio' : ''}`;
    kind.textContent = item.mime?.startsWith('audio') ? 'AUDIO' : 'VIDEO';
    const info = document.createElement('div');
    info.className = 'media-info';
    const title = document.createElement('div');
    title.className = 'media-title';
    title.textContent = hostOf(item.pageUrl || item.url);
    title.title = item.url;
    const sub = document.createElement('div');
    sub.className = 'media-sub';
    sub.textContent = `${item.size ? fmtBytes(item.size) : 'Size unknown'} · ${item.mime || 'media'}`;
    info.append(title, sub);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = sent.has(item.key) ? 'Sent ✓' : 'Download';
    if (sent.has(item.key)) btn.classList.add('sent');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await send('send-url', { url: item.url, referer: activeTab?.url || item.pageUrl || '' });
        sent.add(item.key);
        btn.textContent = 'Sent ✓';
        btn.classList.add('sent');
        showToast('Sent to Smiley Download Manager.');
        loadStatus();
      } catch (e) {
        btn.disabled = false;
        showToast(e.message, true);
      }
    });
    row.append(kind, info, btn);
    list.appendChild(row);
  }
}

async function sendAllMedia() {
  if (!media.length) return;
  try {
    const res = await send('send-batch', {
      items: media.map((m) => ({ url: m.url, referer: activeTab?.url || m.pageUrl || '' })),
    });
    for (const m of media) sent.add(m.key);
    renderMedia();
    showToast(`Sent ${res.added ?? media.length} media file(s) to Smiley.`);
    loadStatus();
  } catch (e) {
    showToast(e.message, true);
  }
}

function wire() {
  $('catchDownloads').addEventListener('change', async (e) => {
    try {
      await send('save-settings', { settings: { catchDownloads: e.target.checked } });
      settings.catchDownloads = e.target.checked;
      showToast(e.target.checked ? 'Catching browser downloads' : 'Browser downloads left alone');
    } catch (err) {
      showToast(err.message, true);
    }
  });
  $('autoMedia').addEventListener('change', async (e) => {
    try {
      await send('save-settings', { settings: { autoMedia: e.target.checked } });
      settings.autoMedia = e.target.checked;
      showToast(e.target.checked ? 'Auto media download is on' : 'Auto media download is off');
    } catch (err) {
      showToast(err.message, true);
    }
  });
  $('refreshMedia').addEventListener('click', loadMedia);
  $('sendAll').addEventListener('click', sendAllMedia);
  const openOptions = () => chrome.runtime.openOptionsPage();
  $('openOptions').addEventListener('click', openOptions);
  $('pairBtn').addEventListener('click', openOptions);
  $('testAgain').addEventListener('click', async () => {
    await loadStatus();
    await loadMedia();
    if (currentStatus?.connected) showToast(currentStatus.paired ? 'Connected to Smiley.' : 'Bridge found — add the pairing token in Options.');
    else showToast('Smiley is not running on this PC.', true);
  });
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;
  wire();
  await loadSettings();
  await loadStatus();
  await loadMedia();
  pollTimer = setInterval(loadStatus, 2000);
  mediaTimer = setInterval(loadMedia, 1600);
  window.addEventListener('unload', () => {
    clearInterval(pollTimer);
    clearInterval(mediaTimer);
  });
}

init().catch((e) => showToast(e.message, true));
