'use strict';

const http = require('http');
const crypto = require('crypto');

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-SDM-Token',
    'Access-Control-Max-Age': '86400',
    'Cache-Control': 'no-store',
  };
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(),
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function tokenMatches(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Local HTTP bridge used by the Chrome/Edge extension.
 * Binds to 127.0.0.1 only and requires the pairing token for every data endpoint.
 */
function createBridge({ engine, getToken, getInfo, onActivity, openFolder = null, video = null, startPort = 6389, maxTries = 12 }) {
  let server = null;
  let port = 0;

  const handler = async (req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders());
      res.end();
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return send(res, 400, { ok: false, error: 'Bad request' });
    }
    const route = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (route === '/api/ping' && req.method === 'GET') {
        return send(res, 200, { ok: true, app: 'Smiley Download Manager', ...getInfo() });
      }

      const token = req.headers['x-sdm-token'] || url.searchParams.get('token');
      if (!tokenMatches(token, getToken())) {
        return send(res, 401, { ok: false, error: 'Unauthorized: pair the extension with the token from Smiley Download Manager → Options → Browser Integration.' });
      }

      if (route === '/api/status' && req.method === 'GET') {
        const snap = engine.snapshot();
        return send(res, 200, {
          ok: true,
          active: snap.active,
          queued: snap.queued,
          totalSpeed: snap.totalSpeed,
          counts: snap.downloads.reduce((acc, d) => {
            acc[d.status] = (acc[d.status] || 0) + 1;
            return acc;
          }, {}),
          recent: snap.downloads.slice(0, 8),
        });
      }

      if (route === '/api/list' && req.method === 'GET') {
        return send(res, 200, { ok: true, downloads: engine.snapshot().downloads });
      }

      if (route === '/api/add' && req.method === 'POST') {
        const body = await readBody(req);
        if (!body.url) return send(res, 400, { ok: false, error: 'url is required' });
        const dl = engine.add({
          url: body.url,
          referer: body.referer,
          cookie: body.cookie,
          userAgent: body.userAgent,
          filename: body.filename,
          description: body.description,
          startNow: body.startNow !== false,
        });
        onActivity?.('add', dl);
        return send(res, 200, { ok: true, download: dl });
      }

      if (route === '/api/add-batch' && req.method === 'POST') {
        const body = await readBody(req);
        const urls = Array.isArray(body.urls) ? body.urls.slice(0, 500) : [];
        if (!urls.length) return send(res, 400, { ok: false, error: 'urls is required' });
        const added = [];
        const errors = [];
        for (const item of urls) {
          try {
            const u = typeof item === 'string' ? { url: item } : item;
            added.push(engine.add({ ...u, startNow: body.startNow !== false }));
          } catch (e) {
            errors.push({ url: item?.url || item, error: e.message });
          }
        }
        onActivity?.('add-batch', added);
        return send(res, 200, { ok: true, added: added.length, errors });
      }

      if (route.startsWith('/api/video/')) {
        if (!video) return send(res, 501, { ok: false, error: 'This build has no video support.' });

        if (route === '/api/video/status' && req.method === 'GET') {
          return send(res, 200, { ok: true, ...(await video.status()) });
        }

        if (route === '/api/video/resolve' && req.method === 'POST') {
          const body = await readBody(req);
          if (!body.url) return send(res, 400, { ok: false, error: 'url is required' });
          const data = await video.resolve(body.url);
          return send(res, 200, { ok: true, ...data });
        }

        if (route === '/api/video/start' && req.method === 'POST') {
          const body = await readBody(req);
          if (!body.token || !body.pick) return send(res, 400, { ok: false, error: 'token and pick are required' });
          const data = await video.start(body.token, body.pick, {
            filename: body.filename,
            dir: body.dir,
          });
          onActivity?.('video-start', { title: data.title, pick: data.pick, count: data.rows.length });
          return send(res, 200, { ok: true, group: data.group, merge: data.merge, rows: data.rows.length, title: data.title });
        }

        if (route === '/api/video/add' && req.method === 'POST') {
          const body = await readBody(req);
          if (!body.url) return send(res, 400, { ok: false, error: 'url is required' });
          const data = await video.add(body.url);
          onActivity?.('video-add', { url: body.url, title: data.plan?.title || '', started: !!data.started });
          return send(res, 200, {
            ok: true,
            started: !!data.started,
            dialog: !!data.dialog,
            plan: data.plan || null,
            title: data.plan?.title || '',
          });
        }

        if (route === '/api/video/cancel-install' && req.method === 'POST') {
          return send(res, 200, { ok: true, ...(await video.cancelInstall()) });
        }

        if (route === '/api/video/install' && req.method === 'POST') {
          const body = await readBody(req);
          const kind = body.kind === 'resolver' ? 'resolver' : 'ffmpeg';
          return send(res, 200, { ok: true, kind, ...(await video.install(kind)) });
        }

        return send(res, 404, { ok: false, error: 'Unknown video endpoint' });
      }

      if (route === '/api/pause' && req.method === 'POST') {        const body = await readBody(req);
        await engine.pause(body.id);
        return send(res, 200, { ok: true });
      }

      if (route === '/api/resume' && req.method === 'POST') {
        const body = await readBody(req);
        engine.start(body.id);
        return send(res, 200, { ok: true });
      }

      if (route === '/api/remove' && req.method === 'POST') {
        const body = await readBody(req);
        await engine.remove(body.id, { deleteFile: !!body.deleteFile });
        return send(res, 200, { ok: true });
      }

      if (route === '/api/pause-all' && req.method === 'POST') {
        await engine.pauseAll();
        return send(res, 200, { ok: true });
      }

      if (route === '/api/start-all' && req.method === 'POST') {
        engine.startAll();
        return send(res, 200, { ok: true });
      }

      if (route === '/api/open-folder' && req.method === 'POST') {
        const body = await readBody(req);
        onActivity?.('open-folder', body.id);
        if (openFolder) await openFolder(body.id);
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { ok: false, error: 'Unknown endpoint' });
    } catch (e) {
      return send(res, 500, { ok: false, error: e?.message || 'Internal error' });
    }
  };

  return {
    start() {
      return new Promise((resolve) => {
        let attempt = 0;
        const tryListen = () => {
          server = http.createServer(handler);
          server.once('error', (err) => {
            if (err.code === 'EADDRINUSE' && attempt < maxTries) {
              attempt++;
              tryListen();
            } else {
              resolve(0);
            }
          });
          server.listen(startPort + attempt, '127.0.0.1', () => {
            port = server.address().port;
            resolve(port);
          });
        };
        tryListen();
      });
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
        server = null;
      });
    },
    get port() {
      return port;
    },
  };
}

module.exports = { createBridge };
