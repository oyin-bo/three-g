# Lowering the Level: Particle Systems as Texture Abstractions

SEE MANDATORY NOTES AT BOTTOM

## Problem Statement

Particle systems currently mix high-level concerns (CPU particle data, validation) with low-level concerns (GPU simulation, kernel orchestration). This creates:

1. **Duplication**: Each of 4 systems duplicates particle→texture conversion logic
2. **Inflexibility**: No way to load pre-texturized data or swap textures at runtime
3. **Asymmetry**: Easy to upload (constructor), awkward to download (separate function)
4. **Wasted bandwidth**: Mass and velocity.w are unnecessarily duplicated between ping-pong buffers
5. **Unclear responsibility**: Systems shouldn't care about particle format; only about texture state

## Solution: Texture-First Architecture

Particle systems become **pure texture-level abstractions**. They operate on GPU textures only, not particle arrays. The factory handles all data conversion and texture management.

This aligns systems with the kernel design pattern (kernels already are texture-in, texture-out).

## Texture Parameter Contract

Each particle system accepts:

```typescript
constructor(options: {
  gl: WebGL2RenderingContext,
  textureWidth: number, // mandatory
  textureHeight: number, // mandatory
  particleCount?: number, // optional, defaults to width*height
  
  // Optional textures - created if undefined
  positionMassTexture?: WebGLTexture, // RGBA32F: xyz=position, w=mass
  velocityColorTexture?: WebGLTexture, // RGBA32F: xyz=velocity, w=unused (can be used as color externally)
  
  // Other parameters (as before)

})
```

**No `particleCount`** Computed from `textureWidth * textureHeight`. Provides redundancy check during validation.

## Texture Lifetime & Ping-Pong Contract

SEE MANDATORY NOTES AT BOTTOM

### After Construction
- Both `positionMassTexture` and `velocityColorTexture` contain initial particle state
- Write textures (`positionMassTextureWrite`, `velocityColorTextureWrite`) are internal implementation details

### After Each `step()`
- System adjusts ping-pong buffers internally from its kernels
- `system.positionMassTexture` and `system.velocityColorTexture` always point to **current** particle state
- Caller doesn't track which buffer is active
- Write textures remain internal

### Caller Responsibility
- Create/provide textures before construction
- After `step()`, read from `system.positionMassTexture` and `system.velocityColorTexture`
- If downloading to CPU, use factory function (see below)

## Texture Format & Data Packing

### Position Texture (RGBA32F)
```glsl
vec4 pos = texelFetch(u_position, coord, 0);
vec3 position = pos.xyz;        // XYZ coordinates
float mass = pos.w;             // Mass in alpha
```

Packed format. Mass is immutable per particle but travels with position ping-pong for simplicity.

### Velocity Texture (RGBA32F)
```glsl
vec4 vel = texelFetch(u_velocity, coord, 0);
vec3 velocity = vel.xyz;        // XYZ components
// vel.w unused (value carried and preserved though)
```

Channel W is unused but accepted as trade-off: separating mass/velocity would add 12.5% memory overhead (36 vs 32 bytes/texel) with no real benefit.

## Factory Responsibilities (High-Level)

The factory (`gravity.js`) becomes the single source of truth for particle data handling:

```javascript
export function particleSystem(options) {
  // create respective particle system
  const system = new GravityQuadrupole({
    gl,
    textureWidth,
    textureHeight,
    // ... physics options
  });
  ...
  // upload initial positions to textures
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, positions);
  ...
  // upload initial velocities to textures
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, velocities);

  return system;
}
```


## Key Design Decisions

SEE MANDATORY NOTES AT BOTTOM

### Decision 1: Mass Packing (Status: Resolved)
**Keep mass in position.w**
- No memory savings from separation (still 16 bytes/texel due to GPU alignment)
- Avoids extra texture fetch per particle
- Simpler shader code
- Design allows future separation if needed

### Decision 2: Unused Channels (Status: Accepted)
**Keep velocity.w unused**
- Velocity texture is RGBA32F with W=0
- Separating would increase memory (36 vs 32 bytes/texel)
- Same trade-off as position; accept for simplicity
- Implementation kernels MUST carry W channel unchanged

### Decision 3: particleCount Parameter (Status: Removed)
**Derive from textureWidth × textureHeight**
- Redundancy check: `textureWidth * textureHeight >= particleCount`
- Reduces parameter count
- Factory computes during validation

## Benefits

1. **Clarity**: Systems know they're GPU abstractions; data handling is factory's job
2. **Flexibility**: Texture swapping, streaming, shared buffers all become possible
3. **Testability**: Each layer tested independently
4. **Reusability**: Upload/download logic lives in one place
5. **Extensibility**: Easy to support new input formats, texture sources
6. **Kernel Alignment**: Matches kernel design pattern

## Future Options (Not Implemented Now)

1. **Dynamic texture swapping**: `system.positionMassTexture = newTexture`
2. **Streaming uploads**: Partial texture updates between frames
3. **Shared textures**: Multiple systems reading same position data
4. **Separate mass texture**: If extra per-particle metadata needed later
5. **GPU→GPU transfers**: System A output → System B input, no CPU round-trip

Design allows all of these without breaking current code.

## Breaking Changes

This is a **breaking change** warranting a version bump:
- Constructor signatures change
- Caller responsibility increases (must provide or accept auto-creation)
- Direct instantiation pattern changes

However, factory function `particleSystem()` remains convenient for common use case.

# Mandatory Notes

* DO NOT implement legacy or backwards compatibility paths in particle systems. The old particleData MUST be removed and salted.
* UPDATE particle system constructors to use parameter destructuring instead of options object.
* AVOID temporary variables in the constructor that are the same as object fields. Fold them into object fields directly.

# Migration Analysis: Lessons from `gravity-monopole.js`

The successful migration of `gravity-monopole.js` to the texture-first architecture provides a clear template for other particle systems. The key lessons are:

1.  **Unified Integration Kernel**: Replacing separate `KIntegrateVelocity` and `KIntegratePosition` kernels with a single `KIntegrateEuler` kernel using Multiple Render Targets (MRT) was highly effective. This halves the number of integration passes, reduces GL state changes, and simplifies the system's `step()` logic.

2.  **Kernel-Owned Ping-Pong Buffers**: The integration kernel now owns its ping-pong textures internally. The particle system only tracks references to the current `positionMassTexture` and `velocityColorTexture`, swapping the kernel's internal buffers after each run. This removes `...Write` textures from the system class, creating a cleaner, higher-level abstraction.

3.  **Constructor-Driven Texture Management**: The pattern of allowing kernels to create their own textures if none are provided, and then having the system adopt those textures, works well. `GravityMonopole` passes its `positionMassTexture` to `KIntegrateEuler`, but if it was `undefined`, the kernel would create it, and the system would then use the kernel's newly created texture. This centralizes texture allocation logic within the kernels while giving the system final authority.

4.  **Simplified API**: The public API is cleaner. The system exposes `positionMassTexture` and `velocityColorTexture` as the always-current state, hiding the internal write-buffers and ping-pong complexity from the caller.

## Applying to `gravity-quadrupole.js`

To migrate `gravity-quadrupole.js`, we should apply the same lessons:

1.  **Adopt `KIntegrateEuler`**: Replace the separate `velocityKernel` (`KIntegrateVelocity`) and `positionKernel` (`KIntegratePosition`) with a single instance of `KIntegrateEuler`. This will unify the integration step. **Note**: `KIntegrateEuler` is compatible with all force calculation methods (monopole tree traversal, quadrupole tree traversal, PM/FFT mesh, and spectral). All systems output forces in the same RGBA32F format (xyz=force, w=unused), so `gravity-mesh.js` and `gravity-spectral.js` can also migrate to `KIntegrateEuler` using this same pattern.

2.  **Refactor Constructor**:
    *   Change the constructor signature to accept `textureWidth`, `textureHeight`, `positionMassTexture`, and `velocityColorTexture`, removing the old `particleData` parameter.
    *   Remove the manual creation and uploading of `positionTexture` and `velocityTexture`. The factory or caller will be responsible for this.
    *   Instantiate `KIntegrateEuler` and let it manage the creation of position/velocity textures if they are not provided.

3.  **Update `_integratePhysics`**:
    *   Remove the two separate kernel calls for velocity and position integration.
    *   Replace them with a single call to `integrateEulerKernel.run()`.
    *   Implement the same ping-pong swap logic as in `gravity-monopole.js` to cycle the input and output textures for the next frame.

4.  **Remove Redundant Textures**: The internal `positionTextureWrite` and `velocityTextureWrite` fields in `GravityQuadrupole` will no longer be needed, as the ping-pong logic will be handled by swapping references to the textures owned by the `KIntegrateEuler` kernel.

## Factory Adaptation (`gravity.js`)

The factory function already demonstrates the texture-first pattern with `gravity-monopole.js`:

```javascript
case 'monopole': {
  const { textureWidth, textureHeight, positions, velocities } = particleData;
  
  // Let GravityMonopole create textures (pass undefined)
  system = new GravityMonopole({
    gl,
    textureWidth,
    textureHeight,
    particleCount,
    // ... physics options, no particleData
  });

  // Upload particle data into allocated textures
  gl.bindTexture(gl.TEXTURE_2D, system.positionMassTexture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, positions);
  gl.bindTexture(gl.TEXTURE_2D, system.velocityColorTexture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, velocities);
  gl.bindTexture(gl.TEXTURE_2D, null);
  break;
}
```

**Key points:**
1. **System creates textures**: Constructor receives `undefined` for position/velocity textures, triggering kernel allocation
2. **Factory uploads data**: After construction, factory uploads CPU particle data via `texSubImage2D`
3. **Clean separation**: System handles GPU architecture, factory handles CPU→GPU conversion

When migrating `gravity-quadrupole.js`, `gravity-mesh.js`, and `gravity-spectral.js`, the factory must adopt this same pattern, replacing the current `particleData`-based approach.