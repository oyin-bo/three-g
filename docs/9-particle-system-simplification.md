# Kernel-Based Particle System Simplification Plan

## Executive Summary

The `particle-system-monopole-kernels.js` implementation serves as the gold standard for our kernel-based architecture. Three simple, concrete changes must be applied to all other kernel-based systems:

1.  **Direct Texture Properties**: Use `positionTexture`/`positionTextureWrite` and `velocityTexture`/`velocityTextureWrite` directly as simple properties. No wrappers.
2.  **Delete Redundant Getters**: Remove `getPositionTexture()`, `getPositionTextures()`, `getCurrentIndex()`, `getTextureSize()` from all particle systems. External code accesses properties directly.
3.  **Strip Particle System of Pipeline Texture Creation**: Particle systems should ONLY create position/velocity textures. All other textures (deposit grids, spectra, force grids, etc.) are created by the kernels that use them.

That's it. No ownership transfers. No new architecture. Just delete cruft and let kernels manage their own resources.

## Justification

### Problem 1: Bloated Particle Systems Create Everything

`mesh-kernels.js` and `spectral-kernels.js` pre-allocate all textures:
- Mass grid, density spectrum, potential spectrum, force spectra, force grids, near-field forces
- This is wrong. The particle system doesn't use these textures. The kernels do.
- Solution: Delete all this from particle system constructor. Kernels create their own textures during initialization.

### Problem 2: Redundant Getters Add Function Call Overhead

Methods like `getPositionTexture()` that return `this.positionTextures?.getCurrentTexture()` add unnecessary indirection.
- Solution: Delete these getters. Let code access properties directly: `physics.positionTexture`.

### Problem 3: Pipeline Textures Not Owned by Their Kernels

When particle system creates textures and passes them to kernels, no one knows who cleans them up.
- Solution: Let each kernel create and own its own output textures. Expose them as properties (e.g., `kernel.outForce`). Kernel disposes in its `dispose()` method.

## Target Kernel-Based Particle Systems

### 1. **`particle-system-quadrupole-kernels.js`**

-   **Status**: Correct structure. Has redundant getters.
-   **Priority**: HIGH
-   **Action**: Delete getter methods: `getPositionTexture()`, `getPositionTextures()`, `getCurrentIndex()`, `getTextureSize()`.

### 2. **`particle-system-mesh-kernels.js`**

-   **Status**: Creates way too many textures in particle system.
-   **Priority**: HIGH
-   **Action**: 
    1. Delete these from constructor: `massGridTexture`, `densitySpectrumTexture`, `potentialSpectrumTexture`, `forceSpectrumX/Y/Z`, `forceGridX/Y/Z`, `nearFieldForceX/Y/Z`
    2. Pass `null` for these in kernel constructors. Kernels will create them.
    3. Delete getter methods.

### 3. **`particle-system-spectral-kernels.js`**

-   **Status**: Creates way too many textures in particle system.
-   **Priority**: MEDIUM
-   **Action**:
    1. Delete these from constructor: `massGridTexture`, `densitySpectrumTexture`, `potentialSpectrumTexture`, `forceSpectrumX/Y/Z`, `forceGridX/Y/Z`
    2. Pass `null` for these in kernel constructors. Kernels will create them.
    3. Delete getter methods.

## Implementation Strategy

### Task 1: quadrupole-kernels

1. Open `particle-system\gravity-multipole\particle-system-quadrupole-kernels.js`
2. Delete these methods: `getPositionTexture()`, `getPositionTextures()`, `getCurrentIndex()`, `getTextureSize()`
3. Search for usages of these methods in the codebase and replace with direct property access
4. Test

### Task 2: mesh-kernels

1. Open `particle-system\gravity-mesh-kernels\particle-system-mesh-kernels.js`
2. In `constructor()`:
   - Delete lines that create: `massGridTexture`, `densitySpectrumTexture`, `potentialSpectrumTexture`, `forceSpectrumX/Y/Z`, `forceGridX/Y/Z`, `nearFieldForceX/Y/Z`
   - Update kernel constructors to pass `null` or omit these textures
3. Update `dispose()` to only dispose kernels (not particle system textures)
4. Delete getter methods: `getPositionTexture()`, `getPositionTextures()`, `getCurrentIndex()`, `getTextureSize()`
5. Search for particle system texture references and remove them
6. Test

### Task 3: spectral-kernels

1. Open `particle-system\gravity-spectral-kernels\particle-system-spectral-kernels.js`
2. In `constructor()`:
   - Delete lines that create: `massGridTexture`, `densitySpectrumTexture`, `potentialSpectrumTexture`, `forceSpectrumX/Y/Z`, `forceGridX/Y/Z`
   - Update kernel constructors to pass `null` or omit these textures
3. Update `dispose()` to only dispose kernels (not particle system textures)
4. Delete getter methods
5. Test

## The Rule

**Delete it if it does nothing. Move responsibility to the code that actually uses it.**

- If a getter just wraps a property, delete it.
- If a particle system allocates a texture but a kernel uses it, move allocation to the kernel.
- If code is bloated, make it small.

That's the whole strategy. No architectural gymnastics. Just ruthless simplification.

## Success Criteria

1. ✅ `quadrupole-kernels` has no getter methods. All external code uses direct property access.
2. ✅ `mesh-kernels` does NOT create pipeline textures in constructor. Only particle data textures remain.
3. ✅ `spectral-kernels` does NOT create pipeline textures in constructor. Only particle data textures remain.
4. ✅ All three systems have no redundant getter methods.
5. ✅ All tests pass.
6. ✅ REPL validation shows correct visual output.
7. ✅ Codebase is simpler, smaller, and more readable.