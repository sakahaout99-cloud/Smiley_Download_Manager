'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { DownloadEngine } = require('../main/engine');
const { createBridge } = require('../main/api');
const { startServer, waitFor } = require('./helpers');

test('bridge authenticates, accepts downloads, and lists them', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sdm-api-'));
  const data = crypto.randomBytes(2 * 1024 * 1024);
  const { server, url: fileUrl } = await startServer({ data });
  const engine = new DownloadEngine({
    partsDir: path.join(dir, 'parts'),
    settings: { defaultDir: path.join(dir, 'downloads'), connections: 4, maxConcurrent: 2 },
  });
  const token = 'test-pairing-token-' + crypto.randomBytes(4).toString('hex');
  const bridge = createBridge({
    engine,
    getToken: () => token,
    getInfo: () => ({ version: '1.0.0' }),
    onActivity: () => {},
    startPort: 64000 + Math.floor(Math.random() * 400),
  });
  const port = await bridge.start();
  assert.ok(port > 0, 'bridge should listen on a port');

  t.after(async () => {
    await bridge.stop();
    engine.dispose();
    server.close();
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;

  const ping = await fetch(`${base}/api/ping`);
  const pingBody = await ping.json();
  assert.equal(ping.status, 200);
  assert.equal(pingBody.ok, true);
  assert.equal(pingBody.app, 'Smiley Download Manager');

  const unauth = await fetch(`${base}/api/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${fileUrl}/files/api.bin` }),
  });
  assert.equal(unauth.status, 401);

  const add = await fetch(`${base}/api/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SDM-Token': token },
    body: JSON.stringify({ url: `${fileUrl}/files/api.bin`, referer: 'https://example.com/page' }),
  });
  const addBody = await add.json();
  assert.equal(add.status, 200);
  assert.equal(addBody.ok, true);
  assert.ok(addBody.download.id);
  assert.ok(['queued', 'connecting', 'downloading'].includes(addBody.download.status));

  const done = await waitFor(() => {
    const dl = engine.get(addBody.download.id);
    if (dl?.status === 'error') throw new Error(dl.error);
    return dl?.status === 'completed' ? dl : null;
  }, { label: 'bridge download completion' });

  assert.equal(done.downloaded, data.length);
  assert.equal(done.referer, 'https://example.com/page');
  assert.ok((await fsp.readFile(done.filePath)).equals(data));

  const list = await fetch(`${base}/api/list`, { headers: { 'X-SDM-Token': token } });
  const listBody = await list.json();
  assert.equal(listBody.ok, true);
  assert.equal(listBody.downloads.length, 1);
  assert.equal(listBody.downloads[0].status, 'completed');

  const paused = await fetch(`${base}/api/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-SDM-Token': token },
    body: JSON.stringify({ url: `${fileUrl}/files/second.bin`, startNow: false }),
  });
  const pausedBody = await paused.json();
  assert.equal(pausedBody.download.status, 'paused');

  const status = await fetch(`${base}/api/status`, { headers: { 'X-SDM-Token': token } });
  const statusBody = await status.json();
  assert.equal(statusBody.ok, true);
  assert.ok(statusBody.counts);
  assert.ok(Array.isArray(statusBody.recent));

  const unknown = await fetch(`${base}/api/does-not-exist`, { headers: { 'X-SDM-Token': token } });
  assert.equal(unknown.status, 404);
});
