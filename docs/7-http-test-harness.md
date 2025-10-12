# serve.js REPL Remote Command Guide

Purpose: drive particle-system diagnostics and verification scripts through the `serve.js` REPL channel. The REPL replaces the legacy mini HTTP harness, letting you queue JavaScript directly into any open demo page and receive results over the same HTTP request (ideal for `curl`, scripts, or ad-hoc debugging).

> NOTE: Assume http://localhost:8302/ is already running. No need to start or stop it, or interfere with its running.

## Prerequisites

- Node.js 18+
- `npm install`
- A WebGL2-capable browser pointed at one of the demos served by `serve.js`

## Quick Start

1. **Install dependencies**
   ```bash
   npm install
   ```
2. **Launch the dev server** (injects the REPL client into every `.html`)
   ```bash
   npm start
   ```
   `serve.js` listens on `http://localhost:8302/` by default.
3. **Open a target page** – e.g. `http://localhost:8302/index.html` (Gravity demo). Keep the tab focused when running long commands.
   Note: Only `index.html` exposes DevTools globals like `window.physics`, `window.setMethod`, and `window.verifyPM()`. Other demos do not export these by default.
4. **Discover active tabs**
   ```bash
   curl http://localhost:8302/serve.js
   ```
   Output lists `tabName`, URL, last heartbeat, and state.
5. **Queue code** – Use either GET (quick snippets) or POST (multiline scripts) to send work to the matching tab fragment.

## Sending Commands

### GET with `eval`
```bash
curl --get \
  --data-urlencode "name=gravity" \
  --data-urlencode "eval=(()=>{ window.setMethod && window.setMethod('spectral'); return 'spectral enabled'; })()" \
  http://localhost:8302/serve.js
```
The response body contains the return value (serialized as JSON). Errors return the stack trace as plain text.

### POST with request body
```bash
curl -X POST \
  --data-binary @commands/fft-roundtrip.js \
  "http://localhost:8302/serve.js?name=gravity&eval=post"
```
`eval=post` tells `serve.js` to read the request body as the code to execute. The response mirrors the GET flow.

### Payload format
Raw JavaScript only. JSON request bodies are not parsed; sending JSON (for example `{ "code": "..." }`) will be treated as invalid JavaScript and result in a syntax error.

## Command Context

- Commands run inside the browser tab that registered the matching name. On `index.html` you have access to `window.physics`, `window.setMethod`, `window.scene`, and helpers like `window.verifyPM()`. Other demos (e.g., `simplistic.html`, `texture-mode.html`) do not expose these globals by default.
- Script shape: provide an expression or an IIFE that returns a value. Do not use top-level `return` or top-level `await`.
- Promises are awaited. Return values are serialized with `JSON.stringify`. Non-serializable values fall back to `String(value)`.
- Use `import()` with cache busting (e.g. `?${Date.now()}`) for hot-reload iterations.

## Examples

- **Minimal smoke test**
  ```javascript
  (async () => {
    await new Promise(r => setTimeout(r, 500));
    return { TEST: 'PING', time: Date.now() };
  })()
  ```
- **Switch to Spectral (PM/FFT)**
  ```javascript
  (async () => {
    window.setMethod && window.setMethod('spectral');
    await new Promise(r => setTimeout(r, 1000));
    return window.physics ? 'spectral enabled' : 'no physics';
  })()
  ```
- **FFT roundtrip verifier** – reuse the example script from `docs/pm-fft-inverse-investigation.md` or store it in a file and POST it as shown above.

## Inspecting Results

- **Immediate output** – The HTTP response contains the command’s return value or error stack.
- **Console logs** – View the target tab’s DevTools console for `console.*` emitted during execution.
- **Archiving** – Redirect curl output to a file if you need history.

## Tips & Troubleshooting

- **Targeting tabs** – Use distinctive window titles to generate unique `tabName` values (stored in `sessionStorage`).
- **Timeouts** – Requests time out after 60 s if the tab does not respond. The HTTP client receives `504 timeout`.
- **Multiple sessions** – Each tab maintains its own queue. Submit commands to the appropriate fragment.
- **Page reloads** – Refreshing a tab resets its queue; the `tabName` persists across reloads (stored in `sessionStorage`). Open a new tab to get a new name or clear `sessionStorage`.

This REPL workflow supersedes the previous file-based HTTP harness. All remote diagnostics should flow through `serve.js` moving forward.
