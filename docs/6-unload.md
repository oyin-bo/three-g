# Unload: Read Computed Particle State Back to CPU

## Overview

This document specifies how to read particle positions and velocities from GPU textures back to CPU memory for all three particle system implementations: **Monopole**, **Quadrupole**, and **Spectral**.

The challenge: the three systems store and compute velocity differently, requiring method-specific unload strategies.

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

Does **not** store per-particle velocities in a texture. Instead:

- **Position texture**: RGBA32F, ping-pong buffer
  - `(x, y, z, mass)`
- **Force texture**: RGBA32F, single texture
  - `(fx, fy, fz, unused)` — updated each frame by PM/FFT pipeline
- Velocities are **implicitly updated** during the integration shader and immediately consumed to advance positions. They exist only transiently during the `vel_integrate` shader execution.

**Unload strategy**: Velocities must be **reconstructed** on GPU via a custom shader that reads position history (current vs. previous frame) and computes `v = (pos_current - pos_prev) / dt`. Alternatively, recompute from forces if position history is unavailable. This requires:

1. Saving previous-frame positions in an additional texture (not currently stored by spectral system), or
2. Running a GPU shader to derive velocity from `(position_delta / dt)` using ping-pong state, or
3. Reconstructing approximate velocity from current force via `v ≈ v_prev + (f / m) * dt` (less accurate, but viable if no position history exists).

**Recommended approach for spectral**:  
Use a dedicated unload shader that samples both position ping-pong textures (current and previous) and computes:

```glsl
vec3 pos_current = texture(u_positionCurrent, uv).xyz;
vec3 pos_previous = texture(u_positionPrevious, uv).xyz;
float dt = u_dt;
vec3 velocity = (pos_current - pos_previous) / dt;
```

This shader writes velocity to a temporary output texture, which is then read back alongside positions.

---

## API Design

```javascript
/**
 * Read particle positions and velocities from GPU back to CPU.
 *
 * @param {Array<object>} particles - Array of particle objects. Length must match particle count.
 * @param {function} [set] - Optional callback invoked per particle:
 *   ({ particle, index, x, y, z, vx, vy, vz }) => void
 *
 * @returns {Promise<void>} Resolves when all data has been transferred and particles updated.
 *
 * @throws {Error} If system is not initialized (check ps.isInitialized or await ps.ready())
 * @throws {Error} If particles array length does not match ps.particleCount
 * @throws {Error} If GPU readback fails
 */
async function unload(particles, set) {
  // Implementation varies by system type
}
```

### Behavior

- **Validates** that `particles.length === ps.options.particleCount`.
- **Checks readiness**: throws if `ps.isInitialized === false`. Callers should `await ps.ready()` first.
- Performs **minimal GPU readback**: reads position and velocity textures (or reconstructs velocity for spectral).
- Calls `set(data)` for each particle if provided, otherwise mutates `particles[i]` directly with `x, y, z, vx, vy, vz`.
- **Blocks** (async) until GPU readback completes. Returns a `Promise<void>`.

---

## Implementation Strategy by Method

### Monopole / Quadrupole

```javascript
async function unload_TreeCode(ps, particles, set) {
  const gl = ps.gl;
  if (!ps.isInitialized) throw new Error("System not initialized");
  if (particles.length !== ps.options.particleCount) {
    throw new Error(
      `Particle count mismatch: expected ${ps.options.particleCount}, got ${particles.length}`
    );
  }

  const w = ps.textureWidth;
  const h = ps.textureHeight;
  const N = ps.options.particleCount;

  // Allocate CPU buffers
  const posBuffer = new Float32Array(w * h * 4);
  const velBuffer = new Float32Array(w * h * 4);

  // Bind position FBO and read
  const posFBO =
    ps.positionTextures.framebuffers[ps.positionTextures.currentIndex];
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFBO);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, posBuffer);

  // Bind velocity FBO and read
  const velFBO =
    ps.velocityTextures.framebuffers[ps.velocityTextures.currentIndex];
  gl.bindFramebuffer(gl.FRAMEBUFFER, velFBO);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, velBuffer);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Unpack into particles
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    const x = posBuffer[idx + 0];
    const y = posBuffer[idx + 1];
    const z = posBuffer[idx + 2];
    const vx = velBuffer[idx + 0];
    const vy = velBuffer[idx + 1];
    const vz = velBuffer[idx + 2];

    if (set) {
      set({ particle: particles[i], index: i, x, y, z, vx, vy, vz });
    } else {
      particles[i].x = x;
      particles[i].y = y;
      particles[i].z = z;
      particles[i].vx = vx;
      particles[i].vy = vy;
      particles[i].vz = vz;
    }
  }
}
```

### Spectral (with Velocity Reconstruction Shader)

Because spectral does not maintain per-particle velocity textures, we must reconstruct velocities on GPU.

**Step 1**: Create a temporary velocity extraction shader and framebuffer (done once, cached):

```javascript
// In ParticleSystemSpectral.init() or lazy-init on first unload():
ps._unloadVelocityTexture = createRenderTexture(
  gl,
  ps.textureWidth,
  ps.textureHeight
);
ps._unloadVelocityProgram = createProgram(
  gl,
  fsQuadVert,
  `#version 300 es
precision highp float;
uniform sampler2D u_positionCurrent;
uniform sampler2D u_positionPrevious;
uniform float u_dt;
in vec2 v_uv;
out vec4 fragColor;

void main() {
  vec4 posCurrent = texture(u_positionCurrent, v_uv);
  vec4 posPrevious = texture(u_positionPrevious, v_uv);
  vec3 velocity = (posCurrent.xyz - posPrevious.xyz) / u_dt;
  fragColor = vec4(velocity, 0.0);
}
`
);
```

**Step 2**: During unload, run the shader to extract velocities:

```javascript
async function unload_Spectral(ps, particles, set) {
  const gl = ps.gl;
  if (!ps.isInitialized) throw new Error("System not initialized");
  if (particles.length !== ps.options.particleCount) {
    throw new Error(
      `Particle count mismatch: expected ${ps.options.particleCount}, got ${particles.length}`
    );
  }

  const w = ps.textureWidth;
  const h = ps.textureHeight;
  const N = ps.options.particleCount;

  // Extract velocity into temporary texture
  gl.useProgram(ps._unloadVelocityProgram);
  gl.bindFramebuffer(gl.FRAMEBUFFER, ps._unloadVelocityTexture.framebuffer);
  gl.viewport(0, 0, w, h);

  const currentIdx = ps.positionTextures.currentIndex;
  const prevIdx = 1 - currentIdx;

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ps.positionTextures.textures[currentIdx]);
  gl.uniform1i(
    gl.getUniformLocation(ps._unloadVelocityProgram, "u_positionCurrent"),
    0
  );

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, ps.positionTextures.textures[prevIdx]);
  gl.uniform1i(
    gl.getUniformLocation(ps._unloadVelocityProgram, "u_positionPrevious"),
    1
  );

  gl.uniform1f(
    gl.getUniformLocation(ps._unloadVelocityProgram, "u_dt"),
    ps.options.dt
  );

  gl.bindVertexArray(ps.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);

  // Allocate CPU buffers
  const posBuffer = new Float32Array(w * h * 4);
  const velBuffer = new Float32Array(w * h * 4);

  // Read position
  const posFBO = ps.positionTextures.framebuffers[currentIdx];
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFBO);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, posBuffer);

  // Read reconstructed velocity
  gl.bindFramebuffer(gl.FRAMEBUFFER, ps._unloadVelocityTexture.framebuffer);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, velBuffer);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Unpack into particles
  for (let i = 0; i < N; i++) {
    const idx = i * 4;
    const x = posBuffer[idx + 0];
    const y = posBuffer[idx + 1];
    const z = posBuffer[idx + 2];
    const vx = velBuffer[idx + 0];
    const vy = velBuffer[idx + 1];
    const vz = velBuffer[idx + 2];

    if (set) {
      set({ particle: particles[i], index: i, x, y, z, vx, vy, vz });
    } else {
      particles[i].x = x;
      particles[i].y = y;
      particles[i].z = z;
      particles[i].vx = vx;
      particles[i].vy = vy;
      particles[i].vz = vz;
    }
  }
}
```

---

## Runtime Constraints and Error Handling

### GPU Readback Stalls

- `gl.readPixels` is **synchronous** and **blocks** the GPU pipeline until all prior rendering commands complete.
- Minimize calls: read entire textures in one `readPixels` call per texture.
- Avoid calling `unload()` every frame — use sparingly (e.g., for snapshots, pause states, or final export).

### Float Texture Support

- Requires `EXT_color_buffer_float` extension (all systems already check this in `checkWebGL2Support()`).
- If unavailable (rare on modern hardware), fall back to encoding floats as RGBA8 (not implemented here, but noted as future work).

### Readiness Checks

Always ensure the system is initialized before calling `unload`:

```javascript
await ps.ready(); // Wait for async initialization
await unload(particles); // Safe to call now
```

If `ps.isInitialized === false`, `unload` must throw immediately with a clear message:

```
Error: Cannot unload: particle system not initialized. Call await ps.ready() first.
```

### Particle Count Validation

Strict validation prevents silent data corruption:

```javascript
if (!Array.isArray(particles)) {
  throw new Error("particles must be an array");
}
if (particles.length !== ps.options.particleCount) {
  throw new Error(
    `Particle count mismatch: expected ${ps.options.particleCount}, got ${particles.length}`
  );
}
```

---

## Integration into Particle System API

Add `unload` as a method on each particle system class:

```javascript
// In particle-system/index.js
const baseAPI = {
  // ... existing methods ...

  /**
   * Read particle positions and velocities from GPU to CPU.
   * @param {Array<object>} particles - Target array (length must match particleCount)
   * @param {function} [set] - Optional callback per particle
   * @returns {Promise<void>}
   */
  unload: async (particles, set) => {
    if (!system.isInitialized) {
      throw new Error(
        "Cannot unload: particle system not initialized. Call await ps.ready() first."
      );
    }
    return system.unload(particles, set);
  },
};
```

Implement `unload()` method in each system class:

- `ParticleSystemMonopole.unload()`
- `ParticleSystemQuadrupole.unload()`
- `ParticleSystemSpectral.unload()` (with velocity reconstruction shader)

---

## Testing and Verification

### Unit Tests

1. **Basic readback** (Monopole/Quadrupole):

   - Create system with 4 particles at known positions `[(0,0,0), (1,0,0), (0,1,0), (0,0,1)]`.
   - Step once (no forces, velocities remain zero).
   - Call `unload(particles)`.
   - Assert positions match input, velocities are zero.

2. **Velocity reconstruction** (Spectral):

   - Create system with 4 particles at `(0,0,0)` with force `(1,0,0)`.
   - Step once.
   - Call `unload(particles)`.
   - Assert velocities are non-zero in x-direction, positions have advanced.

3. **Large particle count**:

   - Test with 10,000 particles.
   - Verify single `readPixels` call per texture (check via profiling or logs).

4. **Error handling**:
   - Call `unload()` before `ps.ready()` → expect error.
   - Pass wrong-length array → expect error.

### Example Usage

```javascript
const ps = particleSystem({ gl, particles, method: "spectral" });
await ps.ready();

// Run simulation
for (let i = 0; i < 100; i++) {
  ps.compute();
}

// Read back results
await ps.unload(particles);

// Now particles array contains updated x, y, z, vx, vy, vz
console.log(particles[0]); // { x: 1.23, y: 4.56, z: 0.78, vx: 0.01, vy: 0.02, vz: 0.00 }
```

---

## Summary

| System     | Position Source  | Velocity Source                       | Unload Strategy                    |
| ---------- | ---------------- | ------------------------------------- | ---------------------------------- |
| Monopole   | Position texture | Velocity texture                      | Direct readback (2 textures)       |
| Quadrupole | Position texture | Velocity texture                      | Direct readback (2 textures)       |
| Spectral   | Position texture | **Reconstructed** from position delta | GPU shader + readback (2 textures) |

**Key takeaway**: Spectral requires a custom GPU shader to extract velocities before CPU readback, because it does not maintain per-particle velocity textures. Tree-code methods (Monopole/Quadrupole) can read velocities directly.
