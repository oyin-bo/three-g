# THREE-g — Galaxy Primitives for THREE.js

GPU-accelerated particle rendering and Barnes-Hut N-body physics for THREE.js.

## Overview

THREE-g is a dual-module library that brings astrophysical-scale particle simulation to the browser. At its heart lie two distinct yet harmoniously intertwined functional modules:

### 1. **Mass Spot Mesh Renderer** (`massSpotMesh`)
A high-performance particle visualization engine that transforms raw spatial data into luminous cosmic beauty. Whether fed from CPU arrays or GPU textures, it renders hundreds of thousands of glowing particles with atmospheric fog effects—all while maintaining silky-smooth frame rates.

### 2. **Particle Physics System** (`particleSystem`)
A GPU-native Barnes-Hut N-body gravitational simulator that computes O(N log N) physics entirely on the graphics card. Both physics particle rendering share GPU avoiding memory bottlenecks.

These modules can operate independently or in concert. The **mass spot mesh** is agnostic to its data source—it happily consumes static arrays, procedural generators, or dynamic GPU textures from any GPGPU simulation. The **particle system** produces GPU-resident position and color textures that plug directly into the renderer's texture mode, creating a zero-copy pipeline from physics to pixels.

## Features

- **massSpotMesh**: Efficient particle rendering with glow effects
- **particleSystem**: GPU-based O(N log N) gravitational physics using Barnes-Hut algorithm
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
  worldBounds: { min: [-4, -4, -2], max: [4, 4, 2] }
});

// Create rendering mesh (texture mode for GPU-to-GPU pipeline)
const textureSize = physics.getTextureSize();
const mesh = massSpotMesh({
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
- `get`: Optional mapper function `(particle, out) => void` for custom data extraction
- `worldBounds`: Simulation bounds `{ min: [x,y,z], max: [x,y,z] }` (optional)
- `theta`: Barnes-Hut approximation threshold (default: 0.5)
- `gravityStrength`: Force multiplier (default: 0.0003)
- `dt`: Timestep (default: 1/60)
- `softening`: Softening length to prevent singularities (default: 0.2)
- `damping`: Velocity damping (default: 0.0)
- `maxSpeed`: Maximum velocity clamp (default: 2.0)
- `maxAccel`: Maximum acceleration clamp (default: 1.0)

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
- `dispose()`: Release GPU resources

### massSpotMesh(options)

Creates particle rendering mesh.

**Texture Mode** (GPU-resident data):
```javascript
massSpotMesh({
  textureMode: true,
  particleCount: 50000,
  textures: { position, color, size }
})
```

**Array Mode** (CPU data):
```javascript
massSpotMesh({
  spots: [{ x, y, z, mass, rgb }, ...]
})
```

## How the Modules Connect

The integration in `demo.js` reveals the elegant choreography between renderer and physics:

1. **Initialization**: Particle data flows from CPU arrays into the physics system via `particleSystem({ particles })`. The system uploads this data to GPU textures during initialization—positions, velocities, colors all transformed into WebGL textures.

2. **GPU-to-GPU Pipeline**: The mass spot mesh is created in texture mode, directly consuming the physics system's position and color textures. No intermediate copies, no CPU readbacks—the renderer samples directly from the physics textures.

3. **Ping-Pong Architecture**: The particle system uses double-buffered textures (ping-pong) for position and velocity updates. Each frame, it reads from one buffer and writes to the other. The mesh renderer must track which texture is current using `getCurrentIndex()` and update its uniform accordingly.

4. **Animation Loop**: Each frame calls `physics.compute()` to advance the simulation, then updates the renderer's texture uniform to point at the newly computed positions. The entire pipeline—force calculation, integration, and rendering—occurs on the GPU without CPU intervention.

This architecture is not unique to gravitational physics. Any GPGPU computation that produces particle positions in a texture can plug into the same rendering pipeline, as demonstrated in `texture-mode.html`.

## The Barnes-Hut Algorithm: A Cosmic Optimization

The particle system's gravitational simulation employs the Barnes-Hut algorithm, a hierarchical tree-based method that revolutionized N-body astrophysics when first proposed in 1986. Before Barnes-Hut, direct particle-particle force calculations scaled as O(N²)—prohibitive for systems beyond a few thousand bodies. The galaxy simulations and dark matter studies that transformed modern cosmology became tractable only after this algorithmic breakthrough.

### The Core Insight

Instead of computing forces between every pair of particles, Barnes-Hut groups distant particles into "supermassive" clusters. If a cluster is sufficiently far away, its constituent particles can be approximated as a single point mass at their center of mass. This trades a small amount of accuracy for dramatic performance gains—O(N log N) instead of O(N²).

The algorithm constructs an octree (3D spatial hierarchy) where each node represents a cubic region of space. Leaf nodes contain individual particles; branch nodes aggregate the mass and center of mass of their children. During force calculation, the tree is traversed: if a node's angular size (as seen from the target particle) falls below a threshold θ (theta), its mass is treated as a point source. Otherwise, the node's children are recursively examined.

### GPU Implementation Challenges

Translating this inherently recursive, pointer-based algorithm to GPU shaders—where recursion is forbidden and memory access is texture-based—required significant architectural ingenuity:

- **Octree as Textures**: The tree is stored as a pyramid of 3D textures (mapped to 2D via Z-slice stacking). Each level represents a spatial subdivision, with Level 0 containing individual particles and higher levels aggregating regions.

- **Iterative Traversal**: The recursive tree walk is rewritten as an iterative loop with an explicit stack, encoded in shader registers. The traversal shader performs this for every particle in parallel.

- **Isotropic 3D Subdivision**: Voxel grids are subdivided uniformly in all three dimensions, with Z-slices packed into 2D textures. This preserves spatial locality for cache coherence.

### History of the Galaxies

The Barnes-Hut algorithm enabled the first large-scale cosmological simulations in the late 1980s, revealing how dark matter halos form and evolve. Modern variants like Fast Multipole Method (FMM) and tree-particle-mesh (TPM) codes power exascale simulations tracking billions of particles across cosmic epochs. By bringing this technique to the browser via GPU shaders, THREE-g democratizes a computational approach that once required supercomputers—now anyone can experiment with gravitational choreography in real-time, right in their web browser.

The θ parameter controls the approximation threshold. Lower values mean tighter accuracy, higher GPU cost. The default of 0.5 keeps systems up to ~200,000 particles physically coherent without dropping below 10 FPS on modern hardware.

## License

MIT © Oleg Mihailik