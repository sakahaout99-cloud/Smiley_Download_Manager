'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { URL } = require('url');

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIN_SEGMENT_SIZE = 512 * 1024; // don't split below 512 KB per connection
const PART_RETRIES = 5;
const MAX_REDIRECTS = 10;
const REQUEST_TIMEOUT = 30000;
const TICK_MS = 1000;
const WRITE_FLUSH_BYTES = 512 * 1024;
const PART_SUFFIX = '.sdm-part';

const VIDEO_EXT = new Set(['mp4', 'mkv', 'avi', 'mov', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', '3gp']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aac', 'ogg', 'm4a', 'wma', 'opus']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'epub', 'csv', 'rtf', 'odt']);
const PROG_EXT = new Set(['exe', 'msi', 'msix', 'appx', 'bat', 'cmd', 'apk', 'dmg']);
const ARCH_EXT = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'iso', 'cab']);

function extensionOf(name) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(String(name || '').split(/[?#]/)[0]);
  return m ? m[1].toLowerCase() : '';
}

function categoryFor(name) {
  const ext = extensionOf(name);
  if (VIDEO_EXT.has(ext)) return 'Video';
  if (AUDIO_EXT.has(ext)) return 'Music';
  if (DOC_EXT.has(ext)) return 'Documents';
  if (PROG_EXT.has(ext)) return 'Programs';
  if (ARCH_EXT.has(ext)) return 'Compressed';
  return 'Other';
}

function sanitizeFilename(name, fallback = 'download') {
  let base = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
  if (!base) base = fallback;
  if (reserved.test(base)) base = '_' + base;
  if (base.length > 180) {
    const ext = extensionOf(base);
    const stem = ext ? base.slice(0, -(ext.length + 1)) : base;
    base = stem.slice(0, 180 - (ext ? ext.length + 1 : 0)) + (ext ? '.' + ext : '');
  }
  return base;
}

function filenameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    return sanitizeFilename(seg, 'download');
  } catch {
    return 'download';
  }
}

function parseContentDisposition(cd) {
  if (!cd) return null;
  let m = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (m) {
    try {
      return decodeURIComponent(m[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  m = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(cd);
  if (m) {
    const raw = (m[1] || m[2] || '').trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function parseContentRange(header) {
  const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(header || '');
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
}

function planParts(size, connections) {
  if (!size || size <= 0) {
    return [{ start: 0, end: null, downloaded: 0, done: false }];
  }
  const count = Math.max(1, Math.min(connections, Math.ceil(size / MIN_SEGMENT_SIZE)));
  if (count === 1) {
    return [{ start: 0, end: size - 1, downloaded: 0, done: false }];
  }
  const each = Math.ceil(size / count);
  const parts = [];
  for (let start = 0, i = 0; start < size; i++) {
    const end = Math.min(size - 1, start + each - 1);
    parts.push({ start, end, downloaded: 0, done: false });
    start = end + 1;
  }
  return parts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function buildHeaders(dl, extra = {}) {
  const headers = {
    'User-Agent': dl.userAgent || DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'identity',
    Connection: 'keep-alive',
    ...(dl.extraHeaders || {}),
    ...extra,
  };
  if (dl.referer) headers.Referer = dl.referer;
  if (dl.cookie) headers.Cookie = dl.cookie;
  return headers;
}

function makeRequest(url, { method = 'GET', headers = {}, signal } = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      return reject(new Error('Invalid URL'));
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reject(new Error('Only http:// and https:// URLs are supported'));
    }
    const mod = u.protocol === 'https:' ? https : http;
    let req;
    try {
      req = mod.request(
        u,
        { method, headers, signal, timeout: REQUEST_TIMEOUT },
        (res) => {
          const status = res.statusCode || 0;
          if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
            res.resume();
            if (redirects >= MAX_REDIRECTS) return reject(new Error('Too many redirects'));
            let next;
            try {
              next = new URL(res.headers.location, u).toString();
            } catch {
              return reject(new Error('Invalid redirect URL'));
            }
            resolve(makeRequest(next, { method, headers, signal }, redirects + 1));
            return;
          }
          res.finalUrl = u.toString();
          resolve({ req, res });
        }
      );
    } catch (e) {
      return reject(e);
    }
    req.on('timeout', () => req.destroy(new Error('Connection timed out')));
    req.on('error', reject);
    req.end();
  });
}

function downloadId() {
  return Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
}

class DownloadEngine extends EventEmitter {
  // partsDir only holds leftovers of the older per-connection part layout.
  // merger runs a kind:'merge' job (video + audio streams → one file); see main/video.js.
  constructor({ partsDir, settings = {}, merger = null }) {
    super();
    this.partsDir = partsDir;
    this.merger = merger;
    this.settings = {
      maxConcurrent: 3,
      connections: 8,
      speedLimitBytes: 0,
      defaultDir: '',
      autoCategorize: false,
      ...settings,
    };
    this.downloads = [];
    this._byId = new Map();
    this.active = new Set();
    this._tokens = 0;
    this._lastRefill = Date.now();
    this._speedTimer = null;
    this._persistTimer = null;
    this._lastPersist = 0;
    this._queue = Promise.resolve();
    this._startTicker();
  }

  setSettings(patch = {}) {
    Object.assign(this.settings, patch);
    if (this.settings.maxConcurrent < 1) this.settings.maxConcurrent = 1;
    if (this.settings.connections < 1) this.settings.connections = 1;
    this._pump();
  }

  _startTicker() {
    if (this._speedTimer) clearInterval(this._speedTimer);
    this._speedTimer = setInterval(() => this._tick(), TICK_MS);
    if (this._speedTimer.unref) this._speedTimer.unref();
  }

  _tick() {
    let total = 0;
    const now = Date.now();
    for (const dl of this.downloads) {
      if (dl.status === 'downloading' || dl.status === 'connecting') {
        const delta = Math.max(0, dl.downloaded - (dl._lastTickBytes || 0));
        const instant = delta / ((now - (dl._lastTickAt || now - TICK_MS)) / 1000);
        dl.speed = dl.speed ? Math.round(dl.speed * 0.55 + instant * 0.45) : Math.round(instant);
        if (dl.speed < 1024 && dl.status === 'connecting') dl.speed = 0;
        total += dl.speed;
      } else {
        dl.speed = 0;
      }
      dl._lastTickBytes = dl.downloaded;
      dl._lastTickAt = now;
      dl.eta = dl.speed > 0 && dl.size ? Math.max(0, Math.round((dl.size - dl.downloaded) / dl.speed)) : null;
      dl.connectionsActive = this._connectionsFor(dl);
    }
    this.totalSpeed = total;
    if (total > 0 || now - this._lastPersist > 4000) {
      if (now - this._lastPersist > 4000) {
        this._lastPersist = now;
        this.emit('persist');
      }
    }
  }

  _connectionsFor(dl) {
    if (dl.status !== 'downloading' || !dl.parts) return 0;
    return dl.parts.filter((p) => !p.done).length;
  }

  add(opts) {
    let url = String(opts.url || '').trim();
    if (!url) throw new Error('URL is required');
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error('Only http:// and https:// URLs are supported');
    }
    const filename = sanitizeFilename(opts.filename || filenameFromUrl(url));
    const dir = opts.dir || this._categoryDir(filename);
    const status = opts.status || (opts.startNow === false ? 'paused' : 'queued');
    const dl = {
      id: downloadId(),
      url,
      finalUrl: url,
      referer: opts.referer || '',
      cookie: opts.cookie || '',
      userAgent: opts.userAgent || '',
      extraHeaders: opts.extraHeaders && typeof opts.extraHeaders === 'object' ? { ...opts.extraHeaders } : {},
      filename,
      dir,
      filePath: '',
      size: Number(opts.size) > 0 ? Number(opts.size) : null,
      downloaded: 0,
      status,
      error: '',
      mime: opts.mime || '',
      etag: '',
      lastModified: '',
      resumable: true,
      parts: [],
      partCount: 0,
      speed: 0,
      eta: null,
      connectionsActive: 0,
      createdAt: Date.now(),
      completedAt: null,
      description: opts.description || '',
      // Video jobs: 'video-stream' is one track, 'merge' waits for its siblings then remuxes.
      // 'tool' rows are hidden helper downloads (resolver / FFmpeg) and 'hidden' keeps them out of the list.
      kind: opts.kind || 'file',
      role: opts.role || '',
      group: opts.group || '',
      label: opts.label || '',
      hidden: !!opts.hidden,
      merge: opts.merge && typeof opts.merge === 'object' ? { ...opts.merge } : null,
      _autoName: !opts.filename,
      _autoDir: !opts.dir,
      _runId: 0,
      _controller: null,
      _fh: null,
      _procs: [],
      _lastTickBytes: 0,
      _lastTickAt: Date.now(),
    };
    this.downloads.unshift(dl);
    this._byId.set(dl.id, dl);
    this.emit('changed');
    this._persistSoon();
    if (dl.status === 'queued') this._pump();
    return this.public(dl);
  }

  _categoryDir(filename) {
    const base = this.settings.defaultDir || path.join(process.env.USERPROFILE || process.cwd(), 'Downloads', 'Smiley Download Manager');
    if (!this.settings.autoCategorize) return base;
    return path.join(base, categoryFor(filename));
  }

  get(id) {
    return this._byId.get(id) || null;
  }

  public(dl) {
    const view = dl.kind === 'merge' ? this._mergeView(dl) : null;
    return {
      id: dl.id,
      url: dl.url,
      finalUrl: dl.finalUrl,
      referer: dl.referer,
      filename: dl.filename,
      dir: dl.dir,
      filePath: dl.filePath,
      size: view ? view.size : dl.size,
      downloaded: view ? view.downloaded : dl.downloaded,
      status: view ? view.status : dl.status,
      error: view ? view.error : dl.error,
      mime: dl.mime,
      resumable: dl.resumable,
      parts: dl.parts.length,
      connections: this.settings.connections,
      connectionsActive: view ? view.connectionsActive : dl.connectionsActive || 0,
      speed: view ? view.speed : dl.speed || 0,
      eta: view ? view.eta : dl.eta,
      createdAt: dl.createdAt,
      completedAt: dl.completedAt,
      description: dl.description,
      kind: dl.kind || 'file',
      role: dl.role || '',
      group: dl.group || '',
      label: dl.label || '',
      mergeWaiting: dl.kind === 'merge' ? !this._mergeReady(dl) : false,
      category: categoryFor(dl.filename),
    };
  }

  snapshot() {
    const downloads = this.downloads.filter((d) => !d.hidden).map((d) => this.public(d));
    return {
      downloads,
      totalSpeed: this.totalSpeed || 0,
      active: this.active.size,
      queued: downloads.filter((d) => d.status === 'queued').length,
      settings: { ...this.settings },
    };
  }

  serialize() {
    return this.downloads.map((dl) => ({
      id: dl.id,
      url: dl.url,
      finalUrl: dl.finalUrl,
      referer: dl.referer,
      cookie: dl.cookie,
      userAgent: dl.userAgent,
      extraHeaders: dl.extraHeaders || {},
      filename: dl.filename,
      dir: dl.dir,
      filePath: dl.filePath,
      size: dl.size,
      downloaded: dl.downloaded,
      status: dl.status,
      error: dl.error,
      mime: dl.mime,
      etag: dl.etag,
      lastModified: dl.lastModified,
      resumable: dl.resumable,
      parts: dl.parts,
      createdAt: dl.createdAt,
      completedAt: dl.completedAt,
      description: dl.description,
      kind: dl.kind || 'file',
      role: dl.role || '',
      group: dl.group || '',
      label: dl.label || '',
      hidden: !!dl.hidden,
      merge: dl.merge || null,
    }));
  }

  load(items) {
    if (!Array.isArray(items)) return;
    for (const raw of items) {
      if (!raw || !raw.url || !raw.id) continue;
      const dl = {
        ...raw,
        extraHeaders: raw.extraHeaders && typeof raw.extraHeaders === 'object' ? raw.extraHeaders : {},
        kind: raw.kind || 'file',
        role: raw.role || '',
        group: raw.group || '',
        label: raw.label || '',
        hidden: !!raw.hidden,
        merge: raw.merge && typeof raw.merge === 'object' ? raw.merge : null,
        parts: Array.isArray(raw.parts) ? raw.parts : [],
        speed: 0,
        eta: null,
        connectionsActive: 0,
        _runId: 0,
        _controller: null,
        _fh: null,
        _procs: [],
        _lastTickBytes: raw.downloaded || 0,
        _lastTickAt: Date.now(),
      };
      if (['downloading', 'connecting', 'queued'].includes(dl.status)) {
        dl._wasActive = true;
        dl.status = dl.kind === 'merge' ? 'queued' : 'paused';
      }
      if (dl.status === 'error' && !dl.error) dl.error = 'Download failed';
      this.downloads.push(dl);
      this._byId.set(dl.id, dl);
    }
    this.emit('changed');
  }

  async probe(url, opts = {}) {
    const probeDl = { url, referer: opts.referer, cookie: opts.cookie, userAgent: opts.userAgent };
    const headers = buildHeaders(probeDl, { Range: 'bytes=0-0' });
    const { res } = await makeRequest(url, { headers, signal: opts.signal });
    res.on('error', () => {});
    const status = res.statusCode || 0;
    let size = null;
    let resumable = false;
    if (status === 206) {
      const range = parseContentRange(res.headers['content-range']);
      if (range && range.total != null) {
        size = range.total;
        resumable = true;
      } else {
        resumable = true;
      }
    } else if (status === 200) {
      const len = Number(res.headers['content-length']);
      size = Number.isFinite(len) && len >= 0 ? len : null;
      resumable = false;
    } else if (status === 416) {
      const range = parseContentRange(res.headers['content-range'] || '');
      size = range && range.total != null ? range.total : 0;
      resumable = true;
    } else {
      res.destroy();
      throw new Error(`Server responded with HTTP ${status}`);
    }
    const filename =
      parseContentDisposition(res.headers['content-disposition']) ||
      filenameFromUrl(res.finalUrl || url);
    const info = {
      size,
      resumable,
      filename: sanitizeFilename(filename),
      mime: res.headers['content-type'] || '',
      etag: res.headers.etag || '',
      lastModified: res.headers['last-modified'] || '',
      finalUrl: res.finalUrl || url,
    };
    res.destroy();
    return info;
  }

  start(id) {
    const dl = this.get(id);
    if (!dl) return false;
    if (dl.status === 'completed') {
      if (dl.filePath && fs.existsSync(dl.filePath)) return false;
      dl.status = 'paused';
    }
    // A visible merge row stands in for its hidden tracks: retrying it retries them too.
    if (dl.kind === 'merge') {
      for (const input of this._mergeInputs(dl)) {
        if (input.status === 'paused' || input.status === 'error') this.start(input.id);
      }
    }
    if (dl.status === 'downloading' || dl.status === 'connecting' || dl.status === 'queued') return true;
    dl.error = '';
    dl.status = 'queued';
    this.emit('changed');
    this._persistSoon();
    this._pump();
    return true;
  }

  startAll() {
    for (const dl of this.downloads) {
      if (dl.status === 'paused' || dl.status === 'error') {
        dl.error = '';
        dl.status = 'queued';
      }
    }
    this.emit('changed');
    this._persistSoon();
    this._pump();
  }

  _pump() {
    // One video download is one queued job, however many hidden rows it owns. Tools get their
    // own slot so installing the resolver or FFmpeg never blocks the user's queue.
    const jobKey = (d) => (d.group ? `group:${d.group}` : d.id);
    const isTool = (d) => d.kind === 'tool';
    const busyJobs = new Set([...this.active].map((id) => this.get(id)).filter((d) => d && !isTool(d)).map(jobKey));
    let capacity = Math.max(1, this.settings.maxConcurrent) - busyJobs.size;
    // Hidden helpers go first: otherwise a helper queued behind a long list would never start.
    const queued = this.downloads
      .filter((d) => d.status === 'queued' && !this.active.has(d.id) && !(d.kind === 'merge' && !this._mergeReady(d)))
      .sort((a, b) => (a.hidden === b.hidden ? a.createdAt - b.createdAt : a.hidden ? -1 : 1));
    const startedJobs = new Set();
    for (const dl of queued) {
      if (!isTool(dl)) {
        const key = jobKey(dl);
        if (!startedJobs.has(key) && !busyJobs.has(key)) {
          if (capacity <= 0) continue;
          capacity--;
          startedJobs.add(key);
        }
      }
      this._begin(dl).catch(() => {});
    }
  }

  _mergeInputs(dl) {
    const ids = (dl.merge && Array.isArray(dl.merge.inputs) ? dl.merge.inputs : []) || [];
    return ids.map((id) => this.get(id)).filter(Boolean);
  }

  _mergeReady(dl) {
    const inputs = this._mergeInputs(dl);
    return inputs.length > 0 && inputs.every((d) => d.status === 'completed' && d.filePath);
  }

  // The one visible merge row reports its hidden tracks' combined progress and state.
  _mergeView(dl) {
    if (dl.status === 'completed') return null;
    const inputs = this._mergeInputs(dl);
    if (!inputs.length) return null;
    const failed = inputs.find((d) => d.status === 'error');
    const active = inputs.filter((d) => d.status === 'downloading' || d.status === 'connecting');
    const paused = inputs.some((d) => d.status === 'paused');
    const downloaded = inputs.reduce((n, d) => n + (d.downloaded || 0), 0);
    const size = inputs.reduce((n, d) => n + (d.size || 0), 0) || dl.size || null;
    const speed = active.reduce((n, d) => n + (d.speed || 0), 0);
    let status = dl.status;
    if (status === 'queued') status = failed ? 'error' : active.length ? 'downloading' : paused ? 'paused' : 'queued';
    return {
      status,
      error: status === 'error' ? dl.error || (failed ? failed.error : '') : '',
      downloaded,
      size,
      speed,
      eta: speed > 0 && size ? Math.max(0, Math.round((size - downloaded) / speed)) : null,
      connectionsActive: active.reduce((n, d) => n + (d.connectionsActive || 0), 0),
    };
  }

  // A merge row carries no bytes of its own: it waits for its sibling rows, then remuxes them.
  async _beginMerge(dl) {
    if (this.active.has(dl.id)) return;
    if (typeof this.merger !== 'function') {
      dl.status = 'error';
      dl.error = 'Video track merging is not available in this build.';
      this.emit('changed');
      return;
    }
    this.active.add(dl.id);
    const runId = ++dl._runId;
    dl.status = 'downloading';
    dl.error = '';
    dl._controller = new AbortController();
    this.emit('changed');
    this.emit('persist');
    try {
      const inputs = this._mergeInputs(dl);
      if (!inputs.length) throw new Error('The video parts for this download are gone. Start it again.');
      const missing = inputs.filter((d) => d.status !== 'completed' || !d.filePath || !fs.existsSync(d.filePath));
      if (missing.length) throw new Error('One part of this video never finished, so the tracks cannot be combined.');
      const out = await this.merger(dl, inputs, { signal: dl._controller.signal });
      if (dl._runId !== runId) return;
      dl.filePath = out.filePath;
      dl.size = out.size;
      dl.downloaded = out.size;
      dl.parts = [];
      dl.status = 'completed';
      dl.completedAt = Date.now();
      dl.error = '';
      dl.speed = 0;
      dl.eta = null;
      dl.connectionsActive = 0;
      this.emit('changed');
      this.emit('persist');
      this.emit('completed', this.public(dl));
    } catch (e) {
      if (dl._runId !== runId || dl.status === 'paused') return;
      dl.status = 'error';
      dl.error = e?.message || String(e);
      dl.speed = 0;
      dl.eta = null;
      this.emit('error', this.public(dl));
    } finally {
      if (dl._runId === runId) {
        this.active.delete(dl.id);
        dl.connectionsActive = 0;
        this.emit('changed');
        this.emit('persist');
        this._pump();
      }
    }
  }

  async _begin(dl) {
    if (this.active.has(dl.id)) return;
    if (dl.kind === 'merge') return this._beginMerge(dl);
    this.active.add(dl.id);
    const runId = ++dl._runId;
    dl.status = 'connecting';
    dl.error = '';
    dl._controller = new AbortController();
    this.emit('changed');
    this.emit('persist');

    try {
      const info = await this.probe(dl.finalUrl || dl.url, {
        referer: dl.referer,
        cookie: dl.cookie,
        userAgent: dl.userAgent,
        signal: dl._controller.signal,
      });
      if (dl._runId !== runId || dl.status !== 'connecting') return;

      dl.finalUrl = info.finalUrl || dl.finalUrl;
      dl.mime = info.mime || dl.mime;
      if (info.size != null) dl.size = info.size;
      dl.etag = info.etag || dl.etag;
      dl.lastModified = info.lastModified || dl.lastModified;
      dl.resumable = info.resumable;
      if (!dl.description) dl.description = dl.finalUrl;

      if (!dl.filePath) {
        if (dl._autoName && info.filename) dl.filename = sanitizeFilename(info.filename);
        dl.filename = sanitizeFilename(dl.filename || info.filename || filenameFromUrl(dl.url));
        if (dl._autoDir) dl.dir = this._categoryDir(dl.filename);
        dl.dir = dl.dir || this._categoryDir(dl.filename);
        dl.filePath = await this._allocatePath(dl.dir, dl.filename);
      }

      const hadParts = Array.isArray(dl.parts) && dl.parts.length > 0;
      let restart = !hadParts;
      if (!restart) {
        if (dl.parts.some((p) => p.downloaded > 0)) {
          if (!info.resumable) restart = true;
          else if (dl.size != null && info.size != null && dl.size !== info.size) restart = true;
          else if (dl.etag && info.etag && dl.etag !== info.etag) restart = true;
        }
        if (dl.parts.length > 1 && !info.resumable) restart = true;
        // The bytes live in the destination file now, so a resume needs that file present.
        if (!restart && !fs.existsSync(this.dataPath(dl))) restart = true;
      }

      if (restart) {
        await this._wipeData(dl);
        dl.parts = info.resumable
          ? planParts(dl.size, Math.max(1, Number(this.settings.connections) || 8))
          : [{ start: 0, end: dl.size != null ? dl.size - 1 : null, downloaded: 0, done: false }];
        dl.partCount = dl.parts.length;
        dl.downloaded = 0;
      } else if (dl.parts.every((p) => p.done)) {
        // Every part landed but the file was never renamed; finish it now.
        dl.status = 'downloading';
        dl._procs = [];
        await this._finalize(dl, runId);
        return;
      }

      dl.status = 'downloading';
      this.emit('changed');
      this.emit('persist');

      dl._fh = await this._openData(dl);

      const procs = dl.parts.map((part) => this._runPart(dl, part, runId));
      dl._procs = procs;
      const results = await Promise.allSettled(procs);
      if (dl._runId !== runId) return;

      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw failed.reason;
      if (dl.status !== 'downloading') return;
      await this._finalize(dl, runId);
    } catch (e) {
      if (dl._runId !== runId || dl.status === 'paused') return;
      dl.status = 'error';
      dl.error = this._describeError(dl, e);
      dl.speed = 0;
      dl.eta = null;
      this.emit('error', this.public(dl));
    } finally {
      if (dl._runId === runId) {
        await this._closeData(dl);
        this.active.delete(dl.id);
        dl.connectionsActive = 0;
        this.emit('changed');
        this.emit('persist');
        this._pump();
      }
    }
  }

  _describeError(dl, e) {
    const message = e?.message || String(e);
    // Stream links handed out by the resolver are signed and short lived.
    if (dl.kind === 'video-stream' && /\b(401|403)\b/.test(message)) {
      return 'The stream link expired before the transfer finished. Open the video again and start the download.';
    }
    return message;
  }

  async _allocatePath(dir, filename) {
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    const ext = extensionOf(filename);
    const stem = ext ? filename.slice(0, -(ext.length + 1)) : filename;
    let candidate = path.join(dir, filename);
    let n = 1;
    const taken = new Set(this.downloads.map((d) => (d.filePath || '').toLowerCase()).filter(Boolean));
    while (fs.existsSync(candidate) || taken.has(candidate.toLowerCase())) {
      candidate = path.join(dir, `${stem} (${n++})${ext ? '.' + ext : ''}`);
    }
    return candidate;
  }

  dataPath(dl) {
    return dl.filePath ? dl.filePath + PART_SUFFIX : '';
  }

  // Segments share one preallocated file so finishing is a rename, not a full re-copy.
  async _openData(dl) {
    await this._closeData(dl);
    const file = this.dataPath(dl);
    if (!file) throw new Error('No destination file was chosen for this download');
    await fsp.mkdir(path.dirname(file), { recursive: true });
    try {
      const created = await fsp.open(file, 'ax');
      await created.close();
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
    }
    const fh = await fsp.open(file, 'r+');
    if (dl.size && dl.resumable) await fh.truncate(dl.size).catch(() => {});
    return fh;
  }

  async _closeData(dl) {
    const fh = dl._fh;
    dl._fh = null;
    if (!fh) return;
    try {
      await fh.close();
    } catch {}
  }

  async _runPart(dl, part, runId) {
    const alive = () => dl._runId === runId && (dl.status === 'downloading' || dl.status === 'connecting');
    let attempts = 0;
    while (alive() && !part.done) {
      try {
        await this._downloadPartOnce(dl, part, runId);
        if (part.done) return;
        throw new Error('Connection closed before this part finished');
      } catch (e) {
        if (!alive()) return;
        if (e && e.name === 'AbortError') return;
        attempts++;
        if (attempts > PART_RETRIES) {
          throw new Error(e.message || 'Download failed');
        }
        this.emit('changed');
        try {
          await sleep(Math.min(8000, 500 * 2 ** attempts));
        } catch {}
      }
    }
  }

  async _takeTokens(n) {
    const limit = Number(this.settings.speedLimitBytes) || 0;
    if (!limit) return;
    for (;;) {
      const now = Date.now();
      this._tokens = Math.min(limit, this._tokens + ((now - this._lastRefill) / 1000) * limit);
      this._lastRefill = now;
      if (this._tokens >= n) {
        this._tokens -= n;
        return;
      }
      await sleep(Math.max(20, Math.min(200, ((n - this._tokens) / limit) * 1000)));
    }
  }

  async _downloadPartOnce(dl, part, runId) {
    const start = part.start + part.downloaded;
    if (part.end != null && start > part.end) {
      part.done = true;
      return;
    }
    const expected = part.end != null ? part.end - start + 1 : null;
    const rangeValue = part.end != null ? `bytes=${start}-${part.end}` : `bytes=${start}-`;
    const headers = buildHeaders(dl, { Range: rangeValue });
    const { req, res } = await makeRequest(dl.finalUrl || dl.url, {
      headers,
      signal: dl._controller?.signal,
    });
    const alive = () => dl._runId === runId && (dl.status === 'downloading' || dl.status === 'connecting');
    if (!alive()) {
      req.destroy();
      return;
    }

    const status = res.statusCode || 0;
    if (status === 416) {
      res.resume();
      if (expected === 0) {
        part.done = true;
        return;
      }
      throw new Error('Server rejected the resume range (HTTP 416)');
    }
    if (status >= 300) {
      res.resume();
      throw new Error(`Server responded with HTTP ${status}`);
    }
    let restartFromZero = false;
    if (status === 200) {
      if (dl.parts.length > 1) {
        res.resume();
        throw new Error('Server does not support resumable downloads');
      }
      // The server ignored our Range header and sent the whole file again.
      if (start > 0) restartFromZero = true;
    } else if (status === 206) {
      const cr = parseContentRange(res.headers['content-range']);
      if (cr && cr.start !== start) {
        res.resume();
        throw new Error('Server returned an unexpected byte range');
      }
    }

    const fh = dl._fh;
    if (!fh) throw new Error('The download file could not be opened');

    let committed = part.downloaded;
    let pending = [];
    let pendingLen = 0;

    if (restartFromZero) {
      committed = 0;
      if (dl.size == null) {
        const len = Number(res.headers['content-length']);
        if (Number.isFinite(len) && len > 0) {
          dl.size = len;
          part.end = len - 1;
        }
      }
    }

    const recount = () => {
      part.downloaded = committed;
      dl.downloaded = dl.parts.reduce((n, p) => n + (p.downloaded || 0), 0);
    };
    const commit = async () => {
      if (!pendingLen) return;
      const buf = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingLen);
      pending = [];
      pendingLen = 0;
      await fh.write(buf, 0, buf.length, part.start + committed);
      committed += buf.length;
      recount();
    };

    const limit = Number(this.settings.speedLimitBytes) || 0;
    let writeError = null;
    try {
      for await (const chunk of res) {
        if (!alive()) throw new Error('Paused');
        const received = committed + pendingLen;
        const remaining = part.end != null ? part.end - (part.start + received) + 1 : Infinity;
        if (remaining <= 0) break;
        const oversized = chunk.length > remaining;
        const buf = oversized ? chunk.subarray(0, remaining) : chunk;
        if (limit) await this._takeTokens(buf.length);
        if (!alive()) throw new Error('Paused');
        pending.push(buf);
        pendingLen += buf.length;
        part.downloaded = received + buf.length;
        dl.downloaded = dl.parts.reduce((n, p) => n + (p.downloaded || 0), 0);
        if (pendingLen >= WRITE_FLUSH_BYTES) await commit();
        if (oversized) break;
      }
      await commit();
    } catch (e) {
      writeError = e;
      // Whatever reached the file stays claimed; the retry resumes after it.
      try {
        await commit();
      } catch {}
    } finally {
      if (!res.destroyed) res.destroy();
      if (!req.destroyed) req.destroy();
      recount();
    }

    if (part.end != null) {
      const cap = part.end - part.start + 1;
      if (committed >= cap) {
        part.done = true;
        this.emit('changed');
        return;
      }
      if (writeError) throw writeError;
      throw new Error('Transfer interrupted, retrying');
    }

    if (writeError) throw writeError;
    part.done = true;
    dl.size = part.start + committed;
    this.emit('changed');
  }

  async _finalize(dl, runId) {
    if (dl._runId !== runId || dl.status !== 'downloading') return;
    const file = this.dataPath(dl);
    if (!file) throw new Error('No destination file was chosen for this download');
    await this._closeData(dl);
    const expected = dl.parts.reduce((n, p) => n + (p.end != null ? p.end - p.start + 1 : p.downloaded), 0);
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      throw new Error('The downloaded data is missing, retry the download');
    }
    if (st.size < expected) throw new Error(`Only ${st.size} of ${expected} bytes reached the disk`);
    if (st.size > expected) await fsp.truncate(file, expected);
    await fsp.rename(file, dl.filePath);
    const total = await fsp.stat(dl.filePath).then((s) => s.size).catch(() => expected);
    dl.size = total;
    dl.downloaded = total;
    dl.parts.forEach((p) => {
      p.done = true;
    });
    dl.status = 'completed';
    dl.completedAt = Date.now();
    dl.error = '';
    dl.speed = 0;
    dl.eta = null;
    dl.connectionsActive = 0;
    await this._wipeData(dl);
    this.emit('changed');
    this.emit('persist');
    this.emit('completed', this.public(dl));
  }

  async _wipeData(dl) {
    if (dl.filePath) {
      await fsp.unlink(this.dataPath(dl)).catch(() => {});
    }
    try {
      await fsp.rm(path.join(this.partsDir, dl.id), { recursive: true, force: true });
    } catch {}
  }

  async pause(id) {
    const dl = this.get(id);
    if (!dl) return false;
    if (!['downloading', 'connecting', 'queued'].includes(dl.status)) return false;
    // The visible row is the only handle on its hidden tracks, so pausing it pauses them too.
    if (dl.kind === 'merge') {
      for (const input of this._mergeInputs(dl)) {
        if (['downloading', 'connecting', 'queued'].includes(input.status)) await this.pause(input.id);
      }
    }
    dl.status = 'paused';
    dl.speed = 0;
    dl.eta = null;
    dl.connectionsActive = 0;
    try {
      dl._controller?.abort();
    } catch {}
    this.active.delete(dl.id);
    this.emit('changed');
    this.emit('persist');
    const procs = dl._procs || [];
    this._pump();
    await Promise.allSettled(procs);
    this.emit('changed');
    this.emit('persist');
    return true;
  }

  async pauseAll() {
    const jobs = this.downloads
      .filter((d) => ['downloading', 'connecting', 'queued'].includes(d.status))
      .map((d) => this.pause(d.id));
    await Promise.allSettled(jobs);
  }

  async remove(id, { deleteFile = false } = {}) {
    const dl = this.get(id);
    if (!dl) return false;
    const inputs = dl.kind === 'merge' ? this._mergeInputs(dl) : [];
    const wasActive = ['downloading', 'connecting', 'queued'].includes(dl.status);
    dl.status = 'removed';
    try {
      dl._controller?.abort();
    } catch {}
    this.active.delete(dl.id);
    // Drop it from the list right away so the UI never waits on stale sockets.
    this.downloads = this.downloads.filter((d) => d.id !== id);
    this._byId.delete(id);
    this.emit('changed');
    this.emit('persist');
    // The hidden tracks are internal parts of this download, so they go with it.
    for (const input of inputs) await this.remove(input.id, { deleteFile: true });
    this._pump();
    this._cleanupRemoved(dl, wasActive, deleteFile).catch(() => {});
    return true;
  }

  async _cleanupRemoved(dl, wasActive, deleteFile) {
    const procs = dl._procs || [];
    if (wasActive && procs.length) {
      await Promise.race([Promise.allSettled(procs), sleep(2500)]);
    }
    await this._closeData(dl);
    const partsDir = path.join(this.partsDir, dl.id);
    for (let i = 0; i < 10; i++) {
      await fsp.rm(partsDir, { recursive: true, force: true }).catch(() => {});
      if (!fs.existsSync(partsDir)) break;
      await sleep(350);
    }
    const work = dl.filePath ? dl.filePath + PART_SUFFIX : '';
    const legacyTmp = dl.filePath ? dl.filePath + '.sdm-tmp' : '';
    const targets = [deleteFile ? dl.filePath : null, work, legacyTmp].filter(Boolean);
    for (const target of targets) {
      for (let i = 0; i < 6; i++) {
        try {
          await fsp.unlink(target);
          break;
        } catch (e) {
          if (e && e.code === 'ENOENT') break;
          await sleep(250);
        }
      }
    }
  }

  async removeCompleted({ deleteFiles = false } = {}) {
    const finished = this.downloads.filter((d) => d.status === 'completed');
    for (const dl of finished) await this.remove(dl.id, { deleteFile: deleteFiles });
    return finished.length;
  }

  async clearAll() {
    for (const dl of [...this.downloads]) await this.remove(dl.id, { deleteFile: false });
  }

  _persistSoon() {
    this.emit('persist');
  }

  dispose() {
    clearInterval(this._speedTimer);
    this._speedTimer = null;
    for (const dl of this.downloads) {
      try {
        dl._controller?.abort();
      } catch {}
    }
  }
}

module.exports = {
  DownloadEngine,
  sanitizeFilename,
  filenameFromUrl,
  parseContentDisposition,
  parseContentRange,
  planParts,
  categoryFor,
  extensionOf,
};
