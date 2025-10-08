# GPU Profiling Guide

## Overview

The particle system includes GPU profiling capabilities using WebGL2's `EXT_disjoint_timer_query_webgl2` extension. This allows you to measure the actual GPU execution time of different pipeline stages to identify performance bottlenecks.

## Enabling Profiling

To enable GPU profiling, set the `enableProfiling` flag when creating the particle system:

```javascript
const physics = particleSystem({
  gl: renderer.getContext(),
  particles: particles,
  enableProfiling: true  // Enable GPU profiling
});
```

## Accessing Profiler Data

The profiler is available through the `profiler` property:

```javascript
// Check if profiler is available and enabled
if (physics.profiler && physics.profiler.enabled) {
  // Get all timing results (averaged over 100 frames)
  const results = physics.profiler.getAll();
  // results = {
  //   aggregation: 0.5,        // Particle aggregation into L0 (ms)
  //   pyramid_reduction: 0.3,  // Pyramid reduction passes (ms)
  //   traversal: 2.1,          // Force traversal (ms)
  //   integration: 0.4         // Velocity + position integration (ms)
  // }
  
  // Get total GPU frame time
  const totalTime = physics.profiler.getTotalTime();  // ms
  const fps = 1000 / totalTime;
  
  // Get individual pass time
  const traversalTime = physics.profiler.get('traversal');
}
```

## Profiler API

### Properties
- `profiler.enabled` - Boolean indicating if the GPU timer extension is available
- `profiler.results` - Object containing averaged timing results

### Methods
- `profiler.get(name)` - Get timing for a specific pass (returns ms)
- `profiler.getAll()` - Get all timing results as an object
- `profiler.getTotalTime()` - Get total GPU frame time (ms)
- `profiler.reset()` - Clear all profiling data

## Pipeline Stages

The profiler tracks these GPU passes:

1. **aggregation** - Particle aggregation into octree L0 using additive blending
2. **pyramid_reduction** - Hierarchical reduction to build octree pyramid
3. **traversal** - Barnes-Hut force calculation traversal
4. **integration** - Velocity and position integration

## Important Notes

### Extension Availability
The `EXT_disjoint_timer_query_webgl2` extension is:
- ✅ Widely supported on desktop browsers (Chrome, Firefox, Edge)
- ❌ May not be available in headless browsers or mobile
- ❌ May be disabled for privacy/security reasons

Always check `profiler.enabled` before using profiler data.

### Performance Considerations
- GPU timing queries are **non-blocking** - results are collected 2-3 frames later
- Results are **averaged over 100 frames** for statistical stability
- Profiling has **near-zero overhead** when enabled
- When `enableProfiling: false` (default), profiler is `null` with **zero overhead**

### Best Practices

```javascript
// Update profiling display periodically (not every frame)
let frameCount = 0;
outcome.animate = () => {
  frameCount++;
  physics.compute();
  
  // Update profiling display every 10 frames
  if (frameCount % 10 === 0 && physics.profiler?.enabled) {
    updateProfilingDisplay();
  }
};

function updateProfilingDisplay() {
  const results = physics.profiler.getAll();
  const totalTime = physics.profiler.getTotalTime();
  
  console.log('GPU Frame Time:', totalTime.toFixed(2) + 'ms');
  console.log('Traversal:', results.traversal.toFixed(2) + 'ms');
  // ... display other results
}
```

## Example: profiling.html

See `profiling.html` for a complete working example with a visual profiling display.

## Troubleshooting

### "GPU profiling not available"
- Extension not supported by browser/GPU
- Try a desktop browser (Chrome/Firefox)
- Check browser console for warnings

### "Profiler results are all 0"
- Wait at least 60 frames for averaging to stabilize
- GPU timer queries take 2-3 frames to return results
- Check that `profiler.enabled` is `true`

### High traversal times
This is expected! The traversal shader is the primary bottleneck:
- At 500K particles: ~2-5ms (normal)
- At 5M particles: ~20-50ms (expected)
- See `/docs/2-optimization-analysis.md` for optimization strategies
