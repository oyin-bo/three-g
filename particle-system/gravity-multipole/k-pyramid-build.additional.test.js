// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KPyramidBuild } from './k-pyramid-build.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * @param {number} gridSize
 * @param {number} slicesPerRow
 */
function textureDimensions(gridSize, slicesPerRow) {
  const width = gridSize * slicesPerRow;
  const sliceRows = Math.ceil(gridSize / slicesPerRow);
  const height = gridSize * sliceRows;
  return { width, height };
}

/**
 * Helper: fill a 3D voxel texture laid out in 2D slices
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number) => [number, number, number, number]} valueFunc
 */
function fillVoxelTexture(gl, gridSize, slicesPerRow, valueFunc) {
  const { width, height } = textureDimensions(gridSize, slicesPerRow);
  const data = new Float32Array(width * height * 4);

  for (let vz = 0; vz < gridSize; vz++) {
    const sliceRow = Math.floor(vz / slicesPerRow);
    const sliceCol = vz % slicesPerRow;

    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const texelX = sliceCol * gridSize + vx;
        const texelY = sliceRow * gridSize + vy;
        const idx = (texelY * width + texelX) * 4;

        const [r, g, b, a] = valueFunc(vx, vy, vz);
        data[idx + 0] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = a;
      }
    }
  }

  return createTestTexture(gl, width, height, data);
}

/**
 * Helper: read a specific voxel from a texture
 * @param {Float32Array} textureData
 * @param {number} vx
 * @param {number} vy
 * @param {number} vz
 * @param {number} gridSize
 * @param {number} slicesPerRow
 */
function readVoxel(textureData, vx, vy, vz, gridSize, slicesPerRow) {
  const { width, height } = textureDimensions(gridSize, slicesPerRow);
  const sliceRow = Math.floor(vz / slicesPerRow);
  const sliceCol = vz % slicesPerRow;
  const texelX = sliceCol * gridSize + vx;
  const texelY = sliceRow * gridSize + vy;
  const idx = (texelY * width + texelX) * 4;

  return [
    textureData[idx + 0],
    textureData[idx + 1],
    textureData[idx + 2],
    textureData[idx + 3]
  ];
}

/**
 * @param {WebGLTexture | null | undefined} texture
 * @param {string} name
 * @returns {WebGLTexture}
 */
function requireTexture(texture, name) {
  if (!texture) {
    throw new Error(`${name} texture should be created`);
  }
  return texture;
}

/**
 * Test 8: Full pyramid chain (L0→L1→L2)
 * Verify that chained pyramid builds produce correct cascading aggregation.
 */
test('KPyramidBuild: full pyramid chain L0→L1→L2', async () => {
  const gl = getGL();

  // L0: 4×4×4 grid
  const l0GridSize = 4;
  const l0SlicesPerRow = 4;
  const { width: l0TexWidth, height: l0TexHeight } = textureDimensions(l0GridSize, l0SlicesPerRow);
  
  // L1: 2×2×2 grid
  const l1GridSize = 2;
  const l1SlicesPerRow = 2;
  const { width: l1TexWidth, height: l1TexHeight } = textureDimensions(l1GridSize, l1SlicesPerRow);
  
  // L2: 1×1×1 grid
  const l2GridSize = 1;
  const l2SlicesPerRow = 1;
  const { width: l2TexWidth, height: l2TexHeight } = textureDimensions(l2GridSize, l2SlicesPerRow);
  
  // Create L0 with uniform mass 1.0 in alpha channel
  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 1.0]);
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  
  // Build L0→L1
  const kernel1 = new KPyramidBuild({
    gl,
    outSize: l1TexWidth,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel1.run();
  
  // L1 should have 8.0 in each voxel (8 children × 1.0)
  const l1OutA0 = requireTexture(kernel1.outA0, 'L1 outA0');
  const l1Result = readTexture(gl, l1OutA0, l1TexWidth, l1TexHeight);
  assertClose(l1Result[3], 8.0, 1e-4, 'L1 voxel mass should be 8.0');

  // Build L1→L2
  const l1OutA0Texture = requireTexture(kernel1.outA0, 'L1 outA0');
  const l1OutA1Texture = requireTexture(kernel1.outA1, 'L1 outA1');
  const l1OutA2Texture = requireTexture(kernel1.outA2, 'L1 outA2');

  const kernel2 = new KPyramidBuild({
    gl,
    outSize: l2TexWidth,
    outGridSize: l2GridSize,
    outSlicesPerRow: l2SlicesPerRow,
    inGridSize: l1GridSize,
    inSlicesPerRow: l1SlicesPerRow,
    inA0: /** @type {WebGLTexture} */ (l1OutA0Texture),
    inA1: /** @type {WebGLTexture} */ (l1OutA1Texture),
    inA2: /** @type {WebGLTexture} */ (l1OutA2Texture)
  });
  kernel2.run();

  // L2 should have 64.0 (8 L1 voxels × 8.0 each)
  const l2OutA0 = requireTexture(kernel2.outA0, 'L2 outA0');
  const l2Result = readTexture(gl, l2OutA0, l2TexWidth, l2TexHeight);
  assertClose(l2Result[3], 64.0, 1e-3, 'L2 root voxel mass should be 64.0 (8×8 children)');
  
  disposeKernel(kernel1);
  disposeKernel(kernel2);
  resetGL();
});

test('KPyramidBuild: 4x4x4 child maps single voxel into 2x2x2 parent', async () => {
  const gl = getGL();

  const childGridSize = 4;
  const childSlicesPerRow = 2;
  const childTextureSize = childGridSize * childSlicesPerRow;

  const parentGridSize = 2;
  const parentSlicesPerRow = 1;
  const parentTextureSize = parentGridSize * parentSlicesPerRow;

  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    if (x === 3 && y === 3 && z === 1) return [0, 0, 0, 5];
    return [0, 0, 0, 0];
  });
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);

  const kernel = new KPyramidBuild({
    gl,
    outSize: parentTextureSize,
    outGridSize: parentGridSize,
    outSlicesPerRow: parentSlicesPerRow,
    inGridSize: childGridSize,
    inSlicesPerRow: childSlicesPerRow,
    inA0: childA0,
    inA1: childA1,
    inA2: childA2
  });

  kernel.run();

  const parentA0Texture = requireTexture(kernel.outA0, 'Parent outA0');
  const parentA0 = readTexture(gl, parentA0Texture, parentTextureSize, parentTextureSize);
  const [, , , mass] = readVoxel(
    parentA0,
    Math.floor(3 / 2),
    Math.floor(3 / 2),
    Math.floor(1 / 2),
    parentGridSize,
    parentSlicesPerRow
  );

  assertClose(mass, 5, 1e-4, 'Parent voxel should receive the child mass');

  disposeKernel(kernel);
  resetGL();
});

test('KPyramidBuild: 8x8x8 child aggregates siblings into 4x4x4 parent', async () => {
  const gl = getGL();

  const childGridSize = 8;
  const childSlicesPerRow = 2;
  const childTextureSize = childGridSize * childSlicesPerRow;

  const parentGridSize = 4;
  const parentSlicesPerRow = 2;
  const parentTextureSize = parentGridSize * parentSlicesPerRow;

  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    if (x === 0 && y === 0 && z === 0) return [0, 0, 0, 2];
    if (x === 1 && y === 1 && z === 1) return [0, 0, 0, 3];
    return [0, 0, 0, 0];
  });
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);

  const kernel = new KPyramidBuild({
    gl,
    outSize: parentTextureSize,
    outGridSize: parentGridSize,
    outSlicesPerRow: parentSlicesPerRow,
    inGridSize: childGridSize,
    inSlicesPerRow: childSlicesPerRow,
    inA0: childA0,
    inA1: childA1,
    inA2: childA2
  });

  kernel.run();

  const parentA0Texture2 = kernel.outA0;
  if (!parentA0Texture2) {
    throw new Error('outA0 texture should be created');
  }
  const parentA0 = readTexture(gl, requireTexture(parentA0Texture2, 'Parent outA0'), parentTextureSize, parentTextureSize);
  const [, , , mass] = readVoxel(parentA0, 0, 0, 0, parentGridSize, parentSlicesPerRow);
  const [, , , oppositeMass] = readVoxel(parentA0, 3, 3, 3, parentGridSize, parentSlicesPerRow);

  assertClose(mass, 5, 1e-4, 'Parent voxel should accumulate sibling masses');
  assertClose(oppositeMass, 0, 1e-4, 'Unrelated parent voxel should remain empty');

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 9: Real system sizes (64×64×64 → 32×32×32)
 * Test with actual octree grid sizes from the convergence test system.
 */
test('KPyramidBuild: real system sizes 64x64x64 to 32x32x32', async () => {
  const gl = getGL();
  
  // Real L0 size
  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0TexWidth, height: l0TexHeight } = textureDimensions(l0GridSize, l0SlicesPerRow);
  
  // Real L1 size
  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1TexWidth, height: l1TexHeight } = textureDimensions(l1GridSize, l1SlicesPerRow);
  
  // Simulate two particles: P0 at voxel [44,32,32], P1 at voxel [32,32,32]
  // P0 mass 1.0, P1 mass 10.0
  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    if (x === 44 && y === 32 && z === 32) return [0, 0, 0, 1.0];  // P0
    if (x === 32 && y === 32 && z === 32) return [0, 0, 0, 10.0]; // P1
    return [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  
  const kernel = new KPyramidBuild({
    gl,
    outSize: l1TexWidth,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel.run();
  
  const l1Result = readTexture(gl, requireTexture(kernel.outA0, 'L1 outA0'), l1TexWidth, l1TexHeight);
  
  // L1 should have total mass 11.0 somewhere (aggregated from L0)
  let totalMass = 0;
  for (let i = 0; i < l1Result.length; i += 4) {
    totalMass += l1Result[i + 3]; // Sum all alpha (mass) values
  }
  
  assertClose(totalMass, 11.0, 1e-3, 'L1 total mass should be 11.0 (1.0 + 10.0)');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 10: Verify slice layout with non-square slicesPerRow
 * Test that the slice-to-texel mapping is correct for various layouts.
 */
test('KPyramidBuild: verify slice layout with non-square slicesPerRow', async () => {
  const gl = getGL();
  
  // Child: 8×8×8 with slicesPerRow=4 (8 slices in 4×2 layout)
  const childGridSize = 8;
  const childSlicesPerRow = 4;
  const { width: childTexWidth, height: childTexHeight } = textureDimensions(childGridSize, childSlicesPerRow);

  // Parent: 4×4×4 with slicesPerRow=2 (4 slices in 2×2 layout)
  const parentGridSize = 4;
  const parentSlicesPerRow = 2;
  const { width: parentTexWidth, height: parentTexHeight } = textureDimensions(parentGridSize, parentSlicesPerRow);
  
  // Mark corner voxels to verify mapping
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    // Mark corners of the grid
    if ((x === 0 || x === 7) && (y === 0 || y === 7) && (z === 0 || z === 7)) {
      return [1, 1, 1, 1];
    }
    return [0, 0, 0, 0];
  });
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  
  const kernel = new KPyramidBuild({
    gl,
    outSize: parentTexWidth,
    outGridSize: parentGridSize,
    outSlicesPerRow: parentSlicesPerRow,
    inGridSize: childGridSize,
    inSlicesPerRow: childSlicesPerRow,
    inA0: childA0,
    inA1: childA1,
    inA2: childA2
  });
  kernel.run();
  
  const resultA0 = readTexture(gl, requireTexture(kernel.outA0, 'Parent outA0'), parentTexWidth, parentTexHeight);
  
  // Each corner parent voxel should aggregate 8 corner children
  const [r, g, b, a] = readVoxel(resultA0, 0, 0, 0, parentGridSize, parentSlicesPerRow);
  assertClose(a, 1, 1e-4, 'Parent corner (0,0,0) should receive mass from its marked child');
  
  // Parent (3,3,3) aggregates children (6,6,6) to (7,7,7)
  const [r2, g2, b2, a2] = readVoxel(resultA0, 3, 3, 3, parentGridSize, parentSlicesPerRow);
  assertClose(a2, 1, 1e-4, 'Parent corner (3,3,3) should receive mass from its marked child');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 11: Multiple sequential runs produce consistent results
 * Verify that the kernel can be run multiple times without state corruption.
 */
test('KPyramidBuild: multiple sequential runs produce consistent results', async () => {
  const gl = getGL();
  
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = 4;
  
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = 1;
  
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [1, 2, 3, 4]);
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0.5, 1.0, 1.5, 2.0]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [10, 20, 30, 40]);
  
  const kernel = new KPyramidBuild({
    gl,
    outSize: parentTextureSize,
    outGridSize: parentGridSize,
    outSlicesPerRow: parentSlicesPerRow,
    inGridSize: childGridSize,
    inSlicesPerRow: childSlicesPerRow,
    inA0: childA0,
    inA1: childA1,
    inA2: childA2
  });
  
  // Run 1
  kernel.run();
  const result1A0 = readTexture(gl, requireTexture(kernel.outA0, 'Parent outA0'), parentTextureSize, parentTextureSize);
  const result1A1 = readTexture(gl, requireTexture(kernel.outA1, 'Parent outA1'), parentTextureSize, parentTextureSize);
  const result1A2 = readTexture(gl, requireTexture(kernel.outA2, 'Parent outA2'), parentTextureSize, parentTextureSize);
  
  // Run 2 (should produce identical results)
  kernel.run();
  const result2A0 = readTexture(gl, requireTexture(kernel.outA0, 'Parent outA0'), parentTextureSize, parentTextureSize);
  const result2A1 = readTexture(gl, requireTexture(kernel.outA1, 'Parent outA1'), parentTextureSize, parentTextureSize);
  const result2A2 = readTexture(gl, requireTexture(kernel.outA2, 'Parent outA2'), parentTextureSize, parentTextureSize);
  
  // Compare all channels
  for (let i = 0; i < 4; i++) {
    assertClose(result1A0[i], result2A0[i], 1e-6, `A0[${i}] run1 vs run2`);
    assertClose(result1A1[i], result2A1[i], 1e-6, `A1[${i}] run1 vs run2`);
    assertClose(result1A2[i], result2A2[i], 1e-6, `A2[${i}] run1 vs run2`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 12: Additive blending accumulates correctly
 * Verify that multiple non-zero voxels in the same parent sum, not overwrite.
 */
test('KPyramidBuild: additive blending accumulates correctly', async () => {
  const gl = getGL();
  
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = 4;
  
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = 1;
  
  // All 8 children have the same mass value
  // With additive blending, parent should have 8× the value
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [5, 10, 15, 20]);
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  
  const kernel = new KPyramidBuild({
    gl,
    outSize: parentTextureSize,
    outGridSize: parentGridSize,
    outSlicesPerRow: parentSlicesPerRow,
    inGridSize: childGridSize,
    inSlicesPerRow: childSlicesPerRow,
    inA0: childA0,
    inA1: childA1,
    inA2: childA2
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, requireTexture(kernel.outA0, 'Parent outA0'), parentTextureSize, parentTextureSize);
  
  // With additive blending, each channel should be 8× the child value
  assertClose(resultA0[0], 5 * 8, 1e-4, 'A0.r should be 5×8=40');
  assertClose(resultA0[1], 10 * 8, 1e-4, 'A0.g should be 10×8=80');
  assertClose(resultA0[2], 15 * 8, 1e-4, 'A0.b should be 15×8=120');
  assertClose(resultA0[3], 20 * 8, 1e-4, 'A0.a should be 20×8=160');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 13: Framebuffer attachment verification
 * Verify that output textures are properly attached and framebuffer is complete.
 */
test('KPyramidBuild: framebuffer attachment is valid', async () => {
  const gl = getGL();
  
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = 4;
  
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = 1;
  
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [1, 2, 3, 4]);
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  
  const kernel = new KPyramidBuild({
    gl,
    outSize: parentTextureSize,
    outGridSize: parentGridSize,
    outSlicesPerRow: parentSlicesPerRow,
    inGridSize: childGridSize,
    inSlicesPerRow: childSlicesPerRow,
    inA0: childA0,
    inA1: childA1,
    inA2: childA2
  });
  
  // Verify output textures exist and are non-null
  assert.ok(kernel.outA0, 'outA0 should be non-null');
  assert.ok(kernel.outA1, 'outA1 should be non-null');
  assert.ok(kernel.outA2, 'outA2 should be non-null');
  
  // Run kernel
  kernel.run();
  
  // Verify we can read from output textures (indicates they're properly bound)
  const resultA0 = readTexture(gl, kernel.outA0, parentTextureSize, parentTextureSize);
  const resultA1 = readTexture(gl, kernel.outA1, parentTextureSize, parentTextureSize);
  const resultA2 = readTexture(gl, kernel.outA2, parentTextureSize, parentTextureSize);
  
  // All results should be finite (not NaN or Inf)
  assertAllFinite(resultA0, 'A0 output must be finite');
  assertAllFinite(resultA1, 'A1 output must be finite');
  assertAllFinite(resultA2, 'A2 output must be finite');
  
  // Verify expected aggregation occurred
  assertClose(resultA0[3], 4 * 8, 1e-4, 'A0.a should be 4×8=32 (8 children × 4)');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 14: Blending state during accumulation
 * Verify that additive blending is properly configured to accumulate values.
 * This test checks that the kernel correctly enables blending and uses additive mode.
 */
test('KPyramidBuild: blending state accumulates without overwriting', async () => {
  const gl = getGL();
  
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = 4;
  
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = 1;
  
  // Create child with non-uniform values to detect overwriting vs accumulation
  // If blending is broken, we'd see only one child's value instead of sum
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    // Each child has a unique value
    const childIndex = x + y * 2 + z * 4;
    return [childIndex * 10, childIndex * 20, childIndex * 30, childIndex * 40];
  });
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
  
  const kernel = new KPyramidBuild({
    gl,
    outSize: parentTextureSize,
    outGridSize: parentGridSize,
    outSlicesPerRow: parentSlicesPerRow,
    inGridSize: childGridSize,
    inSlicesPerRow: childSlicesPerRow,
    inA0: childA0,
    inA1: childA1,
    inA2: childA2
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, kernel.outA0, parentTextureSize, parentTextureSize);
  
  // Expected: sum of all 8 children
  // childIndex 0-7: sum = 0+1+2+3+4+5+6+7 = 28
  const expectedR = 28 * 10;  // 280
  const expectedG = 28 * 20;  // 560
  const expectedB = 28 * 30;  // 840
  const expectedA = 28 * 40;  // 1120
  
  // If blending is broken (overwriting instead of accumulating),
  // we'd see only the last child's values: [70, 140, 210, 280]
  // This test catches that failure mode
  assertClose(resultA0[0], expectedR, 1e-3, 'A0.r should be sum of all children (280), not last child (70)');
  assertClose(resultA0[1], expectedG, 1e-3, 'A0.g should be sum of all children (560), not last child (140)');
  assertClose(resultA0[2], expectedB, 1e-3, 'A0.b should be sum of all children (840), not last child (210)');
  assertClose(resultA0[3], expectedA, 1e-3, 'A0.a should be sum of all children (1120), not last child (280)');
  
  disposeKernel(kernel);
  resetGL();
});
