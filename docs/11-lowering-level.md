# Lowering the Level: Particle Systems as Texture Abstractions

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
  // High-level: delegate data prep to factory
  const { positionMassTexture, velocityColorTexture, textureWidth, textureHeight } =
    uploadParticlesToTextures(...);
  
  // Low-level: pass textures to system
  const system = new GravityQuadrupole({
    gl,
    textureWidth,
    textureHeight,
    positionMassTexture,
    velocityColorTexture,
    // ... physics options
  });
  
  return system;
}
```


## Key Design Decisions

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
