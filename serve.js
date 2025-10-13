#!/usr/bin/env node
// @ts-check

import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync, writeFileSync, watch } from 'node:fs';
import { join, normalize, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ────────────────────────────── constants & paths ───────────────────────────── */

const PORT = Number(process.env.PORT) || 8302;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = normalize(join(__dirname));

const DEBUG_FILE = join(ROOT, 'debug.js');
const DEBUG_SNIPPET_LIMIT = 50;                    // per docs
const DEBUG_HEADER_INTERVAL_MS = 1000;
const DEBUG_FILE_DEBOUNCE_MS = 150;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

const JOB_TIMEOUT_MS = 60_000;                     // per docs
const POLL_WAIT_MS = 10_000;

/* ──────────────────────────────── data shapes ───────────────────────────────── */

/**
 * @typedef {'idle'|'executing'} PageState
 * @typedef {{ status: 'ok' | 'error', duration: number, finishedAt: number, timeout: boolean }} Outcome
 * @typedef {{
 *   id: string,
 *   code: string,
 *   res: import('node:http').ServerResponse | null,
 *   done: boolean,
 *   timer: NodeJS.Timeout | null,
 *   page: Page,
 *   source: 'http'|'file',
 *   fragment: string | null,
 *   snippet: string,
 *   requestedAt: number,
 *   startedAt: number | null,   // set when HTTP response finishes (bytes flushed)
 *   finishedAt: number | null
 * }} Job
 * @typedef {{
 *   name: string,
 *   url: string,
 *   last: number,
 *   state: PageState,
 *   queue: Job[],
 *   current: Job | null,
 *   lastOutcome: Outcome | null,
 *   pendingPoll: { res: import('node:http').ServerResponse, timer: NodeJS.Timeout, dispatch: () => boolean } | null
 * }} Page
 */

/* ─────────────────────────────── page registry ──────────────────────────────── */

const Pages = (() => {
  /** @type {Map<string, Page>} */
  const PAGES = new Map();
  let lastCompletedName = null;

  /** @param {string} name @param {string} href */
  function getOrCreate(name, href) {
    const now = Date.now();
    let page = PAGES.get(name);
    if (!page) {
      page = { name, url: href || '', last: now, state: 'idle', queue: [], current: null, lastOutcome: null, pendingPoll: null };
      PAGES.set(name, page);
    } else {
      if (href) page.url = href;
      page.last = now;
      if (!('pendingPoll' in page)) page.pendingPoll = null;
    }
    return page;
  }

  /** @param {string} fragment */
  function findByFragment(fragment) {
    const needle = fragment.toLowerCase();
    for (const p of PAGES.values()) if (p.name.toLowerCase().includes(needle)) return p;
    return null;
  }

  function markLastCompleted(name) { lastCompletedName = name; }
  function getLastCompleted() { return lastCompletedName; }

  /** sorted list for header render */
  function listForHeader() {
    const arr = Array.from(PAGES.values());
    if (!arr.length) return [];
    arr.sort((a, b) => b.last - a.last);
    return arr;
  }

  return { getOrCreate, findByFragment, listForHeader, markLastCompleted, getLastCompleted, _all: () => PAGES };
})();

/* ─────────────────────────────── header formatting ──────────────────────────── */

const HeaderFmt = (() => {
  function numberFmt(value) {
    try { return Number(value).toLocaleString(); } catch { return String(value); }
  }
  function durationFmt(ms) {
    if (!ms || ms < 1000) return `${numberFmt(ms || 0)}ms`;
    const seconds = ms / 1000;
    return seconds >= 10 ? `${numberFmt(Math.round(ms))}ms` : `${seconds.toFixed(1)}s`;
  }
  function clockFmt(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  function snippet(code) {
    const inline = code.replace(/\s+/g, ' ').trim();
    return (inline.length <= DEBUG_SNIPPET_LIMIT) ? inline : `${inline.slice(0, DEBUG_SNIPPET_LIMIT - 1)}…`;
  }
  function idleLine(p) {
    return `// ${p.name} ${p.url || '-'} ${clockFmt(p.last)} idle`;
  }
  function execLine(p) {
    const j = p.current;
    const snip = j ? j.snippet : '';
    const startedTxt = (j && j.startedAt != null) ? clockFmt(j.startedAt) : '—';
    return `// ${p.name} ${p.url || '-'} ${clockFmt(p.last)} executing "${snip}" job=${j ? j.id : '-'} started=${startedTxt}`;
  }
  function outcomeLine(p) {
    const info = p.lastOutcome;
    if (!info) return idleLine(p);
    const dur = durationFmt(info.duration || 0);
    if (info.status === 'ok') return `// ${p.name} ${p.url || '-'} ${clockFmt(p.last)} completed in ${dur} (result below)`;
    const suffix = info.timeout ? '(timeout)' : '(see below)';
    return `// ${p.name} ${p.url || '-'} ${clockFmt(p.last)} failed after ${dur} ${suffix}`;
  }
  function buildHeaderLines() {
    const pages = Pages.listForHeader();
    if (!pages.length) return [];
    const lines = [];
    const used = new Set();

    const exec = pages.find(p => p.state === 'executing' && p.current);
    if (exec) { lines.push(execLine(exec)); used.add(exec.name); }
    else {
      const lastName = Pages.getLastCompleted();
      if (lastName) {
        const pinned = pages.find(p => p.name === lastName && p.lastOutcome);
        if (pinned) { lines.push(outcomeLine(pinned)); used.add(pinned.name); }
      }
    }
    for (const p of pages) {
      if (used.has(p.name)) continue;
      lines.push(p.lastOutcome ? outcomeLine(p) : idleLine(p));
    }
    return lines;
  }
  function introLine(kind, snip) {
    const label = kind === 'result' ? 'eval result for' : 'eval error for';
    return `// ${label}: ${snip}`;
  }
  return { snippet, buildHeaderLines, introLine };
})();

/* ─────────────────────────────── job lifecycle ──────────────────────────────── */

const Jobs = (() => {
  /** @type {Map<string, NodeJS.Timeout>} */
  const timers = new Map();
  let nextId = 1;

  /** @param {{ code:string, page:Page, source:'http'|'file', res?:import('node:http').ServerResponse|null, fragment?:string|null }} o */
  function create(o) {
    return /** @type {Job} */({
      id: String(nextId++),
      code: o.code,
      res: o.res || null,
      done: false,
      timer: null,
      page: o.page,
      source: o.source,
      fragment: o.fragment || null,
      snippet: HeaderFmt.snippet(o.code),
      requestedAt: Date.now(),
      startedAt: null,
      finishedAt: null
    });
  }

  /** @param {Page} page @param {Job} job */
  function enqueue(page, job) {
    page.queue.push(job);
    const t = setTimeout(() => onTimeout(job), JOB_TIMEOUT_MS);
    timers.set(job.id, t);
    job.timer = t;
    flushPendingPoll(page);
    FileHarness.refreshHeader(true);
  }

  /** @param {Job} job */
  function onTimeout(job) {
    if (job.done) return;
    const t = timers.get(job.id);
    if (t) { clearTimeout(t); timers.delete(job.id); }
    if (job.source === 'http') {
      if (job.res) { try { job.res.writeHead(504, { 'Content-Type': 'text/plain; charset=utf-8' }); job.res.end('timeout'); } catch { } }
      complete(job, { ok: false, error: 'timeout', timeout: true, httpAlreadySent: true });
      return;
    }
    complete(job, { ok: false, error: 'timeout', timeout: true });
  }

  /** @param {Page} page @param {Job} job @param {import('node:http').ServerResponse} res */
  function dispatchToPage(page, job, res) {
    page.current = job;
    page.state = 'executing';
    page.lastOutcome = null;
    Pages.markLastCompleted(null);

    if (job.source === 'file') FileHarness.clearBody();

    // startedAt measures "script delivered → result returned".
    res.once('finish', () => { job.startedAt = Date.now(); FileHarness.refreshHeader(true); });

    if (page.pendingPoll && page.pendingPoll.res !== res) { clearTimeout(page.pendingPoll.timer); page.pendingPoll = null; }
    FileHarness.refreshHeader(true);

    res.writeHead(200, {
      'Content-Type': MIME['.js'] || 'application/javascript',
      'x-job-id': job.id,
      'x-target-name': page.name
    });
    res.end(job.code);
  }

  /** @param {Job} job @param {{ ok:boolean, value?:any, error?:any, timeout?:boolean, httpAlreadySent?:boolean }} outcome */
  function complete(job, outcome) {
    if (job.done) return;
    job.done = true;

    const t = timers.get(job.id);
    if (t) { clearTimeout(t); timers.delete(job.id); }
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
    const dur = job.startedAt ? job.finishedAt - job.startedAt : 0;

    if (page) {
      page.lastOutcome = { status: outcome.ok ? 'ok' : 'error', duration: dur, finishedAt: job.finishedAt, timeout: !!outcome.timeout };
      Pages.markLastCompleted(page.name);
    }

    // HTTP: send reply unless already sent (timeout branch).
    if (job.source === 'http') {
      if (!outcome.httpAlreadySent && job.res) {
        try {
          if (outcome.ok) {
            const v = outcome.value === undefined ? null : outcome.value;
            job.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            job.res.end(JSON.stringify(v));
          } else {
            job.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            job.res.end(String(outcome.error));
          }
        } catch { }
      }
      job.res = null;
      FileHarness.refreshHeader(true);
      return;
    }

    // FILE MODE: write intro + payload body
    FileHarness.finishFileJob(outcome.ok, job.snippet, outcome.ok ? outcome.value : outcome.error);
  }

  function flushPendingPoll(page) {
    const p = page.pendingPoll;
    if (!p) return;
    if (page.state === 'executing') return;
    const dispatched = p.dispatch();
    if (dispatched) { clearTimeout(p.timer); page.pendingPoll = null; }
  }

  return { create, enqueue, dispatchToPage, complete, flushPendingPoll };
})();

/* ───────────────────────────────── file harness ─────────────────────────────── */

const FileHarness = (() => {
  /** @type {{ header: string[], body: string[], footer: string[], text: string }} */
  const view = { header: [], body: [], footer: [], text: '' };
  let activeFileJob = /** @type {Job|null} */(null);
  let debugReadTimer;
  let headerInterval;

  // Matches server-written status header lines:
  // // <name> <url|-> <HH:MM:SS> (idle|executing|completed|failed) ...
  const HEADER_STATUS_RE =
    /^\/\/\s+\S.*\s+(?:https?:\/\/\S+|-)\s+\d{2}:\d{2}:\d{2}\s+(?:idle|executing\b|completed\b|failed\b)/i;
  // Matches server-written intro/body notes (not user requests):
  // // eval result for: ..., // eval error for: ..., // invalid name..., // normal eval request...
  const INTRO_OR_NOTE_RE =
    /^\/\/\s+(?:eval\s+(?:result|error)\s+for:|invalid\s+name|normal\s+eval\s+request)/i;

  function boot() {
    try { if (!existsSync(DEBUG_FILE)) writeFileSync(DEBUG_FILE, '', 'utf8'); } catch { }
    readInitialState();
    refreshHeader(false);
    try { watch(DEBUG_FILE, debounceRead); } catch { }
    headerInterval = setInterval(() => { refreshHeader(false); debounceRead(); }, DEBUG_HEADER_INTERVAL_MS);
  }

  function readInitialState() {
    if (!existsSync(DEBUG_FILE)) { view.text = ''; view.header = []; view.body = []; view.footer = []; return; }
    try {
      const text = readFileSync(DEBUG_FILE, 'utf8');
      view.text = text;
      const lines = text.replace(/\r\n/g, '\n').split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      const header = [], body = [], footer = [];
      let section = 'header';
      for (const line of lines) {
        if (section === 'header') { if (!line.trim()) { section = 'body'; continue; } header.push(line); }
        else if (section === 'body') { if (!line.trim()) { section = 'footer'; continue; } body.push(line); }
        else { footer.push(line); }
      }
      view.header = header; view.body = body; view.footer = footer;
    } catch {
      view.text = ''; view.header = []; view.body = []; view.footer = [];
    }
  }

  function refreshHeader(force) {
    const header = HeaderFmt.buildHeaderLines();
    if (!existsSync(DEBUG_FILE)) return;

    // If body exists and there is no outcome line in the header, don't churn it.
    if (view.body.length) {
      const hasOutcomeLine = header.some((line) => /\b(completed|failed)\b/.test(line));
      if (!hasOutcomeLine) return;
    }

    if (!force && arraysEqual(header, view.header)) return;
    writeDebugFile(header, view.body, view.footer);
  }

  function writeDebugFile(header, body, footer) {
    view.header = header.slice();
    view.body = body.slice();
    view.footer = footer.slice();

    const sections = [];
    sections.push(...header);
    if (body.length) { if (sections.length) sections.push(''); sections.push(...body); }
    if (footer.length) { if (sections.length) sections.push(''); sections.push(...footer); }
    const text = sections.join('\n');
    const output = text ? `${text}\n` : '';
    if (output === view.text) return;
    view.text = output;
    writeFileSync(DEBUG_FILE, output, 'utf8');
  }

  function debounceRead() {
    if (debugReadTimer) clearTimeout(debugReadTimer);
    debugReadTimer = setTimeout(() => {
      debugReadTimer = undefined;
      let text = '';
      try { text = readFileSync(DEBUG_FILE, 'utf8'); } catch { readInitialState(); return; }
      if (text === view.text) return;
      onFileChanged(text);
    }, DEBUG_FILE_DEBOUNCE_MS);
  }

  function onFileChanged(text) {
    const normalized = text.replace(/\r\n/g, '\n');
    view.text = text;
    const lines = normalized.split('\n');

    // 1) Skip any top header/status lines and blanks.
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i += 1; continue; }
      if (HEADER_STATUS_RE.test(line)) { i += 1; continue; }
      break;
    }

    // 2) Find first comment line that is NOT a server status/intro/note → that's the fragment.
    let requestIndex = -1;
    for (; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (!line.startsWith('//')) continue;
      if (HEADER_STATUS_RE.test(line) || INTRO_OR_NOTE_RE.test(line)) continue;
      requestIndex = i;
      break;
    }

    if (requestIndex === -1) { refreshHeader(true); return; }

    const fragment = lines[requestIndex].slice(2).trim();
    const code = lines.slice(requestIndex + 1).join('\n');
    handleFileRequest(fragment, code);
  }

  function handleFileRequest(fragment, code) {
    if (!fragment) {
      const hdr = HeaderFmt.buildHeaderLines();
      writeDebugFile(hdr, [
        `// invalid name${fragment.length > 10 ? ', consider shorter pattern: ' : ':'}${fragment}`,
        '// normal eval request should include page name comment header, then JavaScript snippet'
      ], []);
      return;
    }
    if (!code.trim()) return;
    if (activeFileJob && !activeFileJob.done) return;

    const page = Pages.findByFragment(fragment);
    if (!page) {
      if (!/invalid\s+name/i.test(fragment)) {
        const hdr = HeaderFmt.buildHeaderLines();
        writeDebugFile(hdr, [
          `// invalid name${fragment.length > 10 ? ', consider shorter pattern: ' : ':'}${fragment}`,
          '// normal eval request should include page name comment header, then JavaScript snippet'
        ], []);
      }
      return;
    }

    const job = Jobs.create({ code, page, source: 'file', fragment });
    activeFileJob = job;
    Jobs.enqueue(page, job);
  }

  function clearBody() { view.body = []; view.footer = []; }

  function finishFileJob(ok, snippet, payload) {
    activeFileJob = null;
    const header = HeaderFmt.buildHeaderLines();
    if (ok) {
      const body = buildResultBody(payload);
      writeDebugFile(header, [HeaderFmt.introLine('result', snippet), ...body], []);
    } else {
      const body = buildErrorBody(payload);
      writeDebugFile(header, [HeaderFmt.introLine('error', snippet), ...body], []);
    }
  }

  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function buildResultBody(value) {
    const json = JSON.stringify(value, null, 2) || 'null';
    const lines = json.split('\n');
    const body = [`var result = ${lines[0] || ''}`];
    for (let i = 1; i < lines.length; i++) body.push(lines[i]);
    return body;
  }

  function buildErrorBody(error) {
    const text = error && typeof error === 'object' && error.stack ? String(error.stack) : String(error);
    return text.split('\n');
  }

  return { boot, refreshHeader, clearBody, finishFileJob };
})();

/* ───────────────────────────────── client script ────────────────────────────── */

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
    const time = new Date().toLocaleTimeString().replace(/[^\d]/g, '-');
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
        const value = await(0, eval)(script);
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

/* ────────────────────────────────── HTTP API ────────────────────────────────── */

const HttpApi = (() => {
  function notFound(res, msg = 'Not found') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
  }
  function bad(res, msg = 'Bad request') {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(msg);
  }

  /** GET /serve.js (no params): list active tabs */
  function listTabs(res) {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    const lines = [];
    for (const [name, p] of Pages._all()) lines.push(`${name}\t${p.url || '-'}\t${new Date(p.last).toISOString()}\t${p.state}`);
    res.end(lines.join('\n') + (lines.length ? '\n' : ''));
  }

  /** Admin GET eval */
  function adminEvalGET(res, sp) {
    const frag = sp.get('name') || '';
    const code = sp.get('eval') || '';
    if (!frag) return bad(res, 'eval requires &name=<id-fragment>');
    const page = Pages.findByFragment(frag);
    if (!page) return notFound(res, 'No page matches name fragment: ' + frag);
    const job = Jobs.create({ code, page, res, source: 'http' });
    Jobs.enqueue(page, job);
  }

  /** Admin POST eval body (?eval=post) */
  function adminEvalPOST(req, res, sp) {
    const frag = sp.get('name') || '';
    if (!frag) return bad(res, 'eval requires &name=<id-fragment>');
    const page = Pages.findByFragment(frag);
    if (!page) return notFound(res, 'No page matches name fragment: ' + frag);

    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const code = body || '';
      if (!code) return bad(res, 'empty body');
      const job = Jobs.create({ code, page, res, source: 'http' });
      Jobs.enqueue(page, job);
    });
  }

  /** Page GET poll */
  function pagePollGET(req, res, sp) {
    const qName = sp.get('name') || '';
    const qUrl = sp.get('url') || '';
    const page = Pages.getOrCreate(qName, qUrl);

    const dispatch = () => {
      if (page.state === 'executing') return false;
      const job = page.queue.shift();
      if (!job) return false;
      Jobs.dispatchToPage(page, job, res);
      return true;
    };

    if (dispatch()) return;

    if (page.pendingPoll) {
      try { page.pendingPoll.res.writeHead(200, { 'Content-Type': MIME['.js'] || 'application/javascript' }); page.pendingPoll.res.end(''); } catch { }
      clearTimeout(page.pendingPoll.timer);
    }

    const timer = setTimeout(() => {
      page.pendingPoll = null;
      try { res.writeHead(200, { 'Content-Type': MIME['.js'] || 'application/javascript' }); res.end(''); } catch { }
    }, POLL_WAIT_MS);

    page.pendingPoll = { res, timer, dispatch };
    req.on('close', () => { if (page.pendingPoll && page.pendingPoll.res === res) { clearTimeout(page.pendingPoll.timer); page.pendingPoll = null; } });
    Jobs.flushPendingPoll(page);
  }

  /** Page POST result */
  function pagePostResult(req, res, sp) {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const name = sp.get('name') || '';
      const page = name ? Pages._all().get(name) : null;
      let payload;
      try { payload = body ? JSON.parse(body) : null; }
      catch { payload = { ok: false, error: { message: 'invalid JSON', stack: '' } }; }

      if (page) {
        page.last = Date.now();
        const job = page.current;
        if (job && !job.done) {
          if (payload && payload.ok) Jobs.complete(job, { ok: true, value: payload.value });
          else {
            const msg = payload?.error?.stack || payload?.error?.message || 'error';
            Jobs.complete(job, { ok: false, error: msg });
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  }

  return { notFound, bad, listTabs, adminEvalGET, adminEvalPOST, pagePollGET, pagePostResult };
})();

/* ──────────────────────────────── server bootstrap ──────────────────────────── */

FileHarness.boot();

createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/poll') { res.writeHead(204).end(); return; }

  // Map directories to index.html, root to /index.html
  let p = url.pathname;
  if (p.endsWith('/')) p += 'index.html';
  if (p === '/') p = '/index.html';

  const file = join(ROOT, p);
  if (!existsSync(file)) return HttpApi.notFound(res);

  // Special route: this file doubles as the admin endpoint (/serve.js).
  if (file === __filename) {
    const sp = url.searchParams;
    const hasName = !!sp.get('name');
    const hasEval = sp.has('eval');
    const isPostEval = sp.get('eval') === 'post';

    // A) List tabs
    if (req.method === 'GET' && !hasEval && !hasName && !sp.get('url')) return HttpApi.listTabs(res);

    // B) Admin eval via GET
    if (req.method === 'GET' && hasEval) return HttpApi.adminEvalGET(res, sp);

    // B2) Admin eval via POST body (?eval=post)
    if (req.method === 'POST' && isPostEval) return HttpApi.adminEvalPOST(req, res, sp);

    // C) Page poll (GET with &name=)
    if (req.method === 'GET' && hasName) return HttpApi.pagePollGET(req, res, sp);

    // D) Page posts result
    if (req.method === 'POST') return HttpApi.pagePostResult(req, res, sp);

    return HttpApi.bad(res);
  }

  // Serve .html with client injector; others streamed.
  const type = MIME[extname(file)] || 'application/octet-stream';
  if (extname(file) === '.html') {
    res.writeHead(200, { 'Content-Type': type });
    res.end(readFileSync(file, 'utf8') + '\n<script>\n' + '(function(){inject();\n' + inject + '\n})()\n' + '</script>');
    return;
  }

  res.writeHead(200, { 'Content-Type': type });
  createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`[serve] http://localhost:${PORT}/`);
});
