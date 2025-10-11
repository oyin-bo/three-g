#!/usr/bin/env node
// @ts-check

import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8302;
const __filename = fileURLToPath(import.meta.url);
const ROOT = normalize(join(__filename, '..'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// ---------- pages + jobs ----------
const PAGES = new Map(); // name -> { name, url, last, state, queue: Job[], current: Job|null }
let NEXT_JOB_ID = 1;
const JOB_TIMEOUT_MS = 60000;

function getRawParam(reqUrl, key) {
  const qAt = reqUrl.indexOf('?');
  if (qAt === -1) return null;
  const qs = reqUrl.slice(qAt + 1);
  for (const kv of qs.split('&')) {
    const [k, v = ''] = kv.split('=');
    if (k === key) return decodeURIComponent(v);
  }
  return null;
}

// ---- injected to clients and executed ----
async function inject() {
  console.log('injected>>>');
  // stable per-tab name: <normalized-title>-<5..19>-<word>-<HH:MM:SS>
  let name = sessionStorage.getItem('tabName');
  if (!name) {
    const title = (document.title || 'page')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'page';
    const n = Math.floor(Math.random() * (19 - 5 + 1)) + 5;
    const words = [
      'mint,nova,ember,zen,lumen,oak,river,kite,moss,nook,sol,vibe',
      'dune,opal,brim,echo,fern,halo,iris,loom,meadow,pulse,quill,reef',
      'sage,tide,veil,willow,flare,hearth,drift,grove,haze,ivy,knoll,lark',
      'mist,nest,pebble,quartz,rift,spire,trail,vale,whisper,yarn,zephyr,glow'
    ].join(',').split(',');
    const w = words[Math.floor(Math.random() * words.length)];
    const t = new Date();
    const hh = String(t.getHours()).padStart(2, '0');
    const mm = String(t.getMinutes()).padStart(2, '0');
    const ss = String(t.getSeconds()).padStart(2, '0');
    const time = `${hh}:${mm}:${ss}`;
    name = `${title}-${n}-${w}-${time}`;
    sessionStorage.setItem('tabName', name);
  }

  const endpoint =
    '/serve.js' +
    '?name=' + encodeURIComponent(name) +
    '&url=' + encodeURIComponent(location.href);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  while (true) {
    let response;
    try {
      response = await fetch(endpoint, {
        headers: {
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        }
      });

      const script = await response.text();
      const headers = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      if (!script) {
        await sleep(300);
        continue;
      }

      let payload;
      try {
        const value = await (0, eval)(script);
        try {
          payload = JSON.stringify({ ok: true, value });
        } catch (_err) {
          payload = JSON.stringify({ ok: true, value: String(value) });
        }
      } catch (err) {
        payload = JSON.stringify({
          ok: false,
          error: {
            message: err?.message || String(err),
            stack: err?.stack || null
          }
        });
      }

      await fetch(endpoint, {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json'
        },
        body: payload
      });

      await sleep(100);
    } catch (error) {
      console.warn('[injected] fetch failed:', error);
      await sleep(3000 * Math.random() + 500);
      continue;
    }
  }
}
// ----------------------------------------------------------------

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // minimal poll endpoint
  if (url.pathname === '/poll') { res.writeHead(204).end(); return; }

  let p = url.pathname;
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/') p = '/index.html';

  const file = join(ROOT, p);
  if (!existsSync(file)) {
    return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }

  if (file === __filename) {
    handlePollServer();
    return;
  }

  const type = MIME[extname(file)] || 'application/octet-stream';

  if (extname(file) === '.html') {
    // inject by coercing the function to string (no multi-line literals)
    res.writeHead(200, { 'Content-Type': type });
    res.end(readFileSync(file, 'utf8') +
      '\n<script>\n' +
      '(function() {\n' +
      'inject();\n' +
      inject + '\n' +
      '})()\n' +
      '</script>');
    return;
  }

  res.writeHead(200, { 'Content-Type': type });
  createReadStream(file).pipe(res);

  // ---------------- poll server + features ----------------
  function handlePollServer() {
    const sp = url.searchParams;
    const qName = sp.get('name') || '';
    const qUrl = sp.get('url') || '';
    // keep plus signs in eval
    const qEval = getRawParam(req.url || '', 'eval');

    function pageFor(name, href) {
      const now = Date.now();
      let page = PAGES.get(name);
      if (!page) {
        page = { name, url: href || '', last: now, state: 'idle', queue: [], current: null };
        PAGES.set(name, page);
      }
      if (href) page.url = href;
      page.last = now;
      return page;
    }

    // A) Listing: GET /serve.js (no params)
    if (req.method === 'GET' && !qEval && !qName && !qUrl) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      const lines = [];
      for (const [name, p] of PAGES) {
        lines.push(`${name}\t${p.url || '-'}\t${new Date(p.last).toISOString()}\t${p.state}`);
      }
      res.end(lines.join('\n') + (lines.length ? '\n' : ''));
      return;
    }

    // B) Admin: queue eval (REQUIRES name; lax/partial match; first match wins)
    if (req.method === 'GET' && qEval != null) {
      if (!qName) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('eval requires &name=<id-fragment>');
        return;
      }
      const needle = qName.toLowerCase();
      let page = null;
      for (const [name, p] of PAGES) {
        if (name.toLowerCase().includes(needle)) { page = p; break; }
      }
      if (!page) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No page matches name fragment: ' + qName);
        return;
      }
      const job = {
        id: String(NEXT_JOB_ID++),
        code: qEval,
        res, done: false, timer: null
      };
      page.queue.push(job);

      job.timer = setTimeout(() => {
        if (job.done) return;
        job.done = true;
        const i = page.queue.indexOf(job);
        if (i >= 0) page.queue.splice(i, 1);
        try {
          res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('timeout');
        } catch { }
      }, JOB_TIMEOUT_MS);
      return;
    }

    // B2) Admin: queue eval via POST body when ?eval=post
    if (req.method === 'POST' && qEval === 'post') {
      if (!qName) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('eval requires &name=<id-fragment>');
        return;
      }
      const needle = qName.toLowerCase();
      let page = null;
      for (const [name, p] of PAGES) {
        if (name.toLowerCase().includes(needle)) { page = p; break; }
      }
      if (!page) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('No page matches name fragment: ' + qName);
        return;
      }

      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const code = body || '';
        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('empty body');
          return;
        }

        const job = {
          id: String(NEXT_JOB_ID++),
          code,
          res, done: false, timer: null
        };
        page.queue.push(job);

        job.timer = setTimeout(() => {
          if (job.done) return;
          job.done = true;
          const i = page.queue.indexOf(job);
          if (i >= 0) page.queue.splice(i, 1);
          try {
            res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('timeout');
          } catch { }
        }, JOB_TIMEOUT_MS);
      });
      return;
    }

    // C) Page poll: GET /serve.js?name=...&url=...
    if (req.method === 'GET' && qName) {
      const page = pageFor(qName, qUrl);

      if (page.state !== 'executing' && page.queue.length) {
        const job = page.queue.shift();
        page.current = job;
        page.state = 'executing';
        res.writeHead(200, {
          'Content-Type': MIME['.js'] || 'application/javascript',
          'x-job-id': job.id,
          'x-target-name': page.name
        });
        res.end(job.code);
        return;
      }

      res.writeHead(200, { 'Content-Type': MIME['.js'] || 'application/javascript' });
      res.end('');
      return;
    }

    // D) Page POSTs result (client response). NOTE: must come AFTER admin POST branch
    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const name = sp.get('name') || '';
        const page = name ? PAGES.get(name) : null;
        let payload;
        try {
          payload = body ? JSON.parse(body) : null;
        } catch {
          payload = { ok: false, error: { message: 'invalid JSON', stack: '' } };
        }

        if (page) {
          page.last = Date.now();
          const job = page.current;
          if (job && !job.done && job.res) {
            job.done = true;
            clearTimeout(job.timer);
            try {
              if (payload && payload.ok) {
                const v = payload.value === undefined ? null : payload.value;
                job.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                job.res.end(JSON.stringify(v));
              } else {
                const msg = payload?.error?.stack || payload?.error?.message || 'error';
                job.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
                job.res.end(String(msg));
              }
            } catch { }
          }
          if (page.current === job) {
            page.current = null;
            page.state = 'idle';
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    // Fallback
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
  }
  // ---------------------------------------------------------
}).listen(PORT, () => {
  console.log(`[serve] http://localhost:${PORT}/`);
});
