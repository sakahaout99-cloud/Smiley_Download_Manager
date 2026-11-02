'use strict';

/*
 * YouTube (and other site) video support.
 *
 * Since 2026 YouTube no longer puts playable URLs anywhere a browser extension can read:
 * the page's player response carries no format `url` fields and the media itself arrives over
 * one persistent SABR connection (googlevideo.com/videoplayback?...&sabr=1) that pushes
 * segments, so there is nothing to sniff. This module therefore uses yt-dlp as a *resolver*
 * only: it asks for the format list, and Smiley's own multi-connection engine does the actual
 * transfer, which keeps pause/resume, segmented speed and the download list working as usual.
 *
 * Nothing here defeats DRM: formats marked has_drm are dropped, live streams are refused, and
 * a protected video simply reports that it cannot be downloaded.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');

const YT_DLP_ASSET = 'yt-dlp.exe';
const YT_DLP_LATEST_URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
// LGPL shared build: the user downloads it from the official project, we do not redistribute it.
const FFMPEG_ZIP_URL =
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl-shared.zip';

const YOUTUBE_HOSTS = /^(?:(?:www|m|music)\.)?(?:youtube\.com|youtu\.be)$/i;
// yt-dlp reports plain "https"/"http" here (no colon); HLS/DASH report m3u8_native, mhtml, etc.
const DIRECT_PROTOCOL = /^https?$/i;

function isYouTubeUrl(url) {
  try {
    const u = new URL(String(url));
    return YOUTUBE_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

function videoIdFromUrl(url) {
  try {
    const u = new URL(String(url));
    if (u.hostname === 'youtu.be') return u.pathname.slice(1).split('/')[0] || '';
    const v = u.searchParams.get('v');
    if (v) return v;
    const m = /\/(?:shorts|embed|live|v)\/([\w-]{6,14})/.exec(u.pathname);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

function run(cmd, args, { timeout = 120000, maxBuffer = 64 * 1024 * 1024, env } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: env || process.env });
    } catch (e) {
      return reject(e);
    }
    const chunks = [];
    const err = [];
    let size = 0;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {}
      reject(new Error('The video resolver timed out. YouTube may be slowing this request; try again.'));
    }, timeout);
    child.stdout.on('data', (b) => {
      size += b.length;
      if (size > maxBuffer) return;
      chunks.push(b);
    });
    child.stderr.on('data', (b) => err.push(b));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) return resolve(stdout);
      const text = (stderr || stdout).split('\n').filter(Boolean);
      const important = text.filter((l) => /ERROR|requested video|not available|sign in|age|drm|live/i.test(l));
      reject(new Error((important[0] || text[text.length - 1] || `resolver exited with ${code}`).trim()));
    });
    if (child.stdin) child.stdin.end();
  });
}

function pickBestAudio(audios, videoExt) {
  if (!audios.length) return null;
  const mp4ish = videoExt === 'mp4' || videoExt === 'm4v';
  const ranked = [...audios].sort((a, b) => {
    const compatA = (mp4ish && a.ext === 'm4a') || (!mp4ish && a.ext === 'webm') ? 1 : 0;
    const compatB = (mp4ish && b.ext === 'm4a') || (!mp4ish && b.ext === 'webm') ? 1 : 0;
    if (compatA !== compatB) return compatB - compatA;
    const codecA = a.acodec.startsWith('mp4a') ? 1 : 0;
    const codecB = b.acodec.startsWith('mp4a') ? 1 : 0;
    if (codecA !== codecB) return codecB - codecA;
    return (babr(b) || 0) - (babr(a) || 0);
  });
  return ranked[0];
}

function babr(f) {
  return Number(f.abr || f.tbr || 0) || 0;
}

function codecScore(f) {
  // Prefer the most broadly playable container/codec for a given resolution.
  if (f.ext === 'mp4' && /^avc1/.test(f.vcodec)) return 4;
  if (f.ext === 'mp4' && /^av01/.test(f.vcodec)) return 3;
  if (f.ext === 'webm' && /vp9/.test(f.vcodec)) return 2;
  if (f.ext === 'webm' && /vp8|av01/.test(f.vcodec)) return 1;
  return 0;
}

function groupLabel(h, fps) {
  return `${h}p${fps && fps > 30 ? fps : ''}`;
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let x = v;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return `${x >= 100 ? x.toFixed(0) : x.toFixed(1)} ${units[i]}`;
}

/**
 * Turn a yt-dlp info dictionary into the choices the dialog shows.
 * Streams our engine cannot fetch (HLS, storyboard mhtml, DRM) are dropped here.
 */
function planFromInfo(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const playable = formats.filter((f) => {
    if (!f || !f.url || !DIRECT_PROTOCOL.test(String(f.protocol || 'https'))) return false;
    if (f.has_drm) return false;
    if (!/^https?:$/.test(String(new URL(f.url).protocol))) return false;
    return true;
  });
  const drmOnly = formats.some((f) => f && f.has_drm);
  const videos = playable.filter((f) => f.vcodec && f.vcodec !== 'none');
  const audioOnly = playable.filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
  const combined = playable.filter((f) => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none');

  const picks = [];
  const sizeOf = (list) => list.reduce((n, f) => n + (Number(f.filesize || f.approx_filesize || 0) || 0), 0);

  // Highest quality first: one entry per resolution/fps band, best codec inside the band.
  const bands = new Map();
  for (const v of videos) {
    if (!v.height) continue;
    const key = groupLabel(v.height, v.fps);
    const cur = bands.get(key);
    if (!cur || codecScore(v) > codecScore(cur)) bands.set(key, v);
  }
  const ordered = [...bands.entries()].sort((a, b) => b[1].height - a[1].height || a[0].localeCompare(b[0]));

  for (const [label, video] of ordered) {
    const audio = pickBestAudio(audioOnly, video.ext);
    if (!audio) continue;
    picks.push({
      key: `pair:${video.format_id}`,
      label,
      detail: `${(video.vcodec || '').split('.')[0]} video + ${(audio.acodec || '').split('.')[0]} audio`,
      ext: video.ext === 'webm' ? 'webm' : 'mp4',
      size: sizeOf([video, audio]),
      merge: true,
      streams: [
        { role: 'video', format: video },
        { role: 'audio', format: audio },
      ],
    });
  }

  if (!picks.length && !combined.length) {
    // Rare, but some streams ship without any audio track at all.
    for (const [label, video] of ordered) {
      picks.push({
        key: `single:${video.format_id}`,
        label,
        detail: 'video only, no audio track is offered for this video',
        ext: video.ext,
        size: sizeOf([video]),
        merge: false,
        streams: [{ role: 'video', format: video }],
      });
    }
  }

  for (const c of combined.sort((a, b) => (b.height || 0) - (a.height || 0))) {
    picks.push({
      key: `single:${c.format_id}`,
      label: c.height ? groupLabel(c.height, c.fps) : 'File',
      detail: `one file, no merging (${c.ext})`,
      ext: c.ext,
      size: sizeOf([c]),
      merge: false,
      streams: [{ role: 'video', format: c }],
    });
  }

  for (const a of audioOnly.sort((x, y) => (y.ext === 'm4a' ? 1 : 0) - (x.ext === 'm4a' ? 1 : 0))) {
    if (picks.some((p) => p.key === `audio:${a.format_id}`)) continue;
    picks.push({
      key: `audio:${a.format_id}`,
      label: 'Audio only',
      detail: `${a.ext.toUpperCase()}${a.abr ? ` · ${Math.round(a.abr)}k` : ''} · ${(a.acodec || '').split('.')[0]}`,
      ext: a.ext,
      size: sizeOf([a]),
      merge: false,
      audio: true,
      streams: [{ role: 'audio', format: a }],
    });
    break; // one representative audio track is enough
  }

  const best = ordered.length ? ordered[0] : null;
  if (best && picks.length) picks[0].recommended = true;
  if (best) picks[0].label = `Best (${picks[0].label})`;

  return {
    id: info.id || videoIdFromUrl(info.webpage_url || '') || '',
    title: info.title || 'YouTube video',
    duration: Number(info.duration) || 0,
    thumbnail: info.thumbnail || '',
    channel: info.channel || info.uploader || '',
    license: info.license || '',
    ageLimit: Number(info.age_limit) || 0,
    isLive: !!info.is_live || info.live_status === 'is_live' || info.live_status === 'was_live',
    webpageUrl: info.webpage_url || '',
    drmBlocked: !playable.length && drmOnly,
    blockedReason: !playable.length
      ? drmOnly
        ? 'This video is DRM protected (paid or studio content). Smiley will not strip protection.'
        : 'YouTube served no downloadable stream for this video. It may be private, region locked, or live.'
      : '',
    picks,
  };
}

/**
 * The renderer and the browser extension only ever see this shape: keys and labels, never the
 * signed stream URLs (which expire and must not leave the main process).
 */
function summarizePlan(plan) {
  return {
    id: plan.id,
    title: plan.title,
    duration: plan.duration,
    thumbnail: plan.thumbnail,
    channel: plan.channel,
    isLive: plan.isLive,
    webpageUrl: plan.webpageUrl,
    blockedReason: plan.blockedReason,
    picks: (plan.picks || []).map((p) => ({
      key: p.key,
      label: p.label,
      detail: p.detail,
      ext: p.ext,
      size: p.size,
      merge: !!p.merge,
      audio: !!p.audio,
      recommended: !!p.recommended,
    })),
  };
}

class VideoService {
  constructor({ toolsDir, engine, settingsProvider = () => ({}), onProgressChange = () => {} }) {
    this.toolsDir = toolsDir;
    this.engine = engine;
    this.settingsProvider = settingsProvider;
    this.onProgressChange = onProgressChange;
    this.helperVersion = '';
    this.ffmpegVersion = '';
    this._probing = null;
    this._installs = new Map(); // engineId -> what to do when it lands
    this._jobs = new Map(); // engineId -> plan metadata for grouping
  }

  get helperPath() {
    const custom = String(this.settingsProvider().videoHelperPath || '').trim();
    return custom || path.join(this.toolsDir, YT_DLP_ASSET);
  }

  get ffmpegPath() {
    const custom = String(this.settingsProvider().ffmpegPath || '').trim();
    return custom || path.join(this.toolsDir, 'ffmpeg', 'bin', 'ffmpeg.exe');
  }

  async status() {
    const [helper, ffmpeg, runtime] = await Promise.all([this._checkHelper(), this._checkFfmpeg(), this._jsRuntime()]);
    return {
      helper: {
        installed: !!helper.path,
        path: helper.path || path.join(this.toolsDir, YT_DLP_ASSET),
        version: helper.version || '',
        downloadUrl: YT_DLP_LATEST_URL,
      },
      ffmpeg: {
        installed: !!ffmpeg.path,
        path: ffmpeg.path || this.ffmpegPath,
        version: ffmpeg.version || '',
        downloadUrl: FFMPEG_ZIP_URL,
      },
      jsRuntime: runtime,
      install: this.installProgress(),
    };
  }

  async hasFfmpeg() {
    return !!(await this._checkFfmpeg()).path;
  }

  // Merge inputs are deleted once the combined file lands, so their completion is not news.
  isMergeInput(id) {
    if (!id) return false;
    return this.engine.downloads.some(
      (d) => d.kind === 'merge' && Array.isArray(d.merge?.inputs) && d.merge.inputs.includes(id)
    );
  }

  async _checkHelper() {
    const p = this.helperPath;
    if (!p || !fs.existsSync(p)) {
      this.helperVersion = '';
      return { path: '', version: '' };
    }
    if (this.helperVersion) return { path: p, version: this.helperVersion };
    try {
      const out = await run(p, ['--version'], { timeout: 20000 });
      this.helperVersion = out.trim().split('\n')[0] || '';
    } catch {
      this.helperVersion = '';
    }
    return { path: p, version: this.helperVersion };
  }

  async _checkFfmpeg() {
    const candidates = [this.ffmpegPath, 'ffmpeg.exe', 'ffmpeg'];
    for (const c of candidates) {
      const abs = c === 'ffmpeg.exe' || c === 'ffmpeg' ? null : c;
      if (abs && !fs.existsSync(abs)) continue;
      const cmd = abs || c;
      try {
        const out = await run(cmd, ['-version'], { timeout: 20000 });
        const line = (out || '').split('\n')[0] || '';
        if (!/ffmpeg/i.test(line)) continue;
        this.ffmpegVersion = line.replace(/^ffmpeg version\s*/, '').split(/\s+/)[0] || '';
        return { path: abs || cmd, version: this.ffmpegVersion };
      } catch {
        continue;
      }
    }
    this.ffmpegVersion = '';
    return { path: '', version: '' };
  }

  // yt-dlp wants a JS runtime for part of YouTube extraction; report what we can find.
  async _jsRuntime() {
    const found = [];
    for (const exe of ['deno.exe', 'node.exe', 'bun.exe']) {
      for (const dir of (process.env.PATH || '').split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir.trim(), exe);
        if (fs.existsSync(p)) {
          found.push({ name: exe.replace('.exe', ''), path: p });
          break;
        }
      }
    }
    return found;
  }

  /** Resolve a watch URL into the choices to show. Slow path: a full yt-dlp extraction. */
  async resolve(url) {
    const helper = await this._checkHelper();
    if (!helper.path) throw new Error('The free video resolver is not installed yet.');
    const args = ['-J', '--no-playlist', '--no-warnings', '--no-progress', url];
    const runtime = await this._jsRuntime();
    if (runtime.length) args.splice(1, 0, '--js-runtimes', `${runtime[0].name}:${runtime[0].path}`);
    const stdout = await run(helper.path, args, { timeout: 180000 });
    const info = JSON.parse(stdout);
    return planFromInfo(info);
  }

  /** Queue the chosen pick through the download engine. Returns the visible rows. */
  async start(url, pickKey, { filename, dir, description } = {}) {
    const plan = await this.resolve(url);
    return this.startFromPlan(plan, pickKey, { filename, dir, description });
  }

  startFromPlan(plan, pickKey, { filename, dir, description } = {}) {
    if (plan.isLive) throw new Error('Live or premiering streams cannot be downloaded here.');
    if (plan.blockedReason) throw new Error(plan.blockedReason);
    const pick = plan.picks.find((p) => p.key === pickKey) || plan.picks[0];
    if (!pick) throw new Error('No downloadable format is available for this video.');
    const base = String(filename || plan.title || 'video').replace(/\.[a-z0-9]{2,5}$/i, '');
    const settings = this.settingsProvider();
    const group = `yt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const rows = [];

    if (!pick.merge) {
      const f = pick.streams[0].format;
      rows.push(
        this.engine.add({
          url: f.url,
          dir,
          filename: `${base}.${f.ext}`,
          referer: plan.webpageUrl || url,
          userAgent: (f.http_headers || {})['User-Agent'] || settings.userAgent || '',
          cookie: (f.http_headers || {})['Cookie'] || '',
          extraHeaders: extraOnly(f.http_headers),
          size: Number(f.filesize || f.approx_filesize || 0) || 0,
          kind: 'video-stream',
          group,
          label: `${plan.title} · ${pick.label}`,
          description: description || plan.webpageUrl || url,
          startNow: true,
        })
      );
      return { group, merge: null, rows, title: plan.title, pick: pick.key };
    }

    const inputs = [];
    for (const stream of pick.streams) {
      const f = stream.format;
      const row = this.engine.add({
        url: f.url,
        dir,
        filename: `${base} [${stream.role}].${f.ext}`,
        referer: plan.webpageUrl || url,
        userAgent: (f.http_headers || {})['User-Agent'] || settings.userAgent || '',
        cookie: (f.http_headers || {})['Cookie'] || '',
        extraHeaders: extraOnly(f.http_headers),
        size: Number(f.filesize || f.approx_filesize || 0) || 0,
        kind: 'video-stream',
        // The tracks are internal parts of the merge row: the list shows one download.
        hidden: true,
        group,
        role: stream.role,
        label: `${plan.title} · ${pick.label} · ${stream.role}`,
        description: `Part of “${plan.title}” (${pick.label})`,
        startNow: true,
      });
      inputs.push(row.id);
      rows.push(row);
    }
    const mergeRow = this.engine.add({
      url: plan.webpageUrl || url,
      dir,
      filename: `${base}.${pick.ext}`,
      size: pick.size || 0,
      kind: 'merge',
      group,
      label: `${plan.title} · ${pick.label}`,
      description: description || plan.webpageUrl || url,
      merge: { inputs, role: 'video+audio', deleteParts: settings.videoKeepParts !== true },
      startNow: false,
      status: 'queued',
    });
    return { group, merge: mergeRow.id, rows, mergeRow, title: plan.title, pick: pick.key };
  }

  /** The engine calls this for a kind:'merge' job once both input rows are complete. */
  async merge(dl, inputs, { signal } = {}) {
    const ffmpeg = await this._checkFfmpeg();
    if (!ffmpeg.path) {
      throw new Error(
        'This quality needs FFmpeg to combine the video and audio tracks. Install FFmpeg in Options → Video, or pick a single-file quality.'
      );
    }
    const video = inputs.find((d) => d.role === 'video') || inputs[0];
    const audio = inputs.find((d) => d.role === 'audio');
    const out = await this.engine._allocatePath(dl.dir, dl.filename);
    const args = ['-hide_banner', '-loglevel', 'error', '-y'];
    if (audio) {
      args.push('-i', video.filePath, '-i', audio.filePath, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy');
    } else {
      args.push('-i', video.filePath, '-c', 'copy');
    }
    args.push(out);
    const code = await this._spawnFfmpeg(ffmpeg.path, args, signal);
    if (code !== 0) throw new Error(`FFmpeg could not combine the tracks (exit ${code}).`);
    const st = await fsp.stat(out).catch(() => null);
    if (!st || !st.size) throw new Error('FFmpeg produced no output file.');
    return { filePath: out, size: st.size };
  }

  _spawnFfmpeg(cmd, args, signal) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn(cmd, args, { windowsHide: true });
      } catch (e) {
        return reject(e);
      }
      const err = [];
      child.stderr.on('data', (b) => err.push(b));
      const abort = () => {
        try {
          child.kill();
        } catch {}
      };
      signal?.addEventListener('abort', abort);
      child.on('error', reject);
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abort);
        if (code === 0) return resolve(0);
        const text = Buffer.concat(err).toString('utf8').split('\n').filter(Boolean).pop();
        reject(new Error(text || `FFmpeg exited with code ${code}`));
      });
    });
  }

  /** Download the resolver with Smiley's own engine so the user can see it happen. */
  async installHelper() {
    if (this._installs.size) return { started: false, reason: 'An install is already running.' };
    const helper = await this._checkHelper();
    if (helper.path) await this._retireOldHelper(helper.path);
    const dl = this.engine.add({
      url: YT_DLP_LATEST_URL,
      dir: this.toolsDir,
      filename: `${YT_DLP_ASSET}.new`,
      kind: 'tool',
      hidden: true,
      startNow: true,
      description: 'YouTube resolver (yt-dlp)',
    });
    this._installs.set(dl.id, 'yt-dlp');
    return { started: true, id: dl.id };
  }

  async _retireOldHelper(target) {
    // Keep the previous binary under a new name so a failed update cannot leave the app with none.
    try {
      await fsp.rename(target, `${target}.old`);
    } catch {}
  }

  /** Stop an in-flight resolver or FFmpeg install and delete its partial archive. */
  async cancelInstall() {
    if (!this._installs.size) return { canceled: false };
    const ids = [...this._installs.keys()];
    this._installs.clear();
    for (const id of ids) {
      const row = this.engine.get(id);
      if (!row) continue;
      await this.engine.pause(id).catch(() => {});
      await this.engine.remove(id, { deleteFile: true }).catch(() => {});
    }
    this.onProgressChange();
    return { canceled: true };
  }

  async installFfmpeg() {
    if (this._installs.size) return { started: false, reason: 'An install is already running.' };
    const dl = this.engine.add({
      url: FFMPEG_ZIP_URL,
      dir: this.toolsDir,
      filename: 'ffmpeg-download.zip',
      kind: 'tool',
      hidden: true,
      startNow: true,
      description: 'FFmpeg (needed to combine high-quality video and audio)',
    });
    this._installs.set(dl.id, 'ffmpeg');
    return { started: true, id: dl.id };
  }

  /** Called from the engine 'completed' handler; returns true when this module owned the row. */
  async onDownloadCompleted(dl) {
    if (this._installs.has(dl.id)) {
      const kind = this._installs.get(dl.id);
      this._installs.delete(dl.id);
      try {
        if (kind === 'yt-dlp') await this._finishHelperInstall(dl.filePath);
        else await this._finishFfmpegInstall(dl.filePath);
      } finally {
        await this.engine.remove(dl.id, { deleteFile: false });
        this.onProgressChange();
      }
      return { owned: true, kind };
    }
    if (dl.kind === 'merge') return { owned: true, merge: dl };
    return { owned: false };
  }

  /** After a merge row finishes, its input rows have served their purpose. */
  async cleanupMergeInputs(mergeDl) {
    const inputs = (mergeDl.merge && mergeDl.merge.inputs) || [];
    for (const id of inputs) {
      const row = this.engine.get(id);
      if (!row) continue;
      await this.engine.remove(id, { deleteFile: mergeDl.merge.deleteParts !== false });
    }
  }

  /** Progress for the hidden resolver / FFmpeg downloads, for the Options → Video tab. */
  installProgress() {
    this._pruneInstalls();
    for (const id of this._installs.keys()) {
      const row = this.engine.get(id);
      if (!row) continue;
      return {
        kind: this._installs.get(id),
        status: row.status,
        downloaded: row.downloaded || 0,
        size: row.size || 0,
        speed: row.speed || 0,
        error: row.error || '',
      };
    }
    return null;
  }

  _pruneInstalls() {
    for (const [id, kind] of [...this._installs.entries()]) {
      const row = this.engine.get(id);
      if (!row || ['error', 'completed', 'removed'].includes(row.status)) this._installs.delete(id);
    }
  }

  async _finishHelperInstall(downloaded) {
    if (!downloaded || !fs.existsSync(downloaded)) throw new Error('The resolver download did not reach the disk.');
    await stripZoneMarker(downloaded);
    const target = this.helperPath;
    await fsp.mkdir(path.dirname(target), { recursive: true });
    try {
      await fsp.unlink(target).catch(() => {});
    } catch {}
    await fsp.rename(downloaded, target);
    const stale = `${target}.old`;
    if (fs.existsSync(stale)) await fsp.unlink(stale).catch(() => {});
    this.helperVersion = '';
    await this._checkHelper();
  }

  async _finishFfmpegInstall(zipPath) {
    if (!zipPath || !fs.existsSync(zipPath)) throw new Error('The FFmpeg download did not reach the disk.');
    await stripZoneMarker(zipPath);
    const dest = path.join(this.toolsDir, 'ffmpeg');
    await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(dest, { recursive: true });
    await extractZip(zipPath, dest);
    await fsp.unlink(zipPath).catch(() => {});
    await flattenFfmpegTree(dest);
    const exe = path.join(dest, 'bin', 'ffmpeg.exe');
    if (!fs.existsSync(exe)) throw new Error('FFmpeg archive did not contain bin/ffmpeg.exe.');
    this.ffmpegVersion = '';
    await this._checkFfmpeg();
  }
}

function extraOnly(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (/^(user-agent|cookie)$/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

// Files downloaded from the internet carry an NTFS zone marker that makes Windows warn before
// running them; Smiley fetched the file itself from the official release, so the marker is dropped.
async function stripZoneMarker(file) {
  try {
    await fsp.unlink(`${file}:Zone.Identifier`);
  } catch {}
}

async function extractZip(zipPath, dest) {
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (fs.existsSync(tar)) {
    await run(tar, ['-xf', zipPath, '-C', dest], { timeout: 180000 });
    return;
  }
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  await run(
    ps,
    ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive', '-LiteralPath', zipPath, '-DestinationPath', dest],
    { timeout: 300000 }
  );
}

// The official archive wraps everything in one versioned folder, so bin/ would sit one level
// below the tools directory; move the contents up so the documented tools/ffmpeg/bin path holds.
async function flattenFfmpegTree(dest) {
  if (fs.existsSync(path.join(dest, 'bin', 'ffmpeg.exe'))) return;
  const entries = await fsp.readdir(dest).catch(() => []);
  if (entries.length !== 1) return;
  const inner = path.join(dest, entries[0]);
  const st = await fsp.stat(inner).catch(() => null);
  if (!st || !st.isDirectory()) return;
  for (const name of await fsp.readdir(inner)) {
    await fsp.rename(path.join(inner, name), path.join(dest, name));
  }
  await fsp.rm(inner, { recursive: true, force: true });
}

module.exports = {
  VideoService,
  planFromInfo,
  summarizePlan,
  isYouTubeUrl,
  videoIdFromUrl,
  fmtBytes,
  YT_DLP_LATEST_URL,
  FFMPEG_ZIP_URL,
};
