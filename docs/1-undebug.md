# Particle System: Undebug & Data Input Refactoring Plan

**Date**: October 7, 2025  
**Scope**: Phase 1 cleanup - Remove debugging code & replace particleCount with data loading API  
**Out of Scope**: Deep refactoring, file reorganization, shader rewrites  
**Training Ground**: `particle-system-demo.js` demonstrates new API patterns

---

## I. Objectives

### A. **Remove Non-Production Code** (5-10% performance gain)
Remove all debugging artifacts that consume GPU/CPU cycles:
- Synchronous GPU readback operations (`gl.readPixels` in first N frames)
- Frame-gated console logging (`if (ctx.frameCount < N)`)
- Commented-out debug code in shaders
- Unused renderer.js file

### B. **Replace internal generation with client-provided particle data**
Transform from a system that generated particles internally:
```javascript
// old: system generates particles internally
particleSystem({ gl, ... })
```
To a system that accepts particle data from the caller, aligned with the
`mass-spot-mesh` spots/get pattern (preferred):
```javascript
particleSystem({
  gl,
  // CPU mode: supply the spots array directly and an optional mapper
  particles: [ { x?: number, y?: number, z?: number, mass?: number, rgb?: number }, ... ],
  get?: (spot, out) => void, // optional mapper: fills { x,y,z,mass,rgb } from each spot
  worldBounds: { min, max },
  ...
})
```

In future versions callers may even provide GPU textures directly (texture-based mode) if they
need a zero-copy GPU pipeline; that flow is the rendering path used by
`mass-spot-mesh` and is a separate texture-mode branch.

**Key Principle**: Particle system is a **physics engine**, not a **particle generator**. Data generation moves to demo/client code.

---

## II. Boundary Analysis: API Surface Changes

### Current Public API (`particle-system/index.js`)

**Constructor Options (Before)**:
```javascript
{
  gl: WebGL2RenderingContext,    // Required
  worldBounds?: { min, max },
  theta?: number,
  gravityStrength?: number,
  dt?: number,
  softening?: number,
  damping?: number,
  maxSpeed?: number,
  maxAccel?: number
}
```

**Constructor Options (After)**:
```javascript
{
  gl: WebGL2RenderingContext,    // Required
  particles?: Array<{ x?: number, y?: number, z?: number, mass?: number, rgb?: number }>,
  get?: (spot, out) => void,     // Optional mapper function (mass-spot-mesh style)
  // OR texture-mode (GPU):
  // textures: { position: WebGLTexture, color?: WebGLTexture, size: [w,h] }
  worldBounds: { min, max },      // Required (no defaults)
  theta?: number,                 // Default: 0.5
  gravityStrength?: number,       // Default: 0.0003
  dt?: number,                    // Default: 1/60
  softening?: number,             // Default: 0.2
  damping?: number,               // Default: 0.0
  maxSpeed?: number,              // Default: Infinity (no clamping)
  maxAccel?: number               // Default: Infinity (no clamping)
}
```

**Derived Properties**:
- `textureWidth`, `textureHeight` computed from particle distribution (unchanged logic)

**Return Value**:
```javascript
{
  compute(),
  getPositionTexture(),
  getPositionTextures(),
  getCurrentIndex(),
  getColorTexture(),
  getTextureSize(),
  ready(),
  dispose()
}
```

---

## III. Detailed Changes by File

This section lists the files to edit and the precise places in each file where implementors should make the changes. The goal is a short actionable checklist — no implementation code in this document.

Note: "approx location" uses either a named function/section or a rough position in the file (start/middle/end).

### A. `particle-system/index.js`
- Where: near the top of the exported factory function (constructor / options parsing).
- What: add validation that CPU-mode supplies `options.particles` (an array) or texture-mode supplies valid `options.textures`; compute internal particle count from `options.particles.length` or from texture size and pass particle data through to `ParticleSystem`.

### B. `particle-system/particle-system.js`
- Where: constructor and initialization sequence (top of class and `init()` call site).
- What:
  - Remove the internal particle generator function (search for `initializeParticles` towards the end of the file) and replace with an uploader that consumes `this.particleData`.
  - Add or call `uploadParticleData()` from `init()` instead of `initializeParticles()`.
  - Remove per-frame and initialization `console.log` noise (log only errors/warnings). These appear in the `init()` flow and after shader/program creation (beginning/middle of file).

### C. `particle-system/pipeline/aggregator.js`
- Where: inside `aggregateParticlesIntoL0()` (middle of file), look for `if (ctx.frameCount < 1)` blocks and readback logic.
- What: remove all first-frame readback/debug blocks and any frame-gated console logging; keep GL state checks and functional logic.

### D. `particle-system/pipeline/integrator.js`
- Where: velocity/position integrate passes (middle/end of file), near `velIntegrate` and `posIntegrate` calls.
- What: remove transient `frameCount` logs and any small ad-hoc FBO status logs. Retain runtime error checks.

### E. `particle-system/pipeline/pyramid.js` and `traversal.js`
- Where: top/middle of these reduction/traversal pass functions.
- What: remove commented-out per-pass `console.log` lines and any leftover dev-only comments that force debug visuals.

### F. `particle-system/pipeline/renderer.js`
- Where: entire file.
- What: delete the file if it's unused. Confirm by grep/import check before removal; if unused, remove and note in commit message.

### G. Shader sources (`particle-system/shaders/*.js`)
- Files to inspect (approx positions):
  - `aggregation.vert.js` (towards end: look for commented DEBUG blocks)
  - `aggregation.frag.js` (short file; scan full)
  - `reduction.frag.js` (top/middle)
  - `traversal.frag.js` (top/middle)
  - `vel_integrate.frag.js` and `pos_integrate.frag.js` (full file scan)
- What: remove commented-out debug blocks that force a specific gl_Position/gl_FragColor for tests (these are usually explicit `if (index == N)` or commented `DEBUG` sections). Replace removed blocks with a short `// TODO` note referencing tests/harness if needed.

### H. `particle-system/utils/debug.js`
- Where: leave unchanged (top of file).
- What: retain this utility; it provides useful GL state checks. Do not remove its error logging.

### I. `particle-system-demo.js` (the demo)
- Where: before physics initialization (top third of file where physics is created).
- What: move particle generation into the demo (implementors will write generators here). The doc should instruct: implement generator(s) that return typed arrays with shapes `{ positions: Float32Array, velocities?: Float32Array, colors?: Uint8Array }` and pass them into `particleSystem({ gl, particles, ... })`.

---
## V. Validation Checklist

### After Implementation, Verify:

#### A. **Functionality**
- [ ] Demo still runs at ~40 FPS with 50,000 particles
- [ ] Particles still move under gravitational forces
- [ ] No console errors or warnings (except extension warnings)
- [ ] Ping-pong texture swapping still works
- [ ] Color rendering unchanged

#### B. **Code Quality**
- [ ] Zero `console.log` in production paths (only errors/warnings)
- [ ] Zero `if (ctx.frameCount < N)` blocks
- [ ] Zero `gl.readPixels` in hot paths
- [ ] Zero commented-out code in shaders
- [ ] `renderer.js` deleted

#### C. **API Compliance**
- [ ] `particleSystem({ gl, particles: { positions } })` works
- [ ] Optional velocities default to zero
- [ ] Optional colors default to white
- [ ] Particle count computed correctly
- [ ] Texture dimensions calculated from particle count

#### D. **Performance**
- [ ] Baseline: Record FPS before changes
- [ ] After: FPS improves 5-10% (or stays same)
- [ ] No new GPU stalls introduced

---

## VI. Implementation Order

### Step 1: Clean Dead Code First (1 hour)
**Why first**: Zero risk, immediate clarity
1. Delete `renderer.js`
2. Delete commented code in `aggregation.vert.js`
3. Delete commented `console.log` lines in pipeline/*.js

### Step 2: Remove Debug Readbacks (30 min)
**Why second**: Performance-critical, no API changes yet
1. Delete all `if (ctx.frameCount < N)` blocks in `aggregator.js`
2. Delete frameCount blocks in `integrator.js`
3. Remove most `console.log` (keep errors/warnings)

### Step 3: Update API - particle-system.js (1 hour)
**Why third**: Core changes isolated to one file
1. Update constructor to accept `particleData`
2. Validate required fields
3. Delete `initializeParticles()`
4. Add `uploadParticleData()`
5. Update `init()` call

### Step 4: Update API - index.js (30 min)
**Why fourth**: Public API wrapper
1. Validate `particles.positions` required
2. Compute `particleCount` from data
3. Pass data through to ParticleSystem
4. Update return value

### Step 5: Migrate Demo (30 min)
**Why last**: Test the new API
1. Add `generateDiskParticles()` function
2. Update `particleSystem()` call
3. Verify rendering works
4. Test performance

**Total Estimated Time**: 3.5 hours

---

## VII. Success Metrics

### Quantitative
- **Lines Deleted**: ~150-200 lines
  - `renderer.js`: 106 lines
  - `aggregator.js`: ~50 lines (debug blocks)
  - `integrator.js`: ~8 lines
  - Shader comments: ~11 lines
  - Console logs: ~15 lines
- **Performance Gain**: 5-10% FPS improvement (from removing readbacks)
- **API Simplicity**: 2 required params (gl, particles) vs 3+ before

### Qualitative
- **Clarity**: Particle generation explicitly in demo code
- **Flexibility**: Easy to test different particle distributions
- **Production-Ready**: No debug artifacts in hot paths
- **Maintainability**: Cleaner code easier to test later

---

## VIII. Non-Goals (Deferred)

These are EXPLICITLY out of scope for this phase:

- ❌ Shader unit testing (Phase 3)
- ❌ Performance profiling with GPU timers (Phase 4)
- ❌ Octree resolution configurability (Phase 4)
- ❌ Runtime option updates (Phase 2)
- ❌ Async GPU readback for bounds (Phase 4)
- ❌ File reorganization (future deep refactor)
- ❌ TypeScript migration (NOT DOING THAT EVER)
- ❌ Energy conservation monitoring (Phase 3)

**Focus**: Clean what exists, improve API ergonomics, prepare for testing.

---

## IX. Risk Mitigation

### Risk: Breaking Existing Integration
- **Mitigation**: Keep massSpotMesh integration unchanged
- **Test**: Run demo after EACH step, verify rendering

### Risk: Performance Regression
- **Mitigation**: Measure FPS before/after each step
- **Rollback**: If FPS drops, identify cause before proceeding

### Risk: Texture Size Mismatch
- **Mitigation**: Validate computed texture dimensions match old logic
- **Test**: Log `textureWidth`, `textureHeight` - must equal `ceil(sqrt(particleCount))`

---

## X. Acceptance Criteria

**This phase is complete when**:

1. ✅ `particle-system-demo.js` runs with generated particle data
2. ✅ No `console.log` in hot paths (frame-gated or per-frame)
3. ✅ No `gl.readPixels` in first-frame initialization
4. ✅ `renderer.js` deleted
5. ✅ Commented shader code removed
6. ✅ API accepts `particles: { positions, velocities?, colors? }`
7. ✅ FPS ≥ baseline (ideally +5-10%)
8. ✅ Code review passes (clean, no dead code)

**Then**: Ready for Phase 2 (API refinement) and Phase 3 (testing infrastructure).