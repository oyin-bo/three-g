# Gravity Mesh Kernels

Kernel-based mesh particle system implementation using WebGL2 Kernel architecture.

## Overview

This implementation uses composition of small, testable kernels instead of a monolithic pipeline. It follows the same architecture pattern as `gravity-multipole/particle-system-monopole-kernels.js`.

## Architecture

### Main Class

**ParticleSystemMeshKernels** - Orchestrates all mesh kernels to compute gravitational forces using the Particle-Mesh (PM) method.

### Kernels

Each kernel follows the WebGL2 Kernel contract:
- Owns internal resources (textures, FBOs, programs)
- Exposes input/output slots for wiring
- Has `run()` method to execute
- Has `dispose()` method to clean up

#### 1. KDeposit
Deposits particle mass onto 3D grid using:
- **NGP** (Nearest Grid Point) - O(N) simple assignment
- **CIC** (Cloud-In-Cell) - O(8N) trilinear interpolation

**Inputs:** Particle positions  
**Output:** 3D mass grid (laid out as 2D texture with slices)

#### 2. KFFT
Performs 3D Fast Fourier Transform using Stockham algorithm.

**Forward mode:**
- Converts real grid to complex spectrum
- Includes mass-to-density conversion (divides by cell volume)

**Inverse mode:**
- Converts complex spectrum back to real grid
- Includes `runInverseToReal()` convenience method

**Inputs:** Real grid (RGBA32F) or complex spectrum (RG32F)  
**Output:** Complex spectrum (RG32F) or real grid (RGBA32F)

#### 3. KPoisson
Solves Poisson equation in Fourier space: ∇²φ = 4πGρ

Supports:
- **Split modes:** None (0), sharp k-space split (1), Gaussian split (2)
- **Deconvolution:** Corrects for mass assignment scheme (NGP=1, CIC=2, TSC=3)
- **Discrete vs continuous:** Discrete Green's function for periodic boundaries

**Inputs:** Density spectrum  
**Output:** Gravitational potential spectrum

#### 4. KGradient
Computes force spectra from potential spectrum using: F = -∇φ

Calculates gradient in Fourier space (multiplication by ik) for each axis.

**Inputs:** Potential spectrum  
**Outputs:** Three force component spectra (Fx, Fy, Fz)

#### 5. KForceSample
Interpolates forces from 3D force grids to particle positions.

Supports both:
- **Replace mode:** Overwrites force texture
- **Accumulate mode:** Adds to existing forces (used for near-field)

**Inputs:** Particle positions, three force grids (x, y, z)  
**Output:** Force texture (per-particle)

#### 6. KNearField
Computes near-field corrections using direct particle-particle interactions within grid cells.

Corrects mesh approximation errors at short range by:
1. Computing real-space forces in a neighborhood around each voxel
2. Subtracting long-range contribution already counted in mesh

**Inputs:** Mass grid  
**Outputs:** Three near-field force grids (x, y, z)

## Pipeline

The complete mesh force computation pipeline:

```
Particle Positions
       ↓
   [KDeposit] ← Mass assignment (NGP/CIC)
       ↓
   Mass Grid
       ↓
   [KFFT Forward] ← Real → Complex + density conversion
       ↓
  Density Spectrum
       ↓
   [KPoisson] ← Solve ∇²φ = 4πGρ in k-space
       ↓
  Potential Spectrum
       ↓
   [KGradient] ← Compute F = -∇φ in k-space
       ↓
  Force Spectra (Fx, Fy, Fz)
       ↓
   [KFFT Inverse] × 3 ← Complex → Real for each axis
       ↓
  Force Grids (x, y, z)
       ↓
   [KForceSample] ← Interpolate to particles
       ↓
  Particle Forces
       ↓
   [KNearField] ← Compute corrections
       ↓
   [KForceSample] ← Accumulate corrections
       ↓
  Final Forces
```

## Testing

Each kernel has comprehensive unit tests following the pattern from `gravity-multipole`:

- **k-deposit.test.js** - Tests NGP/CIC, mass conservation, multiple particles
- **k-fft.test.js** - Tests forward/inverse transforms, round-trip recovery
- **k-poisson.test.js** - Tests split modes, deconvolution, world sizes

Tests use browser-based WebGL2 testing infrastructure from `test-utils.js`.

## Usage

```javascript
import { ParticleSystemMeshKernels } from './particle-system/gravity-mesh-kernels/particle-system-mesh-kernels.js';

const physics = new ParticleSystemMeshKernels(gl, {
  particleData: {
    positions: positionsFloat32Array,
    velocities: velocitiesFloat32Array,
    colors: colorsUint8Array
  },
  worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
  mesh: {
    assignment: 'cic',      // 'ngp' or 'cic'
    gridSize: 64,           // Grid resolution
    slicesPerRow: 8,        // Texture layout
    nearFieldRadius: 2      // Near-field correction radius
  }
});

// Simulation loop
physics.step();

// Get position texture for rendering
const positionTexture = physics.getPositionTexture();
```

## Comparison with Original

This implementation replaces the pipeline functions in `gravity-mesh/pipeline/` with standalone kernel classes:

| Original | Kernel |
|----------|--------|
| deposit.js | KDeposit |
| fft.js | KFFT |
| poisson.js | KPoisson |
| gradient.js | KGradient |
| force-sample.js | KForceSample |
| near-field.js | KNearField |
| compute-mesh-forces.js | ParticleSystemMeshKernels.step() |

**Benefits:**
- Each kernel is independently testable
- Clearer ownership of resources
- Easier to understand data flow
- Consistent with monopole-kernels architecture
- Better error handling and state management

## File Structure

```
gravity-mesh-kernels/
├── README.md                          # This file
├── particle-system-mesh-kernels.js   # Main orchestrator
├── k-deposit.js                       # Mass assignment kernel
├── k-deposit.test.js
├── k-fft.js                           # FFT kernel
├── k-fft.test.js
├── k-poisson.js                       # Poisson solver kernel
├── k-poisson.test.js
├── k-gradient.js                      # Gradient kernel
├── k-force-sample.js                  # Force sampling kernel
├── k-near-field.js                    # Near-field kernel
└── shaders/
    ├── deposit.vert.js                # Deposit vertex shader
    └── deposit.frag.js                # Deposit fragment shader
```

Note: Other shaders are reused from `gravity-spectral/shaders/` (fft, poisson, gradient) and `shaders/` (fullscreen.vert, near-field.frag).
