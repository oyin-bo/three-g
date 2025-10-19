# Daebug REPL Guide

Purpose: drive particle-system diagnostics and verification scripts through daebug's markdown-based REPL. You edit markdown files to queue JavaScript; results appear automatically within 1-2 seconds.

> NOTE: Assume daebug server is already running. No need to start or stop it.

## Prerequisites

- Node.js 18+
- `npm install` (in the oyinbo directory)
- A WebGL2-capable browser pointed at one of the demo pages

## Quick Start

1. **Launch the daebug server** (from the oyinbo directory)
   ```bash
   npm start
   ```
   Daebug serves pages and watches `daebug.md` files for REPL commands.
2. **Open a target page** – e.g. `http://localhost:8768/` (the default page). Keep the browser tab open.
   Note: Only `index.html` exposes DevTools globals like `window.physics`, `window.setMethod`, and `window.verifyPM()`. Other demos do not export these by default.

3. **Find active sessions** – Open `daebug.md` in the repo root. The top of the file lists all connected pages with their session links.

4. **Send commands** – Click a session link from `daebug.md`, scroll to the bottom of that session file, and add a JavaScript code block after the prompt line.

## Sending Commands

### Basic Pattern

1. Open the session file (e.g., `daebug/6-dune-2040-42.md`)
2. Scroll to the bottom where you see the prompt: `> `
3. Add a fenced code block:
   ````markdown
   ```js
   window.physics ? 'physics exists' : 'no physics'
   ```
   ````
4. Save the file
5. Results appear automatically within 1-2 seconds

### Command Format

- Use JavaScript fenced code blocks: ````js` ... ````
- Write expressions or IIFEs that return values
- Promises are awaited automatically
- Return values are serialized with `JSON.stringify`
- Non-serializable values fall back to `String(value)`
- Do not use top-level `return` or top-level `await`

### Multi-line Scripts

```js
(async () => {
  window.setMethod && window.setMethod('spectral');
  await new Promise(r => setTimeout(r, 1000));
  return window.physics ? 'spectral enabled' : 'no physics';
})()
```

## Command Context

- Commands run inside the browser tab that owns the session file
- On `index.html` you have access to `window.physics`, `window.setMethod`, `window.scene`, and helpers like `window.verifyPM()`
- Other demos (e.g., `simplistic.html`, `texture-mode.html`) do not expose these globals by default
- Use `import()` with cache busting (e.g. `?${Date.now()}`) for hot-reload iterations

## Examples

### Minimal smoke test
```js
(async () => {
  await new Promise(r => setTimeout(r, 500));
  return { TEST: 'PING', time: Date.now() };
})()
```

### Switch to Spectral (PM/FFT)
```js
(async () => {
  window.setMethod && window.setMethod('spectral');
  await new Promise(r => setTimeout(r, 1000));
  return window.physics ? 'spectral enabled' : 'no physics';
})()
```

### Check execution timing
Always verify execution duration in the result header. This is critical for performance debugging.

## Inspecting Results

- **Immediate output** – Results appear in the same session file within 1-2 seconds
- **Console logs** – View the target tab's DevTools console for `console.*` output
- **History** – All commands and results stay in the session file; scroll up to see previous interactions
- **Execution timing** – Each result shows execution duration; always check this

## Tips & Troubleshooting

- **Finding sessions** – Check `daebug.md` for the list of active pages and their session files
- **Multiple sessions** – Each browser tab gets its own session file; work with multiple tabs concurrently
- **Page reloads** – Refreshing a tab creates a new session; the old session file remains for history
- **Worker threads** – Web workers get separate session files with `-webworker` suffix
- **Restart server** – Add `%%SHUTDOWN%%` on a separate line in `daebug.md`, then run `npm start` again
- **File editing** – Any text editor works; daebug watches for file changes and responds automatically

## Session File Location

Session files are stored in `daebug/` subdirectory with names like:
- `daebug/6-dune-2040-42.md` (main page)
- `daebug/6-dune-2040-42-webworker.md` (web worker)

The master registry `daebug.md` always lists all active sessions with clickable links.
