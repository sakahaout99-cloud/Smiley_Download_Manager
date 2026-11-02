'use strict';

/* global window, document */

const $ = (sel) => document.querySelector(sel);

let current = null;
let lastCompleteAt = 0;
let busy = false;
let plan = null;
let planPick = null;
let planBusy = false;

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)} ${units[i]}`;
}

function fmtEta(sec) {
  if (sec == null || !Number.isFinite(sec) || sec <= 0) return '';
  const s = Math.round(sec);
  if (s < 60) return `${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s left`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m left`;
}

function fmtDuration(sec) {
  const s = Math.round(Number(sec) || 0);
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

async function call(method, payload) {
  const res = await window.sdm.call(method, payload);
  if (!res.ok) throw new Error(res.error || 'Operation failed');
  return res.data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function showPlanView() {
  $('#planView').hidden = false;
  $('#progressView').hidden = true;
  $('#close').title = 'Cancel this quality pick';
}

function showProgressView() {
  plan = null;
  planPick = null;
  $('#planView').hidden = true;
  $('#progressView').hidden = false;
  $('#close').title = 'Hide this popup';
}

function updatePlanNote() {
  const note = $('#planNote');
  note.className = 'plan-note';
  const picks = plan?.plan?.picks || [];
  const pick = picks.find((p) => p.key === planPick);
  if (plan?.plan?.blockedReason) {
    note.className = 'plan-note error';
    note.textContent = plan.plan.blockedReason;
  } else if (plan?.plan?.isLive) {
    note.className = 'plan-note error';
    note.textContent = 'Live and premiering streams cannot be downloaded.';
  } else if (plan?.ffmpegInstalled === false) {
    if (pick?.merge) {
      note.className = 'plan-note error';
      note.textContent = 'This quality has separate video and audio tracks and needs FFmpeg. Pick a single-file quality or install FFmpeg in Options → Video.';
    } else {
      note.className = 'plan-note warn';
      note.textContent = 'FFmpeg is not installed, so split video + audio qualities are unavailable.';
    }
  } else if (pick?.merge) {
    note.textContent = 'Video and audio arrive as separate tracks; Smiley combines them into one file.';
  } else {
    note.textContent = pick?.detail || '';
  }
  const blocked = !planPick || !!plan?.plan?.isLive || !!plan?.plan?.blockedReason || (plan?.ffmpegInstalled === false && !!pick?.merge);
  $('#planStart').disabled = blocked || planBusy;
}

function selectPlanPick(key) {
  planPick = key;
  for (const row of document.querySelectorAll('#planList .plan-row')) {
    const on = row.dataset.key === key;
    row.classList.toggle('active', on);
    row.setAttribute('aria-checked', on ? 'true' : 'false');
  }
  updatePlanNote();
}

function renderPlan(payload) {
  if (plan && payload && plan.token === payload.token) return;
  plan = payload;
  planPick = null;
  const p = payload.plan || {};
  const picks = Array.isArray(p.picks) ? p.picks : [];
  const preferred =
    (payload.ffmpegInstalled === false ? picks.find((x) => !x.merge) : null) ||
    picks.find((x) => x.recommended) ||
    picks[0] ||
    null;
  planPick = preferred?.key || null;

  $('#summary').textContent =
    [p.channel, fmtDuration(p.duration), picks.length ? `${picks.length} qualities` : ''].filter(Boolean).join(' · ') ||
    'Choose a quality';
  $('#planTitle').textContent = p.title || 'Choose a quality';
  $('#planTitle').title = p.title || '';

  const list = $('#planList');
  list.textContent = '';
  for (const pick of picks) {
    const row = el('button', 'plan-row');
    row.type = 'button';
    row.dataset.key = pick.key;
    row.setAttribute('role', 'radio');
    const dot = el('span', 'q-radio');
    const main = el('span', 'q-main');
    main.append(
      el('span', 'q-label', pick.label + (pick.audio ? ' · audio only' : '')),
      el('span', 'q-detail', pick.detail || (pick.merge ? 'Video + audio' : 'Single file'))
    );
    row.append(dot, main);
    if (pick.size) row.append(el('span', 'q-size', fmtBytes(pick.size)));
    if (pick.recommended) row.append(el('span', 'q-best', 'BEST'));
    row.addEventListener('click', () => selectPlanPick(pick.key));
    row.addEventListener('dblclick', () => startPlan());
    list.append(row);
  }

  if (!picks.length) {
    list.append(el('div', 'plan-empty', p.blockedReason || 'No downloadable quality was found for this video.'));
  }

  selectPlanPick(planPick);
  showPlanView();
}

async function startPlan() {
  if (!plan || !planPick || planBusy) return;
  const pick = (plan.plan?.picks || []).find((p) => p.key === planPick);
  if (plan.ffmpegInstalled === false && pick?.merge) return;
  planBusy = true;
  updatePlanNote();
  $('#planCancel').disabled = true;
  try {
    await call('videoStart', { token: plan.token, pick: planPick, dir: plan.dir });
    showProgressView();
    await refresh();
  } catch (e) {
    const note = $('#planNote');
    note.className = 'plan-note error';
    note.textContent = e.message;
  } finally {
    planBusy = false;
    $('#planCancel').disabled = false;
    updatePlanNote();
  }
}

function render(state) {
  if (plan) return;
  const list = Array.isArray(state.downloads) ? state.downloads : [];
  const alive = list
    .filter((d) => ['downloading', 'connecting', 'queued', 'paused', 'error'].includes(d.status))
    .sort((a, b) => b.createdAt - a.createdAt);
  const completed = list
    .filter((d) => d.status === 'completed')
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  let d = alive[0] || null;
  let showingComplete = false;
  if (!d && completed.length) {
    d = completed[0];
    if ((d.completedAt || 0) > lastCompleteAt) lastCompleteAt = d.completedAt || Date.now();
    showingComplete = true;
  }
  current = d || null;

  const active = list.filter((x) => ['downloading', 'connecting', 'queued'].includes(x.status)).length;
  const totalSpeed = Number(state.totalSpeed) || 0;
  const summary = $('#summary');
  if (active > 1) {
    summary.textContent = `${active} downloads · ${fmtBytes(totalSpeed)}/s`;
  } else if (active === 1) {
    summary.textContent = `${fmtBytes(totalSpeed)}/s`;
  } else if (alive.length) {
    summary.textContent = 'Download paused';
  } else if (showingComplete) {
    summary.textContent = 'Download complete';
  } else {
    summary.textContent = 'No active downloads';
  }

  const name = $('#name');
  const meta = $('#meta');
  const fill = $('#fill');
  const pct = $('#pct');
  const toggle = $('#toggle');
  const folder = $('#folder');
  const openFile = $('#openFile');

  fill.className = 'fill';
  if (!d) {
    name.textContent = 'No active downloads';
    meta.textContent = 'Downloads sent from your browser appear here.';
    pct.textContent = '0%';
    fill.style.width = '0%';
    toggle.disabled = true;
    toggle.hidden = false;
    toggle.textContent = 'Pause';
    folder.disabled = true;
    openFile.hidden = true;
    return;
  }

  name.textContent = d.filename;
  folder.disabled = false;
  openFile.hidden = d.status !== 'completed';

  let percent = 0;
  if (d.status === 'completed') percent = 100;
  else if (d.size) percent = Math.max(0, Math.min(100, (d.downloaded / d.size) * 100));

  const sizeText = d.size ? `${fmtBytes(d.downloaded)} of ${fmtBytes(d.size)}` : fmtBytes(d.downloaded);
  const combining = d.status === 'downloading' && d.size > 0 && d.downloaded >= d.size && !(d.speed > 0);
  if (d.status === 'downloading' || d.status === 'connecting') {
    meta.textContent = combining
      ? `Combining video and audio · ${sizeText}`
      : `${fmtBytes(d.speed || 0)}/s · ${fmtEta(d.eta)} · ${sizeText}`.replace(/ ·\s*$/, '');
  } else if (d.status === 'completed') {
    meta.textContent = `Saved · ${sizeText}`;
    fill.classList.add('done');
  } else if (d.status === 'error') {
    meta.textContent = d.error || 'Download failed';
    fill.classList.add('error');
  } else {
    meta.textContent = d.status === 'queued' ? 'Queued' : `Paused · ${sizeText}`;
  }

  fill.style.width = `${percent.toFixed(1)}%`;
  pct.textContent = `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`;

  const activeStatus = ['downloading', 'connecting', 'queued'].includes(d.status);
  toggle.hidden = d.status === 'completed';
  toggle.disabled = d.status === 'completed';
  toggle.textContent = activeStatus ? 'Pause' : d.status === 'completed' ? 'Done' : 'Resume';
  toggle.classList.toggle('warm', activeStatus);
  toggle.classList.toggle('primary', !activeStatus);
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    const state = await call('getState');
    let pending;
    try {
      pending = await call('popupVideoPlan');
    } catch {}
    if (pending && pending.token) {
      renderPlan(pending);
      return;
    }
    if (pending === null && plan) showProgressView();
    render(state);
  } catch {
    $('#summary').textContent = 'App unavailable';
  } finally {
    busy = false;
  }
}

async function toggleCurrent() {
  if (!current || !['downloading', 'connecting', 'queued', 'paused', 'error'].includes(current.status)) return;
  try {
    if (['downloading', 'connecting', 'queued'].includes(current.status)) await call('pause', { id: current.id });
    else await call('start', { id: current.id });
    await refresh();
  } catch {}
}

async function cancelPlan() {
  plan = null;
  showProgressView();
  await call('popupDismissPlan').catch(() => {});
  await call('hidePopup').catch(() => {});
}

function init() {
  $('#close').addEventListener('click', async () => {
    if (plan) {
      await cancelPlan();
      return;
    }
    call('hidePopup').catch(() => {});
  });
  $('#openApp').addEventListener('click', () => call('openMain').catch(() => {}));
  $('#file').addEventListener('click', () => {
    if (current) call('focusDownload', { id: current.id }).catch(() => {});
    else call('openMain').catch(() => {});
  });
  $('#openFile').addEventListener('click', () => {
    if (current) call('openFile', { id: current.id }).catch(() => {});
  });
  $('#folder').addEventListener('click', () => {
    if (current) call('openFolder', { id: current.id }).catch(() => {});
  });
  $('#toggle').addEventListener('click', toggleCurrent);
  $('#planCancel').addEventListener('click', cancelPlan);
  $('#planStart').addEventListener('click', startPlan);

  window.sdm.onEvent(({ type, payload }) => {
    if (type === 'video-plan') {
      if (payload) renderPlan(payload);
      else if (plan) {
        showProgressView();
        refresh();
      }
    } else if (type === 'popup-open') {
      refresh();
    }
  });

  refresh();
  setInterval(refresh, 700);
}

document.addEventListener('DOMContentLoaded', init);
