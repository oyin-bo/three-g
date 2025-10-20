# Spectral Kernels (PM/FFT) - Kernel-Based Implementation

This directory contains a kernel-based implementation of the Particle-Mesh (PM) spectral method for gravitational force computation. It follows the same architectural pattern as the monopole kernel implementation (`gravity-multipole/`).

## Overview

The spectral method computes gravitational forces using a Particle-Mesh approach with FFT-based Poisson solver:

1. **Deposit** particles onto a 3D grid (mass assignment)
2. **Forward FFT** to transform density to Fourier space
3. **Poisson solve** in Fourier space: φ(k) = -4πGρ(k)/k²
4. **Gradient** computation: F(k) = -ik·φ(k)
5. **Inverse FFT** to transform forces back to real space (3 axes)
6. **Sample** forces at particle positions using trilinear interpolation

## Architecture

Each stage is implemented as a self-contained **Kernel** with:
- Own shader programs and GPU resources
- Simple `run()` interface
- Clean `dispose()` for resource cleanup
- Input/output textures wired by the main system

This follows the WebGL2 Kernel contract established in `docs/8-webgl-kernels.md`.

## Files

### Kernel Implementations

- **`k-deposit.js`** - Particle deposition onto PM grid
  - Supports NGP (Nearest Grid Point) and CIC (Cloud-In-Cell) assignment
  - Additive blending for mass accumulation
  
- **`k-fft.js`** - 3D FFT transforms (forward and inverse)
  - Separable 3D FFT using butterfly stages
  - Internal ping-pong buffers for intermediate results
  - Handles real ↔ complex conversions
  
- **`k-poisson.js`** - Poisson equation solver in Fourier space
  - Computes gravitational potential from density
  - Includes deconvolution for mass assignment correction
  - Optional discrete Laplacian and Gaussian smoothing
  
- **`k-gradient.js`** - Force field computation
  - Spectral differentiation: F = -∇φ
  - Generates force spectra for 3 axes (X, Y, Z)
  
- **`k-force-sample.js`** - Force sampling at particle positions
  - Trilinear interpolation from 3D force grids
  - Writes particle force texture for integration

- **`particle-system-spectral-kernels.js`** - Main system orchestration
  - Creates and wires all kernels
  - Manages particle textures and PM grid resources
  - Reuses velocity/position integrators from monopole kernels

### Tests

- **`k-deposit.test.js`** - Tests particle deposition
  - Single/multiple particles
  - NGP vs CIC assignment
  - Mass conservation
  
- **`k-poisson.test.js`** - Tests Poisson solver
  - DC mode handling
  - Single/multiple frequency modes
  - Finite value validation

### Shaders

Copied from `gravity-spectral/shaders/`:
- `pm-deposit.vert.js` / `pm-deposit.frag.js` - Particle deposition
- `fft.frag.js` - FFT butterfly stages
- `poisson.frag.js` - Poisson solver
- `gradient.frag.js` - Gradient computation
- `force-sample.vert.js` / `force-sample.frag.js` - Force sampling

## Usage

```javascript
import { ParticleSystemSpectralKernels } from './gravity-spectral-kernels/particle-system-spectral-kernels.js';

// Create system (reuses existing WebGL2 context)
const system = new ParticleSystemSpectralKernels(gl, {
  particleData: {
    positions: particlePositions,  // Float32Array (x,y,z,mass per particle)
    velocities: particleVelocities, // Float32Array (vx,vy,vz,0 per particle)
    colors: particleColors          // Uint8Array (r,g,b,a per particle)
  },
  particleCount: 10000,
  worldBounds: { min: [-50, -50, -50], max: [50, 50, 50] },
  gridSize: 64,           // PM grid resolution
  assignment: 'CIC',      // or 'NGP'
  gravityStrength: 0.0003,
  dt: 1/60
});

// Animation loop
function animate() {
  system.step();  // Compute forces and integrate
  
  // Render particles using system.getPositionTexture()
  
  requestAnimationFrame(animate);
}
```

## Comparison with Original Implementation

| Original (`gravity-spectral/`) | Kernel-Based (`gravity-spectral-kernels/`) |
|-------------------------------|-------------------------------------------|
| Monolithic pipeline functions | Self-contained kernel classes |
| State stored in `psys` object | State encapsulated per kernel |
| Direct GL calls in pipeline | Kernels manage own GL resources |
| Harder to test in isolation | Each kernel independently testable |
| Tightly coupled to main system | Loose coupling via texture wiring |

## Performance Characteristics

- **O(N + M log M)** complexity where N = particle count, M = grid size³
- Best for uniform particle distributions
- Grid resolution (64³ typical) determines force accuracy vs. performance
- FFT stages dominate computation time
- CIC assignment more accurate than NGP but 8x more geometry

## Testing

Tests follow the monopole kernel testing pattern:
- Use shared `test-utils.js` helpers
- Run in browser environment with WebGL2
- Validate correctness, mass conservation, finite values

Run tests:
```bash
# Via daebug REPL (preferred)
npm start
# Open http://localhost:8768/kernel-test.html
# Use daebug markdown REPL to execute tests

# Or via Node.js (will fail - needs browser)
node --test particle-system/gravity-spectral-kernels/*.test.js
```

## References

- Parent implementation: `gravity-spectral/`
- Architecture docs: `docs/8-webgl-kernels.md`
- Monopole kernels: `gravity-multipole/`
- FFT normalization: `gravity-spectral/pm-fft.js` header comments
