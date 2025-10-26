# Kernel Reflection

## Problem

When unit tests fail, we add diagnostics. When those diagnostics aren't enough, we add more. Tests become cluttered with ad-hoc inspection code. Each kernel reinvents its own debugging helpers.

We need a systematic way to inspect kernel state without polluting tests with diagnostic code.

## Solution

Every kernel has built-in reflection: a method that captures its complete computational state. This state is both machine-readable (for assertions) and human-readable (for test failures).

The reflection is opt-in. Normal GPU execution is unaffected. Only when explicitly invoked does the kernel synchronize, read back GPU data, compute statistics, and format results.

## Design

Kernels expose three methods:

**`run()`** executes the kernel (GPU computation). Returns a metadata object with execution details:
```js
{
  renderCount: 42  // Number of times kernel has been executed (tracked internally)
}
```

**`valueOf(options)`** returns a plain object containing all relevant state: textures, buffers, parameters, validation flags. This object is JSON-serializable for structural comparisons. 

Options:
- `pixels` (boolean|undefined): Whether to capture pixel data. `true` = always capture, `false` = never capture, `undefined` = auto-decide based on size (default).

**`toString()`** returns a compact string summarizing the kernel's state in human-readable form. Uses dense notation with Unicode block characters for visual profiles. Useful for console inspection and test failure messages.

The snapshot object returned by `valueOf()` also has its own `toString()` method that produces the same compact output. 

**Critical implementation notes:**
- `toString()` generates its output string **immediately** when `valueOf()` is called, not lazily when `toString()` is invoked. This ensures the string reflects the exact state at snapshot time, even if the kernel state changes later.
- All values in the snapshot are **deep-copied** to prevent later mutations from affecting the snapshot. Mutable objects like `worldBounds` are cloned.
- Scalar values are **preserved exactly**: `renderCount: this.renderCount` **not** `this.renderCount || 0` to preserve exact values including zero, undefined, null.
- Texture checks can use truthy: `this.inPosition ? readLinear(...) : this.inPosition` is fine because textures are objects (WebGLTexture) or null/undefined, never 0/false/"".
- The `pixels` parameter is passed through from `valueOf(options)` to all `readLinear/readGrid3D` calls, giving the caller control over pixel capture.

There are also two utility methods (we will put them into diag.js module in the particle-system directory):

**`readLinear()`** reads 1D particle/array data stored in 2D textures. Used for particle positions, velocities, forces, and CSR graph arrays (shards, column indices, weights). Requires texture width/height, optional element count and channel labels.

**`readGrid3D()`** reads 3D cubic grid data packed as Z-slices in 2D textures. Used for density grids, force grids, FFT spectra, and octree levels. Requires texture width/height and grid size (for slice packing), optional channel labels.

**Note on dimensions:** WebGL does not provide a reliable way to query texture dimensions. The `gl.getTexParameter()` doesn't support `TEXTURE_WIDTH`/`TEXTURE_HEIGHT`, and `gl.getTexLevelParameter()` may not be available in all implementations. Kernels must track their texture dimensions and pass them to read functions.


## Composability

Reflection is compositional. Helper functions create snapshots for individual GPU resources (textures, buffers). These resource snapshots have a `toString()` method for readable output.

Kernel snapshots assemble resource snapshots along with kernel-specific metadata (parameters, validation results, computed invariants). Each level of composition maintains the dual interface: structured data via `valueOf()`, readable output via `toString()`.

Kernel's valueOf() invokes read** methods for its textures and adds returned values into its returned diagnostic object, by the name of corresponding texture prop. If corresponding texture is falsy, propagate that value into the returned diagnostic object.

The toString can invoke this.valueOf() and shape those values into a neat tightly formatted readable string.

Example composition:

```
readLinear({gl, texture, width, height, count}) → {width, height, count, x: {...}, y: {...}, pixels, toString()}
readGrid3D({gl, texture, width, height, gridSize}) → {width, height, gridSize, density: {...}, pixels, toString()}
kernel.valueOf() → {position: {...}, force: {...}, valueA: 1, valueB: 45, toString()}
```

## What Gets Captured: Kernels
- All textures
- Non-texture parameters
- Render count
- Computed stats relevant for given kernel (total energy, momentum, particle count)

## What Gets Captured: Textures

**Texture metadata:**
- Dimensions (width, height)
- Format (RGBA32F, RG32F, etc.) and bytes per pixel
- Layout-specific: element count (linear), grid size and slice packing (grid3D)

**Per-channel statistics:**
- Basic: min, max, mean, median, stddev
- Distribution: histogram (visual string), profile (visual string, linear only) or profileX/Y/Z (grid3D only)
- Concentration: belowAbs0_001, nearMin_5pc, nearMax_5pc, outliers_ex3stddev
- Occupancy: nonzero count

**Pixel data (optional):**
- Linear: array of objects with channel-labeled properties
- Grid3D: nested 3D array `[z][y][x]` with channel-labeled properties
- Controlled by `pixels` parameter: `false` (never), `true` (always), `undefined` (auto based on size)

### Linear Layout Example

```js
readLinear({
  gl,
  texture,
  width: 256,
  height: 64,
  count: 10000,
  channels: ['x', 'y', 'z', 'mass'],
  pixels: false
})

// Returns:
{
  width: 256,
  height: 64,
  count: 10000,
  channels: 4,
  format: 'RGBA32F',
  bytesPerPixel: 16,
  
  x: {
    min: -3.2,
    max: 4.1,
    mean: 0.5,
    median: 0.4,
    stddev: 1.7,
    
    profile: '▃▄▅▆▇█▇▆▅▄▃▃▂▂▁▁',        // value along array
    histogram: '▁▃▅▇█▇▆▅▄▃▃▂▂▁▁▁',      // value distribution
    
    belowAbs0_001: 234,
    nearMin_5pc: 150,
    nearMax_5pc: 82,
    outliers_ex3stddev: 42,
    nonzero: 9998
  },
  y: { /* ... */ },
  z: { /* ... */ },
  mass: { /* ... */ },
  
  pixels: undefined,  // not captured (pixels: false)
  
  toString() { /* compact output */ }
}
```

### Grid3D Layout Example

```js
readGrid3D({
  gl,
  texture,
  width: 512,
  height: 512,
  gridSize: 64,
  channels: ['density'],
  pixels: true
})

// Returns:
{
  width: 512,
  height: 512,
  gridSize: 64,
  slicesPerRow: 8,
  voxelCount: 262144,
  channels: 1,
  format: 'RGBA32F',
  bytesPerPixel: 16,
  
  density: {
    min: 0.0,
    max: 12.5,
    mean: 2.3,
    median: 1.8,
    stddev: 1.7,
    
    histogram: '▁▃▅▇█▇▆▅▄▃▃▂▂▁▁▁',      // value distribution
    profileX: '▃▄▅▆▇█▇▆▅▄▃▃▂▂▁▁',      // mean along X axis
    profileY: '▂▃▄▅▆▇█▇▆▅▄▃▂▁▁▁',      // mean along Y axis
    profileZ: '▄▅▆▇█▇▆▅▄▃▂▂▁▁▁▁',      // mean along Z axis
    
    belowAbs0_001: 1234,
    nearMin_5pc: 850,
    nearMax_5pc: 412,
    outliers_ex3stddev: 142,
    nonzero: 45120
  },
  
  pixels: [  // nested 3D array [z][y][x]
    [  // z=0
      [{density: 0.1}, {density: 0.2}, ...],  // y=0, all x
      [{density: 0.3}, {density: 0.4}, ...],  // y=1, all x
      // ... 64 rows
    ],
    [  // z=1
      [{density: 0.5}, {density: 0.6}, ...],
      // ...
    ],
    // ... 64 Z-slices
  ],
  
  toString() { /* compact output */ }
}
```


## Formatting Principles

Snapshots use compact, information-dense notation:

- Unicode block characters (▁▂▃▄▅▆▇█) for visual profiles and histograms
- ASCII labels (mean/std/median/theta/soft) for clarity
- Controlled precision: 3-4 significant digits for floats
- Scientific notation (1.2e-3) for extreme values
- Zero handled specially: shows `0` not `+0` or `-0`
- All metrics shown - toString contains everything valueOf has

## Output Format

The `toString()` method returns a pre-generated string (created at snapshot time) showing ALL data from `valueOf()` except the pixels


The Markdown use is humble, where it adds to clarity

## Usage Patterns

**In unit tests:**

Test structural properties of the snapshot object. Assertions operate on plain data: `snapshot.position.x.mean > 0`. When tests fail, the snapshot's `toString()` provides diagnostic context automatically.

```js
const snapshot = kernel.valueOf({ pixels: false }); // Fast, stats only
assert(snapshot.position.x.mean > -5);
assert(snapshot.position.x.mean < 5);
```

**In REPL:**

Call `kernel.valueOf()` or `kernel.toString()` to inspect live state. The compact output is easy to read in console or can be logged to daebug session files for persistent inspection.

```js
// Auto-decide based on size (default)
const snap = kernel.valueOf();

// Force pixel capture for detailed inspection
const snapWithData = kernel.valueOf({ pixels: true });
console.log(snapWithData.position.pixels[0]); // {x: -2.3, y: 3.4, z: 0.2, mass: 1.0}
```

**For regression detection:**

Serialize snapshots to JSON. Compare against reference snapshots from known-good states. Detect unexpected changes in statistical properties, texture shapes, or validation flags.

**For pipeline debugging:**

Capture snapshots at each stage of a multi-kernel pipeline. Diff consecutive snapshots to see what each kernel changed. Track how quantities flow through the computation.


## Design Principles

**Opt-in:** Zero cost unless valueOf/toString invoked.

**Composable:** Small pieces (texture snapshots) combine into larger pieces (kernel snapshots). Each piece maintains the same interface.

**Minimal surface area:** Two methods (`valueOf`, `toString`), simple data structures.


## Implementation Status

All 22 WebGL2 kernels have complete reflection support:

### Gravity Multipole (8 kernels)

| Kernel | valueOf | toString | valueOf LOC |
|--------|---------|----------|-------------|
| `KAggregator` | ✅ | ✅ | 51 |
| `KAggregatorQuadrupole` | ✅ | ✅ | 64 |
| `KBoundsReduce` | ✅ | ✅ | 39 |
| `KIntegratePosition` | ✅ | ✅ | 47 |
| `KIntegrateVelocity` | ✅ | ✅ | 53 |
| `KPyramidBuild` | ✅ | ✅ | 58 |
| `KTraversal` | ✅ | ✅ | 56 |
| `KTraversalQuadrupole` | ✅ | ✅ | 53 |

### Gravity Spectral (5 kernels)

| Kernel | valueOf | toString | valueOf LOC |
|--------|---------|----------|-------------|
| `KDeposit` | ✅ | ✅ | 42 |
| `KFFT` | ✅ | ✅ | 47 |
| `KForceSample` | ✅ | ✅ | 58 |
| `KGradient` | ✅ | ✅ | 47 |
| `KPoisson` | ✅ | ✅ | 37 |

### Gravity Mesh (6 kernels)

| Kernel | valueOf | toString | valueOf LOC |
|--------|---------|----------|-------------|
| `KDeposit` | ✅ | ✅ | 40 |
| `KFFT` | ✅ | ✅ | 47 |
| `KForceSample` | ✅ | ✅ | 58 |
| `KGradient` | ✅ | ✅ | 47 |
| `KNearField` | ✅ | ✅ | 39 |
| `KPoisson` | ✅ | ✅ | 35 |

### Graph Laplacian (3 kernels)

| Kernel | valueOf | toString | valueOf LOC |
|--------|---------|----------|-------------|
| `KLaplacianFinish` | ✅ | ✅ | 51 |
| `KLaplacianPartials` | ✅ | ✅ | 53 |
| `KLaplacianReduceBlend` | ✅ | ✅ | 39 |

The `valueOf()` implementations range from 35 to 64 lines of code, averaging approximately 47 LOC per kernel.
