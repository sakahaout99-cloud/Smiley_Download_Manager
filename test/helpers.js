'use strict';

const http = require('http');

function startServer({ data, honorRange = true, delayMs = 0, chunked = false, disposition = null }) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/redirect') {
        res.writeHead(302, { Location: '/files/redirect-target.bin' });
        res.end();
        return;
      }
      if (!url.pathname.startsWith('/files/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      const headers = { 'Content-Type': 'application/octet-stream' };
      if (honorRange) headers['Accept-Ranges'] = 'bytes';
      if (disposition) headers['Content-Disposition'] = disposition;
      let start = 0;
      let end = data.length - 1;
      let status = 200;
      const range = req.headers.range;
      if (honorRange && range) {
        const m = /bytes=(\d+)-(\d*)/.exec(range);
        if (m) {
          start = Number(m[1]);
          end = m[2] ? Math.min(Number(m[2]), data.length - 1) : data.length - 1;
          if (start >= data.length) {
            res.writeHead(416, { 'Content-Range': `bytes */${data.length}` });
            res.end();
            return;
          }
          status = 206;
          headers['Content-Range'] = `bytes ${start}-${end}/${data.length}`;
        }
      }
      if (!chunked) headers['Content-Length'] = end - start + 1;
      res.writeHead(status, headers);
      let pos = start;
      let stopped = false;
      res.on('close', () => {
        stopped = true;
      });
      res.on('error', () => {
        stopped = true;
      });
      const pump = () => {
        if (stopped || res.destroyed) return;
        if (pos > end) {
          res.end();
          return;
        }
        const next = Math.min(end + 1, pos + 65536);
        const ok = res.write(data.subarray(pos, next));
        pos = next;
        if (delayMs) setTimeout(pump, delayMs);
        else if (ok) setImmediate(pump);
        else res.once('drain', pump);
      };
      pump();
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function waitFor(check, { timeout = 45000, interval = 40, label = 'condition' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = check();
      } catch (e) {
        clearInterval(timer);
        reject(e);
        return;
      }
      if (value) {
        clearInterval(timer);
        resolve(value);
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${label}`));
      }
    };
    const timer = setInterval(tick, interval);
    tick();
  });
}

module.exports = { startServer, waitFor };
