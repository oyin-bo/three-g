#!/usr/bin/env node
// @ts-check

import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync, writeFileSync, watch } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 8302;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = normalize(join(__dirname));

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
/** @typedef {{ id:string, code:string, res: import('node:http').ServerResponse|null, done:boolean, timer: NodeJS.Timeout|null, page:any, source:'http'|'file', fragment:string|null, snippet:string, requestedAt:number, startedAt:number|null, finishedAt:number|null }} Job */

const PAGES = new Map(); // name -> { name, url, last, state, queue: Job[], current: Job|null, lastOutcome: any, pendingPoll: any }
let NEXT_JOB_ID = 1;
const JOB_TIMEOUT_MS = 60000;
const JOB_TIMERS = new Map();
const POLL_WAIT_MS = 10000;

const fileView = /** @type {{ header: string[]; body: string[]; footer: string[]; text: string }} */ ({ header: [], body: [], footer: [], text: '' });
let activeFileJob = /** @type {Job|null} */(null);
let debugReadTimer;
let headerInterval;
let lastCompletedPageName = null;

/* ---------------- boot ---------------- */
initFileHarness();

/* ---------------- utils ---------------- */
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

/* ---------------- file harness ---------------- */
function initFileHarness() {
  try { if (!existsSync(DEBUG_FILE)) writeFileSync(DEBUG_FILE, '', 'utf8'); } catch { }
  initializeDebugFileState();
  refreshDebugFile(false);
  try { watch(DEBUG_FILE, scheduleDebugRead); } catch { }
  headerInterval = setInterval(() => {
    refreshDebugFile(false);
    scheduleDebugRead();
  }, DEBUG_HEADER_INTERVAL_MS);
}

function initializeDebugFileState() {
  if (existsSync(DEBUG_FILE)) {
    try {
      const text = readFileSync(DEBUG_FILE, 'utf8');
      fileView.text = text;
      const normalized = text.replace(/\r\n/g, '\n');
      const lines = normalized.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const header = [], body = [], footer = [];
      let section = 'header';
      for (const line of lines) {
        if (section === 'header') { if (!line.trim()) { section = 'body'; continue; } header.push(line); }
        else if (section === 'body') { if (!line.trim()) { section = 'footer'; continue; } body.push(line); }
        else { footer.push(line); }
      }
      fileView.header = header; fileView.body = body; fileView.footer = footer;
    } catch {
      fileView.text = ''; fileView.header = []; fileView.body = []; fileView.footer = [];
    }
  } else {
    fileView.text = ''; fileView.header = []; fileView.body = []; fileView.footer = [];
  }
}

function refreshDebugFile(force) {
  const header = buildHeaderLines();
  if (!existsSync(DEBUG_FILE)) return;
  if (fileView.body.length) {
    const hasOutcomeLine = header.some((line) => /\b(completed|failed)\b/.test(line));
    if (!hasOutcomeLine) return;
  }
  if (!force && arraysEqual(header, fileView.header)) return;
  writeDebugFile(header, fileView.body, fileView.footer);
}

function writeDebugFile(header, body, footer) {
  fileView.header = header.slice();
  fileView.body = body.slice();
  fileView.footer = footer.slice();
  const sections = [];
  sections.push(...header);
  if (body.length) { if (sections.length) sections.push(''); sections.push(...body); }
  if (footer.length) { if (sections.length) sections.push(''); sections.push(...footer); }
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
    try { text = readFileSync(DEBUG_FILE, 'utf8'); } catch { initializeDebugFileState(); return; }
    if (text === fileView.text) return;
    handleDebugFileChange(text);
  }, DEBUG_FILE_DEBOUNCE_MS);
}

function handleDebugFileChange(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  fileView.text = text;
  const lines = normalized.split('\n');
  const header = fileView.header;
  let index = 0, headerIndex = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (headerIndex < header.length && line === header[headerIndex]) { headerIndex += 1; index += 1; continue; }
    if (line.startsWith('//')) {
      const fragment = line.slice(2).trim();
      const codeLines = lines.slice(index + 1);
      handleFileRequest(fragment, codeLines.join('\n'));
      return;
    }
    break;
  }
  refreshDebugFile(true);
}

function handleFileRequest(fragment, code) {
  if (!fragment) { writeDebugFile(buildHeaderLines(), [`// page not found for "${fragment}"`], []); return; }
  if (!code.trim()) return;
  if (activeFileJob && !activeFileJob.done) return;

  const page = findPageByFragment(fragment);
  if (!page) { writeDebugFile(buildHeaderLines(), [`// page not found for "${fragment}"`], []); return; }

  const job = createJob({ code, page, source: 'file', fragment });
  activeFileJob = job;
  queuePageJob(page, job);
}

function findPageByFragment(fragment) {
  const needle = fragment.toLowerCase();
  for (const page of PAGES.values()) if (page.name.toLowerCase().includes(needle)) return page;
  return null;
}

/* ---------------- job pipeline ---------------- */
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
    startedAt: null,     // set when HTTP response finishes (bytes flushed)
    finishedAt: null
  };
}

function queuePageJob(page, job) {
  page.queue.push(job);
  const timer = setTimeout(() => handleJobTimeout(job), JOB_TIMEOUT_MS);
  JOB_TIMERS.set(job.id, timer);
  job.timer = timer;
  flushPendingPoll(page);
  refreshDebugFile(true);
}

function handleJobTimeout(job) {
  if (job.done) return;
  if (JOB_TIMERS.has(job.id)) { clearTimeout(JOB_TIMERS.get(job.id)); JOB_TIMERS.delete(job.id); }
  if (job.source === 'http') {
    if (job.res) { try { job.res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' }); job.res.end('timeout'); } catch { } }
    completeJob(job, { ok: false, error: 'timeout', timeout: true, httpAlreadySent: true });
    return;
  }
  completeJob(job, { ok: false, error: 'timeout', timeout: true });
}

function dispatchJobToPage(page, job, res) {
  page.current = job;
  page.state = 'executing';
  page.lastOutcome = null;
  lastCompletedPageName = null;

  if (job.source === 'file') { fileView.body = []; fileView.footer = []; }

  // Measure only the "script delivered → result returned" window.
  res.once('finish', () => { job.startedAt = Date.now(); refreshDebugFile(true); });

  if (page.pendingPoll && page.pendingPoll.res !== res) { clearTimeout(page.pendingPoll.timer); page.pendingPoll = null; }
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

  if (JOB_TIMERS.has(job.id)) { clearTimeout(JOB_TIMERS.get(job.id)); JOB_TIMERS.delete(job.id); }
  if (job.timer) { clearTimeout(job.timer); job.timer = null; }

  const page = job.page;
  if (page) {
    const idx = page.queue.indexOf(job);
    if (idx >= 0) page.queue.splice(idx, 1);
    if (page.current === job) page.current = null;
    if (page.state === 'executing') page.state = 'idle';
    flushPendingPoll(page);
  }

  job.finishedAt = Date.now();
  const duration = job.startedAt ? job.finishedAt - job.startedAt : 0;

  if (page) {
    page.lastOutcome = { status: outcome.ok ? 'ok' : 'error', duration, finishedAt: job.finishedAt, timeout: !!outcome.timeout };
    lastCompletedPageName = page.name;
  }

  // HTTP clients still get their response directly
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
      } catch { }
    }
    job.res = null;
    refreshDebugFile(true);
    return;
  }

  // FILE MODE: write a small second-header line (snippet) above the body payload.
  activeFileJob = null;
  if (outcome.ok) {
    const core = buildResultBody(outcome.value);
    writeDebugFile(buildHeaderLines(), buildIntroLine('result', job.snippet).concat(core), []);
  } else {
    const core = buildErrorBody(outcome.error);
    writeDebugFile(buildHeaderLines(), buildIntroLine('error', job.snippet).concat(core), []);
  }
}

function flushPendingPoll(page) {
  const pending = page.pendingPoll;
  if (!pending) return;
  if (page.state === 'executing') return;
  const dispatched = pending.dispatch();
  if (dispatched) { clearTimeout(pending.timer); page.pendingPoll = null; }
}

/* ---------------- header + formatting ---------------- */
function buildHeaderLines() {
  const pages = Array.from(PAGES.values());
  if (!pages.length) return [];
  pages.sort((a, b) => b.last - a.last);
  const lines = [];
  const used = new Set();

  const executing = pages.find((page) => page.state === 'executing' && page.current);
  if (executing) { lines.push(formatExecutingLine(executing)); used.add(executing.name); }
  else if (lastCompletedPageName) {
    const pinned = pages.find((page) => page.name === lastCompletedPageName && page.lastOutcome);
    if (pinned) { lines.push(formatOutcomeLine(pinned)); used.add(pinned.name); }
  }

  for (const page of pages) {
    if (used.has(page.name)) continue;
    if (page.lastOutcome) lines.push(formatOutcomeLine(page));
    else lines.push(formatIdleLine(page));
  }
  return lines;
}

function formatIdleLine(page) {
  return `// ${page.name} ${page.url || '-'} ${formatClock(page.last)} idle`;
}

function formatExecutingLine(page) {
  const job = page.current;
  const snippet = job ? job.snippet : '';
  const startedTxt = (job && job.startedAt != null) ? formatClock(job.startedAt) : '—';
  return `// ${page.name} ${page.url || '-'} ${formatClock(page.last)} executing "${snippet}" job=${job ? job.id : '-'} started=${startedTxt}`;
}

function formatOutcomeLine(page) {
  const info = page.lastOutcome;
  if (!info) return formatIdleLine(page);
  const durationText = formatDuration(info.duration || 0);
  if (info.status === 'ok') return `// ${page.name} ${page.url || '-'} ${formatClock(page.last)} completed in ${durationText} (result below)`;
  const suffix = info.timeout ? '(timeout)' : '(see below)';
  return `// ${page.name} ${page.url || '-'} ${formatClock(page.last)} failed after ${durationText} ${suffix}`;
}

function buildIntroLine(kind, snippet) {
  const label = kind === 'result' ? 'eval result for' : 'eval error for';
  // This line becomes the first line of the BODY; header->(blank)->intro->payload
  return [`// ${label}: ${snippet}`];
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
  try { return Number(value).toLocaleString(); } catch { return String(value); }
}

function buildResultBody(value) {
  const json = JSON.stringify(value, null, 2) || 'null';
  const lines = json.split('\n');
  const body = [`var result = ${lines[0] || ''}`];
  for (let i = 1; i < lines.length; i += 1) body.push(lines[i]);
  return body;
}

function buildErrorBody(error) {
  const text = error && typeof error === 'object' && error.stack ? String(error.stack) : String(error);
  return text.split('\n');
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/* ---------------- client injection ---------------- */
async function inject() {
  console.log('injected>>>');
  let name = sessionStorage.getItem('tabName');
  if (!name) {
    const n = Math.floor(Math.random() * (19 - 5 + 1)) + 5;
    const words = [
      'mint,nova,ember,zen,lumen,oak,river,kite,moss,nook,sol,vibe',
      'dune,opal,brim,echo,fern,halo,iris,loom,meadow,pulse,quill,reef',
      'sage,tide,veil,willow,flare,hearth,drift,grove,haze,ivy,knoll,lark',
      'mist,nest,pebble,quartz,rift,spire,trail,vale,whisper,yarn,zephyr,glow'
    ].join(',').split(',');
    const w = words[Math.floor(Math.random() * words.length)];
    const time = new Date().toLocaleTimeString();
    name = `${n}-${w}-${time}`;
    sessionStorage.setItem('tabName', name);
  }

  const endpoint = '/serve.js' + '?name=' + encodeURIComponent(name) + '&url=' + encodeURIComponent(location.href);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  while (true) {
    try {
      const response = await fetch(endpoint, { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } });
      const script = await response.text();
      const headers = {}; response.headers.forEach((value, key) => { headers[key] = value; });

      if (!script) { await sleep(300); continue; }

      let payload;
      try {
        const value = await (0, eval)(script);
        try { payload = JSON.stringify({ ok: true, value }); }
        catch { payload = JSON.stringify({ ok: true, value: String(value) }); }
      } catch (err) {
        payload = JSON.stringify({ ok: false, error: { message: err?.message || String(err), stack: err?.stack || null } });
      }

      await fetch(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: payload });
      await sleep(100);
    } catch (error) {
      console.warn('[injected] fetch failed:', error);
      await sleep(3000 * Math.random() + 500);
      continue;
    }
  }
}

/* ---------------- server ---------------- */
createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/poll') { res.writeHead(204).end(); return; }

  let p = url.pathname;
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/') p = '/index.html';

  const file = join(ROOT, p);
  if (!existsSync(file)) return res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');

  if (file === __filename) { handlePollServer(); return; }

  const type = MIME[extname(file)] || 'application/octet-stream';
  if (extname(file) === '.html') {
    res.writeHead(200, { 'Content-Type': type });
    res.end(readFileSync(file, 'utf8') + '\n<script>\n' + '(function(){inject();\n' + inject + '\n})()\n' + '</script>');
    return;
  }

  res.writeHead(200, { 'Content-Type': type });
  createReadStream(file).pipe(res);

  function handlePollServer() {
    const sp = url.searchParams;
    const qName = sp.get('name') || '';
    const qUrl = sp.get('url') || '';
    const qEval = getRawParam(req.url || '', 'eval');

    function pageFor(name, href) {
      const now = Date.now();
      let page = PAGES.get(name);
      if (!page) { page = { name, url: href || '', last: now, state: 'idle', queue: [], current: null, lastOutcome: null, pendingPoll: null }; PAGES.set(name, page); }
      else if (!('pendingPoll' in page)) page.pendingPoll = null;
      if (href) page.url = href;
      page.last = now;
      return page;
    }

    // A) List active tabs
    if (req.method === 'GET' && !qEval && !qName && !qUrl) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      const lines = [];
      for (const [name, p] of PAGES) lines.push(`${name}\t${p.url || '-'}\t${new Date(p.last).toISOString()}\t${p.state}`);
      res.end(lines.join('\n') + (lines.length ? '\n' : ''));
      return;
    }

    // B) Admin GET eval
    if (req.method === 'GET' && qEval != null) {
      if (!qName) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('eval requires &name=<id-fragment>'); return; }
      const needle = qName.toLowerCase();
      let page = null;
      for (const [name, p] of PAGES) { if (name.toLowerCase().includes(needle)) { page = p; break; } }
      if (!page) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No page matches name fragment: ' + qName); return; }
      const job = createJob({ code: qEval, page, res, source: 'http' });
      queuePageJob(page, job);
      return;
    }

    // B2) Admin POST eval body (?eval=post)
    if (req.method === 'POST' && qEval === 'post') {
      if (!qName) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('eval requires &name=<id-fragment>'); return; }
      const needle = qName.toLowerCase();
      let page = null;
      for (const [name, p] of PAGES) { if (name.toLowerCase().includes(needle)) { page = p; break; } }
      if (!page) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No page matches name fragment: ' + qName); return; }

      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const code = body || '';
        if (!code) { res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('empty body'); return; }
        const job = createJob({ code, page, res, source: 'http' });
        queuePageJob(page, job);
      });
      return;
    }

    // C) Page poll
    if (req.method === 'GET' && qName) {
      const page = pageFor(qName, qUrl);

      const dispatch = () => {
        if (page.state === 'executing') return false;
        const job = page.queue.shift();
        if (!job) return false;
        dispatchJobToPage(page, job, res);
        return true;
      };

      if (dispatch()) return;

      if (page.pendingPoll) { try { page.pendingPoll.res.writeHead(200, { 'Content-Type': MIME['.js'] || 'application/javascript' }); page.pendingPoll.res.end(''); } catch { } clearTimeout(page.pendingPoll.timer); }

      const timer = setTimeout(() => {
        page.pendingPoll = null;
        try { res.writeHead(200, { 'Content-Type': MIME['.js'] || 'application/javascript' }); res.end(''); } catch { }
      }, POLL_WAIT_MS);

      page.pendingPoll = { res, timer, dispatch };
      req.on('close', () => { if (page.pendingPoll && page.pendingPoll.res === res) { clearTimeout(page.pendingPoll.timer); page.pendingPoll = null; } });
      flushPendingPoll(page);
      return;
    }

    // D) Page POSTs result
    if (req.method === 'POST') {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const name = sp.get('name') || '';
        const page = name ? PAGES.get(name) : null;
        let payload;
        try { payload = body ? JSON.parse(body) : null; }
        catch { payload = { ok: false, error: { message: 'invalid JSON', stack: '' } }; }

        if (page) {
          page.last = Date.now();
          const job = page.current;
          if (job && !job.done) {
            if (payload && payload.ok) completeJob(job, { ok: true, value: payload.value });
            else {
              const msg = payload?.error?.stack || payload?.error?.message || 'error';
              completeJob(job, { ok: false, error: msg });
            }
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }

    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad request');
  }
}).listen(PORT, () => {
  console.log(`[serve] http://localhost:${PORT}/`);
});
