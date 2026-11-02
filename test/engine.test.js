'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
  DownloadEngine,
  sanitizeFilename,
  filenameFromUrl,
  parseContentDisposition,
  planParts,
} = require('../main/engine');
const { startServer, waitFor } = require('./helpers');

const MB = 1024 * 1024;

async function setup(t, settings = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdm-engine-'));
  const engine = new DownloadEngine({
    partsDir: path.join(dir, 'parts'),
    settings: {
      defaultDir: path.join(dir, 'downloads'),
      connections: 4,
      maxConcurrent: 3,
      ...settings,
    },
  });
  t.after(async () => {
    engine.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return { engine, dir };
}

test('multi-connection download produces exact bytes', async (t) => {
  const data = crypto.randomBytes(3 * MB);
  const { server, url } = await startServer({ data });
  t.after(() => server.close());
  const { engine } = await setup(t);

  const dl = engine.add({ url: `${url}/files/test-file.bin` });
  assert.equal(dl.parts, 0);
  const done = await waitFor(() => {
    const d = engine.get(dl.id);
    if (d?.status === 'error') throw new Error(d.error);
    return d?.status === 'completed' ? d : null;
  }, { label: 'completion' });

  assert.equal(done.filename, 'test-file.bin');
  assert.equal(done.parts.length, 4, 'should use four connections');
  assert.equal(done.size, data.length);
  assert.equal(done.downloaded, data.length);
  const fileData = await fsp.readFile(done.filePath);
  assert.equal(fileData.length, data.length);
  assert.equal(crypto.createHash('sha256').update(fileData).digest('hex'), crypto.createHash('sha256').update(data).digest('hex'));
  assert.ok(fs.existsSync(done.filePath));
});

test('pause and resume keeps byte ranges intact', async (t) => {
  const data = crypto.randomBytes(20 * MB);
  const { server, url } = await startServer({ data, delayMs: 18 });
  t.after(() => server.close());
  const { engine } = await setup(t, { connections: 4 });

  const dl = engine.add({ url: `${url}/files/big-file.bin` });
  await waitFor(() => {
    const d = engine.get(dl.id);
    if (d?.status === 'error') throw new Error(d.error);
    return d.downloaded > 1 * MB;
  }, { label: 'initial progress' });

  await engine.pause(dl.id);
  const paused = engine.get(dl.id);
  assert.equal(paused.status, 'paused');
  assert.ok(paused.downloaded > 0, 'some bytes should be kept');
  assert.ok(paused.downloaded < data.length, 'download should not be finished');
  const partsBefore = paused.parts.reduce((n, p) => n + p.downloaded, 0);
  assert.equal(partsBefore, paused.downloaded, 'part counters should match total');

  engine.start(dl.id);
  const done = await waitFor(() => {
    const d = engine.get(dl.id);
    if (d?.status === 'error') throw new Error(d.error);
    return d?.status === 'completed' ? d : null;
  }, { label: 'resumed completion', timeout: 60000 });

  assert.equal(done.size, data.length);
  assert.equal(done.downloaded, data.length);
  const fileData = await fsp.readFile(done.filePath);
  assert.equal(
    crypto.createHash('sha256').update(fileData).digest('hex'),
    crypto.createHash('sha256').update(data).digest('hex'),
    'file contents must match after resume'
  );
});

test('server without range support downloads in a single connection', async (t) => {
  const data = crypto.randomBytes(2 * MB);
  const { server, url } = await startServer({ data, honorRange: false });
  t.after(() => server.close());
  const { engine } = await setup(t);

  const dl = engine.add({ url: `${url}/files/plain.bin` });
  const done = await waitFor(() => {
    const d = engine.get(dl.id);
    if (d?.status === 'error') throw new Error(d.error);
    return d?.status === 'completed' ? d : null;
  }, { label: 'plain completion' });

  assert.equal(done.size, data.length);
  const fileData = await fsp.readFile(done.filePath);
  assert.ok(fileData.equals(data));
});

test('chunked response without content-length completes and learns size', async (t) => {
  const data = crypto.randomBytes(900 * 1024);
  const { server, url } = await startServer({ data, honorRange: false, chunked: true });
  t.after(() => server.close());
  const { engine } = await setup(t);

  const dl = engine.add({ url: `${url}/files/stream.bin` });
  const done = await waitFor(() => {
    const d = engine.get(dl.id);
    if (d?.status === 'error') throw new Error(d.error);
    return d?.status === 'completed' ? d : null;
  }, { label: 'chunked completion' });

  assert.equal(done.size, data.length);
  assert.ok((await fsp.readFile(done.filePath)).equals(data));
});

test('redirects and content-disposition filenames are honored', async (t) => {
  const data = crypto.randomBytes(300 * 1024);
  const { server, url } = await startServer({
    data,
    disposition: 'attachment; filename="Smiley Test (v1).bin"',
  });
  t.after(() => server.close());
  const { engine } = await setup(t);

  const dl = engine.add({ url: `${url}/redirect` });
  const done = await waitFor(() => {
    const d = engine.get(dl.id);
    if (d?.status === 'error') throw new Error(d.error);
    return d?.status === 'completed' ? d : null;
  }, { label: 'redirect completion' });

  assert.equal(done.filename, 'Smiley Test (v1).bin');
  assert.equal(done.finalUrl, `${url}/files/redirect-target.bin`);
  assert.ok(fs.existsSync(done.filePath));
});

test('download queue respects maxConcurrent', async (t) => {
  const data = crypto.randomBytes(512 * 1024);
  const { server, url } = await startServer({ data, delayMs: 15 });
  t.after(() => server.close());
  const { engine } = await setup(t, { maxConcurrent: 2, connections: 1 });

  const a = engine.add({ url: `${url}/files/one.bin` });
  const b = engine.add({ url: `${url}/files/two.bin` });
  const c = engine.add({ url: `${url}/files/three.bin` });

  await waitFor(() => engine.active.size === 2, { label: 'two active downloads' });
  let d = engine.get(c.id);
  assert.equal(d.status, 'queued');

  await waitFor(() => engine.downloads.every((x) => x.status === 'completed'), {
    label: 'all queued downloads',
    timeout: 60000,
  });
  assert.ok(fs.existsSync(engine.get(a.id).filePath));
  assert.ok(fs.existsSync(engine.get(b.id).filePath));
  assert.ok(fs.existsSync(engine.get(c.id).filePath));
});

test('a hidden helper download starts even when the visible queue is full', async (t) => {
  const data = crypto.randomBytes(2 * MB);
  const { server, url } = await startServer({ data, delayMs: 12 });
  t.after(() => server.close());
  const { engine } = await setup(t, { maxConcurrent: 1, connections: 1 });

  const busy = engine.add({ url: `${url}/files/busy.bin` });
  await waitFor(() => engine.active.has(busy.id), { label: 'first download active' });
  const queued = engine.add({ url: `${url}/files/queued.bin` });
  const helper = engine.add({ url: `${url}/files/helper.bin`, kind: 'tool', hidden: true });

  assert.equal(engine.get(queued.id).status, 'queued', 'the user queue waits for its turn');
  await waitFor(() => engine.active.has(helper.id) || engine.get(helper.id).status === 'completed', {
    label: 'helper starts regardless of the queue',
  });
});

test('an in-progress download occupies only its own file', async (t) => {
  const data = crypto.randomBytes(16 * MB);
  const { server, url } = await startServer({ data, delayMs: 20 });
  t.after(() => server.close());
  const { engine, dir } = await setup(t, { connections: 4 });

  const dl = engine.add({ url: `${url}/files/grows.bin` });
  await waitFor(() => engine.get(dl.id).downloaded > 3 * MB, { label: 'progress' });
  await engine.pause(dl.id);

  const names = await fsp.readdir(path.join(dir, 'downloads'));
  assert.deepEqual(names, ['grows.bin.sdm-part'], 'no second copy of the data is kept');
  const st = await fsp.stat(path.join(dir, 'downloads', names[0]));
  assert.ok(st.size <= data.length, 'the working file never grows past the real file size');
});

test('a restarted engine resumes the file in place instead of starting over', async (t) => {
  const data = crypto.randomBytes(12 * MB);
  const { server, url } = await startServer({ data, delayMs: 14 });
  t.after(() => server.close());
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdm-restart-'));
  const settings = { defaultDir: path.join(dir, 'downloads'), connections: 4, maxConcurrent: 3 };
  const partsDir = path.join(dir, 'parts');
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  const first = new DownloadEngine({ partsDir, settings });
  const dl = first.add({ url: `${url}/files/resume-me.bin` });
  await waitFor(() => first.get(dl.id).downloaded > 2 * MB, { label: 'partial download' });
  await first.pause(dl.id);
  const saved = first.serialize();
  first.dispose();

  const second = new DownloadEngine({ partsDir, settings });
  t.after(() => second.dispose());
  second.load(saved);
  const before = second.get(dl.id).downloaded;
  assert.ok(before > 0, 'progress survives the restart');

  second.start(dl.id);
  const done = await waitFor(() => {
    const d = second.get(dl.id);
    if (d?.status === 'error') throw new Error(d.error);
    return d?.status === 'completed' ? d : null;
  }, { label: 'restarted completion', timeout: 60000 });

  assert.ok((await fsp.readFile(done.filePath)).equals(data));
  assert.deepEqual(await fsp.readdir(settings.defaultDir), ['resume-me.bin']);
});

test('a split video download presents one row with combined progress', async (t) => {
  const data = crypto.randomBytes(16 * MB);
  const { server, url } = await startServer({ data, delayMs: 20 });
  t.after(() => server.close());
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdm-merge-row-'));
  const downloadsDir = path.join(dir, 'downloads');
  const merger = async (dl, inputs) => {
    const chunks = [];
    for (const input of inputs) chunks.push(await fsp.readFile(input.filePath));
    const buf = Buffer.concat(chunks);
    const out = path.join(dl.dir, dl.filename);
    await fsp.writeFile(out, buf);
    return { filePath: out, size: buf.length };
  };
  const engine = new DownloadEngine({
    partsDir: path.join(dir, 'parts'),
    settings: { defaultDir: downloadsDir, connections: 2, maxConcurrent: 2 },
    merger,
  });
  t.after(async () => {
    engine.dispose();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const group = 'split-job';
  const video = engine.add({
    url: `${url}/files/track-v.bin`,
    dir: downloadsDir,
    filename: 'clip [video].mp4',
    kind: 'video-stream',
    group,
    role: 'video',
    hidden: true,
  });
  const audio = engine.add({
    url: `${url}/files/track-a.bin`,
    dir: downloadsDir,
    filename: 'clip [audio].m4a',
    kind: 'video-stream',
    group,
    role: 'audio',
    hidden: true,
  });
  const merge = engine.add({
    url: `${url}/watch`,
    dir: downloadsDir,
    filename: 'clip.mp4',
    kind: 'merge',
    group,
    size: data.length * 2,
    merge: { inputs: [video.id, audio.id] },
    status: 'queued',
    startNow: false,
  });

  assert.deepEqual(engine.snapshot().downloads.map((d) => d.id), [merge.id], 'only the final file is listed');

  await waitFor(() => {
    const row = engine.snapshot().downloads[0];
    return row?.status === 'downloading' && row.downloaded > 0 && row.speed > 0;
  }, { label: 'combined progress' });

  const live = engine.snapshot().downloads[0];
  assert.equal(live.size, data.length * 2, 'size covers both tracks');
  assert.ok(live.speed > 0, 'track speed is reported on the one row');
  assert.ok(live.downloaded < data.length * 2);

  await engine.pause(merge.id);
  assert.equal(engine.get(video.id).status, 'paused', 'the hidden tracks pause with the row');
  assert.equal(engine.get(audio.id).status, 'paused');
  assert.equal(engine.snapshot().downloads[0].status, 'paused');

  engine.start(merge.id);
  const done = await waitFor(() => {
    const row = engine.snapshot().downloads[0];
    if (row?.status === 'error') throw new Error(row.error);
    return row?.status === 'completed' ? row : null;
  }, { label: 'merged completion', timeout: 60000 });

  assert.equal(done.filename, 'clip.mp4');
  assert.equal(done.size, data.length * 2);
  const file = await fsp.readFile(done.filePath);
  assert.equal(file.length, data.length * 2);
  assert.ok(file.subarray(0, data.length).equals(data));

  await engine.remove(merge.id, { deleteFile: true });
  assert.equal(engine.get(video.id), null, 'removing the row removes its hidden tracks');
  assert.equal(engine.get(audio.id), null);
});

test('filename and URL helpers are safe', () => {
  assert.equal(sanitizeFilename('a/b\\c:d*e?.zip'), 'a_b_c_d_e_.zip');
  assert.equal(sanitizeFilename('CON.txt'), '_CON.txt');
  assert.equal(sanitizeFilename('   spaced.  '), 'spaced');
  assert.equal(filenameFromUrl('https://example.com/path/My%20File.mp4?token=1'), 'My File.mp4');
  assert.equal(parseContentDisposition("attachment; filename*=UTF-8''Smiley%20File.zip"), 'Smiley File.zip');
  assert.equal(parseContentDisposition('attachment; filename="Café.zip"'), 'Café.zip');

  const parts = planParts(10 * MB, 8);
  assert.equal(parts.length, 8);
  assert.equal(parts[0].start, 0);
  assert.equal(parts[parts.length - 1].end, 10 * MB - 1);
  for (let i = 1; i < parts.length; i++) assert.equal(parts[i].start, parts[i - 1].end + 1);
  const total = parts.reduce((n, p) => n + (p.end - p.start + 1), 0);
  assert.equal(total, 10 * MB);

  const single = planParts(100, 8);
  assert.equal(single.length, 1);
  assert.deepEqual(single[0], { start: 0, end: 99, downloaded: 0, done: false });
});

test('connection settings are clamped and options propagate', async (t) => {
  const { engine } = await setup(t, { connections: 99, maxConcurrent: 99 });
  engine.setSettings({ connections: 99, maxConcurrent: 99 });
  assert.equal(engine.settings.maxConcurrent, 99);
  assert.equal(engine.settings.connections, 99);
  const parts = planParts(4 * MB, engine.settings.connections);
  assert.equal(parts.length, 8, 'planParts caps at one part per 512 KB');
});
