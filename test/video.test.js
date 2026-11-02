'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { planFromInfo, summarizePlan } = require('../main/video');
const { createBridge } = require('../main/api');

const INFO = {
  id: 'dQw4w9WgXcQ',
  title: 'A test video',
  duration: 213,
  channel: 'Test Channel',
  webpage_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  formats: [
    {
      format_id: '137',
      ext: 'mp4',
      height: 1080,
      fps: 30,
      vcodec: 'avc1.640028',
      acodec: 'none',
      protocol: 'https',
      url: 'https://r1.googlevideo.com/videoplayback?itag=137',
      filesize: 40_000_000,
    },
    {
      format_id: '248',
      ext: 'webm',
      height: 1080,
      fps: 30,
      vcodec: 'vp9',
      acodec: 'none',
      protocol: 'https',
      url: 'https://r1.googlevideo.com/videoplayback?itag=248',
      filesize: 38_000_000,
    },
    {
      format_id: '140',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      protocol: 'https',
      url: 'https://r1.googlevideo.com/videoplayback?itag=140',
      filesize: 3_400_000,
    },
    {
      format_id: '251',
      ext: 'webm',
      vcodec: 'none',
      acodec: 'opus',
      protocol: 'https',
      url: 'https://r1.googlevideo.com/videoplayback?itag=251',
      filesize: 3_000_000,
    },
    {
      format_id: '18',
      ext: 'mp4',
      height: 360,
      fps: 30,
      vcodec: 'avc1.42001E',
      acodec: 'mp4a.40.2',
      protocol: 'https',
      url: 'https://r1.googlevideo.com/videoplayback?itag=18',
      filesize: 9_000_000,
    },
    {
      format_id: 'hls',
      ext: 'mp4',
      height: 720,
      vcodec: 'avc1.4d401f',
      acodec: 'mp4a.40.2',
      protocol: 'm3u8_native',
      url: 'https://manifest.googlevideo.com/api/manifest/hls_variant/xyz/index.m3u8',
    },
    {
      format_id: 'drm',
      ext: 'mp4',
      height: 2160,
      vcodec: 'av01.0.12M.08',
      acodec: 'mp4a.40.2',
      protocol: 'https',
      url: 'https://r1.googlevideo.com/videoplayback?itag=drm',
      has_drm: true,
    },
  ],
};

test('planFromInfo pairs tracks, drops HLS and DRM, and recommends the top quality', () => {
  const plan = planFromInfo(INFO);
  assert.equal(plan.id, 'dQw4w9WgXcQ');
  assert.equal(plan.isLive, false);
  assert.equal(plan.blockedReason, '');

  const keys = plan.picks.map((p) => p.key);
  assert.ok(keys.includes('pair:137'), '1080p avc1 should pair with m4a audio');
  assert.ok(!keys.includes('pair:248'), 'one entry per resolution band: the playable avc1 wins over vp9');
  assert.ok(keys.includes('single:18'), 'the combined 360p file should be offered as one file');
  assert.ok(!keys.includes('pair:hls'), 'HLS variants cannot be fetched by the engine');
  assert.ok(!keys.includes('pair:drm') && !keys.includes('single:drm'), 'DRM formats are refused');

  const pair1080 = plan.picks.find((p) => p.key === 'pair:137');
  assert.equal(pair1080.ext, 'mp4');
  assert.equal(pair1080.merge, true);
  assert.equal(pair1080.streams.length, 2);
  assert.equal(pair1080.streams[1].format.format_id, '140', 'mp4 video gets m4a audio');
  assert.equal(pair1080.size, 43_400_000);
  assert.match(plan.picks[0].label, /^Best \(1080p\)$/);
  assert.equal(plan.picks[0].recommended, true);
});

test('planFromInfo refuses a DRM-only video with a clear reason', () => {
  const plan = planFromInfo({
    id: 'xyz',
    title: 'Protected',
    webpage_url: 'https://www.youtube.com/watch?v=xyz',
    formats: [INFO.formats.at(-1)],
  });
  assert.equal(plan.drmBlocked, true);
  assert.equal(plan.picks.length, 0);
  assert.match(plan.blockedReason, /DRM/i);
});

test('summarizePlan never exposes signed stream URLs', () => {
  const summary = summarizePlan(planFromInfo(INFO));
  const text = JSON.stringify(summary);
  assert.ok(!text.includes('googlevideo'));
  assert.ok(!text.includes('videoplayback'));
  assert.equal(summary.picks.length, planFromInfo(INFO).picks.length);
  for (const pick of summary.picks) {
    assert.equal(pick.streams, undefined);
    assert.equal(typeof pick.key, 'string');
  }
});

async function startBridge(video) {
  const token = 'video-test-' + crypto.randomBytes(4).toString('hex');
  const bridge = createBridge({
    engine: { snapshot: () => ({ downloads: [], active: 0, queued: 0, totalSpeed: 0 }) },
    video,
    getToken: () => token,
    getInfo: () => ({ version: 'test' }),
    onActivity: () => {},
    startPort: 64400 + Math.floor(Math.random() * 300),
  });
  const port = await bridge.start();
  return { bridge, token, base: `http://127.0.0.1:${port}` };
}

test('bridge video endpoints require the pairing token and return compact plans', async (t) => {
  const calls = [];
  const video = {
    status: async () => ({ helper: { installed: true }, ffmpeg: { installed: false }, install: null }),
    resolve: async (url) => {
      calls.push(['resolve', url]);
      return { token: 'plan-token', plan: summarizePlan(planFromInfo(INFO)), dir: 'C:\\Videos' };
    },
    start: async (token, pick, opts) => {
      calls.push(['start', token, pick, opts]);
      return { group: 'g1', merge: 'm1', rows: [{ id: 'a' }, { id: 'b' }], title: 'A test video', pick };
    },
    add: async (url) => {
      calls.push(['add', url]);
      return { started: true, plan: summarizePlan(planFromInfo(INFO)) };
    },
    cancelInstall: async () => ({ canceled: true }),
  };
  const { bridge, token, base } = await startBridge(video);
  t.after(() => bridge.stop());

  const unauth = await fetch(`${base}/api/video/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: INFO.webpage_url }),
  });
  assert.equal(unauth.status, 401);

  const headers = { 'Content-Type': 'application/json', 'X-SDM-Token': token };

  const status = await fetch(`${base}/api/video/status`, { headers });
  assert.equal((await status.json()).helper.installed, true);

  const resolved = await fetch(`${base}/api/video/resolve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: INFO.webpage_url }),
  });
  const resolvedBody = await resolved.json();
  assert.equal(resolvedBody.ok, true);
  assert.equal(resolvedBody.token, 'plan-token');
  assert.ok(!JSON.stringify(resolvedBody).includes('googlevideo'));

  const started = await fetch(`${base}/api/video/start`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ token: 'plan-token', pick: 'pair:137', filename: 'Clip', dir: 'C:\\Videos' }),
  });
  const startedBody = await started.json();
  assert.equal(startedBody.ok, true);
  assert.equal(startedBody.rows, 2);
  assert.deepEqual(calls.find((c) => c[0] === 'start'), ['start', 'plan-token', 'pair:137', { filename: 'Clip', dir: 'C:\\Videos' }]);

  const added = await fetch(`${base}/api/video/add`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ url: INFO.webpage_url }),
  });
  const addedBody = await added.json();
  assert.equal(addedBody.ok, true);
  assert.equal(addedBody.started, true);
  assert.equal(addedBody.plan.title, 'A test video');

  const bad = await fetch(`${base}/api/video/start`, { method: 'POST', headers, body: JSON.stringify({}) });
  assert.equal(bad.status, 400);
});

test('bridge open-folder reveals the requested download', async (t) => {
  const seen = [];
  const token = 'folder-test-' + crypto.randomBytes(4).toString('hex');
  const bridge = createBridge({
    engine: { snapshot: () => ({ downloads: [], active: 0, queued: 0, totalSpeed: 0 }) },
    getToken: () => token,
    getInfo: () => ({ version: 'test' }),
    openFolder: async (id) => seen.push(id),
    startPort: 64800 + Math.floor(Math.random() * 300),
  });
  const port = await bridge.start();
  t.after(() => bridge.stop());

  const res = await fetch(`http://127.0.0.1:${port}/api/open-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SDM-Token': token },
    body: JSON.stringify({ id: 'download-1' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['download-1']);
});

test('bridge without a video service answers 501 for video routes', async (t) => {
  const { bridge, token, base } = await startBridge(null);
  t.after(() => bridge.stop());
  const res = await fetch(`${base}/api/video/status`, { headers: { 'X-SDM-Token': token } });
  assert.equal(res.status, 501);
});
