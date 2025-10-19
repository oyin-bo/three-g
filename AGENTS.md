# THREE-g Development Guide

# Directness

Always give direct answers to questions, without including any extra commentary or preamble.

# Project Structure

This is the **three-g** GPU particle physics library for THREE.js. It provides Barnes-Hut N-body simulation and particle rendering.

# Starting the Server

**From three-g-1 directory:**
```bash
npm start
```

This runs daebug from the adjacent oyinbo directory. Daebug serves three-g-1 pages and provides REPL debugging.

**Server location:** Pages served at `http://localhost:8768/`

**Main demos:**
- `index.html` – Full physics simulation with quadrupole/monopole/mesh/spectral methods
- `simplistic.html` – Pure rendering (no physics)
- `texture-mode.html` – Custom GPGPU integration example

# Using Daebug REPL for Testing

REPL is the primary tool for testing, debugging, and verification. Always use REPL to validate changes.

## Quick Start

1. Run `npm start` (from three-g-1 or oyinbo directory)
2. Open browser to `http://localhost:8768/`
3. Open `daebug.md` in repo root
4. Click session link for your page
5. Scroll to bottom and add JS code blocks
6. Save file and see results in 1-2 seconds

## Finding Sessions

Open `c:\Users\mihai\three-g-1\daebug.md` to see all active pages and their session files.

## Adding REPL Commands

1. Open session file (e.g., `daebug/6-dune-2040-42.md`)
2. Scroll to bottom where prompt `> ` appears
3. Add code block after prompt:
   ````markdown
   ```js
   window.physics ? 'physics exists' : 'no physics'
   ```
   ````
4. Save file
5. Results appear within 1-2 seconds

## Command Format

- Use `js` fenced code blocks
- Write expressions or IIFEs that return values
- Promises awaited automatically
- Do NOT use top-level `return` or `await`
- Always check execution timing in results (e.g., `(17ms)`)

## Available Globals (index.html only)

- `window.physics` – Particle system instance
- `window.setMethod(method)` – Switch physics method ('quadrupole', 'monopole', 'mesh', 'spectral')
- `window.verifyPM()` – Run PM/FFT verification
- `window.scene` – THREE.js scene

Other demos (simplistic.html, texture-mode.html) do not expose these globals.

# Restarting and Refreshing

**Restart server:**
1. Add `%%SHUTDOWN%%` on separate line in `daebug.md`
2. Run `npm start` again

**Refresh page:**
- Send `location.reload()` via REPL, or
- Close and reopen browser tab
- New session created automatically

**Check server status:** Open `daebug.md` to see connected pages and timestamps

# Testing Physics Methods

## Switch Methods via REPL

```js
// Switch to spectral method
window.setMethod && window.setMethod('spectral');
'switched to spectral'
```

```js
// Switch to quadrupole method
window.setMethod && window.setMethod('quadrupole');
'switched to quadrupole'
```

## Verify Computation

```js
(async () => {
  // Run one frame
  window.physics && window.physics.compute();
  await new Promise(r => setTimeout(r, 100));
  return 'compute complete';
})()
```

## Check Performance

```js
(async () => {
  const start = performance.now();
  for (let i = 0; i < 10; i++) {
    window.physics && window.physics.compute();
  }
  const elapsed = performance.now() - start;
  return { frames: 10, elapsed, avgMs: elapsed / 10 };
})()
```

# Execution Timing

**Critical:** Always check execution time in REPL results. Example:
- `## Result at 12:35:20 (17ms)` – Command took 17ms
- `## Error at 12:35:30 (16ms)` – Error after 16ms

Performance timing is essential for debugging GPU operations.

# Documentation

[README.md](README.md) – API documentation and examples
[docs/7-http-test-harness.md](docs/7-http-test-harness.md) – Daebug REPL guide
[docs/7.1-file-test-harness.md](docs/7.1-file-test-harness.md) – File protocol details
[docs/7.3-repl-chat.md](docs/7.3-repl-chat.md) – Markdown REPL implementation

# Code Comments

Comments should explain complex or non-obvious code quirks and intent, NOT mirror code actions.

Comments always relate to the current code state, NEVER to changes made NOR to previous state.

# Rich Markdown

Use full Markdown capabilities: headings, lists, code blocks, links, images, tables.

# Directness

Always give direct answers to questions. DO NOT embellish or recommend anything unless requested.

Do not announce writing TODOs.
