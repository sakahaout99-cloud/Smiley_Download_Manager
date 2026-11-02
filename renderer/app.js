'use strict';

/* global window, document, localStorage, navigator */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const STATUS_LABEL = {
  downloading: 'Downloading',
  connecting: 'Connecting',
  queued: 'Queued',
  paused: 'Paused',
  completed: 'Complete',
  error: 'Error',
};

const CATEGORY_ICON = {
  Video: 'video',
  Music: 'audio',
  Documents: 'doc',
  Programs: 'exe',
  Compressed: 'zip',
  Other: 'other',
};

let state = { downloads: [], settings: {}, info: {} };
let selected = new Set();
let anchorId = null;
let filter = 'all';
let search = '';
let sortKey = 'createdAt';
let sortDir = 'desc';
let rowEls = new Map();
let renderedOrder = '';
let pollBusy = false;
let toastTimers = new Map();
let graphSamples = [];
let lastSampleAt = 0;
let graphHidden = localStorage.getItem('sdm.graphHidden') === '1';
let propsId = null;
let addProbe = null;
let addProbeSeq = 0;
let addFilenameAuto = true;
let addDirAuto = true;
let localSchedule = [];
let optionsToken = '';
let activeRowId = null;
let videoPlan = null;
let videoStatus = null;
let videoPollTimer = null;

/* ---------------- helpers ---------------- */

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

function fmtSpeed(bytes) {
  return `${fmtBytes(bytes)}/s`;
}

function fmtEta(seconds) {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')} sec`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} day${d > 1 ? 's' : ''} ${h % 24} hr`;
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function progressPct(d) {
  if (d.status === 'completed') return 100;
  if (!d.size || d.size <= 0) return null;
  return Math.max(0, Math.min(100, (d.downloaded / d.size) * 100));
}

function iconFor(d) {
  return CATEGORY_ICON[d.category] || 'other';
}

function truncate(str, n) {
  const s = String(str || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

async function call(method, payload) {
  if (!window.sdm) throw new Error('Desktop bridge unavailable');
  const res = await window.sdm.call(method, payload);
  if (!res.ok) throw new Error(res.error || 'Operation failed');
  return res.data;
}

function showToast({ type = 'info', title, message = '', actions = [], timeout = 6500 }) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;

  const body = document.createElement('div');
  body.className = 't-body';
  const t = document.createElement('div');
  t.className = 't-title';
  t.textContent = title;
  body.appendChild(t);
  if (message) {
    const m = document.createElement('div');
    m.className = 't-msg';
    m.textContent = message;
    body.appendChild(m);
  }
  if (actions.length) {
    const wrap = document.createElement('div');
    wrap.className = 't-actions';
    for (const action of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 't-btn';
      b.textContent = action.label;
      b.addEventListener('click', () => {
        try {
          action.onClick();
        } finally {
          dismiss();
        }
      });
      wrap.appendChild(b);
    }
    body.appendChild(wrap);
  }
  el.appendChild(body);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 't-close';
  close.textContent = '×';
  close.title = 'Dismiss';
  el.appendChild(close);
  box.appendChild(el);

  const dismiss = () => {
    const timer = toastTimers.get(el);
    if (timer) clearTimeout(timer);
    toastTimers.delete(el);
    el.style.opacity = '0';
    el.style.transition = 'opacity .18s ease';
    setTimeout(() => el.remove(), 180);
  };
  close.addEventListener('click', dismiss);
  const timer = setTimeout(dismiss, Math.max(2500, timeout));
  toastTimers.set(el, timer);
  while (box.children.length > 4) box.firstElementChild.remove();
}

function askConfirm({ title, message, checkboxLabel = '', checked = false, okLabel = 'Delete', danger = true }) {
  return new Promise((resolve) => {
    const dlg = $('#confirmDialog');
    $('#confirmTitle').textContent = title;
    $('#confirmMessage').textContent = message;
    const extra = $('#confirmExtraWrap');
    extra.hidden = !checkboxLabel;
    $('#confirmCheckLabel').textContent = checkboxLabel;
    $('#confirmCheck').checked = checked;
    const okBtn = $('#confirmOk');
    okBtn.textContent = okLabel;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    dlg.returnValue = '';
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve({ ok: dlg.returnValue === 'ok', checked: $('#confirmCheck').checked });
    };
    dlg.addEventListener('close', onClose);
    if (!dlg.open) dlg.showModal();
  });
}

/* ---------------- state rendering ---------------- */

function redactUrlMaybe(url) {
  return url;
}

function visibleDownloads() {
  const q = search.trim().toLowerCase();
  let list = state.downloads.filter((d) => {
    if (filter === 'unfinished' && d.status === 'completed') return false;
    if (filter === 'finished' && d.status !== 'completed') return false;
    if (!['all', 'unfinished', 'finished'].includes(filter) && d.category !== filter) return false;
    if (q) {
      const hay = `${d.filename} ${d.url} ${d.description} ${STATUS_LABEL[d.status] || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  const getter = {
    filename: (d) => d.filename.toLowerCase(),
    size: (d) => d.size || 0,
    status: (d) => d.status,
    eta: (d) => (d.eta == null ? Number.POSITIVE_INFINITY : d.eta),
    speed: (d) => d.speed || 0,
    progress: (d) => progressPct(d) ?? -1,
    createdAt: (d) => d.createdAt,
  }[sortKey] || ((d) => d.createdAt);
  list = list.sort((a, b) => {
    const va = getter(a);
    const vb = getter(b);
    let cmp;
    if (typeof va === 'string' || typeof vb === 'string') cmp = String(va).localeCompare(String(vb));
    else cmp = va - vb;
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return list;
}

function updateCounts() {
  const ds = state.downloads;
  const counts = {
    all: ds.length,
    unfinished: ds.filter((d) => d.status !== 'completed').length,
    finished: ds.filter((d) => d.status === 'completed').length,
    Video: 0,
    Music: 0,
    Documents: 0,
    Programs: 0,
    Compressed: 0,
    Other: 0,
  };
  for (const d of ds) {
    if (counts[d.category] != null) counts[d.category]++;
  }
  for (const [key, value] of Object.entries(counts)) {
    const el = $(`#cnt-${key}`);
    if (el) el.textContent = String(value);
  }
  const active = ds.filter((d) => ['downloading', 'connecting'].includes(d.status)).length;
  const queued = ds.filter((d) => d.status === 'queued').length;
  const done = counts.finished;
  const stats = $('#quickStats');
  stats.textContent = '';
  const entries = [
    ['active', active, 'active'],
    ['queued', queued, 'queued'],
    ['done', done, 'finished'],
  ];
  for (const [, value, label] of entries) {
    const span = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = String(value);
    span.appendChild(b);
    span.appendChild(document.createTextNode(` ${label}`));
    stats.appendChild(span);
  }
}

function selectionSummary() {
  return state.downloads.filter((d) => selected.has(d.id));
}

function activeSelection() {
  const sel = selectionSummary();
  if (sel.length) return sel;
  const id = activeRowId || anchorId;
  const d = id ? state.downloads.find((x) => x.id === id) : null;
  if (!d) return [];
  selected = new Set([d.id]);
  anchorId = d.id;
  updateSelectionClasses();
  return [d];
}

function updateToolbar() {
  const sel = selectionSummary();
  const canStart = sel.some((d) => ['paused', 'error'].includes(d.status));
  const canPause = sel.some((d) => ['downloading', 'connecting', 'queued'].includes(d.status));
  $('#tbStart').disabled = !canStart;
  $('#tbPause').disabled = !canPause;
  $('#tbDelete').disabled = sel.length === 0;
}

function updateSelectionClasses() {
  for (const [id, tr] of rowEls) {
    tr.classList.toggle('selected', selected.has(id));
    if (tr._c?.check) tr._c.check.checked = selected.has(id);
  }
  const all = $('#checkAll');
  if (all) {
    const visible = visibleDownloads();
    const selectedVisible = visible.filter((d) => selected.has(d.id)).length;
    all.checked = visible.length > 0 && selectedVisible === visible.length;
    all.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  }
  updateToolbar();
}

function updateStatusBar() {
  const ds = state.downloads;
  const active = ds.filter((d) => ['downloading', 'connecting'].includes(d.status));
  const queued = ds.filter((d) => d.status === 'queued').length;
  const errors = ds.filter((d) => d.status === 'error').length;
  const dot = $('#sbDot');
  dot.classList.toggle('active', active.length > 0);
  let text;
  if (active.length) {
    text = `${active.length} download${active.length > 1 ? 's' : ''} in progress`;
    if (queued) text += ` · ${queued} queued`;
    if (errors) text += ` · ${errors} failed`;
  } else if (selected.size) {
    text = `${selected.size} selected`;
  } else if (errors) {
    text = `${errors} download${errors > 1 ? 's' : ''} failed — select and press Start to retry`;
  } else {
    text = 'Ready';
  }
  $('#sbText').textContent = text;
  $('#sbSpeed').textContent = fmtSpeed(state.totalSpeed || 0);
  const conns = ds.reduce((n, d) => n + (d.connectionsActive || 0), 0);
  const connEl = $('#sbConn');
  connEl.textContent = `${conns} connection${conns === 1 ? '' : 's'}`;
  const ver = state.info?.version || '1.0.0';
  $('#sbVersion').textContent = `Smiley Download Manager ${ver}`;
}

function listTitleForFilter() {
  if (filter === 'all') return 'All Downloads';
  if (filter === 'unfinished') return 'Unfinished Downloads';
  if (filter === 'finished') return 'Finished Downloads';
  return filter;
}

function makeRow(d) {
  const id = d.id;
  const tr = document.createElement('tr');
  tr.dataset.id = id;

  const tdCheck = document.createElement('td');
  tdCheck.className = 'cell-check';
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.title = 'Select this download';
  check.checked = selected.has(d.id);
  check.addEventListener('click', (e) => e.stopPropagation());
  check.addEventListener('change', () => {
    if (check.checked) selected.add(d.id);
    else selected.delete(d.id);
    anchorId = d.id;
    activeRowId = d.id;
    updateSelectionClasses();
    updateStatusBar();
  });
  tdCheck.appendChild(check);

  const tdName = document.createElement('td');
  const fc = document.createElement('div');
  fc.className = 'filecell';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'ficon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-file-${iconFor(d)}`);
  svg.appendChild(use);
  const name = document.createElement('span');
  name.className = 'fname';
  name.title = 'Click to see download details';
  name.addEventListener('click', (e) => {
    e.stopPropagation();
    select(id, e);
    openProps(id);
  });
  fc.appendChild(svg);
  fc.appendChild(name);
  tdName.appendChild(fc);

  const tdSize = document.createElement('td');
  tdSize.className = 'num cell-size';
  const tdStatus = document.createElement('td');
  const status = document.createElement('span');
  status.className = 'status';
  tdStatus.appendChild(status);
  const tdEta = document.createElement('td');
  tdEta.className = 'cell-eta';
  const tdRate = document.createElement('td');
  tdRate.className = 'num cell-rate';
  const tdProg = document.createElement('td');
  const pc = document.createElement('div');
  pc.className = 'progress-cell';
  const track = document.createElement('div');
  track.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  track.appendChild(fill);
  const pct = document.createElement('span');
  pct.className = 'pct';
  pc.appendChild(track);
  pc.appendChild(pct);
  tdProg.appendChild(pc);
  const tdDate = document.createElement('td');
  tdDate.className = 'cell-date';

  tr.append(tdCheck, tdName, tdSize, tdStatus, tdEta, tdRate, tdProg, tdDate);
  tr._c = { check, name, iconUse: use, size: tdSize, status, eta: tdEta, rate: tdRate, fill, pct, track, date: tdDate };

  tr.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    select(id, e);
  });
  tr.addEventListener('dblclick', () => onRowDoubleClick(id));
  tr.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!selected.has(id)) {
      selected = new Set([id]);
      anchorId = id;
      updateSelectionClasses();
    }
    showContextMenu(e.clientX, e.clientY);
  });

  updateRow(tr, d);
  return tr;
}

function updateRow(tr, d) {
  const c = tr._c;
  c.check.checked = selected.has(d.id);
  c.name.textContent = d.filename;
  c.name.title = `${d.url}${d.error ? `\n${d.error}` : ''}`;
  c.iconUse.setAttribute('href', `#i-file-${iconFor(d)}`);

  c.size.textContent = d.size ? fmtBytes(d.size) : d.downloaded ? `${fmtBytes(d.downloaded)} ?` : '—';
  c.size.title = d.size ? `${fmtBytes(d.downloaded)} of ${fmtBytes(d.size)}` : 'Size unknown';

  c.status.className = `status status-${d.status}`;
  c.status.textContent = STATUS_LABEL[d.status] || d.status;
  c.status.title = d.error || '';

  c.eta.textContent = d.status === 'downloading' ? fmtEta(d.eta) : d.status === 'connecting' ? '…' : '—';
  c.rate.textContent = ['downloading', 'connecting'].includes(d.status) && d.speed ? fmtSpeed(d.speed) : '—';

  const pct = progressPct(d);
  const cls = d.status === 'completed' ? 'complete' : d.status === 'paused' ? 'paused' : d.status === 'error' ? 'error' : '';
  c.fill.className = `progress-fill ${cls}`.trim();
  if (pct == null && ['downloading', 'connecting'].includes(d.status)) {
    c.fill.classList.add('indeterminate');
    c.fill.style.width = '100%';
    c.pct.textContent = d.downloaded ? fmtBytes(d.downloaded) : '';
  } else {
    const value = pct == null ? 0 : pct;
    c.fill.style.width = `${value.toFixed(1)}%`;
    c.pct.textContent = pct == null ? '—' : `${value < 10 ? value.toFixed(1) : Math.round(value)}%`;
  }

  c.date.textContent = fmtDate(d.createdAt);
  c.date.title = d.completedAt ? `Completed ${fmtDate(d.completedAt)}` : '';
  tr.classList.toggle('selected', selected.has(d.id));
}

function rebuildRows(list) {
  const tbody = $('#rows');
  rowEls.clear();
  const frag = document.createDocumentFragment();
  for (const d of list) {
    const tr = makeRow(d);
    rowEls.set(d.id, tr);
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
  renderedOrder = list.map((d) => d.id).join('|');
}

function updateRows(list) {
  for (const d of list) {
    const tr = rowEls.get(d.id);
    if (tr) updateRow(tr, d);
  }
}

function updateSortIndicators() {
  $$('#grid thead th').forEach((th) => {
    const ind = th.querySelector('.sort-ind');
    if (!ind) return;
    ind.textContent = th.dataset.sort === sortKey ? (sortDir === 'asc' ? '▲' : '▼') : '';
  });
}

function render() {
  updateCounts();
  const list = visibleDownloads();
  const order = list.map((d) => d.id).join('|');
  if (order !== renderedOrder) rebuildRows(list);
  else updateRows(list);
  $('#emptyState').classList.toggle('show', list.length === 0);
  $('#listTitle').textContent = listTitleForFilter();
  $('#listCount').textContent = `${list.length} item${list.length === 1 ? '' : 's'}`;
  if (!selected.size && activeRowId) activeRowId = null;
  updateSelectionClasses();
  updateStatusBar();
  updateSortIndicators();
  updateMenuState();
  if (propsId && $('#propsDialog').open) {
    const d = state.downloads.find((x) => x.id === propsId);
    if (d) updatePropsDialog(d);
    else $('#propsDialog').close();
  }
  drawSpeedGraph();
}

function updateMenuState() {
  const clip = $('#menuClipboard');
  if (clip) clip.textContent = state.settings?.watchClipboard ? 'Monitor clipboard ✓' : 'Monitor clipboard';
  const graph = $('#menuGraph');
  if (graph) graph.textContent = graphHidden ? 'Show speed graph' : 'Hide speed graph';
  $('#speedCard').classList.toggle('hidden', graphHidden);
}

/* ---------------- speed graph ---------------- */

function sampleGraph(now) {
  if (now - lastSampleAt < 450) return;
  lastSampleAt = now;
  graphSamples.push(Math.max(0, Number(state.totalSpeed) || 0));
  if (graphSamples.length > 80) graphSamples.shift();
}

function drawSpeedGraph() {
  const canvas = $('#speedGraph');
  if (!canvas) return;
  const now = Date.now();
  sampleGraph(now);
  if (graphHidden) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 180;
  const h = canvas.clientHeight || 76;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const g = canvas.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  g.strokeStyle = '#edf2f9';
  g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    const y = (h * i) / 4 + 0.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(w, y);
    g.stroke();
  }

  const samples = graphSamples.length ? graphSamples : [0];
  const peak = Math.max(1, ...samples);
  const peakEl = $('#speedPeak');
  if (peakEl) peakEl.textContent = `Peak ${fmtSpeed(peak === 1 && !graphSamples.some((v) => v > 0) ? 0 : peak)}`;
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const avgEl = $('#speedAvg');
  if (avgEl) avgEl.textContent = `Avg ${fmtSpeed(avg)}`;
  const headEl = $('#speedNow');
  if (headEl) headEl.textContent = fmtSpeed(state.totalSpeed || 0);

  if (samples.length < 2) return;
  const step = w / (samples.length - 1);
  const yFor = (v) => h - 4 - (v / peak) * (h - 10);
  const points = samples.map((v, i) => [i * step, yFor(v)]);

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(47, 111, 208, .30)');
  grad.addColorStop(1, 'rgba(47, 111, 208, .02)');
  g.beginPath();
  g.moveTo(0, h);
  for (const [x, y] of points) g.lineTo(x, y);
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = grad;
  g.fill();

  g.beginPath();
  points.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.strokeStyle = '#2f6fd0';
  g.lineWidth = 1.7;
  g.lineJoin = 'round';
  g.stroke();

  const last = points[points.length - 1];
  g.beginPath();
  g.arc(last[0], last[1], 2.4, 0, Math.PI * 2);
  g.fillStyle = '#2f6fd0';
  g.fill();
}

/* ---------------- selection ---------------- */

function select(id, e) {
  const list = visibleDownloads();
  if (e.shiftKey && anchorId) {
    const ids = list.map((d) => d.id);
    const from = ids.indexOf(anchorId);
    const to = ids.indexOf(id);
    if (from >= 0 && to >= 0) {
      selected = new Set(ids.slice(Math.min(from, to), Math.max(from, to) + 1));
    }
  } else if (e.ctrlKey || e.metaKey) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    anchorId = id;
  } else {
    selected = new Set([id]);
    anchorId = id;
  }
  activeRowId = id;
  updateSelectionClasses();
  updateStatusBar();
}

function moveSelection(delta) {
  const list = visibleDownloads();
  if (!list.length) return;
  let idx = list.findIndex((d) => selected.has(d.id) && d.id === anchorId);
  if (idx < 0) idx = list.findIndex((d) => selected.has(d.id));
  if (idx < 0) idx = 0;
  else idx = Math.max(0, Math.min(list.length - 1, idx + delta));
  const d = list[idx];
  selected = new Set([d.id]);
  anchorId = d.id;
  activeRowId = d.id;
  updateSelectionClasses();
  const tr = rowEls.get(d.id);
  tr?.scrollIntoView({ block: 'nearest' });
  updateStatusBar();
}

function focusRow(id) {
  selected = new Set([id]);
  anchorId = id;
  activeRowId = id;
  updateSelectionClasses();
  rowEls.get(id)?.scrollIntoView({ block: 'nearest' });
}

/* ---------------- actions ---------------- */

async function refresh() {
  if (pollBusy) return;
  pollBusy = true;
  try {
    const data = await call('getState');
    state = data;
    const ids = new Set(state.downloads.map((d) => d.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    if (anchorId && !ids.has(anchorId)) anchorId = null;
    render();
  } catch (e) {
    $('#sbText').textContent = `Engine unavailable: ${e.message}`;
  } finally {
    pollBusy = false;
  }
}

async function pauseAll() {
  try {
    await call('pauseAll');
    showToast({ type: 'info', title: 'All downloads paused' });
    refresh();
  } catch (e) {
    showToast({ type: 'error', title: 'Could not pause', message: e.message });
  }
}

async function startAll() {
  try {
    await call('startAll');
    refresh();
  } catch (e) {
    showToast({ type: 'error', title: 'Could not start', message: e.message });
  }
}

async function startSelected() {
  const items = activeSelection();
  if (!items.length) return;
  try {
    for (const d of items) {
      if (['paused', 'error'].includes(d.status)) await call('start', { id: d.id });
    }
    refresh();
  } catch (e) {
    showToast({ type: 'error', title: 'Could not start download', message: e.message });
  }
}

async function pauseSelected() {
  const items = activeSelection();
  if (!items.length) return;
  try {
    for (const d of items) {
      if (['downloading', 'connecting', 'queued'].includes(d.status)) await call('pause', { id: d.id });
    }
    refresh();
  } catch (e) {
    showToast({ type: 'error', title: 'Could not pause download', message: e.message });
  }
}

async function confirmRemove(deleteFileDefault = false) {
  const items = activeSelection();
  if (!items.length) return;
  const n = items.length;
  const label = n === 1 ? items[0].filename : `${n} downloads`;
  const { ok, checked } = await askConfirm({
    title: n === 1 ? 'Remove this download?' : `Remove ${n} downloads?`,
    message: n === 1 ? label : 'The selected items will be removed from the list.',
    checkboxLabel: 'Also delete the downloaded file(s) from disk',
    checked: deleteFileDefault,
    okLabel: 'Remove',
  });
  if (!ok) return;
  try {
    for (const d of items) await call('remove', { id: d.id, deleteFile: checked });
    selected.clear();
    anchorId = null;
    refresh();
  } catch (e) {
    showToast({ type: 'error', title: 'Could not remove', message: e.message });
  }
}

async function openSelectedFile() {
  const d = state.downloads.find((x) => x.id === (anchorId || activeRowId)) || selectionSummary()[0];
  if (!d) return;
  try {
    await call('openFile', { id: d.id });
  } catch (e) {
    showToast({ type: 'error', title: 'Cannot open file', message: e.message });
  }
}

async function openSelectedFolder() {
  const d = state.downloads.find((x) => x.id === (anchorId || activeRowId)) || selectionSummary()[0];
  if (!d) return;
  await openFolderFor(d.id);
}

async function openFolderFor(id) {
  if (!id) return;
  try {
    await call('openFolder', { id });
  } catch (e) {
    showToast({ type: 'error', title: 'Cannot open folder', message: e.message });
  }
}

function onRowDoubleClick(id) {
  const d = state.downloads.find((x) => x.id === id);
  if (!d) return;
  if (d.status === 'completed') {
    call('openFile', { id: d.id }).catch((e) => {
      showToast({ type: 'error', title: 'Cannot open file', message: e.message });
      openProps(d.id);
    });
  } else {
    openProps(d.id);
  }
}

async function toggleSelectedPause() {
  const items = selectionSummary();
  const active = items.filter((d) => ['downloading', 'connecting', 'queued'].includes(d.status));
  if (active.length) await pauseSelected();
  else await startSelected();
}

async function removeCompleted() {
  const count = state.downloads.filter((d) => d.status === 'completed').length;
  if (!count) {
    showToast({ type: 'info', title: 'No completed downloads', message: 'Nothing to clear right now.' });
    return;
  }
  const { ok } = await askConfirm({
    title: 'Clear completed downloads?',
    message: `${count} finished item${count > 1 ? 's' : ''} will be removed from the list. Files stay on disk.`,
    okLabel: 'Clear list',
    danger: false,
  });
  if (!ok) return;
  try {
    await call('removeCompleted', { deleteFiles: false });
    selected.clear();
    refresh();
  } catch (e) {
    showToast({ type: 'error', title: 'Could not clear list', message: e.message });
  }
}

/* ---------------- context menu ---------------- */

function hideContextMenu() {
  $('#ctxMenu').classList.remove('show');
}

function showContextMenu(x, y) {
  const items = selectionSummary();
  if (!items.length) return;
  const one = items.length === 1 ? items[0] : null;
  const menu = $('#ctxMenu');
  menu.textContent = '';

  const addItem = (label, shortcut, handler, disabled = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (shortcut) {
      const s = document.createElement('span');
      s.className = 'sc';
      s.textContent = shortcut;
      b.appendChild(s);
    }
    b.disabled = disabled;
    b.addEventListener('click', () => {
      hideContextMenu();
      handler();
    });
    menu.appendChild(b);
  };
  const sep = () => {
    const d = document.createElement('div');
    d.className = 'sep';
    menu.appendChild(d);
  };

  if (one) {
    addItem('Open file', 'Enter', openSelectedFile, one.status !== 'completed');
    addItem('Open containing folder', '', openSelectedFolder);
    sep();
  }
  if (items.some((d) => ['paused', 'error'].includes(d.status))) addItem('Start / Resume', '', startSelected);
  if (items.some((d) => ['downloading', 'connecting', 'queued'].includes(d.status))) addItem('Pause', '', pauseSelected);
  sep();
  addItem('Copy URL', '', () => {
    const urls = items.map((d) => d.url).join('\n');
    call('copyText', { text: urls }).catch(() => {});
  });
  if (one) addItem('Copy file path', '', () => call('copyText', { text: one.filePath || one.url }).catch(() => {}));
  sep();
  if (one) addItem('Properties', 'Alt+Enter', () => openProps(one.id));
  addItem(items.length > 1 ? `Remove ${items.length} downloads` : 'Remove from list', 'Del', () => confirmRemove(false));
  addItem(items.length > 1 ? 'Delete files from disk…' : 'Delete file from disk…', 'Shift+Del', () => confirmRemove(true));

  menu.classList.add('show');
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 6);
  const top = Math.min(y, window.innerHeight - rect.height - 6);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${Math.max(4, top)}px`;
}

/* ---------------- Add dialog ---------------- */

function openAddDialog(prefill = {}) {
  const dlg = $('#addDialog');
  addProbe = null;
  addProbeSeq++;
  addFilenameAuto = true;
  addDirAuto = true;
  $('#addForm').reset();
  $('#addUrl').value = prefill.url || '';
  $('#addFilename').value = '';
  $('#addDir').value = prefill.dir || state.settings.defaultDir || state.info.defaultDir || '';
  $('#addDesc').value = '';
  $('#addProbeNote').className = 'field-note';
  $('#addProbeNote').textContent = 'File name and size are detected automatically.';
  $('#addBadges').textContent = '';
  $('#addOk').disabled = false;
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $('#addUrl').focus(), 30);
  if (prefill.url) scheduleAddProbe(150);
}

let addProbeTimer = null;
function scheduleAddProbe(delay = 600) {
  clearTimeout(addProbeTimer);
  addProbeTimer = setTimeout(() => probeAddUrl(false), delay);
}

async function probeAddUrl(manual = true) {
  const url = $('#addUrl').value.trim();
  const note = $('#addProbeNote');
  const badges = $('#addBadges');
  if (!url) {
    note.className = 'field-note error';
    note.textContent = 'Enter a web address first.';
    return;
  }
  if (!/^https?:\/\//i.test(url) && !/^[\w.-]+\.[a-z]{2,}\//i.test(url)) {
    if (manual) {
      note.className = 'field-note error';
      note.textContent = 'That does not look like an http(s) link.';
    }
    return;
  }
  const seq = ++addProbeSeq;
  note.className = 'field-note';
  note.textContent = 'Checking link…';
  badges.textContent = '';
  if (manual) $('#addFetch').disabled = true;
  try {
    const info = await call('probeUrl', { url });
    if (seq !== addProbeSeq) return;
    addProbe = info;
    note.className = 'field-note good';
    note.textContent = info.resumable
      ? 'Link looks good · resumable · multi-connection download available.'
      : 'Link looks good · server does not support resume, single connection.';
    if (addFilenameAuto && info.filename) $('#addFilename').value = info.filename;
    if (addDirAuto && info.suggestedDir) $('#addDir').value = info.suggestedDir;
    const chips = [];
    chips.push([info.size != null ? fmtBytes(info.size) : 'Size unknown', 'good']);
    chips.push([info.resumable ? 'Resumable' : 'No resume', info.resumable ? 'good' : 'warn']);
    if (info.category) chips.push([info.category, '']);
    if (info.mime) chips.push([truncate(info.mime.split(';')[0], 26), '']);
    badges.textContent = '';
    for (const [text, cls] of chips) {
      const span = document.createElement('span');
      span.className = `badge ${cls}`.trim();
      span.textContent = text;
      badges.appendChild(span);
    }
  } catch (e) {
    if (seq !== addProbeSeq) return;
    addProbe = null;
    note.className = 'field-note error';
    note.textContent = `Could not check the link: ${e.message}. You can still try downloading it.`;
  } finally {
    if (manual) $('#addFetch').disabled = false;
  }
}

async function submitAdd(ev) {
  ev.preventDefault();
  const url = $('#addUrl').value.trim();
  const note = $('#addProbeNote');
  if (!url) {
    note.className = 'field-note error';
    note.textContent = 'Enter a URL.';
    $('#addUrl').focus();
    return;
  }
  const startNow = $('#addForm').querySelector('input[name="startMode"]:checked')?.value !== 'later';
  const payload = {
    url,
    dir: $('#addDir').value.trim() || undefined,
    filename: $('#addFilename').value.trim() || undefined,
    description: $('#addDesc').value.trim() || undefined,
    startNow,
  };
  $('#addOk').disabled = true;
  try {
    const dl = await call('addUrl', payload);
    $('#addDialog').close();
    focusRow(dl.id);
    showToast({
      type: 'success',
      title: startNow ? 'Download queued' : 'Added as paused',
      message: dl.filename,
      actions: [{ label: 'Open list', onClick: () => { filter = 'all'; syncFilterUI(); render(); } }],
    });
    refresh();
  } catch (e) {
    note.className = 'field-note error';
    note.textContent = e.message;
  } finally {
    $('#addOk').disabled = false;
  }
}

/* ---------------- Batch dialog ---------------- */

function openBatchDialog() {
  $('#batchForm').reset();
  $('#batchDir').value = state.settings.defaultDir || '';
  $('#batchStart').checked = true;
  $('#batchNote').textContent = '';
  $('#batchNote').className = 'field-note';
  const dlg = $('#batchDialog');
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $('#batchUrls').focus(), 30);
}

async function submitBatch(ev) {
  ev.preventDefault();
  const urls = $('#batchUrls')
    .value.split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const note = $('#batchNote');
  if (!urls.length) {
    note.className = 'field-note error';
    note.textContent = 'Add at least one URL.';
    return;
  }
  try {
    const res = await call('addBatch', {
      urls,
      dir: $('#batchDir').value.trim() || undefined,
      startNow: $('#batchStart').checked,
    });
    $('#batchDialog').close();
    showToast({
      type: res.added ? 'success' : 'error',
      title: `${res.added} download${res.added === 1 ? '' : 's'} added`,
      message: res.errors?.length ? `${res.errors.length} link(s) were skipped.` : '',
    });
    refresh();
  } catch (e) {
    note.className = 'field-note error';
    note.textContent = e.message;
  }
}

/* ---------------- Properties ---------------- */

function openProps(id) {
  const d = state.downloads.find((x) => x.id === id);
  if (!d) return;
  propsId = id;
  updatePropsDialog(d);
  const dlg = $('#propsDialog');
  if (!dlg.open) dlg.showModal();
}

function updatePropsDialog(d) {
  $('#propsName').textContent = d.filename;
  $('#propsName').title = d.filename;
  const iconUse = $('#propsIcon use');
  if (iconUse) iconUse.setAttribute('href', `#i-file-${iconFor(d)}`);

  const status = $('#propsStatus');
  status.className = `status status-${d.status}`;
  status.textContent = STATUS_LABEL[d.status] || d.status;
  const active = ['downloading', 'connecting'].includes(d.status);
  $('#propsRate').textContent = active && d.speed ? fmtSpeed(d.speed) : '';
  $('#propsEta').textContent = active && d.eta ? `· ${fmtEta(d.eta)}` : '';

  const pct = progressPct(d);
  const fill = $('#propsFill');
  fill.className = 'progress-fill';
  if (d.status === 'completed') fill.classList.add('complete');
  else if (d.status === 'paused') fill.classList.add('paused');
  else if (d.status === 'error') fill.classList.add('error');
  if (pct == null && ['downloading', 'connecting'].includes(d.status)) {
    fill.classList.add('indeterminate');
    fill.style.width = '100%';
  } else {
    fill.classList.remove('indeterminate');
    fill.style.width = `${(pct == null ? 0 : pct).toFixed(1)}%`;
  }
  $('#propsPct').textContent = pct == null ? '—' : `${pct < 10 ? pct.toFixed(1) : Math.round(pct)}%`;
  $('#propsBytes').textContent = d.size
    ? `${fmtBytes(d.downloaded)} of ${fmtBytes(d.size)}`
    : `${fmtBytes(d.downloaded)} downloaded`;
  $('#propsConns').textContent = `${d.connectionsActive || 0} of ${d.connections || 0} connections`;

  $('#propsUrl').value = d.url || '';

  const list = $('#propsList');
  list.textContent = '';
  const rows = [
    ['Save folder', d.dir],
    ['File path', d.filePath || '—'],
    ['Final address', d.finalUrl && d.finalUrl !== d.url ? d.finalUrl : '—'],
    ['Referer', d.referer || '—'],
    ['Description', d.description || '—'],
    ['Connections', `${d.connectionsActive || 0} active · ${d.parts || 0} part(s)`],
    ['Resumable', d.resumable ? 'Yes' : 'No'],
    ['File type', d.mime || '—'],
    ['Added', fmtDate(d.createdAt)],
    ['Completed', d.completedAt ? fmtDate(d.completedAt) : '—'],
  ];
  if (d.error) rows.push(['Last error', d.error]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dd.title = v;
    list.append(dt, dd);
  }

  $('#propsOpenFile').disabled = d.status !== 'completed';
  const pauseBtn = $('#propsPause');
  const running = ['downloading', 'connecting', 'queued'].includes(d.status);
  pauseBtn.textContent = running ? 'Pause' : d.status === 'completed' ? 'Pause' : 'Resume';
  pauseBtn.disabled = d.status === 'completed';
}

/* ---------------- video ---------------- */

function fmtDuration(total) {
  const s = Math.round(Number(total) || 0);
  if (s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

function videoSafeName(title) {
  return String(title || 'video')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'video';
}

function openVideoUrlDialog(prefill = '') {
  const dlg = $('#videoUrlDialog');
  $('#videoUrl').value = prefill || '';
  const note = $('#videoUrlNote');
  note.className = 'field-note';
  note.textContent = 'Smiley asks the resolver which qualities are available.';
  $('#videoUrlOk').disabled = false;
  if (!dlg.open) dlg.showModal();
  $('#videoUrl').focus();
}

async function submitVideoUrl(ev) {
  ev.preventDefault();
  const url = $('#videoUrl').value.trim();
  if (!url) return;
  const note = $('#videoUrlNote');
  const ok = $('#videoUrlOk');
  note.className = 'field-note';
  note.textContent = 'Asking the resolver… this can take a few seconds.';
  ok.disabled = true;
  try {
    const data = await call('videoInfo', { url });
    $('#videoUrlDialog').close();
    showVideoPlan(data);
  } catch (e) {
    note.className = 'field-note error';
    note.textContent = e.message;
  } finally {
    ok.disabled = false;
  }
}

function showVideoPlan({ token, plan, dir, ffmpegInstalled = true }) {
  videoPlan = { token, plan, dir, ffmpegInstalled };
  $('#videoTitle').textContent = plan.title || 'Download video';
  const bits = [];
  if (plan.channel) bits.push(plan.channel);
  if (plan.duration) bits.push(fmtDuration(plan.duration));
  if (plan.picks.length) bits.push(`${plan.picks.length} qualities`);
  $('#videoSub').textContent = bits.join(' · ') || 'Choose a quality to download.';

  const meta = $('#videoMeta');
  meta.textContent = '';
  const ico = document.createElement('div');
  ico.className = 'vm-ico';
  ico.innerHTML = '<svg><use href="#i-file-video"/></svg>';
  const txt = document.createElement('div');
  txt.className = 'vm-txt';
  const title = document.createElement('div');
  title.className = 'vm-title';
  title.textContent = plan.title || plan.webpageUrl || '';
  title.title = title.textContent;
  const sub = document.createElement('div');
  sub.className = 'vm-sub';
  sub.textContent = plan.isLive ? 'Live stream — not downloadable' : plan.channel || plan.webpageUrl || '';
  txt.append(title, sub);
  meta.append(ico, txt);

  const list = $('#videoQualities');
  list.textContent = '';
  const note = $('#videoNote');
  note.className = 'field-note';
  const okBtn = $('#videoOk');

  if (!plan.picks.length) {
    note.className = 'field-note error';
    note.textContent = plan.blockedReason || 'No downloadable quality was found for this video.';
    okBtn.disabled = true;
  } else {
    okBtn.disabled = plan.isLive;
    note.textContent = plan.isLive ? 'Live and premiering streams cannot be downloaded.' : '';
    if (!plan.isLive && ffmpegInstalled === false) {
      note.className = 'field-note warn';
      note.textContent =
        'FFmpeg is not installed, so qualities that pair a video track with an audio track cannot be finished. Install it in Options → Video, or choose a single-file quality.';
    }
    const preferred =
      (ffmpegInstalled === false ? plan.picks.find((p) => !p.merge) : null) ||
      plan.picks.find((p) => p.recommended) ||
      plan.picks[0];
    for (const pick of plan.picks) {
      const row = document.createElement('label');
      row.className = 'quality-row';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'videoPick';
      radio.value = pick.key;
      radio.checked = pick.key === preferred.key;
      row.classList.toggle('active', radio.checked);
      radio.addEventListener('change', () => {
        $$('#videoQualities .quality-row').forEach((r) => r.classList.toggle('active', r.contains(radio)));
      });
      const main = document.createElement('div');
      main.className = 'q-main';
      const label = document.createElement('div');
      label.className = 'q-label';
      label.textContent = pick.label;
      const detail = document.createElement('div');
      detail.className = 'q-detail';
      detail.textContent = pick.detail || (pick.audio ? 'Audio track' : '');
      main.append(label, detail);
      row.append(radio, main);
      if (pick.recommended) {
        const best = document.createElement('span');
        best.className = 'q-best';
        best.textContent = 'BEST';
        row.appendChild(best);
      }
      selectedSize(row, pick.size);
      list.appendChild(row);
    }
  }

  $('#videoFilename').value = `${videoSafeName(plan.title)}.mp4`;
  $('#videoDir').value = dir || '';
  const dlg = $('#videoDialog');
  if (!dlg.open) dlg.showModal();
}

function selectedSize(row, size) {
  if (!size) return;
  const span = document.createElement('span');
  span.className = 'q-size';
  span.textContent = fmtBytes(size);
  row.appendChild(span);
}

async function submitVideo(ev) {
  ev.preventDefault();
  if (!videoPlan) return;
  const picked = $('#videoQualities input[name="videoPick"]:checked');
  const note = $('#videoNote');
  if (!picked) {
    note.className = 'field-note error';
    note.textContent = 'Pick a quality first.';
    return;
  }
  const okBtn = $('#videoOk');
  okBtn.disabled = true;
  note.className = 'field-note';
  note.textContent = 'Adding to the download list…';
  try {
    const res = await call('videoStart', {
      token: videoPlan.token,
      pick: picked.value,
      filename: $('#videoFilename').value.trim(),
      dir: $('#videoDir').value.trim(),
    });
    $('#videoDialog').close();
    videoPlan = null;
    showToast({ type: 'success', title: 'Video added', message: res.title || '' });
    refresh();
  } catch (e) {
    note.className = 'field-note error';
    note.textContent = e.message;
  } finally {
    okBtn.disabled = false;
  }
}

function setStatusDot(node, ok) {
  node.className = `dot ${ok ? 'ok' : 'bad'}`;
}

function renderVideoOptions() {
  const st = videoStatus;
  const helper = st?.helper || {};
  const ffmpeg = st?.ffmpeg || {};
  setStatusDot($('#resolverDot'), !!helper.installed);
  $('#resolverTitle').textContent = helper.installed
    ? `Resolver ready${helper.version ? ` · ${helper.version}` : ''}`
    : 'Resolver not installed yet';
  $('#resolverSub').textContent = helper.installed
    ? 'Smiley can look up the formats this video offers.'
    : 'Install the free resolver to download videos.';
  setStatusDot($('#ffmpegDot'), !!ffmpeg.installed);
  $('#ffmpegTitle').textContent = ffmpeg.installed
    ? `FFmpeg ready${ffmpeg.version ? ` · ${ffmpeg.version}` : ''}`
    : 'FFmpeg not installed yet';
  $('#ffmpegSub').textContent = ffmpeg.installed
    ? 'Separate video and audio tracks can be combined.'
    : 'Needed only for qualities that arrive as separate tracks.';

  const install = st?.install;
  const busy = !!install && !['error', 'completed'].includes(install.status);
  $('#optInstallResolver').disabled = busy;
  $('#optInstallFfmpeg').disabled = busy;
  $('#optCancelInstall').disabled = !busy;
  const note = $('#videoInstallNote');
  note.className = 'field-note';
  if (install) {
    if (install.status === 'error') {
      note.className = 'field-note error';
      note.textContent = `Install failed: ${install.error || 'unknown error'}`;
    } else if (busy) {
      const pct = install.size ? ` · ${Math.round((install.downloaded / install.size) * 100)}%` : '';
      note.textContent = `Downloading ${install.kind === 'ffmpeg' ? 'FFmpeg' : 'the resolver'}${pct}${
        install.speed ? ` · ${fmtSpeed(install.speed)}` : ''
      }`;
    } else {
      note.textContent = 'Install finished.';
    }
  } else {
    note.textContent = '';
  }
}

async function loadVideoStatus() {
  try {
    videoStatus = await call('videoStatus');
  } catch {
    videoStatus = null;
  }
  renderVideoOptions();
}

function startVideoPoll() {
  if (videoPollTimer) return;
  videoPollTimer = setInterval(loadVideoStatus, 1200);
}

function stopVideoPoll() {
  if (videoPollTimer) clearInterval(videoPollTimer);
  videoPollTimer = null;
}

async function installVideoTool(kind) {
  const note = $('#videoInstallNote');
  try {
    const res = kind === 'ffmpeg' ? await call('videoInstallFfmpeg') : await call('videoInstallHelper');
    if (res && res.started === false) {
      note.className = 'field-note error';
      note.textContent = res.reason || 'An install is already running.';
      return;
    }
    note.className = 'field-note';
    note.textContent = 'Starting the download…';
    await loadVideoStatus();
    startVideoPoll();
  } catch (e) {
    note.className = 'field-note error';
    note.textContent = e.message;
  }
}

/* ---------------- Options ---------------- */

function switchOptionsTab(tab) {
  $$('#optionsNav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('.options-panes .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === tab));
  if (tab === 'browser') updateBridgeCard();
  if (tab === 'video') {
    loadVideoStatus();
    if (videoStatus?.install) startVideoPoll();
  }
}

function updateBridgeCard() {
  const port = state.info?.apiPort;
  $('#bridgeDot').className = `dot ${port ? 'ok' : 'bad'}`;
  $('#bridgeTitle').textContent = port ? 'Local bridge is running' : 'Local bridge is offline';
  $('#bridgeSub').textContent = port
    ? 'The Chrome / Edge extension can send downloads to Smiley.'
    : 'Enable port access or restart the app.';
  $('#optPort').textContent = port || '—';
  $('#extPathBox').textContent = state.info?.extensionDir || '';
}

function renderScheduleList() {
  const box = $('#scheduleList');
  box.textContent = '';
  if (!localSchedule.length) {
    const empty = document.createElement('div');
    empty.className = 'schedule-empty';
    empty.textContent = 'No scheduled actions. Add one below.';
    box.appendChild(empty);
    return;
  }
  const sorted = [...localSchedule].sort((a, b) => a.time.localeCompare(b.time));
  for (const task of sorted) {
    const row = document.createElement('div');
    row.className = 'schedule-row';
    const time = document.createElement('span');
    time.className = 'sched-time';
    time.textContent = task.time;
    const action = document.createElement('span');
    action.className = 'sched-action';
    action.textContent = task.action === 'start' ? 'Start all downloads' : 'Pause all downloads';
    const enabled = document.createElement('label');
    enabled.className = 'check';
    enabled.style.fontSize = '10.5px';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = task.enabled !== false;
    cb.addEventListener('change', () => {
      task.enabled = cb.checked;
    });
    enabled.append(cb, document.createTextNode('On'));
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Remove';
    del.addEventListener('click', () => {
      localSchedule = localSchedule.filter((t) => t.id !== task.id);
      renderScheduleList();
    });
    row.append(time, action, enabled, del);
    box.appendChild(row);
  }
}

async function openOptions(tab = 'general') {
  const dlg = $('#optionsDialog');
  const s = state.settings || {};
  $('#optDefaultDir').value = s.defaultDir || '';
  $('#optAutoCat').checked = !!s.autoCategorize;
  $('#optConcurrent').value = s.maxConcurrent ?? 3;
  $('#optConnections').value = s.connections ?? 16;
  $('#optSpeedLimit').value = s.speedLimitKB ?? 0;
  $('#optAutoResume').checked = s.autoResume !== false;
  $('#optCloseToTray').checked = s.closeToTray !== false;
  $('#optStartWindows').checked = !!s.startWithWindows;
  $('#optClipboard').checked = !!s.watchClipboard;
  $('#optNotify').checked = s.notifyOnComplete !== false;
  $('#optShowPopup').checked = s.showPopup !== false;
  $('#optApiPort').value = s.apiPort ?? 6389;
  $('#optVideoEnabled').checked = s.videoEnabled !== false;
  $('#optVideoAsk').checked = s.videoAskQuality !== false;
  $('#optVideoKeep').checked = !!s.videoKeepParts;
  loadVideoStatus();
  localSchedule = (s.schedule || []).map((t) => ({ ...t }));
  renderScheduleList();
  updateBridgeCard();
  const ver = state.info?.version || '1.0.0';
  $('#aboutVersion').textContent = `Version ${ver}`;
  $('#aboutMeta').textContent = `Electron ${window.sdm?.versions?.electron || '—'} · Chromium ${window.sdm?.versions?.chrome || '—'} · Data: ${state.info?.dataDir || ''}`;
  try {
    optionsToken = await call('getToken');
  } catch {
    optionsToken = 'unavailable';
  }
  $('#optToken').value = optionsToken;
  switchOptionsTab(tab);
  if (!dlg.open) dlg.showModal();
}

async function saveOptions(ev) {
  ev.preventDefault();
  const patch = {
    defaultDir: $('#optDefaultDir').value.trim(),
    autoCategorize: $('#optAutoCat').checked,
    maxConcurrent: Number($('#optConcurrent').value),
    connections: Number($('#optConnections').value),
    speedLimitKB: Number($('#optSpeedLimit').value),
    autoResume: $('#optAutoResume').checked,
    closeToTray: $('#optCloseToTray').checked,
    startWithWindows: $('#optStartWindows').checked,
    watchClipboard: $('#optClipboard').checked,
    notifyOnComplete: $('#optNotify').checked,
    showPopup: $('#optShowPopup').checked,
    apiPort: Number($('#optApiPort').value),
    videoEnabled: $('#optVideoEnabled').checked,
    videoAskQuality: $('#optVideoAsk').checked,
    videoKeepParts: $('#optVideoKeep').checked,
    schedule: localSchedule,
  };
  try {
    await call('saveSettings', patch);
    $('#optionsDialog').close();
    showToast({ type: 'success', title: 'Options saved' });
    refresh();
  } catch (e) {
    showToast({ type: 'error', title: 'Could not save options', message: e.message });
  }
}

/* ---------------- menu / actions routing ---------------- */

function syncFilterUI() {
  $$('#categoryList li[data-filter]').forEach((li) => {
    li.classList.toggle('active', li.dataset.filter === filter);
  });
}

function handleAction(action) {
  switch (action) {
    case 'add':
      openAddDialog();
      break;
    case 'batch':
      openBatchDialog();
      break;
    case 'video':
      openVideoUrlDialog();
      break;
    case 'start':
      startSelected();
      break;
    case 'pause':
      pauseSelected();
      break;
    case 'stop-all':
      pauseAll();
      break;
    case 'start-all':
      startAll();
      break;
    case 'remove':
      confirmRemove(true);
      break;
    case 'remove-file':
      confirmRemove(true);
      break;
    case 'open':
      openSelectedFile();
      break;
    case 'open-folder':
      openSelectedFolder();
      break;
    case 'properties':
      openProps(anchorId || activeRowId || [...selected][0]);
      break;
    case 'clear-completed':
      removeCompleted();
      break;
    case 'toggle-graph':
      graphHidden = !graphHidden;
      localStorage.setItem('sdm.graphHidden', graphHidden ? '1' : '0');
      render();
      break;
    case 'refresh':
      refresh();
      break;
    case 'options':
      openOptions('general');
      break;
    case 'browser-options':
    case 'extension-help':
      openOptions('browser');
      break;
    case 'scheduler-options':
      openOptions('scheduler');
      break;
    case 'about':
      openOptions('about');
      break;
    case 'toggle-clipboard':
      call('saveSettings', { watchClipboard: !state.settings.watchClipboard })
        .then(() => {
          showToast({
            type: 'info',
            title: state.settings.watchClipboard ? 'Clipboard monitoring off' : 'Clipboard monitoring on',
            message: state.settings.watchClipboard
              ? 'Smiley will stop watching for copied links.'
              : 'Copy a file link and Smiley offers to download it.',
          });
          refresh();
        })
        .catch((e) => showToast({ type: 'error', title: 'Could not change setting', message: e.message }));
      break;
    case 'open-extension':
      openExtensionFolder();
      break;
    case 'exit':
      call('quitApp').catch(() => {});
      break;
    default:
      break;
  }
}

async function openExtensionFolder() {
  try {
    await call('openExtensionFolder');
  } catch (e) {
    showToast({ type: 'error', title: 'Cannot open extension folder', message: e.message });
  }
}

/* ---------------- dialogs wiring ---------------- */

function wireDialogs() {
  $('#addForm').addEventListener('submit', submitAdd);
  $('#addCancel').addEventListener('click', () => $('#addDialog').close());
  $('#addBrowse').addEventListener('click', async () => {
    const res = await call('chooseFolder', { current: $('#addDir').value }).catch(() => null);
    if (res && !res.canceled) {
      $('#addDir').value = res.path;
      addDirAuto = false;
    }
  });
  $('#addPaste').addEventListener('click', async () => {
    try {
      const text = await call('readClipboard');
      if (text) {
        $('#addUrl').value = text.trim();
        addFilenameAuto = true;
        addDirAuto = true;
        scheduleAddProbe(150);
      }
    } catch (e) {
      showToast({ type: 'error', title: 'Clipboard unavailable', message: e.message });
    }
  });
  $('#addFetch').addEventListener('click', () => probeAddUrl(true));
  $('#addUrl').addEventListener('input', () => {
    addProbe = null;
    scheduleAddProbe(650);
  });
  $('#addFilename').addEventListener('input', () => {
    addFilenameAuto = false;
  });
  $('#addDir').addEventListener('input', () => {
    addDirAuto = false;
  });

  $('#batchForm').addEventListener('submit', submitBatch);
  $('#batchCancel').addEventListener('click', () => $('#batchDialog').close());

  $('#optionsNav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (btn) switchOptionsTab(btn.dataset.tab);
  });
  $('#optionsForm').addEventListener('submit', saveOptions);
  $('#optionsCancel').addEventListener('click', () => $('#optionsDialog').close());
  $('#optBrowse').addEventListener('click', async () => {
    const res = await call('chooseFolder', { current: $('#optDefaultDir').value }).catch(() => null);
    if (res && !res.canceled) $('#optDefaultDir').value = res.path;
  });
  $('#optCopyToken').addEventListener('click', async () => {
    await call('copyText', { text: $('#optToken').value }).catch(() => {});
    showToast({ type: 'success', title: 'Token copied', message: 'Paste it in the extension options page.' });
  });
  $('#optRegenToken').addEventListener('click', async () => {
    try {
      optionsToken = await call('regenerateToken');
      $('#optToken').value = optionsToken;
      showToast({ type: 'info', title: 'New token generated', message: 'Update the token in the browser extension.' });
    } catch (e) {
      showToast({ type: 'error', title: 'Could not reset token', message: e.message });
    }
  });
  $('#optOpenExt').addEventListener('click', openExtensionFolder);
  $('#optCopyPath').addEventListener('click', async () => {
    await call('copyText', { text: $('#extPathBox').textContent }).catch(() => {});
    showToast({ type: 'success', title: 'Extension folder path copied' });
  });
  $('#schedAdd').addEventListener('click', () => {
    const time = $('#schedTime').value || '09:00';
    const action = $('#schedAction').value;
    localSchedule.push({
      id: Math.random().toString(36).slice(2, 10),
      time,
      action,
      enabled: true,
      lastFired: '',
    });
    renderScheduleList();
  });

  $('#videoUrlForm').addEventListener('submit', submitVideoUrl);
  $('#videoUrlCancel').addEventListener('click', () => $('#videoUrlDialog').close());
  $('#videoForm').addEventListener('submit', submitVideo);
  $('#videoCancel').addEventListener('click', () => {
    $('#videoDialog').close();
    videoPlan = null;
  });
  $('#videoBrowse').addEventListener('click', async () => {
    const res = await call('chooseFolder', { current: $('#videoDir').value }).catch(() => null);
    if (res && !res.canceled) $('#videoDir').value = res.path;
  });
  $('#optInstallResolver').addEventListener('click', () => installVideoTool('yt-dlp'));
  $('#optInstallFfmpeg').addEventListener('click', () => installVideoTool('ffmpeg'));
  $('#optCancelInstall').addEventListener('click', async () => {
    try {
      await call('videoCancelInstall');
      stopVideoPoll();
      await loadVideoStatus();
    } catch (e) {
      showToast({ type: 'error', title: 'Could not cancel the install', message: e.message });
    }
  });
  $('#optionsDialog').addEventListener('close', stopVideoPoll);

  $('#propsCopyUrl').addEventListener('click', async () => {
    const d = state.downloads.find((x) => x.id === propsId);
    if (!d) return;
    await call('copyText', { text: d.url }).catch(() => {});
    showToast({ type: 'success', title: 'Download link copied' });
  });
  $('#propsCopyPath').addEventListener('click', async () => {
    const d = state.downloads.find((x) => x.id === propsId);
    if (!d) return;
    await call('copyText', { text: d.filePath || d.url }).catch(() => {});
    showToast({ type: 'success', title: 'File path copied' });
  });
  $('#propsOpenFile').addEventListener('click', async () => {
    if (!propsId) return;
    try {
      await call('openFile', { id: propsId });
    } catch (e) {
      showToast({ type: 'error', title: 'Cannot open file', message: e.message });
    }
  });
  $('#propsFolder').addEventListener('click', () => {
    if (propsId) call('openFolder', { id: propsId }).catch((e) => showToast({ type: 'error', title: 'Cannot open folder', message: e.message }));
  });
  $('#propsPause').addEventListener('click', async () => {
    const d = state.downloads.find((x) => x.id === propsId);
    if (!d) return;
    try {
      if (['downloading', 'connecting', 'queued'].includes(d.status)) await call('pause', { id: d.id });
      else await call('start', { id: d.id });
      refresh();
    } catch (e) {
      showToast({ type: 'error', title: 'Could not change state', message: e.message });
    }
  });
  $('#propsUrl').addEventListener('focus', (e) => e.target.select());
  $('#propsRemove').addEventListener('click', async () => {
    const id = propsId;
    if (!id) return;
    $('#propsDialog').close();
    selected = new Set([id]);
    anchorId = id;
    activeRowId = id;
    updateSelectionClasses();
    await confirmRemove(true);
  });
  $('#propsDialog').addEventListener('close', () => {
    propsId = null;
  });
}

/* ---------------- events / init ---------------- */

function wireMenus() {
  const menus = $$('.menu');
  const closeMenus = () => menus.forEach((m) => m.classList.remove('open'));
  for (const menu of menus) {
    const title = $('.menu-title', menu);
    title.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains('open');
      closeMenus();
      if (!wasOpen) menu.classList.add('open');
    });
    menu.addEventListener('mouseenter', () => {
      if (menus.some((m) => m.classList.contains('open'))) {
        closeMenus();
        menu.classList.add('open');
      }
    });
  }
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu')) closeMenus();
    if (!e.target.closest('.ctx-menu')) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMenus();
      hideContextMenu();
    }
  });
}

function wireActions() {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.closest('.dropdown')) {
      $$('.menu').forEach((m) => m.classList.remove('open'));
    }
    if (btn.disabled) return;
    handleAction(btn.dataset.action);
  });

  $('#checkAll').addEventListener('change', (e) => {
    const visible = visibleDownloads();
    if (e.target.checked) for (const d of visible) selected.add(d.id);
    else for (const d of visible) selected.delete(d.id);
    if (visible.length) {
      anchorId = visible[0].id;
      activeRowId = anchorId;
    }
    updateSelectionClasses();
    updateStatusBar();
  });

  $$('#grid thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      else {
        sortKey = key;
        sortDir = key === 'filename' || key === 'status' ? 'asc' : 'desc';
      }
      renderedOrder = '';
      render();
    });
  });

  $('#categoryList').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-filter]');
    if (!li) return;
    filter = li.dataset.filter;
    selected.clear();
    anchorId = null;
    syncFilterUI();
    renderedOrder = '';
    render();
  });

  $('#searchInput').addEventListener('input', (e) => {
    search = e.target.value;
    renderedOrder = '';
    render();
  });

  document.addEventListener('keydown', (e) => {
    if ($('dialog[open]')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (e.ctrlKey && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openAddDialog();
      return;
    }
    if (e.key === 'F5') {
      e.preventDefault();
      refresh();
      return;
    }
    if (inField) {
      if (e.key === 'Escape') e.target.blur();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selected = new Set(visibleDownloads().map((d) => d.id));
      anchorId = [...selected][0] || null;
      updateSelectionClasses();
      updateStatusBar();
      return;
    }
    if (e.altKey && e.key === 'Enter') {
      e.preventDefault();
      const id = anchorId || activeRowId;
      if (id) openProps(id);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
      return;
    }
    if (e.key === 'Delete') {
      if (selected.size || activeRowId) {
        e.preventDefault();
        confirmRemove(!e.shiftKey);
      }
      return;
    }
    if (e.key === ' ' && selected.size) {
      e.preventDefault();
      toggleSelectedPause();
      return;
    }
    if (e.key === 'Enter' && selected.size === 1) {
      e.preventDefault();
      openSelectedFile();
    }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    if (!text) return;
    const urls = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
    if (urls.length === 1) openAddDialog({ url: urls[0] });
    else if (urls.length > 1) {
      openBatchDialog();
      $('#batchUrls').value = urls.join('\n');
    }
  });
}

function wireEvents() {
  window.sdm?.onEvent?.(({ type, payload }) => {
    if (type === 'download-completed') {
      showToast({
        type: 'success',
        title: 'Download complete',
        message: payload?.filename || '',
        actions: [{ label: 'Open folder', onClick: () => openFolderFor(payload?.id) }],
      });
      refresh();
    } else if (type === 'download-error') {
      showToast({
        type: 'error',
        title: 'Download failed',
        message: `${payload?.filename || 'Item'}: ${payload?.error || 'unknown error'}`,
      });
      refresh();
    } else if (type === 'clipboard-url') {
      if ($('#addDialog').open) return;
      showToast({
        type: 'info',
        title: 'Download link detected',
        message: truncate(payload.url, 90),
        actions: [{ label: 'Add download', onClick: () => openAddDialog({ url: payload.url }) }],
        timeout: 9000,
      });
    } else if (type === 'bridge-activity') {
      if (payload?.type === 'add' || payload?.type === 'add-batch') {
        const item = Array.isArray(payload.payload) ? payload.payload[0] : payload.payload;
        if (item?.filename) {
          showToast({ type: 'info', title: 'Added from browser', message: item.filename });
        }
        refresh();
      }
    } else if (type === 'scheduler-fired') {
      showToast({
        type: 'info',
        title: 'Scheduler',
        message: payload.action === 'start' ? 'Queue started' : 'Queue paused',
      });
      refresh();
    } else if (type === 'focus-download') {
      refresh().then(() => {
        const id = payload?.id;
        if (id && state.downloads.some((d) => d.id === id)) {
          filter = 'all';
          syncFilterUI();
          render();
          focusRow(id);
          openProps(id);
        }
      });
    } else if (type === 'video-plan') {
      if (payload?.plan) showVideoPlan(payload);
    } else if (type === 'video-status-changed') {
      if ($('#optionsDialog').open) {
        videoStatus = payload || videoStatus;
        renderVideoOptions();
      }
    } else if (type === 'video-install-error') {
      stopVideoPoll();
      showToast({ type: 'error', title: 'Video tool install failed', message: payload || '' });
      if ($('#optionsDialog').open) loadVideoStatus();
    } else if (type === 'state-changed') {
      /* the poll loop keeps the grid fresh */
    }
  });
}

function init() {
  wireMenus();
  wireActions();
  wireDialogs();
  wireEvents();
  syncFilterUI();
  updateMenuState();
  refresh();
  setInterval(refresh, 600);
  window.addEventListener('resize', () => drawSpeedGraph());
  for (let i = 0; i < 40; i++) graphSamples.push(0);
  setTimeout(() => {
    const params = new URLSearchParams(location.search);
    if (params.get('openAdd') === '1') openAddDialog();
  }, 300);
}

document.addEventListener('DOMContentLoaded', init);
