# Unload: Read Computed Particle State Back to CPU

## Overview

This document specifies how to read particle positions and velocities from GPU textures back to CPU memory for all particle system implementations: **Monopole**, **Quadrupole**, **Spectral**, and **Mesh**.

Key update: all current systems persist a per‑particle velocity texture (RGBA32F) alongside positions. A single, synchronous unload strategy works across systems; no spectral‑specific velocity reconstruction is required.

---

## System-Specific Data Layout

### Monopole and Quadrupole (Tree-Code Methods)

Both maintain explicit per-particle velocity textures throughout the simulation:

- **Position texture**: RGBA32F, ping-pong buffer
  - `(x, y, z, mass)`
- **Velocity texture**: RGBA32F, ping-pong buffer
  - `(vx, vy, vz, unused)`

**Unload strategy**: Direct readback from both textures — straightforward, no computation required.

### Spectral (Particle-Mesh/FFT Method)

Uses PM/FFT to compute forces, then the shared integration path. Persisted textures:

- **Position texture**: RGBA32F, ping-pong buffer
  - `(x, y, z, mass)`
- **Velocity texture**: RGBA32F, ping-pong buffer
  - `(vx, vy, vz, unused)`
- **Force texture**: RGBA32F (PM-sampled), consumed by integration

**Unload strategy**: Direct readback from position and velocity textures — identical to tree-code methods. No GPU reconstruction pass required.

### Mesh (Plan B / PM-FFT/TreePM Scaffold)

Mirrors the resource layout of other systems while delegating force computation to the mesh pipeline:

- **Position texture**: RGBA32F, ping-pong buffer
- **Velocity texture**: RGBA32F, ping-pong buffer
- **PM force texture**: RGBA32F (sampled forces), consumed by integration

**Unload strategy**: Direct readback from position and velocity textures.

---

## API Design

```javascript
/**
 * Read particle positions and velocities from GPU back to CPU (synchronous).
 * Blocks on gl.readPixels until prior GPU work completes.
 *
 * @param {ParticleSystemAPI} ps - Public particle system API
 * @param {Array<object>} particles - Array of particle objects. Length must match particle count.
 * @param {function} [set] - Optional callback per particle:
 *   ({ particle, index, x, y, z, vx, vy, vz }) => void
 *
 * @throws {Error} If particles length does not match ps.particleCount
 * @throws {Error} If GPU readback fails
 */
function unload(ps, particles, set) {
  // Implementation uses API-level access; see Generic Unload section.
}
```

### Behavior

- **Validates** that `particles.length === ps.particleCount`.
- Performs **minimal GPU readback**: reads position and velocity textures.
- Calls `set(data)` for each particle if provided, otherwise mutates `particles[i]` directly with `x, y, z, vx, vy, vz`.
- **Synchronous**: `gl.readPixels` blocks the CPU until prior rendering finishes. No async/await or Promises.

---

## Implementation Strategy by Method

### Generic Unload (API-level, synchronous)

The same readback procedure applies to all systems. The unloader can operate at the `ParticleSystemAPI` level without system-specific code if the API provides:

- `getPositionTextures(): WebGLTexture[]`
- `getCurrentIndex(): 0|1`
- `getTextureSize(): {width:number,height:number}`
- `getVelocityTextures(): WebGLTexture[]`
- `getGL(): WebGL2RenderingContext`

```javascript
// Pseudocode: synchronous, API-level
function unload(ps, particles, set) {
  const gl = ps.getGL();
  if (!gl) throw new Error('WebGL2 context not available on ParticleSystemAPI');

  const { width, height } = ps.getTextureSize();
  const N = ps.particleCount;
  if (!Array.isArray(particles) || particles.length !== N) {
    throw new Error(`Particle count mismatch: expected ${N}, got ${particles && particles.length}`);
  }

  const posTextures = ps.getPositionTextures();
  const velTextures = ps.getVelocityTextures();
  const idx = ps.getCurrentIndex();

  if (!posTextures || !posTextures[idx] || !velTextures || !velTextures[idx]) {
    throw new Error('Position/velocity textures not available');
  }

  // Create a temporary FBO to read from any texture (no need to reuse system FBOs)
  const fbo = gl.createFramebuffer();
  const readRGBA32F = (tex, dst) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, dst);
  };

  const posBuffer = new Float32Array(width * height * 4);
  const velBuffer = new Float32Array(width * height * 4);
  readRGBA32F(posTextures[idx], posBuffer);
  readRGBA32F(velTextures[idx], velBuffer);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);

  for (let i = 0; i < N; i++) {
    const b = i * 4;
    const x = posBuffer[b + 0];
    const y = posBuffer[b + 1];
    const z = posBuffer[b + 2];
    const vx = velBuffer[b + 0];
    const vy = velBuffer[b + 1];
    const vz = velBuffer[b + 2];
    if (set) set({ particle: particles[i], index: i, x, y, z, vx, vy, vz });
    else {
      particles[i].x = x; particles[i].y = y; particles[i].z = z;
      particles[i].vx = vx; particles[i].vy = vy; particles[i].vz = vz;
    }
  }
}
```

---

## Integration into Particle System API

Preferred approach: expose an API-level unloader so callers do not need system-specific knowledge.

1) **Minimal public API additions**:

- `getVelocityTextures(): WebGLTexture[]`
- `getGL(): WebGL2RenderingContext`

2) **Expose `unload` on the returned API** (synchronous):

```javascript
// In particle-system/index.js
const baseAPI = {
  // ...existing methods...
  unload: (particles, set) => unload(this, particles, set) // calls Generic Unload above
};
```

---

## Testing and Verification

### Unit Tests

1. **Basic readback** (All systems):

   - Create system with 4 particles at known positions `[(0,0,0), (1,0,0), (0,1,0), (0,0,1)]`.
   - Step once (no forces, velocities remain zero).
   - Call `unload(ps, particles)`.
   - Assert positions match input, velocities are zero.

2. **Spectral PM path**:

   - Create spectral system with 4 particles and enable PM pipeline.
   - Step once.
   - Call `unload(ps, particles)`.
   - Assert velocities are finite and positions have advanced.

3. **Large particle count**:

   - Test with 10,000 particles.
   - Verify single `readPixels` call per texture (check via profiling or logs).

4. **Error handling**:
   - Call `unload(ps, [])` with wrong-length array → expect error.

### Example Usage

```javascript
const ps = particleSystem({ gl, particles, method: "spectral" });

// Run simulation
for (let i = 0; i < 100; i++) {
  ps.compute();
}

// Read back results (synchronous)
ps.unload(particles);

// Now particles array contains updated x, y, z, vx, vy, vz
console.log(particles[0]); // { x: 1.23, y: 4.56, z: 0.78, vx: 0.01, vy: 0.02, vz: 0.00 }
```

---

## Summary

| System     | Position Source  | Velocity Source   | Unload Strategy              |
| ---------- | ---------------- | ----------------- | ---------------------------- |
| Monopole   | Position texture | Velocity texture  | Direct readback (2 textures) |
| Quadrupole | Position texture | Velocity texture  | Direct readback (2 textures) |
| Spectral   | Position texture | Velocity texture  | Direct readback (2 textures) |
| Mesh       | Position texture | Velocity texture  | Direct readback (2 textures) |

**Key takeaway**: All current methods persist per‑particle velocities; a single synchronous unloader can read positions and velocities directly. For a clean API‑level implementation, add `getVelocityTextures()` and a public `gl` accessor to the `ParticleSystemAPI`.
