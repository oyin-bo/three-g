# THREE-g — Galaxy Primitives for THREE.js

GPU-accelerated particle rendering and Barnes-Hut N-body physics for THREE.js.

## Overview

THREE-g is a dual-module library that brings astrophysical-scale particle simulation to the browser. At its heart lie two distinct yet harmoniously intertwined functional modules:

### 1. **Mass Spot Mesh Renderer** (`massSpotMesh`)
A high-performance particle visualization engine that transforms raw spatial data into luminous cosmic beauty. Whether fed from CPU arrays or GPU textures, it renders hundreds of thousands of glowing particles with atmospheric fog effects—all while maintaining silky-smooth frame rates.

### 2. **Particle Physics System** (`particleSystem`)
A GPU-native N-body gravitational simulator with four computational methods:

- **Quadrupole** (default): 2nd-order Barnes-Hut tree-code with quadrupole moments and improved multipole acceptance criterion (MAC). Provides superior accuracy with better force approximations at distance.
- **Monopole**: 1st-order Barnes-Hut tree-code using only monopole moments (center of mass). The classic approach with simpler computations.
- **Mesh**: Hybrid Particle-Mesh method combining FFT-based far-field forces with local near-field corrections. Offers smooth, artifact-free forces with O(N + M log M) complexity.
- **Spectral** (experimental): Pure Particle-Mesh method with FFT-based Poisson solver. Uses spectral techniques for smooth long-range forces, currently under active development.

All methods compute O(N log N) or better physics entirely on the GPU. Both physics and particle rendering share GPU resources, avoiding memory bottlenecks.

These modules can operate independently or in concert. The **mass spot mesh** is agnostic to its data source—it happily consumes static arrays, procedural generators, or dynamic GPU textures from any GPGPU simulation. The **particle system** produces GPU-resident position and color textures that plug directly into the renderer's texture mode, creating a zero-copy pipeline from physics to pixels.

## Features

- **massSpotMesh**: Efficient particle rendering with glow effects
- **particleSystem**: GPU-based O(N log N) gravitational physics with four computational methods:
  - **Quadrupole**: 2nd-order Barnes-Hut with improved accuracy
  - **Monopole**: Classic 1st-order Barnes-Hut
  - **Mesh**: Hybrid PM/FFT with near-field correction
  - **Spectral**: Pure FFT-based Particle-Mesh (experimental)
- Scales to 200,000+ particles at 10-30 FPS
- Zero CPU involvement: all computation on GPU

## Quick Start

```javascript
import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh, particleSystem } from 'three-g';

const { scene, renderer } = createScene();

// Generate initial particle data (mass-spot style)
const particles = Array.from({ length: 50000 }, () => ({
  x: (Math.random() - 0.5) * 4,
  y: (Math.random() - 0.5) * 4,
  z: (Math.random() - 0.5) * 2,
  mass: 0.5 + Math.random() * 1.5,
  rgb: new THREE.Color().setHSL(Math.random(), 0.7, 0.6).getHex()
}));

// Create physics system with particle data
const physics = particleSystem({
  gl: renderer.getContext(),
  particles,
  method: 'quadrupole',  // 'quadrupole' (default), 'monopole', or 'spectral'
  worldBounds: { min: [-4, -4, -2], max: [4, 4, 2] }
});

// Create rendering mesh (texture mode for GPU-to-GPU pipeline)
const textureSize = physics.getTextureSize();
const { mesh } = massSpotMesh({
  textureMode: true,
  particleCount: physics.particleCount,
  textures: {
    position: physics.getPositionTexture(),
    color: physics.getColorTexture(),
    size: [textureSize.width, textureSize.height]
  },
  fog: { start: 15, gray: 40 }
});

scene.add(mesh);

// Animation loop
function animate() {
  physics.compute();
  mesh.material.uniforms.u_positionTexture.value = physics.getPositionTexture();
  requestAnimationFrame(animate);
}
animate();
```

## Demo Pages

The repository includes three demonstration pages showcasing different usage patterns:

### **[index.html](index.html)** — Full Physics Simulation
The flagship demo (`demo.js`) demonstrates the complete integration of both modules. It creates a dynamic gravitational N-body system where 50,000+ particles attract each other in real-time. This is where the mass spot mesh renderer and particle physics system join forces—physics computes positions on the GPU, and those textures flow directly into the renderer without ever touching CPU memory. A pure GPU pipeline.

### **[simplistic.html](simplistic.html)** — Pure Rendering
A minimalist showcase (`simplistic.js`) of the **mass spot mesh** in isolation. It renders 40,000 static particles from a CPU array, demonstrating the renderer's array mode. No physics, no complexity—just raw rendering prowess with fog and glow effects. Perfect for understanding the renderer's standalone capabilities.

### **[texture-mode.html](texture-mode.html)** — Custom GPGPU Integration
An architectural blueprint (`texture-mode.js`) showing how to wire any GPGPU simulation into the mass spot mesh renderer. It manually creates WebGL textures with particle data, demonstrating the texture mode interface. This pattern is exactly how `demo.js` connects the particle system to the renderer—you can substitute any custom GPU computation (fluid dynamics, flocking algorithms, etc.) using the same approach.

## API

### particleSystem(options)

Creates GPU-accelerated Barnes-Hut N-body simulation.

**Initial Particle Data**: The system accepts particle data at initialization time through the `particles` array parameter. Each particle can specify initial position, velocity, mass, and color. The system transforms this CPU data into GPU textures during initialization—a one-time upload that establishes the initial state. From that moment forward, all particle data lives exclusively on the GPU.

**Options**:
- `gl`: WebGL2 context (required) — reused from THREE.WebGLRenderer
- `particles`: Array of particle objects (required) — initial state
- `method`: Computation method (optional, default: 'quadrupole')
  - `'quadrupole'`: 2nd-order Barnes-Hut with quadrupole moments
  - `'monopole'`: 1st-order Barnes-Hut with monopole moments only
  - `'mesh'`: Hybrid Particle-Mesh with FFT far-field and local near-field
  - `'spectral'`: Pure Particle-Mesh with FFT (experimental)
- `get`: Optional mapper function `(particle, out) => void` for custom data extraction
- `worldBounds`: Simulation bounds `{ min: [x,y,z], max: [x,y,z] }` (optional)
- `theta`: Barnes-Hut approximation threshold (default: 0.5 for spectral, 0.65 for tree methods)
- `gravityStrength`: Force multiplier (default: 0.0003)
- `dt`: Timestep (default: 1/60)
- `softening`: Softening length to prevent singularities (default: 0.2)
- `damping`: Velocity damping (default: 0.0)
- `maxSpeed`: Maximum velocity clamp (default: 2.0)
- `maxAccel`: Maximum acceleration clamp (default: 1.0)
- `enableProfiling`: Enable GPU profiling (default: false)

**Particle Object Shape**:
```javascript
{
  x?: number,      // Position (default: 0)
  y?: number,
  z?: number,
  vx?: number,     // Velocity (default: 0)
  vy?: number,
  vz?: number,
  mass?: number,   // Mass (default: 0)
  rgb?: number     // Color as 24-bit integer (default: 0xFFFFFF)
}
```

**Returns**: System object with methods:
- `compute()`: Step simulation forward one frame
- `getPositionTexture()`: Get current positions (WebGLTexture, RGBA32F)
- `getColorTexture()`: Get particle colors (WebGLTexture, RGBA)
- `getTextureSize()`: Get texture dimensions `{ width, height }`
- `getCurrentIndex()`: Get current ping-pong buffer index (0 or 1)
- `unload(particles, set?)`: Read GPU state back to CPU (see below)
- `stats()`: Get GPU timing stats if profiling enabled (returns object or null)
- `dispose()`: Release GPU resources

### massSpotMesh(options)

Creates particle rendering mesh.

**Texture Mode** (GPU-resident data):
```javascript
massSpotMesh({
  textureMode: true,
  particleCount: 50000,
  textures: { position, color, size },
gl: renderer.getContext()
})
```

**Array Mode** (CPU data):
```javascript
massSpotMesh({
  spots: [{ x, y, z, mass, rgb }, ...],
  gl: renderer.getContext()
})
```

**Returns**: Mesh object with:
- `mesh`: THREE.Points object to add to scene
- `stats()`: Get GPU timing stats if profiling enabled (returns object or null)
- `update(spots)`: Update particle data (array mode only)

## How the Modules Connect

The integration in `demo.js` reveals the elegant choreography between renderer and physics:

1. **Initialization**: Particle data flows from CPU arrays into the physics system via `particleSystem({ particles, method })`. The method parameter selects between 'monopole', 'quadrupole' (default), 'mesh', or 'spectral' implementations. The system uploads this data to GPU textures during initialization—positions, velocities, colors all transformed into WebGL textures.

2. **GPU-to-GPU Pipeline**: The mass spot mesh is created in texture mode, directly consuming the physics system's position and color textures. No intermediate copies, no CPU readbacks—the renderer samples directly from the physics textures.

3. **Ping-Pong Architecture**: The particle system uses double-buffered textures (ping-pong) for position and velocity updates. Each frame, it reads from one buffer and writes to the other. The mesh renderer must track which texture is current using `getCurrentIndex()` and update its uniform accordingly.

4. **Animation Loop**: Each frame calls `physics.compute()` to advance the simulation, then updates the renderer's texture uniform to point at the newly computed positions. The entire pipeline—force calculation, integration, and rendering—occurs on the GPU without CPU intervention.

### Method Selection

Choose the computation method based on your requirements:

- **Use 'quadrupole'** (default) for:
  - Best accuracy-to-performance ratio
  - Complex clustering scenarios
  - When visual quality is paramount
  - Production applications

- **Use 'monopole'** for:
  - Maximum performance with acceptable quality
  - Simpler force models
  - Debugging and comparison
  - Educational purposes

- **Use 'mesh'** for:
  - Smooth, artifact-free force fields
  - Uniform or semi-uniform particle distributions
  - Scenarios where tree-based stepping artifacts are undesirable
  - Hybrid PM/tree-code approaches

- **Use 'spectral'** for:
  - Experimental smooth-field physics
  - Periodic boundary conditions
  - Research into spectral methods
  - Development and testing (currently experimental)

This architecture is not unique to gravitational physics. Any GPGPU computation that produces particle positions in a texture can plug into the same rendering pipeline, as demonstrated in `texture-mode.html`.

## The Barnes-Hut Algorithm: A Cosmic Optimization

The particle system's tree-based gravitational simulation employs the Barnes-Hut algorithm, a hierarchical tree-based method that revolutionized N-body astrophysics when first proposed in 1986. Before Barnes-Hut, direct particle-particle force calculations scaled as O(N²)—prohibitive for systems beyond a few thousand bodies. The galaxy simulations and dark matter studies that transformed modern cosmology became tractable only after this algorithmic breakthrough.

### The Core Insight

Instead of computing forces between every pair of particles, Barnes-Hut groups distant particles into "supermassive" clusters. If a cluster is sufficiently far away, its constituent particles can be approximated as a single point mass at their center of mass. This trades a small amount of accuracy for dramatic performance gains—O(N log N) instead of O(N²).

The algorithm constructs an octree (3D spatial hierarchy) where each node represents a cubic region of space. Leaf nodes contain individual particles; branch nodes aggregate the mass and center of mass of their children. During force calculation, the tree is traversed: if a node's angular size (as seen from the target particle) falls below a threshold θ (theta), its mass is treated as a point source. Otherwise, the node's children are recursively examined.

### Computational Methods

THREE-g implements three distinct approaches to N-body force computation, each with different accuracy/performance tradeoffs:

#### Monopole Method (1st-order Barnes-Hut)

The classic Barnes-Hut implementation. Each octree node stores only monopole moments: total mass M₀ and center of mass position. When a node is accepted by the multipole acceptance criterion (MAC), it contributes a force as if all its mass were concentrated at the center of mass:

```
F = G · M₀ · r / |r|³
```

This provides good performance but can exhibit directional bias when nodes are accepted too aggressively, leading to artifacts in clustered configurations.

**Implementation**: Uses individual 2D textures per octree level, storing `[Σ(m·x), Σ(m·y), Σ(m·z), Σm]` per voxel.

#### Quadrupole Method (2nd-order Barnes-Hut, default)

An enhanced Barnes-Hut variant that stores both monopole and quadrupole moments at each node. The quadrupole tensor captures the second moments of the mass distribution, enabling more accurate force approximations for extended mass distributions.

Each node stores:
- **A0**: Monopole moments `[Σ(m·x), Σ(m·y), Σ(m·z), Σm]`
- **A1**: Second moments `[Σ(m·x²), Σ(m·y²), Σ(m·z²), Σ(m·xy)]`
- **A2**: Second moments `[Σ(m·xz), Σ(m·yz), 0, 0]`

The force computation assembles a trace-free quadrupole tensor Q from these moments and evaluates:

```
F = G · [M₀ · r/|r|³ + Q·r/|r|⁵ - 2.5·(r·Q·r)·r/|r|⁷]
```

The quadrupole method also uses an **improved multipole acceptance criterion (MAC)** that accounts for the offset between the node's geometric center and its center of mass:

```
Accept if: d > s/θ + δ
```

where d is the distance to the target particle, s is the cell size, θ is the opening angle, and δ = |COM - cell_center| is the COM offset.

This approach markedly reduces anisotropic errors, allowing higher θ values (more aggressive pruning) without visual artifacts. It also includes optional KDK (Kick-Drift-Kick) symplectic integration for improved energy conservation.

**Implementation**: Uses WebGL2 texture arrays (3 arrays of 8 layers each) to reduce texture unit usage and improve cache coherence. Supports occupancy masking to skip empty voxels during traversal.

#### Mesh Method (Hybrid Particle-Mesh, production-ready)

A practical hybrid approach that combines the smooth far-field forces of Particle-Mesh methods with accurate local near-field corrections. This TreePM-inspired technique splits the gravitational force into two ranges:

**Far-field (PM/FFT)**:
1. **Deposit**: Particles → density field ρ(x) on 64³ grid (NGP or CIC interpolation)
2. **Forward FFT**: ρ(x) → ρ̂(k) (real space → frequency space)
3. **Split filter**: Apply Gaussian smoothing S(k) = exp(-(k·r_s)²) to separate scales
4. **Poisson solve**: ρ̂(k) → φ̂(k) using Green's function -4πG/k²·S(k)
5. **Gradient**: φ̂(k) → ĝ(k) = ik·φ̂(k) (force in frequency space)
6. **Inverse FFT**: ĝ(k) → g_far(x) (frequency space → real space)
7. **Sample**: Interpolate g_far(x) at particle positions

**Near-field (local correction)**:
- Direct summation over neighboring L0 voxels (3×3×3 or 5×5×5 neighborhood)
- Uses complementary Ewald/Gaussian kernel to avoid double-counting
- Adds high-frequency force components filtered out by the PM stage

The mesh method eliminates tree traversal entirely, replacing it with FFT convolution (O(M log M) where M = grid size) plus local corrections (O(N·k) where k is neighborhood size, typically 27). This provides smooth, artifact-free forces without the stepping or angular bias that can affect tree methods.

**Key advantages**:
- No tree construction overhead
- Naturally smooth forces (no cell-crossing discontinuities)
- Predictable performance independent of clustering
- Well-suited for uniform and semi-uniform distributions
- Production-ready with established PM/TreePM heritage

**Implementation**: Reuses the existing L0 grid infrastructure (same 64³ grid and Z-slice texture mapping as the tree methods), adding FFT pipeline stages and near-field correction passes. The fixed periodic domain ensures consistent FFT semantics.

#### Spectral Method (Pure Particle-Mesh with FFT, experimental)

A research implementation exploring pure spectral techniques without hybrid split. Follows the same PM pipeline as the Mesh method but without the near-field correction stage. This pure-FFT approach:

1. **Deposit**: Particles → density field ρ(x) on 64³ grid (CIC/TSC interpolation)
2. **Forward FFT**: ρ(x) → ρ̂(k) (real space → frequency space)
3. **Poisson solve**: ρ̂(k) → φ̂(k) using Green's function -4πG/k²
4. **Gradient**: φ̂(k) → ĝ(k) = ik·φ̂(k) (force in frequency space)
5. **Inverse FFT**: ĝ(k) → g(x) (frequency space → real space)
6. **Sample**: Interpolate g(x) at particle positions

This method provides O(N + M log M) complexity where N is particle count and M is grid size. It excels with smooth, uniform distributions and eliminates the stepping artifacts inherent to tree methods. The spectral approach also naturally smooths short-wavelength noise that can seed numerical instabilities.

**Current status**: The spectral implementation is functional but experimental. It includes a comprehensive debugging infrastructure (`particle-system/gravity-spectral/debug/`) with synthetic data generators, validators, and snapshot comparison tools for verifying each pipeline stage. Active development focuses on accuracy refinement and performance optimization.

### GPU Implementation Challenges

Translating these algorithms to GPU shaders—where recursion is forbidden and memory access is texture-based—required significant architectural ingenuity:

- **Octree as Textures**: The tree is stored as a pyramid of 3D textures (mapped to 2D via Z-slice stacking). Each level represents a spatial subdivision, with Level 0 containing individual particles and higher levels aggregating regions.

- **Iterative Traversal**: The recursive tree walk is rewritten as an iterative loop with an explicit stack, encoded in shader registers. The traversal shader performs this for every particle in parallel.

- **Isotropic 3D Subdivision**: Voxel grids are subdivided uniformly in all three dimensions, with Z-slices packed into 2D textures. This preserves spatial locality for cache coherence.

- **MRT Aggregation**: Multiple render targets (MRT) enable simultaneous output of monopole and quadrupole moments during the aggregation and reduction passes, minimizing bandwidth.

- **Spectral Transforms**: The FFT implementation uses Stockham's algorithm with ping-pong textures, performing three 1D transforms (X→Y→Z) on the sliced 3D grid.

### History of the Galaxies

The Barnes-Hut algorithm enabled the first large-scale cosmological simulations in the late 1980s, revealing how dark matter halos form and evolve. Modern variants like Fast Multipole Method (FMM) and tree-particle-mesh (TPM) codes power exascale simulations tracking billions of particles across cosmic epochs. 

The spectral particle-mesh approach, pioneered in the 1970s, became the foundation for modern cosmological codes like GADGET and Enzo when combined with adaptive mesh refinement. The PM method's ability to handle periodic boundary conditions naturally makes it ideal for simulating cosmic structure formation in expanding universes.

The hybrid TreePM method emerged in the 1990s as a practical reconciliation of these two paradigms. By splitting gravitational forces into smooth long-range (handled via FFT) and sharp short-range (handled via direct summation or tree codes) components, TreePM methods like those in GADGET-2 achieved the best of both worlds: FFT efficiency for large-scale structure and high-resolution accuracy for dense clusters. This split-force approach became the workhorse of modern cosmological simulations, enabling studies of galaxy formation from cosmic dawn to the present day.

By bringing these techniques to the browser via GPU shaders, THREE-g democratizes computational approaches that once required supercomputers—now anyone can experiment with gravitational choreography in real-time, right in their web browser.

The θ parameter controls the approximation threshold. Lower values mean tighter accuracy, higher GPU cost. The default of 0.65 for tree methods keeps systems up to ~200,000 particles physically coherent without dropping below 10 FPS on modern hardware. The quadrupole method achieves similar accuracy with higher θ values due to its improved force model.

## License

MIT © Oleg Mihailik