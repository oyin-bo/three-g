#!/usr/bin/env node
// @ts-check

import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync, writeFileSync, watch } from 'node:fs';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8302;
const __filename = fileURLToPath(import.meta.url);
const ROOT = normalize(join(__filename, '..'));

const DEBUG_FILE = join(ROOT, 'debug.js');
const DEBUG_SNIPPET_LIMIT = 50;
const DEBUG_HEADER_INTERVAL_MS = 1000;
const DEBUG_FILE_DEBOUNCE_MS = 150;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

// ---------- pages + jobs ----------
const PAGES = new Map(); // name -> { name, url, last, state, queue: Job[], current: Job|null }
let NEXT_JOB_ID = 1;
const JOB_TIMEOUT_MS = 60000;
const JOB_TIMERS = new Map();

const fileView = { header: [], body: [], footer: [], text: '' };
let activeFileJob = null;
let debugReadTimer;
let headerInterval;
let lastCompletedPageName = null;

initFileHarness();

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

function initFileHarness() {
  ensureDebugFile();
  refreshDebugFile(true);
  try {
    watch(DEBUG_FILE, scheduleDebugRead);
  } catch {
  }
  headerInterval = setInterval(() => refreshDebugFile(false), DEBUG_HEADER_INTERVAL_MS);
}

function ensureDebugFile() {
  if (!existsSync(DEBUG_FILE)) {
    writeFileSync(DEBUG_FILE, '', 'utf8');
  }
}

function refreshDebugFile(force) {
  const header = buildHeaderLines();
  if (!force && arraysEqual(header, fileView.header)) return;
  writeDebugFile(header, fileView.body, fileView.footer);
}

function writeDebugFile(header, body, footer) {
  fileView.header = header.slice();
  fileView.body = body.slice();
  fileView.footer = footer.slice();
  const sections = [];
  sections.push(...header);
  if (body.length) {
    if (sections.length) sections.push('');
    sections.push(...body);
  }
  if (footer.length) {
    if (sections.length) sections.push('');
    sections.push(...footer);
  }
  const text = sections.join('\n');
  const output = text ? `${text}\n` : '';
  if (output === fileView.text) return;
  fileView.text = output;
  writeFileSync(DEBUG_FILE, output, 'utf8');
}

function scheduleDebugRead() {
  if (debugReadTimer) clearTimeout(debugReadTimer);
  debugReadTimer = setTimeout(() => {
    debugReadTimer = undefined;
    let text = '';
    try {
      text = readFileSync(DEBUG_FILE, 'utf8');
    } catch {
      return;
    }
    if (text === fileView.text) return;
    handleDebugFileChange(text);
  }, DEBUG_FILE_DEBOUNCE_MS);
}

function handleDebugFileChange(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const header = fileView.header;
  let matchesHeader = lines.length >= header.length;
  if (matchesHeader) {
    for (let i = 0; i < header.length; i += 1) {
      if (lines[i] !== header[i]) { matchesHeader = false; break; }
    }
  }
  if (!matchesHeader) {
    refreshDebugFile(true);
    return;
  }
  let index = header.length;
  while (index < lines.length && !lines[index].trim()) index += 1;
  if (index >= lines.length) return;
  const first = lines[index];
  if (!first.startsWith('//')) {
    refreshDebugFile(true);
    return;
  }
  const fragment = first.slice(2).trim();
  const code = lines.slice(index + 1).join('\n');
  handleFileRequest(fragment, code);
}

function handleFileRequest(fragment, code) {
  if (!fragment) {
    writeDebugFile(buildHeaderLines(), [`// page not found for "${fragment}"`], []);
    return;
  }
  if (!code.trim()) return;
  if (activeFileJob && !activeFileJob.done) return;

  const page = findPageByFragment(fragment);
  if (!page) {
    writeDebugFile(buildHeaderLines(), [`// page not found for "${fragment}"`], []);
    return;
  }

  resetCompletionStates();
  fileView.body = [];
  fileView.footer = [];

  const job = createJob({ code, page, source: 'file', fragment });
  activeFileJob = job;
  queuePageJob(page, job);
}

function resetCompletionStates() {
  lastCompletedPageName = null;
  for (const page of PAGES.values()) page.lastOutcome = null;
}

function findPageByFragment(fragment) {
  const needle = fragment.toLowerCase();
  for (const page of PAGES.values()) {
    if (page.name.toLowerCase().includes(needle)) return page;
  }
  return null;
}

function createJob(options) {
  return {
    id: String(NEXT_JOB_ID++),
    code: options.code,
    res: options.res || null,
    done: false,
    timer: null,
    page: options.page,
    source: options.source,
    fragment: options.fragment || null,
    snippet: formatSnippet(options.code),
    requestedAt: Date.now(),
    startedAt: null,
    finishedAt: null
  };
}

function queuePageJob(page, job) {
  page.queue.push(job);
  const timer = setTimeout(() => handleJobTimeout(job), JOB_TIMEOUT_MS);
  JOB_TIMERS.set(job.id, timer);
  job.timer = timer;
  refreshDebugFile(true);
}

function handleJobTimeout(job) {
  if (job.done) return;
  if (JOB_TIMERS.has(job.id)) {
    clearTimeout(JOB_TIMERS.get(job.id));
    JOB_TIMERS.delete(job.id);
  }
  if (job.source === 'http') {
    if (job.res) {
      try {
        job.res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' });
        job.res.end('timeout');
      } catch {
      }
    }
    completeJob(job, { ok: false, error: 'timeout', timeout: true, httpAlreadySent: true });
    return;
  }
  completeJob(job, { ok: false, error: 'timeout', timeout: true });
}

function dispatchJobToPage(page, job, res) {
  page.current = job;
  page.state = 'executing';
  job.startedAt = Date.now();
  refreshDebugFile(true);
  res.writeHead(200, {
    'Content-Type': MIME['.js'] || 'application/javascript',
    'x-job-id': job.id,
    'x-target-name': page.name
  });
  res.end(job.code);
}

function completeJob(job, outcome) {
  if (job.done) return;
  job.done = true;
  if (JOB_TIMERS.has(job.id)) {
    clearTimeout(JOB_TIMERS.get(job.id));
    JOB_TIMERS.delete(job.id);
  }
  if (job.timer) {
    clearTimeout(job.timer);
    job.timer = null;
  }
  const page = job.page;
  if (page) {
    const idx = page.queue.indexOf(job);
    if (idx >= 0) page.queue.splice(idx, 1);
    if (page.current === job) page.current = null;
    if (page.state === 'executing') page.state = 'idle';
  }
  job.finishedAt = Date.now();
  const duration = job.startedAt ? job.finishedAt - job.startedAt : 0;
  if (page) {
    page.lastOutcome = {
      status: outcome.ok ? 'ok' : 'error',
      duration,
      finishedAt: job.finishedAt,
      timeout: !!outcome.timeout
    };
    lastCompletedPageName = page.name;
  }
  if (job.source === 'http') {
    if (!outcome.httpAlreadySent && job.res) {
      try {
        if (outcome.ok) {
          const value = outcome.value === undefined ? null : outcome.value;
          job.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          job.res.end(JSON.stringify(value));
        } else {
          job.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          job.res.end(String(outcome.error));
        }
      } catch {
      }
    }
    job.res = null;
    refreshDebugFile(true);
    return;
  }
  activeFileJob = null;
  if (outcome.ok) {
    writeDebugFile(buildHeaderLines(), buildResultBody(outcome.value, job), []);
  } else {
    writeDebugFile(buildHeaderLines(), buildErrorBody(outcome.error, job), []);
  }
}

function buildHeaderLines() {
  const pages = Array.from(PAGES.values());
  if (!pages.length) return [];
  pages.sort((a, b) => b.last - a.last);
  const lines = [];
  const used = new Set();

  const executing = pages.find((page) => page.state === 'executing' && page.current);
  if (executing) {
    lines.push(formatExecutingLine(executing));
    used.add(executing.name);
  } else if (lastCompletedPageName) {
    const pinned = pages.find((page) => page.name === lastCompletedPageName && page.lastOutcome);
    if (pinned) {
      lines.push(formatOutcomeLine(pinned));
      used.add(pinned.name);
    }
  }

  for (const page of pages) {
    if (used.has(page.name)) continue;
    if (page.lastOutcome) {
      lines.push(formatOutcomeLine(page));
    } else {
      lines.push(formatIdleLine(page));
    }
  }
  return lines;
}

function formatIdleLine(page) {
  return `// ${page.name} ${page.url || '-'} ${formatClock(page.last)} idle`;
}

function formatExecutingLine(page) {
  const job = page.current;
  const snippet = job ? job.snippet : '';
  const started = formatClock(job ? job.startedAt || job.requestedAt : page.last);
  return `// ${page.name} ${page.url || '-'} ${formatClock(page.last)} executing "${snippet}" job=${job ? job.id : '-'} started=${started}`;
}

function formatOutcomeLine(page) {
  const info = page.lastOutcome;
  if (!info) return formatIdleLine(page);
  const durationText = formatDuration(info.duration || 0);
  if (info.status === 'ok') {
    return `// ${page.name} ${page.url || '-'} ${formatClock(page.last)} completed in ${durationText} (result below)`;
  }
  const suffix = info.timeout ? '(timeout)' : '(see below)';
  return `// ${page.name} ${page.url || '-'} ${formatClock(page.last)} failed after ${durationText} ${suffix}`;
}

function formatSnippet(code) {
  const inline = code.replace(/\s+/g, ' ').trim();
  if (inline.length <= DEBUG_SNIPPET_LIMIT) return inline;
  return `${inline.slice(0, DEBUG_SNIPPET_LIMIT - 1)}…`;
}

function formatDuration(duration) {
  if (!duration || duration < 1000) return `${formatNumber(duration || 0)}ms`;
  const seconds = duration / 1000;
  return seconds >= 10 ? `${formatNumber(Math.round(duration))}ms` : `${seconds.toFixed(1)}s`;
}

function formatClock(ms) {
  const date = new Date(ms);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function formatNumber(value) {
  try {
    return Number(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function buildResultBody(value, job) {
  const json = JSON.stringify(value, null, 2) || 'null';
  const lines = json.split('\n');
  const body = [`var result = ${lines[0] || ''}`];
  for (let i = 1; i < lines.length; i += 1) body.push(lines[i]);
  body.push(`// finished=${new Date(job.finishedAt).toISOString()} duration=${formatNumber(job.startedAt ? job.finishedAt - job.startedAt : 0)}ms`);
  return body;
}

function buildErrorBody(error, job) {
  const text = error && typeof error === 'object' && error.stack ? String(error.stack) : String(error);
  const body = text.split('\n');
  body.push(`// finished=${new Date(job.finishedAt).toISOString()} duration=${formatNumber(job.startedAt ? job.finishedAt - job.startedAt : 0)}ms`);
  return body;
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
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
        page = { name, url: href || '', last: now, state: 'idle', queue: [], current: null, lastOutcome: null };
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
