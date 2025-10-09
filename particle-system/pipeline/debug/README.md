# Debug Staging Modules

This directory contains the debug staging infrastructure for Plan C, enabling isolated testing of pipeline stages.

## Module Overview

### `router.js`
Routes debug execution to appropriate stage harnesses based on `debugMode`.

**Exports:**
- `runAggregationOnly(ctx)` - Execute aggregation in isolation
- `runReductionOnly(ctx)` - Execute reduction in isolation
- `runTraversalOnly(ctx)` - Execute traversal in isolation
- `runIntegratorOnly(ctx)` - Execute integration in isolation
- `runFullPipeline_Record(ctx)` - Run full pipeline with capture
- `runFullPipeline_Replay(ctx)` - Replay from recorded state

### `harnesses.js`
Per-stage execution harnesses with isolated setup/teardown.

**Exports:**
- `runAggregationHarness(ctx)` - Aggregation stage only
- `runReductionHarness(ctx)` - Reduction passes only
- `runTraversalHarness(ctx)` - Force calculation only
- `runIntegratorHarness(ctx)` - Integration step only

### `record.js`
GPU→CPU texture capture and CPU→GPU replay.

**Exports:**
- `captureStageOutput(ctx, stageName, target)` - Capture texture to CPU
- `replayStageInput(ctx, stageName, target)` - Upload texture from CPU
- `clearRecordings()` - Clear all recordings
- `exportRecordings()` - Export to JSON-serializable object
- `importRecordings(data)` - Import from JSON

### `sources.js`
Mock data sources for synthetic testing.

**Exports:**
- `injectConstantForceParticles(ctx, options)` - Grid of particles at rest
- `injectTwoBodySystem(ctx, options)` - Binary orbit
- `injectGaussianBlob(ctx, options)` - Gaussian distributed particles
- `injectUniformL0(ctx, options)` - Uniform density L0
- `injectConstantForceField(ctx, options)` - Constant force vector field

### `validators.js`
Invariant checkers and correctness validation.

**Exports:**
- `assertMassConservation(ctx, level, expected, tolerance)` - Check mass totals
- `assertNoNaNs(ctx, texture, width, height, name)` - Check for invalid values
- `assertMomentumReasonable(ctx, maxPerParticle)` - Check momentum bounds
- `compareTexturesRMSE(ctx, tex1, tex2, w, h, name)` - Compute RMSE difference
- `computeMassAndCOM(ctx)` - Calculate system totals

### `visualizers.js`
Debug visualization helpers.

**Exports:**
- `blitLevelAttachment(ctx, level, attachment, options)` - Blit texture to screen
- `overlayCOMMarkers(ctx, level)` - Draw COM markers
- `showForceField(ctx, options)` - Visualize force vectors
- `createHeatmap(ctx, texture, w, h, options)` - Generate heatmap ImageData
- `logTextureStats(ctx, texture, w, h, name)` - Log min/max/mean to console

### `index.js`
Unified export for all debug modules.

## Usage

```javascript
// Via public API
const psys = particleSystem({ gl, particles, get, planC: true })
psys.setDebugMode('AggregateOnly')
psys.setDebugFlags({ validateMassConservation: true })
psys.step_Debug()

// Direct module access
const debug = await psys._debug()
debug.assertMassConservation(psys._system, 0, 1000.0)
debug.injectGaussianBlob(psys._system, { sigma: 1.0 })
```

## Architecture

```
ParticleSystem.step_Debug()
       ↓
    router.js  ← debugMode switch
       ↓
   harnesses.js  ← per-stage execution
       ↓
  sources.js (inject) / record.js (replay)
       ↓
  [Stage execution: aggregation, reduction, traversal, integration]
       ↓
  validators.js (check) / record.js (capture)
       ↓
  visualizers.js (display)
```

## Debug Flow Example

```javascript
// 1. Enable Plan C
planC(true)

// 2. Set up debug context
dbg.mode('AggregateOnly')
dbg.flags({
  mockParticles: false,  // Use real particles
  captureOutput: true,   // Record L0
  validateMassConservation: true
})

// 3. Execute (routes through router → harness → validator)
dbg.step()
// → router.runAggregationOnly()
//   → harnesses.runAggregationHarness()
//     → aggregator.aggregateParticlesIntoL0()
//   → record.captureStageOutput('aggregation', L0)
//   → validators.assertMassConservation()

// 4. Check results
// Validation logged to console
```

## Implementation Notes

- **Captures are blocking**: `readPixels` stalls GPU pipeline
- **Recordings are in-memory**: Cleared on page reload
- **JSON export**: Use `exportRecordings()` to save test cases
- **Lazy loading**: Modules only loaded when `_debug()` is called
- **Profiler integration**: Harnesses respect `ctx.profiler` if enabled

## Testing Strategy

1. **Unit test stages**: Use harnesses to test each stage independently
2. **Mock upstream**: Use sources to inject known inputs
3. **Validate invariants**: Use validators to check correctness
4. **Record golden**: Capture known-good outputs for regression
5. **Replay determinism**: Verify replayed state matches recording

## See Also

- **Usage Guide**: `/docs/debug-staging-usage.md`
- **Quick Start**: `/docs/QUICK-START-DEBUG.md`
- **Spec**: `/docs/4.c-1-staging.md`
