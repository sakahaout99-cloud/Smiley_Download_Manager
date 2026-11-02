'use strict';

const DEFAULT_SETTINGS = {
  token: '',
  port: 6389,
  catchDownloads: true,
  autoMedia: false,
  sniffer: true,
  pagePanel: true,
  minMediaSize: 1024 * 1024,
  excludeDomains: [],
};

const STREAM_EXCLUDE = /\.(m3u8|mpd|ts|m4s|m4f|ism|ismc)(\?|$)/i;
const MEDIA_MIME_EXCLUDE = /(mpegurl|dash\+xml|mp2t)/i;
const YOUTUBE_HOST = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i;

let settingsCache = null;
let cachedPort = 0;
const sentMedia = new Set();

async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await chrome.storage.local.get(null);
  settingsCache = {
    ...DEFAULT_SETTINGS,
    ...stored,
    excludeDomains: Array.isArray(stored.excludeDomains) ? stored.excludeDomains : [],
  };
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    settingsCache = null;
    cachedPort = 0;
  }
});

function isExcluded(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return (settingsCache?.excludeDomains || []).some((d) => {
      const rule = String(d || '').trim().replace(/^www\./, '').toLowerCase();
      return rule && (host === rule || host.endsWith('.' + rule));
    });
  } catch {
    return false;
  }
}

async function ping(port, timeout = 850) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: ctrl.signal });
    const data = await res.json().catch(() => null);
    return !!(res.ok && data && data.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function findPort(force = false) {
  const s = await getSettings();
  if (!force && cachedPort && (await ping(cachedPort))) return cachedPort;
  const candidates = Array.from({ length: 11 }, (_, i) => 6389 + i);
  if (s.port && !candidates.includes(Number(s.port))) candidates.unshift(Number(s.port));
  const checks = await Promise.all(candidates.map(async (p) => ({ p, ok: await ping(p) })));
  const hit = checks.find((c) => c.ok);
  cachedPort = hit ? hit.p : 0;
  return cachedPort;
}

async function apiFetch(path, { method = 'GET', body, timeout = 12000 } = {}) {
  const s = await getSettings();
  const port = await findPort();
  if (!port) throw new Error('BRIDGE_DOWN');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(s.token ? { 'X-SDM-Token': s.token } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new Error('PAIR_REQUIRED');
    if (!res.ok || !data || !data.ok) throw new Error(data?.error || `HTTP ${res.status}`);
    return data;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Bridge did not respond in time.');
    if (e instanceof TypeError || e.message === 'Failed to fetch') {
      cachedPort = 0;
      throw new Error('BRIDGE_DOWN');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function cookieHeader(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function addToSmiley(entry) {
  if (!entry || !/^https?:\/\//i.test(entry.url || '')) throw new Error('Only http(s) links can be sent.');
  const s = await getSettings();
  if (!s.token) throw new Error('PAIR_REQUIRED');
  const cookie = await cookieHeader(entry.url);
  const payload = {
    url: entry.url,
    referer: entry.referer || '',
    filename: entry.filename || '',
    cookie,
    userAgent: navigator.userAgent,
    startNow: true,
  };
  const data = await apiFetch('/api/add', { method: 'POST', body: payload });
  cachedPort = cachedPort || (await findPort());
  return data;
}

/*
 * Videos are resolved inside Smiley (yt-dlp runs there, not here), and the signed stream links
 * never leave the desktop app. This call only asks Smiley to add the page; the app either starts
 * the best quality or shows its own quality picker.
 */
async function addVideoToSmiley(url) {
  if (!/^https?:\/\//i.test(url || '')) throw new Error('Only http(s) video pages can be sent.');
  const s = await getSettings();
  if (!s.token) throw new Error('PAIR_REQUIRED');
  return apiFetch('/api/video/add', { method: 'POST', body: { url }, timeout: 240000 });
}

async function addBatchToSmiley(items) {  const s = await getSettings();
  if (!s.token) throw new Error('PAIR_REQUIRED');
  const clean = [];
  for (const item of items.slice(0, 200)) {
    if (!/^https?:\/\//i.test(item.url)) continue;
    clean.push({
      url: item.url,
      referer: item.referer || '',
      filename: item.filename || '',
      cookie: await cookieHeader(item.url),
      userAgent: navigator.userAgent,
    });
  }
  if (!clean.length) throw new Error('No downloadable links found on this page.');
  return apiFetch('/api/add-batch', { method: 'POST', body: { urls: clean, startNow: true } });
}

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title,
      message,
      priority: 0,
    });
  } catch {}
}

function flashBadge(text, color = '#1e8a44') {
  try {
    chrome.action.setBadgeBackgroundColor({ color });
    chrome.action.setBadgeText({ text });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '' }).catch?.(() => {});
    }, 4000);
  } catch {}
}

function downloadUrlFromSelection(text) {
  const m = String(text || '').match(/https?:\/\/[^\s"'<>]+/i);
  return m ? m[0] : '';
}

/* ---------------- context menus ---------------- */

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'sdm-link',
      title: 'Download with Smiley Download Manager',
      contexts: ['link'],
    });
    chrome.contextMenus.create({
      id: 'sdm-media',
      title: 'Download media with Smiley',
      contexts: ['video', 'audio'],
    });
    chrome.contextMenus.create({
      id: 'sdm-selection',
      title: 'Download selected link with Smiley',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: 'sdm-page',
      title: 'Send download links on this page to Smiley',
      contexts: ['page'],
    });
  });
}

async function handleSendResult(promise, successMessage) {
  try {
    await promise;
    if (successMessage) notify('Smiley Download Manager', successMessage);
    flashBadge('✓');
  } catch (e) {
    if (e.message === 'PAIR_REQUIRED') {
      notify('Pair the Smiley extension', 'Open the extension options and paste the pairing token from Smiley → Options → Browser integration.');
    } else if (e.message === 'BRIDGE_DOWN') {
      notify('Smiley is not running', 'Start Smiley Download Manager, then try again.');
    } else {
      notify('Could not send download', e.message);
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'sdm-link' && info.linkUrl) {
    handleSendResult(
      addToSmiley({ url: info.linkUrl, referer: info.pageUrl || tab?.url || '' }),
      'Download sent to Smiley.'
    );
  } else if (info.menuItemId === 'sdm-media' && info.srcUrl) {
    handleSendResult(
      addToSmiley({ url: info.srcUrl, referer: info.pageUrl || tab?.url || '' }),
      'Media download sent to Smiley.'
    );
  } else if (info.menuItemId === 'sdm-selection') {
    const url = downloadUrlFromSelection(info.selectionText);
    if (url) {
      handleSendResult(addToSmiley({ url, referer: info.pageUrl || tab?.url || '' }), 'Download sent to Smiley.');
    } else {
      notify('No link in selection', 'Select a full http(s) address and try again.');
    }
  } else if (info.menuItemId === 'sdm-page' && tab?.id) {
    sendPageLinks(tab).catch((e) => notify('Could not collect links', e.message));
  }
});

async function sendPageLinks(tab) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => Array.from(document.querySelectorAll('a[href]')).map((a) => a.href).slice(0, 500),
  });
  const EXT = /\.(zip|rar|7z|tar|gz|iso|exe|msi|msix|apk|pdf|epub|docx?|xlsx?|pptx?|mp3|wav|flac|aac|ogg|m4a|mp4|mkv|avi|mov|webm|flv|wmv|m4v|jpg|jpeg|png|gif|webp|bin|dmg|pkg)(\?|#|$)/i;
  const urls = [...new Set(result?.result || [])]
    .filter((u) => /^https?:\/\//i.test(u) && EXT.test(u))
    .slice(0, 100);
  if (!urls.length) {
    notify('No download links found', 'This page does not appear to link to files directly.');
    return;
  }
  const res = await addBatchToSmiley(urls.map((url) => ({ url, referer: tab.url || '' })));
  notify('Smiley Download Manager', `Sent ${res.added} link(s) from ${new URL(tab.url).hostname}.`);
}

/* ---------------- download interception ---------------- */

chrome.downloads.onCreated.addListener((item) => {
  interceptDownload(item).catch(() => {});
});

async function interceptDownload(item) {
  const s = await getSettings();
  if (!s.catchDownloads) return;
  if (item.byExtensionId === chrome.runtime.id) return;
  if (!s.token) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:\/\//i.test(url)) return;
  if (isExcluded(url)) return;
  if (STREAM_EXCLUDE.test(url)) return;
  if (!(await findPort())) return;
  try {
    await addToSmiley({ url, referer: item.referrer || '' });
    try {
      await chrome.downloads.cancel(item.id);
      await chrome.downloads.erase({ id: item.id });
    } catch {}
    flashBadge('✓');
  } catch (e) {
    if (e.message === 'PAIR_REQUIRED') {
      notify('Pair the Smiley extension', 'Open the extension options and paste the pairing token.');
    }
  }
}

/* ---------------- media sniffing ---------------- */

const MEDIA_TYPES = ['media', 'object', 'xmlhttprequest', 'other'];

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    sniffMedia(details).catch(() => {});
  },
  { urls: ['<all_urls>'], types: MEDIA_TYPES },
  ['responseHeaders']
);

function mediaKey(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete('range');
    u.hash = '';
    return u.toString();
  } catch {
    return url;
  }
}

async function sniffMedia(details) {
  const s = await getSettings();
  if (!s.sniffer) return;
  if (details.tabId < 0) return;
  if (details.statusCode && details.statusCode >= 400) return;
  if (!/^https?:\/\//i.test(details.url)) return;
  if (isExcluded(details.url)) return;
  if (STREAM_EXCLUDE.test(details.url)) return;
  const headers = {};
  for (const h of details.responseHeaders || []) headers[String(h.name).toLowerCase()] = h.value || '';
  const ct = (headers['content-type'] || '').toLowerCase();
  const cd = headers['content-disposition'] || '';
  const isMedia = ct.startsWith('audio/') || ct.startsWith('video/');
  if (!isMedia) return;
  if (MEDIA_MIME_EXCLUDE.test(ct)) return;
  const size = Number(headers['content-length']) || null;
  if (size && size < Number(s.minMediaSize || 0)) return;

  let pageUrl = '';
  try {
    const tab = await chrome.tabs.get(details.tabId);
    pageUrl = tab?.url || '';
  } catch {}
  if (pageUrl && isExcluded(pageUrl)) return;

  const media = {
    key: mediaKey(details.url),
    url: details.url,
    mime: ct.split(';')[0],
    size,
    pageUrl,
    title: pageUrl ? hostOf(pageUrl) : '',
    ts: Date.now(),
  };
  const added = await recordMedia(details.tabId, media);
  if (!added) return;
  if (s.autoMedia) {
    await autoSendMedia(details.tabId, media, s);
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function recordMedia(tabId, media) {
  const key = `media:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  const list = stored[key] || [];
  if (list.some((m) => m.key === media.key)) return false;
  list.unshift(media);
  const trimmed = list.slice(0, 12);
  await chrome.storage.session.set({ [key]: trimmed });
  try {
    chrome.action.setBadgeBackgroundColor({ tabId, color: '#2f6fd0' });
    chrome.action.setBadgeText({ tabId, text: String(Math.min(list.length, 12)) });
    if (YOUTUBE_HOST.test(hostOf(media.pageUrl))) {
      // Informational only; no special bypass is performed.
      chrome.action.setTitle({ tabId, title: 'Smiley Download Manager — media detected' });
    }
  } catch {}
  const settings = await getSettings();
  if (settings.pagePanel !== false) {
    chrome.tabs.sendMessage(tabId, { type: 'sdm-media-found', media: trimmed }).catch(() => {});
  }
  return true;
}

async function autoSendMedia(tabId, media, s) {
  if (sentMedia.has(media.key)) return;
  sentMedia.add(media.key);
  try {
    await addToSmiley({ url: media.url, referer: media.pageUrl });
    flashBadge('↓');
  } catch (e) {
    sentMedia.delete(media.key);
    if (e.message === 'PAIR_REQUIRED') {
      notify('Pair the Smiley extension', 'Add the pairing token in the extension options to auto-download media.');
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`media:${tabId}`).catch?.(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' && changeInfo.url) {
    chrome.storage.session.remove(`media:${tabId}`).catch?.(() => {});
    try {
      chrome.action.setBadgeText({ tabId, text: '' });
    } catch {}
  }
});

/* ---------------- messaging ---------------- */

async function getConnectionStatus() {
  const s = await getSettings();
  const port = await findPort();
  if (!port) return { connected: false, port: 0, paired: false, tokenSet: !!s.token };
  if (!s.token) return { connected: true, port, paired: false, tokenSet: false };
  try {
    const data = await apiFetch('/api/status', { timeout: 4000 });
    return {
      connected: true,
      port,
      paired: true,
      tokenSet: true,
      active: data.active,
      queued: data.queued,
      totalSpeed: data.totalSpeed,
      counts: data.counts || {},
      recent: data.recent || [],
    };
  } catch (e) {
    if (e.message === 'PAIR_REQUIRED') return { connected: true, port, paired: false, tokenSet: true };
    return { connected: false, port: 0, paired: false, tokenSet: true, error: e.message };
  }
}

async function getMediaForTab(tabId) {
  const key = `media:${tabId}`;
  const stored = await chrome.storage.session.get(key);
  return stored[key] || [];
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case 'status':
        return await getConnectionStatus();
      case 'get-settings':
        return { settings: await getSettings() };
      case 'save-settings': {
        const next = { ...(await getSettings()), ...(msg.settings || {}) };
        if (typeof next.port === 'string') next.port = Number(next.port) || 6389;
        if (typeof next.token === 'string') next.token = next.token.trim();
        await chrome.storage.local.set(next);
        settingsCache = null;
        cachedPort = 0;
        return { ok: true, settings: await getSettings() };
      }
      case 'send-url': {
        const res = await addToSmiley({
          url: msg.url,
          referer: msg.referer || '',
          filename: msg.filename || '',
        });
        return { ok: true, download: res.download };
      }
      case 'send-batch': {
        const res = await addBatchToSmiley((msg.items || []).map((item) => ({ ...item })));
        return { ok: true, added: res.added, errors: res.errors };
      }
      case 'send-video': {
        const res = await addVideoToSmiley(msg.url);
        return { ok: true, started: !!res.started, dialog: !!res.dialog, title: res.title || '' };
      }
      case 'get-media':
        return { ok: true, media: await getMediaForTab(msg.tabId) };
      case 'page-media': {
        const tabId = sender?.tab?.id;
        if (tabId == null) return { ok: true, media: [], enabled: false };
        const s = await getSettings();
        return {
          ok: true,
          media: await getMediaForTab(tabId),
          enabled: s.pagePanel !== false && s.sniffer !== false,
          paired: !!s.token,
        };
      }
      case 'clear-media':
        await chrome.storage.session.remove(`media:${msg.tabId}`);
        try {
          chrome.action.setBadgeText({ tabId: msg.tabId, text: '' });
        } catch {}
        return { ok: true };
      case 'test': {
        const port = Number(msg.port) || 6389;
        const up = await ping(port, 1800);
        if (!up) return { ok: false, connected: false, error: 'No Smiley bridge on this port. Is the desktop app running?' };
        if (msg.token) {
          try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 3000);
            const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
              headers: { 'X-SDM-Token': String(msg.token) },
              signal: ctrl.signal,
            }).finally(() => clearTimeout(t));
            if (res.status === 401) return { ok: false, connected: true, error: 'Bridge found, but the token is wrong.' };
            return { ok: true, connected: true, error: '' };
          } catch {
            return { ok: false, connected: true, error: 'Bridge found, but the token check failed.' };
          }
        }
        return { ok: true, connected: true, error: '' };
      }
      case 'open-options':
        chrome.runtime.openOptionsPage();
        return { ok: true };
      default:
        return { ok: false, error: 'Unknown message' };
    }
  })().then(
    (data) => sendResponse({ ok: true, ...data }),
    (err) => sendResponse({ ok: false, error: err.message })
  );
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  const s = await getSettings();
  await chrome.storage.local.set(s);
  createMenus();
  if (!s.token) chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  createMenus();
});
