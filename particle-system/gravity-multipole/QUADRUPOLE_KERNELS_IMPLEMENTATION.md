# Quadrupole Kernels Implementation

## Overview

This document describes the implementation of the quadrupole particle system using the Kernel architecture, following the exact same pattern as the monopole-kernels implementation.

## Files Created

1. **k-traversal-quadrupole.js** (462 lines)
   - Kernel for quadrupole Barnes-Hut tree traversal
   - Uses individual texture uniforms (not arrays) to match monopole pattern
   - Implements full quadrupole force calculation with second moments
   - Follows WebGL2 Kernel contract from docs/8-webgl-kernels.md

2. **particle-system-quadrupole-kernels.js** (495 lines)
   - Main particle system class using kernel composition
   - Orchestrates: aggregation → pyramid → traversal → integration
   - Uses the same kernels as monopole: KAggregator, KPyramidBuild, KIntegrateVelocity, KIntegratePosition
   - Adds quadrupole-specific: KTraversalQuadrupole with A1/A2 moment handling

3. **k-traversal-quadrupole.test.js** (413 lines)
   - Unit tests following the same pattern as monopole tests
   - Tests: single particle, two particles, quadrupole vs monopole, multiple levels, edge cases

## Implementation Approach

### Following Monopole Pattern

The implementation strictly follows the monopole-kernels pattern:

1. **Kernel Contract Compliance**
   - Constructor with options object
   - Flat resource properties (inPosition, outForce, etc.)
   - Resource creation rule: truthy or null = no creation
   - Synchronous run() method
   - Unconditional dispose() method

2. **Texture Handling**
   - Uses individual sampler2D uniforms (not texture arrays)
   - Matches monopole shader pattern with separate uniforms per level
   - A0 textures: u_levelA0_0 through u_levelA0_6
   - A1 textures: u_levelA1_0 through u_levelA1_6  
   - A2 textures: u_levelA2_0 through u_levelA2_6

3. **Kernel Composition**
   - Reuses existing kernels: KAggregator, KPyramidBuild, integrators
   - Only adds new KTraversalQuadrupole for quadrupole-specific logic
   - Same pipeline structure: build octree → calculate forces → integrate

### Key Differences from Monopole

1. **Three Moment Textures Per Level**
   - A0: monopole moments [m*x, m*y, m*z, m]
   - A1: second moments [m*x², m*y², m*z², m*xy]
   - A2: second moments [m*xz, m*yz, 0, 0]

2. **Quadrupole Force Calculation**
   - Monopole term (same as monopole kernel)
   - Quadrupole correction using second moments
   - Can be toggled via enableQuadrupoles flag

3. **Additional Configuration**
   - enableQuadrupoles: boolean to enable/disable quadrupole terms
   - useOccupancyMasks: boolean for future occupancy optimization

## Shader Implementation

The quadrupole traversal shader is implemented inline (not using the generator) to:
- Match the monopole pattern exactly
- Use individual textures instead of texture arrays
- Keep implementation simpler and more testable
- Avoid dependency on texture array support

The shader includes:
- Barnes-Hut MAC (Multipole Acceptance Criterion) 
- Monopole force calculation
- Quadrupole moment reconstruction from A1/A2 textures
- Quadrupole force correction with proper tensor contraction

## Testing Strategy

Tests follow the exact same pattern as monopole kernel tests:

1. **Basic Functionality**
   - Single particle (no force)
   - Two particle interaction
   - Quadrupole vs monopole comparison

2. **Edge Cases**
   - Multiple hierarchy levels
   - Zero mass particles
   - Out of bounds handling

3. **Test Infrastructure**
   - Uses same test-utils.js helpers
   - Requires browser environment with WebGL2
   - Can be run via daebug test harness

## Usage Example

```javascript
import { ParticleSystemQuadrupoleKernels } from './particle-system-quadrupole-kernels.js';

const gl = canvas.getContext('webgl2');

const system = new ParticleSystemQuadrupoleKernels(gl, {
  particleData: {
    positions: new Float32Array([...]), // x,y,z,mass per particle
    velocities: new Float32Array([...]), // vx,vy,vz,0 per particle
    colors: new Uint8Array([...])        // r,g,b,a per particle
  },
  worldBounds: { min: [-4, -4, 0], max: [4, 4, 2] },
  theta: 0.5,
  dt: 1/60,
  gravityStrength: 0.0003,
  softening: 0.2,
  enableQuadrupoles: true  // Enable quadrupole moments
});

// Animation loop
function animate() {
  system.step();  // Compute one frame
  
  // Get position texture for rendering
  const posTexture = system.getPositionTexture();
  
  requestAnimationFrame(animate);
}

// Cleanup
system.dispose();
```

## Kernel API

### KTraversalQuadrupole

```javascript
const kernel = new KTraversalQuadrupole({
  gl,
  inPosition: positionTexture,      // Particle positions
  inLevelA0: [a0_L0, a0_L1, ...],  // Monopole moments per level
  inLevelA1: [a1_L0, a1_L1, ...],  // Quadrupole moments (xx,yy,zz,xy)
  inLevelA2: [a2_L0, a2_L1, ...],  // Quadrupole moments (xz,yz)
  outForce: forceTexture,           // Output force texture
  particleTexWidth: 32,
  particleTexHeight: 32,
  numLevels: 7,
  levelConfigs: [...],
  worldBounds: { min: [-4,-4,0], max: [4,4,2] },
  theta: 0.5,
  gravityStrength: 0.0003,
  softening: 0.2,
  enableQuadrupoles: true
});

kernel.run();  // Compute forces
kernel.dispose();  // Cleanup
```

## Verification Checklist

- [x] Follows exact kernel contract from docs/8-webgl-kernels.md
- [x] Constructor handles resource creation correctly
- [x] Uses same pattern as monopole-kernels
- [x] Reuses existing kernels where possible
- [x] Unit tests follow monopole test pattern
- [x] Proper dispose() implementation
- [x] Inline shader uses individual textures
- [x] Quadrupole force calculation implemented
- [x] Toggleable quadrupole terms
- [x] Documentation and comments

## Future Enhancements

1. **Occupancy Masks**: Implement occupancy mask support for sparse grids
2. **Performance Tuning**: Optimize shader for specific GPU architectures
3. **Adaptive Theta**: Dynamic MAC threshold based on error estimates
4. **Integration Tests**: Full pipeline tests comparing to reference implementation
5. **Browser Tests**: Run tests in headless browser via daebug harness

## References

- docs/8-webgl-kernels.md - Kernel contract specification
- docs/8.1-multipole-migration.md - Migration guide for multipole systems
- particle-system-monopole-kernels.js - Reference monopole implementation
- k-traversal.js - Reference monopole traversal kernel
