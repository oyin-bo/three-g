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

const DEBUG_FILE = join(ROOT, 'debug.md');
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

/* ─────────────────────────────── Markdown formatting ──────────────────────────── */

const MarkdownFmt = (() => {
  function clockFmt(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  
  function durationMs(startMs, endMs) {
    if (!startMs || !endMs) return null;
    return endMs - startMs;
  }
  
  function buildConnectedPages() {
    const pages = Pages.listForHeader();
    if (!pages.length) return [];
    const lines = ['# Connected pages:'];
    for (const p of pages) {
      lines.push(`* [${p.name}](${p.url || 'http://localhost:8302/'}) last ${clockFmt(p.last)}`);
    }
    return lines;
  }
  
  return { clockFmt, durationMs, buildConnectedPages };
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
      snippet: o.code.replace(/\s+/g, ' ').trim().slice(0, 100),
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

    if (job.source === 'file') FileHarness.writeExecutingStatus(job);

    // startedAt measures "script delivered → result returned".
    res.once('finish', () => { job.startedAt = Date.now(); });

    if (page.pendingPoll && page.pendingPoll.res !== res) { clearTimeout(page.pendingPoll.timer); page.pendingPoll = null; }

    res.writeHead(200, {
      'Content-Type': MIME['.js'] || 'application/javascript',
      'x-job-id': job.id,
      'x-target-name': page.name
    });
    res.end(job.code);
  }

  /** @param {Job} job @param {{ ok:boolean, value?:any, error?:any, timeout?:boolean, httpAlreadySent?:boolean, errors?:any[] }} outcome */
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

    const errors = outcome.errors || [];

    // HTTP: send reply unless already sent (timeout branch).
    if (job.source === 'http') {
      if (!outcome.httpAlreadySent && job.res) {
        try {
          if (outcome.ok) {
            const v = outcome.value === undefined ? null : outcome.value;
            let result = JSON.stringify(v);
            // Prepend errors as comment block if any
            if (errors.length > 0) {
              const errorBlock = '/*\n' + errors.join('\n---\n') + '\n*/\n';
              result = errorBlock + result;
            }
            job.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            job.res.end(result);
          } else {
            let errorText = String(outcome.error);
            // Append errors as comment block if any
            if (errors.length > 0) {
              const errorBlock = '\n/*\n' + errors.join('\n---\n') + '\n*/';
              errorText = errorText + errorBlock;
            }
            job.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            job.res.end(errorText);
          }
        } catch { }
      }
      job.res = null;
      return;
    }

    // FILE MODE: write Markdown reply
    FileHarness.writeReply(job, outcome.ok, outcome.ok ? outcome.value : outcome.error, errors);
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
  let fileText = '';
  let activeFileJob = /** @type {Job|null} */(null);
  let debugReadTimer;
  let headerUpdateTimer;

  function boot() {
    try { 
      if (!existsSync(DEBUG_FILE)) {
        const init = '# Connected pages:\n\n';
        writeFileSync(DEBUG_FILE, init, 'utf8');
        fileText = init;
      } else {
        fileText = readFileSync(DEBUG_FILE, 'utf8');
      }
    } catch { }
    try { watch(DEBUG_FILE, debounceRead); } catch { }
    
    // Periodically update the connected pages header
    headerUpdateTimer = setInterval(() => {
      updateConnectedPagesHeader();
    }, 5000);  // Update every 5 seconds
  }

  function updateConnectedPagesHeader() {
    const header = MarkdownFmt.buildConnectedPages();
    const lines = fileText.split('\n');
    
    // Find where connected pages section ends
    let headerStart = -1;
    let headerEnd = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('# Connected pages:')) {
        headerStart = i;
        // Find the end of this section (first non-list item or blank followed by content)
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] === '' && j + 1 < lines.length && lines[j + 1] !== '') {
            headerEnd = j;
            break;
          } else if (!lines[j].startsWith('*') && lines[j] !== '') {
            headerEnd = j;
            break;
          } else if (j === lines.length - 1) {
            headerEnd = j + 1;
            break;
          }
        }
        break;
      }
    }
    
    if (headerStart === -1) {
      // No header found, add it at the beginning
      const newLines = [...header, '', ...lines];
      const newText = newLines.join('\n');
      if (newText !== fileText) {
        fileText = newText;
        writeFileSync(DEBUG_FILE, fileText, 'utf8');
      }
    } else {
      // Replace existing header
      const beforeHeader = lines.slice(0, headerStart);
      const afterHeader = lines.slice(headerEnd);
      const newLines = [...beforeHeader, ...header, ...afterHeader];
      const newText = newLines.join('\n');
      if (newText !== fileText) {
        fileText = newText;
        writeFileSync(DEBUG_FILE, fileText, 'utf8');
      }
    }
  }

  function debounceRead() {
    if (debugReadTimer) clearTimeout(debugReadTimer);
    debugReadTimer = setTimeout(() => {
      debugReadTimer = undefined;
      let text = '';
      try { text = readFileSync(DEBUG_FILE, 'utf8'); } catch { return; }
      if (text === fileText) return;
      onFileChanged(text);
    }, DEBUG_FILE_DEBOUNCE_MS);
  }

  function onFileChanged(text) {
    fileText = text;
    const normalized = text.replace(/\r\n/g, '\n');
    
    // Parse Markdown to find agent requests
    // Format: **agent** to <page-fragment> at HH:MM:SS
    // followed by ```JS or ```js fence with code
    const agentRequestRE = /^\*\*(\S+)\*\*\s+to\s+(\S+)\s+at\s+(\d{2}:\d{2}:\d{2})\s*$/;
    const lines = normalized.split('\n');
    
    let i = lines.length - 1;
    // Scan from bottom up to find the most recent agent request
    while (i >= 0) {
      const line = lines[i];
      const match = agentRequestRE.exec(line);
      if (match) {
        const agent = match[1];
        const pageFragment = match[2];
        const timeStr = match[3];
        
        // Look for code fence immediately after
        let codeStart = -1;
        let codeEnd = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j].startsWith('```')) {
            if (codeStart === -1) {
              codeStart = j + 1;
            } else {
              codeEnd = j;
              break;
            }
          }
        }
        
        if (codeStart > 0 && codeEnd > codeStart) {
          // Check if there's already a reply for this request
          let hasReply = false;
          for (let j = codeEnd + 1; j < lines.length; j++) {
            const replyLine = lines[j];
            // Check for reply format: **<page>** to <agent>
            if (replyLine.match(/^\*\*\S+\*\*\s+to\s+\S+/)) {
              // Check if it's a reply to this request (same page and close time)
              if (replyLine.includes(`to ${agent}`)) {
                hasReply = true;
                break;
              }
            }
            // Check for next request
            if (agentRequestRE.test(replyLine)) break;
          }
          
          if (!hasReply) {
            const code = lines.slice(codeStart, codeEnd).join('\n');
            handleFileRequest(pageFragment, code, agent, timeStr);
            return;
          }
        }
      }
      i--;
    }
  }

  function handleFileRequest(fragment, code, agent, timeStr) {
    if (!code.trim()) return;
    if (activeFileJob && !activeFileJob.done) return;

    const page = Pages.findByFragment(fragment);
    if (!page) return;

    const job = Jobs.create({ code, page, source: 'file', fragment });
    job.agentName = agent;
    job.requestTime = timeStr;
    activeFileJob = job;
    Jobs.enqueue(page, job);
  }

  function writeExecutingStatus(job) {
    // Append "executing ..." status after the request
    const lines = fileText.split('\n');
    const agentRequestRE = /^\*\*(\S+)\*\*\s+to\s+(\S+)\s+at\s+(\d{2}:\d{2}:\d{2})\s*$/;
    
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = agentRequestRE.exec(lines[i]);
      if (match && match[1] === job.agentName && match[3] === job.requestTime) {
        // Find code fence end
        let codeEnd = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] === '```') {
            codeEnd = j;
            break;
          }
        }
        
        if (codeEnd > 0) {
          // Check if executing status already exists
          if (lines[codeEnd + 1] !== '' || !lines[codeEnd + 2]?.startsWith('**')) {
            lines.splice(codeEnd + 1, 0, '', `**${job.page.name}** to ${job.agentName} at ${MarkdownFmt.clockFmt(Date.now())}  `, 'executing ...');
            fileText = lines.join('\n');
            writeFileSync(DEBUG_FILE, fileText, 'utf8');
          }
        }
        break;
      }
    }
  }

  function writeReply(job, ok, payload, errors) {
    activeFileJob = null;
    
    // Build reply content
    const now = Date.now();
    const duration = MarkdownFmt.durationMs(job.startedAt, now);
    const durationText = duration !== null ? `${duration}ms` : '';
    const errorPrefix = ok ? '' : '**ERROR** after ';
    
    let replyHeader = `**${job.page.name}** to ${job.agentName || 'agent'} at ${MarkdownFmt.clockFmt(now)}`;
    if (errorPrefix || durationText) {
      replyHeader += ` (${errorPrefix}${durationText})`;
    }
    
    let lang = 'JSON';
    let content = '';
    
    if (ok) {
      try {
        content = JSON.stringify(payload, null, 2) || 'null';
      } catch {
        content = String(payload);
        lang = 'Text';
      }
    } else {
      const errorObj = payload && typeof payload === 'object' && payload.stack ? payload.stack : payload;
      content = String(errorObj);
      lang = 'Error';
    }
    
    // Append errors if any
    if (errors && errors.length > 0) {
      content += '\n\n/* Captured errors:\n';
      for (const err of errors) {
        content += String(err) + '\n---\n';
      }
      content += '*/';
    }
    
    // Update connected pages header and append reply
    const header = MarkdownFmt.buildConnectedPages();
    const lines = fileText.split('\n');
    
    // Find where connected pages section ends
    let headerEnd = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('# Connected pages:')) {
        // Find the end of this section (first blank line or next section)
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] === '' || lines[j].startsWith('#')) {
            headerEnd = j;
            break;
          }
        }
        break;
      }
    }
    
    // Remove executing status if it exists
    const agentRequestRE = /^\*\*(\S+)\*\*\s+to\s+(\S+)\s+at\s+(\d{2}:\d{2}:\d{2})\s*$/;
    for (let i = lines.length - 1; i >= 0; i--) {
      const match = agentRequestRE.exec(lines[i]);
      if (match && match[1] === job.agentName && match[3] === job.requestTime) {
        // Find code fence end
        let codeEnd = -1;
        for (let j = i + 1; j < lines.length; j++) {
          if (lines[j] === '```') {
            codeEnd = j;
            break;
          }
        }
        
        if (codeEnd > 0 && lines[codeEnd + 3] === 'executing ...') {
          // Remove the executing status (blank line, page name, "executing ...")
          lines.splice(codeEnd + 1, 3);
        }
        break;
      }
    }
    
    // Replace header and append reply
    const beforeHeader = lines.slice(0, headerEnd > 0 ? lines.findIndex(l => l.startsWith('# Connected pages:')) : 0);
    const afterHeader = lines.slice(headerEnd || 0);
    
    const newLines = [
      ...header,
      '',
      ...afterHeader,
      '',
      replyHeader,
      '```' + lang,
      content,
      '```',
      ''
    ];
    
    fileText = newLines.join('\n');
    writeFileSync(DEBUG_FILE, fileText, 'utf8');
  }

  return { boot, writeExecutingStatus, writeReply };
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

  // Error buffer: capture all window errors since last eval
  const errorBuffer = [];
  const errorHandler = (event) => {
    const err = event.error || event.reason || { message: event.message || String(event) };
    const stack = err?.stack || String(err);
    errorBuffer.push(stack);
  };
  window.addEventListener('error', errorHandler);
  window.addEventListener('unhandledrejection', errorHandler);

  while (true) {
    try {
      const response = await fetch(endpoint, { headers: { 'cache-control': 'no-cache', pragma: 'no-cache' } });
      const script = await response.text();
      const headers = {}; response.headers.forEach((value, key) => { headers[key] = value; });

      if (!script) { await sleep(300); continue; }

      // Clear error buffer before eval
      errorBuffer.length = 0;

      let payload;
      try {
        const value = await(0, eval)(script);
        // Handle function and undefined specially
        let serializedValue = value;
        if (typeof value === 'function' || value === undefined) {
          serializedValue = String(value);
        }
        try { payload = JSON.stringify({ ok: true, value: serializedValue, errors: errorBuffer.slice() }); }
        catch { payload = JSON.stringify({ ok: true, value: String(value), errors: errorBuffer.slice() }); }
      } catch (err) {
        payload = JSON.stringify({ ok: false, error: { message: err?.message || String(err), stack: err?.stack || null }, errors: errorBuffer.slice() });
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
      catch { payload = { ok: false, error: { message: 'invalid JSON', stack: '' }, errors: [] }; }

      if (page) {
        page.last = Date.now();
        const job = page.current;
        if (job && !job.done) {
          const errors = payload?.errors || [];
          if (payload && payload.ok) Jobs.complete(job, { ok: true, value: payload.value, errors });
          else {
            const msg = payload?.error?.stack || payload?.error?.message || 'error';
            Jobs.complete(job, { ok: false, error: msg, errors });
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
