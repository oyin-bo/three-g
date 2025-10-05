# THREE-g — Galaxy Primitives for THREE.js

GPU-accelerated particle rendering and Barnes-Hut N-body physics for THREE.js.

## Features

- **massSpotMesh**: Efficient particle rendering with glow effects
- **barnesHutSystem**: GPU-based O(N log N) gravitational physics
- Scales to 200,000+ particles at 10-30 FPS
- Zero CPU involvement: all computation on GPU

## Quick Start

```javascript
import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh, barnesHutSystem } from 'three-g';

const { scene, renderer } = createScene();

// Create physics system
const physics = barnesHutSystem({
  gl: renderer.getContext(),
  particleCount: 50000
});

// Create rendering
const mesh = massSpotMesh({
  textureMode: true,
  particleCount: physics.options.particleCount,
  textures: {
    position: physics.getPositionTexture(),
    color: physics.getColorTexture(),
    size: [512, 512]
  },
  fog: { start: 15, gray: 40 }
});

scene.add(mesh);

// Animation loop
function animate() {
  physics.compute();
  mesh.updateTextures(physics.getPositionTexture());
}
```

## API

### barnesHutSystem(options)

Creates GPU Barnes-Hut N-body simulation.

**Options**:
- `gl`: WebGL2 context (required)
- `particleCount`: Number of particles (default: 200000)
- `theta`: Barnes-Hut approximation threshold (default: 0.5)
- `gravityStrength`: Force multiplier (default: 0.0003)
- `worldBounds`: Simulation bounds

**Returns**: System object with methods:
- `compute()`: Step simulation forward
- `getPositionTexture()`: Get current positions (GPU texture)
- `getColorTexture()`: Get particle colors (GPU texture)
- `getTextureSize()`: Get texture dimensions

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

## License

MIT © Oleg Mihailik