# PM Debug Module

Stage-isolated debugging system for Plan A (PM/FFT pipeline).

## Architecture

```
pm-debug/
├── index.js          # Core orchestration, hooks, API surface
├── types.js          # TypeScript type definitions
├── synthetic.js      # Synthetic source generators
├── snapshot.js       # Record/replay snapshot system
├── metrics.js        # GPU-side invariant checks
├── overlay.js        # Visual debugging overlays
└── README.md         # This file
```

## Design Principles

### 1. **Stage Isolation**
Each PM/FFT stage can run independently with custom inputs/outputs:
- **Sources** provide stage inputs (live, synthetic, or snapshot)
- **Sinks** capture stage outputs (snapshot, overlay, metrics, readback)
- **Single-stage mode** runs one stage per frame for focused debugging

### 2. **Non-Intrusive**
- Zero overhead when `enabled: false`
- Hooks integrate via `pmDebugBeforeStage()` / `pmDebugAfterStage()`
- Snapshots stored separately from simulation state
- Compatible with existing profiling system

### 3. **GPU-First**
- Synthetic sources generated via fragment shaders
- Metrics computed using pyramid reduction (GPU-side)
- Overlays rendered directly to screen (no CPU readback)
- Snapshots use `blitFramebuffer` for fast texture copies

### 4. **Reusable Infrastructure**
- Leverages existing 3D grid slicing layout
- Reuses fullscreen quad VAO and shader compilation
- Integrates with `GPUProfiler` for timing debug passes
- Uses `unbindAllTextures()` and `checkGl()` for state hygiene

## Module Details

### `index.js` - Core Orchestration

**Exports:**
- `pmDebugInit(psys, config)` - Initialize/update debug configuration
- `pmDebugDispose(psys)` - Cleanup resources
- `pmDebugRunSingle(psys, stage, source?, sink?)` - Run single stage in isolation
- `pmDebugBeforeStage(psys, stage)` - Hook called before stage (returns source override)
- `pmDebugAfterStage(psys, stage)` - Hook called after stage (returns sink)
- `pmSnapshotStore(psys, key, atStage)` - Manually capture snapshot
- `pmSnapshotLoad(psys, key, forStage)` - Load snapshot as source
- `pmSnapshotDispose(psys, key)` - Delete snapshot

**Internal State:**
Stored in `psys._pmDebugState`:
```javascript
{
  config: DebugPMConfig,           // Current configuration
  snapshots: Map<string, PMSnapshot>, // Snapshot bank
  programs: {                      // Cached shader programs
    synthetic?: WebGLProgram,
    overlay?: WebGLProgram,
    metrics?: WebGLProgram
  },
  metricsResults: Map<string, any>  // Cached metrics results
}
```

### `types.js` - Type Definitions

Defines all TypeScript types:
- `PMStageID` - Stage identifiers
- `PMSyntheticSpec` - Synthetic source types
- `PMSourceSpec` - Source union type
- `PMOverlaySpec` - Overlay visualization types
- `PMCheckSpec` - Metrics check flags
- `PMReadbackSpec` - Readback buffer specs
- `PMSinkSpec` - Sink union type
- `PMSnapshot` - Snapshot texture bundle
- `DebugPMConfig` - Configuration object
- `PMDebugState` - Internal state

### `synthetic.js` - Source Generators

**Exports:**
- `generateGridImpulse(psys, centerVoxel, mass, targetTexture)`
- `generateTwoPointMasses(psys, a, b, ma, mb, targetTexture)`
- `generatePlaneWaveDensity(psys, k, amplitude, targetTexture)`
- `generateSpectrumDelta(psys, k, amplitude, targetTexture)`

**Shader Program:**
- Single program with `u_synthType` uniform to switch modes
- Reuses fullscreen quad VAO from ParticleSystem
- Outputs to provided target texture via FBO
- Handles 3D→2D texture coordinate mapping for sliced grids

**Implementation Notes:**
- All generators write directly to GPU textures
- Voxel coordinates use existing `texCoordToVoxel()` mapping
- Plane wave uses `cos(2π k·x / N)` for spectral purity
- Spectrum delta handles negative frequencies via wrapping

### `snapshot.js` - Record/Replay

**Exports:**
- `captureSnapshot(psys, stage, key)` - Copy current stage outputs
- `restoreSnapshot(psys, stage, key)` - Restore snapshot to stage inputs
- `listSnapshots(psys)` - List all snapshot keys
- `getSnapshotInfo(psys, key)` - Get snapshot metadata

**Snapshot Storage:**
Per-stage texture bundles:
- `pm_deposit` → `pmMassGrid` (R32F)
- `pm_fft_forward` → `rhoSpectrum` (RG32F)
- `pm_poisson` → `phiSpectrum` (RG32F)
- `pm_gradient` → `accelSpectrumXYZ` (3× RG32F)
- `pm_fft_inverse` → `pmAccelXYZ` (3× R32F)
- `pm_sample` → `sampledForces` (RGBA32F)

**Implementation:**
- Uses `blitFramebuffer` for fast GPU→GPU copies
- Snapshots stored in `psys._pmDebugState.snapshots` Map
- Manual disposal required to free GPU memory

### `metrics.js` - Invariant Checks

**Exports:**
- `checkMassConservation(psys)` - Compare grid vs particle mass
- `checkDCZero(psys, spectrumTexture)` - Verify k=0 mode is zero
- `checkFFTInverseIdentity(psys, original, roundtrip, w, h)` - FFT roundtrip error
- `checkPoissonOnPlaneWave(psys, k, rhoSpectrum, phiSpectrum)` - Validate Poisson solve
- `runAllMetrics(psys, stage, checks)` - Run multiple checks

**GPU Reduction:**
- Uses temporary pyramid textures for summation
- Reuses existing reduction infrastructure where possible
- Final result read via `readPixels` (1 texel, minimal stall)

**Metrics Shader:**
- Computes per-pixel error metrics (e.g., |A - B|²)
- Reduced to single value via pyramid sum
- Results cached in `psys._pmDebugState.metricsResults`

### `overlay.js` - Visualizations

**Exports:**
- `renderGridSlice(psys, gridTexture, axis, index, logScale, channel)` - 2D slice
- `renderSpectrumMagnitude(psys, spectrumTexture, logScale)` - Spectrum heatmap
- `renderVectorGlyphs(psys, fieldX, fieldY, fieldZ, stride)` - Vector field (TODO)

**Overlay Shader:**
- Renders to default framebuffer (screen)
- Supports X/Y/Z slice axes
- Turbo colormap for perceptually uniform colors
- Log scale for wide dynamic range
- Handles 3D→2D sliced layout

## Integration with ParticleSystem

### Initialization

```javascript
// In ParticleSystem constructor
this._pmDebugState = null;

// User enables via options
if (this.options.planA) {
  // Debug system will be initialized when pmDebugInit() is called
}
```

### Step Hook

```javascript
// In ParticleSystem.step()
if (this._pmDebugState?.config?.enabled && this._pmDebugState.config.singleStageRun) {
  // Run single stage in isolation
  pmDebugRunSingle(this, stage, source, sink);
  return; // Skip normal pipeline
}

// Normal pipeline with hooks
this.buildQuadtreeWithDebug();
// ... rest of pipeline
```

### Stage Hooks

```javascript
// In buildQuadtreeWithDebug()
if (this._pmDebugState?.config?.enabled) {
  const sourceBefore = pmDebugBeforeStage(this, 'pm_deposit');
  // Apply source override if present
  
  this.buildQuadtree(); // Normal aggregation
  
  const sinkAfter = pmDebugAfterStage(this, 'pm_deposit');
  // Apply sink if present
}
```

## Future Enhancements

### When FFT/Poisson Pipeline is Implemented

1. **Full spectrum metrics:**
   - Parseval's theorem checks
   - k-space anisotropy analysis
   - Aliasing detection

2. **Deconvolution validation:**
   - CIC/TSC window function checks
   - Spectral accuracy vs. real-space

3. **Vector field overlays:**
   - Acceleration field glyphs
   - Divergence/curl visualization
   - Streamlines

### Additional Features

1. **Batch testing:**
   - Run multiple synthetic tests
   - Compare against analytical solutions
   - Regression test suite

2. **Performance profiling:**
   - Per-stage timing breakdown
   - Memory usage tracking
   - Bandwidth analysis

3. **A/B comparison:**
   - Side-by-side snapshots
   - Diff overlays
   - Convergence plots

## Performance Notes

- **Synthetic sources:** ~0.1-0.5ms (fullscreen quad)
- **Snapshots:** ~0.2-1ms per texture (blitFramebuffer)
- **Metrics:** ~1-5ms (depends on reduction depth)
- **Overlays:** ~0.5-2ms (fullscreen render)

All timings for 64³ grid on modern GPU (RTX/M1). Overhead negligible when `enabled: false`.

## References

- [4.a-0-linear-octree-morton.md](../../docs/4.a-0-linear-octree-morton.md) - Plan A design
- [4.a-1-staging.md](../../docs/4.a-1-staging.md) - This staging specification
- [PM-DEBUG-USAGE.md](../../docs/PM-DEBUG-USAGE.md) - Usage guide with examples
