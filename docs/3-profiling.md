## GPU profiling: what it is and what it enables

This file explains the current GPU profiling capability (what it measures, how to enable and read it) and why those metrics matter for future optimizations. It is intentionally short and practical.

## How profiling works

- Uses WebGL2 timer queries via the extension `EXT_disjoint_timer_query_webgl2`.
- Queries are issued around GPU work (begin/end), collected asynchronously 2–3 frames later to avoid CPU/GPU sync stalls.
- Results are stored as rolling averages (configurable sample window) to smooth variance.

Core behavior: enable profiling when you need data; it is opt-in and has negligible overhead when active and zero when disabled.

## How to enable and read metrics

1. Enable profiling when creating the particle system:

```javascript
const physics = particleSystem({ gl: renderer.getContext(), enableProfiling: true });
```

2. Each frame call the profiler update (done by the system if enabled):

```javascript
physics.profiler?.update(); // called every frame by the particle system
```

3. Read averaged results:

```javascript
const stats = physics.stats(); // returns map of passName => ms (or null if unavailable)
// e.g. stats.traversal, stats.aggregation
```

Pass names exposed by the profiler (the ones you can expect to see in `stats`):
- `octree_clear`, `aggregation`, `pyramid_reduction`, `traversal`, `vel_integrate`, `pos_integrate`, `texture_update`, `particle_render`

Note: check `physics.profiler.enabled` before relying on results; the extension may be unavailable on some platforms.

## What these metrics enable (practical, focused)

- Verify where GPU time is spent (physics vs rendering).
- Measure before/after for any change (microbenchmarks for shader edits, format changes, rebuild strategies).
- Track regressions automatically as code changes.
- Provide quantitative inputs to decide whether to:
  - optimize shaders (reduce fetches or simplify math),
  - change data formats (e.g. float16 vs float32),
  - alter rebuild frequency (lazy rebuilds), or
  - pursue larger algorithm changes (Particle-Mesh / WebGPU) only if the measured gains justify the cost.

In short: profiling converts guesses into measurable hypotheses and lets you accept or reject them quickly.

## Limitations

- Requires `EXT_disjoint_timer_query_webgl2` — not available everywhere (Safari, some mobile/embedded GPUs).
- Measures GPU execution time only; it does not measure CPU-side time or hardware-specific counters (memory bandwidth, cache behavior).

## Recommended immediate steps

1. Enable profiling in the main demo (`index.html`) and collect baselines at a few particle counts (e.g. small, medium, large).
2. Use the per-pass numbers to pick a single, low-risk optimization (shader fetch reduction or texture format change), measure the effect, and iterate.
3. Reserve algorithmic rewrites (PM / WebGPU) until profiling shows remaining work cannot be addressed by smaller changes.

---

This document is intentionally minimal — if you want an accompanying short checklist or a tiny script to collect baselines automatically, I can add it next.
