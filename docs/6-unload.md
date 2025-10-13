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

`particleSystem(options)` returns a `ParticleSystemAPI`. The synchronous unload primitive is exposed directly on that returned object:

```ts
// Part of ParticleSystemAPI
unload(
  particles: any[],
  set?: (payload: {
    particle: any,
    index: number,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number
  }) => void
): void
```

### Behavior

- **Validates** that `particles.length` matches `ps.particleCount`.
- Performs **minimal GPU readback** by sampling the active position and velocity ping-pong textures.
- Invokes `set({...})` when supplied; otherwise mutates `particles[i]` with `x, y, z, vx, vy, vz` fields.
- **Synchronous**: `gl.readPixels` blocks until GPU work completes. No async/await or Promises.

---

## Implementation Strategy by Method

### Generic Unload (inline on `ParticleSystemAPI`, synchronous)

Every concrete system exposes consistent ping-pong resources (`system.positionTextures`, `system.velocityTextures`, and `system.textureWidth/Height`). The public API already closes over `system`, so the `unload` method can live directly inside the `baseAPI` literal in `particle-system/index.js`.

- **Validation**: reject arrays whose length does not match `system.options.particleCount` and surface missing texture allocations early.
- **Readback**: bind a throwaway framebuffer, attach the active position and velocity textures (using the shared `currentIndex`), and issue one `gl.readPixels` per texture into temporary `Float32Array` buffers sized to the texture.
- **Materialize results**: walk `[0, total)` once, translate the RGBA quads into per-particle `{x,y,z,vx,vy,vz}`, and either call the optional `set(payload)` or mutate `particles[i]` in place.
- **Cleanup**: restore framebuffer binding to `null` and delete the temporary framebuffer to avoid leaks.

Because the method remains synchronous and lives alongside other base API members, no helper wrapper (`attachUnload`) is required. Each system class (`particle-system-monopole.js`, `particle-system-quadrupole.js`, `particle-system-spectral.js`, `particle-system-mesh.js`) already satisfies the required surface area, so no additional per-method wiring is needed.

---

## Integration into Particle System API

The API returned from `particleSystem(...)` includes the `unload` method constructed above. Callers simply invoke `ps.unload(particles, set)` without any knowledge of the underlying method-specific implementation.

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

**Key takeaway**: All current methods persist per‑particle velocities; the shared synchronous `unload` method on `ParticleSystemAPI` reads positions and velocities directly while keeping method-specific hooks internal.
