'use strict';

const $ = (id) => document.getElementById(id);

let savedSettings = {};

async function send(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res) throw new Error('The extension background worker did not respond.');
  if (res.ok === false) throw new Error(res.error || 'Request failed');
  return res;
}

function setResult(el, text, kind = '') {
  el.textContent = text;
  el.className = `result ${kind}`.trim();
}

function fillForm(s) {
  savedSettings = s || {};
  $('token').value = s.token || '';
  $('port').value = s.port || 6389;
  $('catchDownloads').checked = s.catchDownloads !== false;
  $('sniffer').checked = s.sniffer !== false;
  $('autoMedia').checked = !!s.autoMedia;
  $('pagePanel').checked = s.pagePanel !== false;
  $('minMediaSize').value = Math.max(0, Math.round((s.minMediaSize || 0) / (1024 * 1024))) || 0;
  $('excludeDomains').value = Array.isArray(s.excludeDomains) ? s.excludeDomains.join('\n') : '';
}

function collectForm() {
  return {
    token: $('token').value.trim(),
    port: Math.min(65535, Math.max(1024, Number($('port').value) || 6389)),
    catchDownloads: $('catchDownloads').checked,
    sniffer: $('sniffer').checked,
    autoMedia: $('autoMedia').checked,
    pagePanel: $('pagePanel').checked,
    minMediaSize: Math.max(0, Number($('minMediaSize').value) || 0) * 1024 * 1024,
    excludeDomains: $('excludeDomains')
      .value.split(/\r?\n/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

async function load() {
  try {
    const res = await send('get-settings');
    fillForm(res.settings);
  } catch (e) {
    setResult($('saveStatus'), e.message, 'err');
  }
}

async function save(showMessage = true) {
  try {
    const settings = collectForm();
    const res = await send('save-settings', { settings });
    savedSettings = res.settings || settings;
    if (showMessage) {
      const time = new Date().toLocaleTimeString();
      setResult($('saveStatus'), `Saved at ${time}`, 'ok');
      setTimeout(() => {
        if ($('saveStatus').textContent.startsWith('Saved')) setResult($('saveStatus'), '');
      }, 4000);
    }
    return true;
  } catch (e) {
    setResult($('saveStatus'), e.message, 'err');
    return false;
  }
}

async function test() {
  const btn = $('test');
  btn.disabled = true;
  setResult($('testResult'), 'Testing…');
  try {
    await save(false);
    const res = await send('test', {
      port: Number($('port').value) || 6389,
      token: $('token').value.trim(),
    });
    if (res.ok) setResult($('testResult'), 'Connected. Smiley is ready.', 'ok');
    else setResult($('testResult'), res.error || 'Could not connect.', 'err');
  } catch (e) {
    setResult($('testResult'), e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function wire() {
  $('save').addEventListener('click', () => save(true));
  $('test').addEventListener('click', test);
  $('toggleToken').addEventListener('click', () => {
    const input = $('token');
    input.type = input.type === 'password' ? 'text' : 'password';
    $('toggleToken').textContent = input.type === 'password' ? 'Show' : 'Hide';
  });
  $('reset').addEventListener('click', () => {
    fillForm({
      token: '',
      port: 6389,
      catchDownloads: true,
      sniffer: true,
      autoMedia: false,
      pagePanel: true,
      minMediaSize: 1024 * 1024,
      excludeDomains: [],
    });
    setResult($('saveStatus'), 'Defaults loaded — press Save to apply.');
  });
  $('openExtensions').addEventListener('click', async () => {
    const isEdge = /Edg\//.test(navigator.userAgent);
    const url = isEdge ? 'edge://extensions' : 'chrome://extensions';
    try {
      await chrome.tabs.create({ url });
      setResult($('extResult'), '', '');
    } catch {
      setResult($('extResult'), `Open this address manually: ${url}`, 'err');
    }
  });
  for (const id of ['token', 'port', 'minMediaSize']) {
    $(id).addEventListener('input', () => setResult($('saveStatus'), ''));
  }
}

load();
wire();
