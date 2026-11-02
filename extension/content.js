'use strict';

/* Smiley Download Manager — IDM-style in-page download panel. */

(() => {
  if (window.top !== window) return;
  if (window.__smileyPanelLoaded) return;
  window.__smileyPanelLoaded = true;

  const HOST_ID = 'smiley-dm-panel-root';
  let host = null;
  let shadow = null;
  let media = [];
  let enabled = true;
  let paired = false;
  let minimized = false;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .wrap {
      font-family: "Segoe UI", Tahoma, sans-serif;
      color: #24374d;
      user-select: none;
    }
    .panel {
      width: 336px;
      background: #fff;
      border: 1px solid #b9c7d9;
      border-radius: 10px;
      box-shadow: 0 14px 38px rgba(16, 34, 60, .28);
      overflow: hidden;
    }
    .head {
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 9px 10px;
      background: linear-gradient(#ffffff, #f2f6fc);
      border-bottom: 1px solid #e2e9f3;
      cursor: move;
    }
    .head img { width: 26px; height: 26px; flex: 0 0 auto; }
    .headtext { min-width: 0; flex: 1; }
    .headtext b {
      display: block;
      font-size: 12px;
      font-weight: 700;
      color: #1c3a5e;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .headtext span {
      display: block;
      font-size: 10px;
      color: #6d8098;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .hbtns { display: flex; gap: 3px; }
    .hbtn {
      width: 22px; height: 22px;
      border: 0; border-radius: 5px;
      background: transparent; color: #64788f;
      font-size: 15px; line-height: 1; cursor: pointer;
      padding: 0;
    }
    .hbtn:hover { background: #e8eef7; color: #1c3a5e; }
    .list { max-height: 236px; overflow: auto; padding: 4px 6px; }
    .item {
      display: flex; align-items: center; gap: 8px;
      padding: 7px 6px;
      border-radius: 7px;
    }
    .item + .item { border-top: 1px solid #eef2f8; }
    .item:hover { background: #f6f9fe; }
    .glyph {
      width: 26px; height: 26px; flex: 0 0 auto;
      border-radius: 6px; background: #e9f1fd; color: #2f6fd0;
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 700;
    }
    .info { flex: 1; min-width: 0; }
    .fname {
      font-size: 11.5px; font-weight: 600; color: #23374f;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .fmeta { font-size: 10px; color: #75879c; margin-top: 1px; }
    .dl {
      flex: 0 0 auto;
      border: 1px solid #275fb3; background: #2f6fd0; color: #fff;
      font-size: 10.5px; font-weight: 600;
      padding: 5px 9px; border-radius: 5px; cursor: pointer;
    }
    .dl:hover { background: #2a64bd; }
    .dl:disabled { opacity: .65; cursor: default; }
    .dl.sent { background: #2e8c47; border-color: #26763b; }
    .dl.bad { background: #c23c3c; border-color: #a53131; }
    .foot {
      display: flex; align-items: center; gap: 6px;
      padding: 8px 10px;
      border-top: 1px solid #e6ecf5;
      background: #f8fafd;
    }
    .foot .status { flex: 1; font-size: 10px; color: #6d8098; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .allbtn {
      border: 1px solid #c6d2e2; background: #fff; color: #24405e;
      font-size: 10.5px; padding: 5px 9px; border-radius: 5px; cursor: pointer;
    }
    .allbtn:hover { background: #eef3fa; }
    .allbtn.sent { background: #e8f6ec; border-color: #8fc9a1; color: #26763b; }
    .bubble {
      width: 46px; height: 46px; border-radius: 50%;
      background: #fff; border: 1px solid #b9c7d9;
      box-shadow: 0 8px 22px rgba(16, 34, 60, .3);
      display: flex; align-items: center; justify-content: center;
      cursor: pointer; position: relative;
    }
    .bubble img { width: 30px; height: 30px; }
    .bubble .count {
      position: absolute; top: -4px; right: -4px;
      min-width: 18px; height: 18px; padding: 0 4px;
      border-radius: 9px; background: #2f6fd0; color: #fff;
      font-size: 10px; font-weight: 700; line-height: 18px; text-align: center;
      border: 2px solid #fff;
    }
    .note { padding: 6px 10px 8px; font-size: 10px; color: #a46900; background: #fff8ea; border-top: 1px solid #f3e2bd; }
    .hidden { display: none !important; }
  `;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function fmtBytes(n) {
    const v = Number(n) || 0;
    if (!v) return 'size unknown';
    if (v < 1024) return `${Math.round(v)} B`;
    const units = ['KB', 'MB', 'GB'];
    let x = v / 1024;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i++;
    }
    return `${x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2)} ${units[i]}`;
  }

  function extOf(url) {
    try {
      const p = new URL(url).pathname;
      const m = p.match(/\.([a-z0-9]{2,5})$/i);
      return m ? m[1].toLowerCase() : '';
    } catch {
      return '';
    }
  }

  function labelFor(item) {
    const mime = String(item.mime || '');
    if (/^audio\//.test(mime)) return 'Audio';
    const ext = extOf(item.url);
    if (ext && ext.length <= 5) return ext.toUpperCase();
    if (/^video\//.test(mime)) return 'Video';
    return 'Media';
  }

  function fileFor(item, index) {
    let base = '';
    try {
      const p = new URL(item.url).pathname.split('/').filter(Boolean).pop() || '';
      base = decodeURIComponent(p);
    } catch {}
    if (!base || base.length > 90) {
      const title = (document.title || 'media').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 70) || 'media';
      base = `${title}${index ? ` (${index})` : ''}`;
    }
    const ext = extOf(item.url);
    if (ext && !new RegExp(`\\.${ext}$`, 'i').test(base)) base += `.${ext}`;
    return base;
  }

  function ensureHost() {
    if (host && document.documentElement.contains(host)) return;
    host = document.getElementById(HOST_ID);
    if (host) {
      shadow = host.shadowRoot;
      return;
    }
    host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;';
    shadow = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
    }
    document.documentElement.appendChild(host);
  }

  function removeHost() {
    host?.remove();
    host = null;
    shadow = null;
  }

  function render() {
    if (!media.length || !enabled) {
      if (host) removeHost();
      minimized = false;
      return;
    }
    ensureHost();
    shadow.textContent = '';
    const wrap = el('div', 'wrap');

    if (minimized) {
      const bubble = el('div', 'bubble');
      bubble.title = 'Show Smiley downloads';
      const img = document.createElement('img');
      img.src = chrome.runtime.getURL('icons/icon48.png');
      img.alt = '';
      bubble.appendChild(img);
      bubble.appendChild(el('span', 'count', String(media.length)));
      bubble.addEventListener('click', () => {
        minimized = false;
        render();
      });
      wrap.appendChild(bubble);
      shadow.appendChild(wrap);
      return;
    }

    const panel = el('div', 'panel');

    const head = el('div', 'head');
    const logo = document.createElement('img');
    logo.src = chrome.runtime.getURL('icons/icon48.png');
    logo.alt = '';
    head.appendChild(logo);
    const headtext = el('div', 'headtext');
    headtext.appendChild(el('b', null, 'Smiley Download Manager'));
    const total = media.reduce((n, m) => n + (Number(m.size) || 0), 0);
    headtext.appendChild(
      el('span', null, `${media.length} file${media.length === 1 ? '' : 's'} found${total ? ` · ${fmtBytes(total)}` : ''}`)
    );
    head.appendChild(headtext);
    const hbtns = el('div', 'hbtns');
    const minBtn = el('button', 'hbtn', '–');
    minBtn.title = 'Minimize';
    minBtn.addEventListener('click', () => {
      minimized = true;
      render();
    });
    const closeBtn = el('button', 'hbtn', '×');
    closeBtn.title = 'Close panel';
    closeBtn.addEventListener('click', () => {
      media = [];
      removeHost();
    });
    hbtns.append(minBtn, closeBtn);
    head.appendChild(hbtns);
    panel.appendChild(head);

    const list = el('div', 'list');
    const status = el('span', 'status', paired ? 'Sends straight to Smiley' : 'Paste the pairing token in extension Options');
    media.forEach((item, index) => {
      const row = el('div', 'item');
      row.appendChild(el('div', 'glyph', '▶'));
      const info = el('div', 'info');
      const fname = fileFor(item, index);
      const nameEl = el('div', 'fname', fname);
      nameEl.title = fname;
      info.appendChild(nameEl);
      info.appendChild(el('div', 'fmeta', `${labelFor(item)} · ${fmtBytes(item.size)}`));
      row.appendChild(info);

      const btn = el('button', 'dl', 'Download');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'send-url',
            url: item.url,
            referer: item.pageUrl || location.href,
            filename: fname,
          });
          if (!res || res.ok === false) throw new Error((res && res.error) || 'Could not send');
          btn.textContent = 'Sent ✓';
          btn.classList.add('sent');
          status.textContent = 'Download added to Smiley';
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Retry';
          btn.classList.add('bad');
          status.textContent = friendlyError(e.message);
        }
      });
      row.appendChild(btn);
      list.appendChild(row);
    });
    panel.appendChild(list);

    if (!paired) panel.appendChild(el('div', 'note', 'The extension is not paired with the Smiley app yet. Open the extension Options and paste the pairing token.'));

    const foot = el('div', 'foot');
    foot.appendChild(status);
    if (media.length > 1) {
      const all = el('button', 'allbtn', 'Download all');
      all.addEventListener('click', async () => {
        all.disabled = true;
        all.textContent = 'Sending…';
        try {
          const res = await chrome.runtime.sendMessage({
            type: 'send-batch',
            items: media.map((item, index) => ({
              url: item.url,
              referer: item.pageUrl || location.href,
              filename: fileFor(item, index),
            })),
          });
          if (!res || res.ok === false) throw new Error((res && res.error) || 'Could not send');
          all.textContent = `${res.added || media.length} sent ✓`;
          all.classList.add('sent');
          status.textContent = 'Downloads added to Smiley';
        } catch (e) {
          all.disabled = false;
          all.textContent = 'Retry all';
          status.textContent = friendlyError(e.message);
        }
      });
      foot.appendChild(all);
    }
    panel.appendChild(foot);
    wrap.appendChild(panel);

    shadow.appendChild(wrap);
    makeDraggable(panel, head);
  }

  function friendlyError(message) {
    if (message === 'PAIR_REQUIRED') return 'Pair the extension with Smiley first.';
    if (message === 'BRIDGE_DOWN') return 'Smiley Download Manager is not running.';
    return message || 'Could not reach Smiley.';
  }

  function makeDraggable(panel, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const rect = host.getBoundingClientRect();
      const startX = e.clientX;
      const startY = e.clientY;
      const offX = rect.left;
      const offY = rect.top;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = `${offX}px`;
      host.style.top = `${offY}px`;
      handle.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const nx = Math.min(Math.max(4, offX + ev.clientX - startX), window.innerWidth - rect.width - 4);
        const ny = Math.min(Math.max(4, offY + ev.clientY - startY), window.innerHeight - rect.height - 4);
        host.style.left = `${nx}px`;
        host.style.top = `${ny}px`;
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
    });
  }

  function setMedia(list) {
    if (!Array.isArray(list)) return;
    media = list.filter((m) => m && /^https?:\/\//i.test(m.url));
    if (media.length) render();
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'sdm-media-found') setMedia(msg.media);
  });

  /* ---------------- YouTube player button ---------------- */

  const YT_HOST = /(^|\.)youtube\.com$|(^|\.)youtu\.be$/i;

  function onVideoPage() {
    if (!YT_HOST.test(location.hostname)) return false;
    return /^\/(watch|shorts|embed|live)\b/.test(location.pathname) || /\/[\w-]{6,}/.test(location.pathname);
  }

  function ytStyle() {
    if (document.getElementById('smiley-yt-style')) return;
    const style = document.createElement('style');
    style.id = 'smiley-yt-style';
    style.textContent = `
      #smiley-yt-download {
        display: inline-flex; align-items: center; gap: 5px;
        height: 26px; margin: 0 6px 0 2px; padding: 0 9px;
        border: 1px solid rgba(255, 255, 255, .5);
        border-radius: 14px;
        background: rgba(0, 0, 0, .55);
        color: #fff; font: 600 11px/1 "Segoe UI", Roboto, sans-serif;
        cursor: pointer; vertical-align: middle;
      }
      #smiley-yt-download:hover { background: #2f6fd0; border-color: #2f6fd0; }
      #smiley-yt-download:disabled { opacity: .7; cursor: default; }
      #smiley-yt-download img { width: 14px; height: 14px; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  let ytButton = null;
  let ytTimer = 0;

  function mountYouTubeButton() {
    if (!onVideoPage()) {
      ytButton?.remove();
      ytButton = null;
      return;
    }
    const player = document.querySelector('#movie_player.html5-video-player, #movie_player');
    if (!player) return;
    if (ytButton && player.contains(ytButton)) return;
    ytButton?.remove();
    ytStyle();

    const btn = document.createElement('button');
    btn.id = 'smiley-yt-download';
    btn.type = 'button';
    btn.title = 'Download this video with Smiley Download Manager';
    const icon = document.createElement('img');
    icon.src = chrome.runtime.getURL('icons/icon32.png');
    icon.alt = '';
    btn.append(icon, document.createTextNode('Download'));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      sendVideo();
    });

    const controls = player.querySelector('.ytp-right-controls');
    if (controls) controls.prepend(btn);
    else player.appendChild(btn);
    ytButton = btn;
  }

  function scheduleYouTubeButton() {
    clearTimeout(ytTimer);
    ytTimer = setTimeout(mountYouTubeButton, 300);
  }

  async function sendVideo() {
    if (!ytButton) return;
    const btn = ytButton;
    btn.disabled = true;
    btn.lastChild.textContent = ' Sending…';
    try {
      const res = await chrome.runtime.sendMessage({ type: 'send-video', url: location.href });
      if (!res || res.ok === false) throw new Error((res && res.error) || 'Could not send the video.');
      btn.lastChild.textContent = res.dialog ? ' Choose quality in the popup' : ' Added ✓';
      setTimeout(() => {
        btn.lastChild.textContent = ' Download';
        btn.disabled = false;
      }, 4500);
    } catch (e) {
      btn.disabled = false;
      btn.lastChild.textContent = ' Retry';
      btn.title = friendlyError(e.message);
      setTimeout(() => {
        btn.lastChild.textContent = ' Download';
        btn.title = 'Download this video with Smiley Download Manager';
      }, 4500);
    }
  }

  // The player is created after load and re-created on every SPA navigation; a short retry loop
  // is cheaper than watching YouTube's constantly-mutating DOM.
  let ytAttempts = 0;
  function retryYouTubeButton() {
    if (!onVideoPage() || ytAttempts++ > 30) return;
    mountYouTubeButton();
    if (!ytButton) setTimeout(retryYouTubeButton, 500);
  }

  document.addEventListener('yt-navigate-finish', () => {
    ytAttempts = 0;
    retryYouTubeButton();
  });
  window.addEventListener('popstate', scheduleYouTubeButton);
  window.addEventListener('loadeddata', scheduleYouTubeButton, true);
  setInterval(() => {
    if (onVideoPage() && (!ytButton || !document.contains(ytButton))) {
      ytAttempts = 0;
      retryYouTubeButton();
    }
  }, 4000);
  retryYouTubeButton();

  chrome.runtime
    .sendMessage({ type: 'page-media' })
    .then((res) => {
      if (!res || res.ok === false) return;
      enabled = res.enabled !== false;
      paired = !!res.paired;
      if (enabled) setMedia(res.media || []);
    })
    .catch(() => {});
})();
