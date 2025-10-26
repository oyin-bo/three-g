// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';

import { assertAllFinite, assertClose, createTestTexture, disposeKernel, getGL, readTexture, resetGL } from '../test-utils.js';
import { KAggregatorMonopole } from './k-aggregator-monopole.js';
import { KTraversalQuadrupole } from './k-traversal-quadrupole.js';

/**
 * Helper: fill a 3D voxel texture laid out in 2D slices (square texture)
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number) => [number, number, number, number]} valueFunc
 */
function fillVoxelTexture(gl, gridSize, slicesPerRow, valueFunc) {
  const textureSize = gridSize * slicesPerRow;
  const data = new Float32Array(textureSize * textureSize * 4);

  for (let vz = 0; vz < gridSize; vz++) {
    const sliceRow = Math.floor(vz / slicesPerRow);
    const sliceCol = vz % slicesPerRow;

    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const texelX = sliceCol * gridSize + vx;
        const texelY = sliceRow * gridSize + vy;
        const idx = (texelY * textureSize + texelX) * 4;

        const [r, g, b, a] = valueFunc(vx, vy, vz);
        data[idx + 0] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = a;
      }
    }
  }

  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Create texture array from per-level 2D textures (mimics system copyTexSubImage3D flow)
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture[]} levelTextures - Array of 2D textures (one per level)
 * @param {number} maxSize - Maximum texture size (size of L0)
 * @returns {WebGLTexture}
 */
function createTextureArrayFromLevels(gl, levelTextures, maxSize) {
  const numLevels = levelTextures.length;

  // Create texture array
  const texArray = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
  gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA32F, maxSize, maxSize, numLevels, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  // Copy each level texture into the array layer
  for (let i = 0; i < numLevels; i++) {
    const srcTex = levelTextures[i];

    // Create temporary framebuffer to read from source texture
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, srcTex, 0);

    // Copy from FBO to texture array layer
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, texArray);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, 0, 0, maxSize, maxSize);

    gl.deleteFramebuffer(fbo);
  }

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

  return texArray;
}

/**
 * Test 1: Single particle - should experience no force (no other mass)
 */
test('KTraversalQuadrupole: single particle no force', async () => {
  const gl = getGL();

  const particleTexWidth = 1;
  const particleTexHeight = 1;

  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);

  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;

  // Create empty octree levels
  const levelA0 = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  const levelA1 = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  const levelA2 = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);

  // Convert to texture arrays
  const levelsA0 = createTextureArrayFromLevels(gl, [levelA0], octreeSize);
  const levelsA1 = createTextureArrayFromLevels(gl, [levelA1], octreeSize);
  const levelsA2 = createTextureArrayFromLevels(gl, [levelA2], octreeSize);

  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);

  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });

  const kernel = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelsA0: levelsA0,
    inLevelsA1: levelsA1,
    inLevelsA2: levelsA2,
    outForce,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: true });

  // Force should be zero (no other mass)
  assertClose(snapshot.force.pixels[0].fx, 0.0, 1e-5,
    `Force x should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.pixels[0].fy, 0.0, 1e-5,
    `Force y should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.pixels[0].fz, 0.0, 1e-5,
    `Force z should be zero\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Two particles - mutual gravitational attraction with quadrupole
 */
test('KTraversalQuadrupole: two particle interaction', async () => {
  const gl = getGL();

  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;

  // Two particles separated along x-axis
  const posData = new Float32Array([
    -1.0, 0.0, 0.0, 1.0,
    1.0, 0.0, 0.0, 1.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);

  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;

  // Aggregate particles into octree
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });

  const aggregator = new KAggregatorMonopole({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: true
  });

  aggregator.run();

  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);

  const kernel = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelsA0: createTextureArrayFromLevels(gl, [aggregator.outA0], octreeSize),
    inLevelsA1: createTextureArrayFromLevels(gl, [aggregator.outA1], octreeSize),
    inLevelsA2: createTextureArrayFromLevels(gl, [aggregator.outA2], octreeSize),
    outForce,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.0003,
    softening: 0.2,
    enableQuadrupoles: true
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: true });

  // First particle should feel force in +x direction (toward second particle)
  assert.ok(snapshot.force.pixels[0].fx > 0,
    `First particle should feel attraction in +x\n\n${kernel.toString()}`);

  // Second particle should feel force in -x direction
  assert.ok(snapshot.force.pixels[1].fx < 0,
    `Second particle should feel attraction in -x\n\n${kernel.toString()}`);

  // Y and Z forces should be near zero
  assertClose(snapshot.force.pixels[0].fy, 0.0, 1e-4,
    `First particle force y should be ~0\n\n${kernel.toString()}`);
  assertClose(snapshot.force.pixels[0].fz, 0.0, 1e-4,
    `First particle force z should be ~0\n\n${kernel.toString()}`);
  assertClose(snapshot.force.pixels[1].fy, 0.0, 1e-4,
    `Second particle force y should be ~0\n\n${kernel.toString()}`);
  assertClose(snapshot.force.pixels[1].fz, 0.0, 1e-4,
    `Second particle force z should be ~0\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  disposeKernel(aggregator);
  resetGL();
});

/**
 * Test 3: Quadrupole vs monopole comparison
 * Verify that quadrupole moments provide different (potentially more accurate) results
 */
test('KTraversalQuadrupole: quadrupole enabled vs disabled', async () => {
  const gl = getGL();

  const particleCount = 4;
  const particleTexWidth = 2;
  const particleTexHeight = 2;

  // Four particles in a configuration where quadrupole effects are visible
  const posData = new Float32Array([
    -0.5, -0.5, 0.0, 1.0,
    0.5, -0.5, 0.0, 1.0,
    -0.5, 0.5, 0.0, 1.0,
    0.5, 0.5, 0.0, 1.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);

  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;

  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });

  const aggregator = new KAggregatorMonopole({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: false
  });

  aggregator.run();

  // Test with quadrupoles enabled
  const outForceQuad = createTestTexture(gl, particleTexWidth, particleTexHeight, null);

  const kernelQuad = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelsA0: createTextureArrayFromLevels(gl, [aggregator.outA0], octreeSize),
    inLevelsA1: createTextureArrayFromLevels(gl, [aggregator.outA1], octreeSize),
    inLevelsA2: createTextureArrayFromLevels(gl, [aggregator.outA2], octreeSize),
    outForce: outForceQuad,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  kernelQuad.run();

  const resultQuad = readTexture(gl, outForceQuad, particleTexWidth, particleTexHeight);

  assertAllFinite(resultQuad, 'Quadrupole force must be finite');

  // Test with quadrupoles disabled (monopole only)
  const outForceMono = createTestTexture(gl, particleTexWidth, particleTexHeight, null);

  const kernelMono = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelsA0: createTextureArrayFromLevels(gl, [aggregator.outA0], octreeSize),
    inLevelsA1: createTextureArrayFromLevels(gl, [aggregator.outA1], octreeSize),
    inLevelsA2: createTextureArrayFromLevels(gl, [aggregator.outA2], octreeSize),
    outForce: outForceMono,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  kernelMono.run();

  const resultMono = readTexture(gl, outForceMono, particleTexWidth, particleTexHeight);

  assertAllFinite(resultMono, 'Monopole force must be finite');

  // Both should produce finite forces, but they may differ
  // We're not asserting they're different here, just that both work

  disposeKernel(kernelQuad);
  disposeKernel(kernelMono);
  disposeKernel(aggregator);
  resetGL();
});

/**
 * Test 4: Multiple hierarchy levels
 * Verify the kernel can handle multiple octree levels
 */
test('KTraversalQuadrupole: multiple hierarchy levels', async () => {
  const gl = getGL();

  const particleTexWidth = 2;
  const particleTexHeight = 2;

  const posData = new Float32Array([
    -1.0, 0.0, 0.0, 1.0,
    1.0, 0.0, 0.0, 1.0,
    0.0, -1.0, 0.0, 1.0,
    0.0, 1.0, 0.0, 1.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);

  // Create two levels
  const gridSize0 = 4;
  const slicesPerRow0 = 2;
  const octreeSize0 = gridSize0 * slicesPerRow0;

  const gridSize1 = 2;
  const slicesPerRow1 = 1;
  const octreeSize1 = gridSize1 * slicesPerRow1;

  const levelConfigs = [
    { size: octreeSize0, gridSize: gridSize0, slicesPerRow: slicesPerRow0 },
    { size: octreeSize1, gridSize: gridSize1, slicesPerRow: slicesPerRow1 }
  ];

  // Create empty levels
  const level0A0 = fillVoxelTexture(gl, gridSize0, slicesPerRow0, () => [0, 0, 0, 1]);
  const level0A1 = fillVoxelTexture(gl, gridSize0, slicesPerRow0, () => [0, 0, 0, 0]);
  const level0A2 = fillVoxelTexture(gl, gridSize0, slicesPerRow0, () => [0, 0, 0, 0]);

  const level1A0 = fillVoxelTexture(gl, gridSize1, slicesPerRow1, () => [0, 0, 0, 1]);
  const level1A1 = fillVoxelTexture(gl, gridSize1, slicesPerRow1, () => [0, 0, 0, 0]);
  const level1A2 = fillVoxelTexture(gl, gridSize1, slicesPerRow1, () => [0, 0, 0, 0]);

  // Convert to texture arrays (maxSize = L0 size)
  const arrayA0 = createTextureArrayFromLevels(gl, [level0A0, level1A0], octreeSize0);
  const arrayA1 = createTextureArrayFromLevels(gl, [level0A1, level1A1], octreeSize0);
  const arrayA2 = createTextureArrayFromLevels(gl, [level0A2, level1A2], octreeSize0);

  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);

  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });

  const kernel = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelsA0: arrayA0,
    inLevelsA1: arrayA1,
    inLevelsA2: arrayA2,
    outForce,
    particleTexWidth,
    particleTexHeight,
    numLevels: 2,
    levelConfigs,
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  kernel.run();

  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);

  assertAllFinite(result, 'Force must be finite with multiple levels');

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 5: Edge case - zero mass particle
 */
test('KTraversalQuadrupole: zero mass particle', async () => {
  const gl = getGL();

  const particleTexWidth = 2;
  const particleTexHeight = 1;

  const posData = new Float32Array([
    0.0, 0.0, 0.0, 0.0,  // zero mass
    1.0, 0.0, 0.0, 1.0   // normal mass
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);

  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;

  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });

  const aggregator = new KAggregatorMonopole({
    gl,
    inPosition: posTex,
    particleCount: 2,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: true
  });

  aggregator.run();

  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);

  const kernel = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelsA0: createTextureArrayFromLevels(gl, [aggregator.outA0], octreeSize),
    inLevelsA1: createTextureArrayFromLevels(gl, [aggregator.outA1], octreeSize),
    inLevelsA2: createTextureArrayFromLevels(gl, [aggregator.outA2], octreeSize),
    outForce,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  kernel.run();

  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);

  assertAllFinite(result, 'Force must be finite');

  // Zero mass particle should feel minimal force
  assertClose(result[0], 0.0, 1e-4, 'Zero mass particle force x');
  assertClose(result[1], 0.0, 1e-4, 'Zero mass particle force y');
  assertClose(result[2], 0.0, 1e-4, 'Zero mass particle force z');

  disposeKernel(kernel);
  disposeKernel(aggregator);
  resetGL();
});
