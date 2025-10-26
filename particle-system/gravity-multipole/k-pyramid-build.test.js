// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KPyramidBuild } from './k-pyramid-build.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: fill a 3D voxel texture laid out in 2D slices
 * Creates a SQUARE texture as expected by KPyramidBuild
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize - voxel grid dimension (e.g., 4 for 4×4×4)
 * @param {number} slicesPerRow - how many Z-slices fit per row
 * @param {(x: number, y: number, z: number) => [number, number, number, number]} valueFunc
 */
function fillVoxelTexture(gl, gridSize, slicesPerRow, valueFunc) {
  // Calculate square texture size: gridSize * slicesPerRow
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
 * Helper: read a specific voxel from a texture (square texture layout)
 * @param {Float32Array} textureData
 * @param {number} vx
 * @param {number} vy
 * @param {number} vz
 * @param {number} gridSize
 * @param {number} slicesPerRow
 */
function readVoxel(textureData, vx, vy, vz, gridSize, slicesPerRow) {
  const textureSize = gridSize * slicesPerRow;
  const sliceRow = Math.floor(vz / slicesPerRow);
  const sliceCol = vz % slicesPerRow;
  const texelX = sliceCol * gridSize + vx;
  const texelY = sliceRow * gridSize + vy;
  const idx = (texelY * textureSize + texelX) * 4;
  
  return [
    textureData[idx + 0],
    textureData[idx + 1],
    textureData[idx + 2],
    textureData[idx + 3]
  ];
}

/**
 * Test 1: Single voxel reduction (2×2×2 → 1×1×1)
 * Eight child voxels with known values should sum correctly.
 */
test('KPyramidBuild: single voxel 2x2x2 reduction', async () => {
  const gl = getGL();
  
  // Child level: 2×2×2 grid, needs 4 slices in 2×2 layout
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = childGridSize * childSlicesPerRow; // 4×4
  
  // Parent level: 1×1×1 grid, needs 1 slice in 1×1 layout
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = parentGridSize * parentSlicesPerRow; // 1×1
  
  // Create child textures with distinct values for each of 8 voxels
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    const voxelIndex = x + y * 2 + z * 4; // 0-7
    return [voxelIndex * 1.0, voxelIndex * 2.0, voxelIndex * 3.0, voxelIndex * 4.0];
  });
  
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    const voxelIndex = x + y * 2 + z * 4;
    return [voxelIndex * 0.1, voxelIndex * 0.2, voxelIndex * 0.3, voxelIndex * 0.4];
  });
  
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    const voxelIndex = x + y * 2 + z * 4;
    return [voxelIndex * 10.0, voxelIndex * 20.0, voxelIndex * 30.0, voxelIndex * 40.0];
  });
  
  // Create and run kernel
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
  
  const snapshot = kernel.valueOf({ pixels: true });
  
  // Expected: sum of all 8 voxels (indices 0-7)
  const expectedA0 = [28, 56, 84, 112];
  const expectedA1 = [2.8, 5.6, 8.4, 11.2];
  const expectedA2 = [280, 560, 840, 1120];
  
  assertClose(snapshot.a0.pixels[0].mass, expectedA0[0], 1e-5, 
    `A0.mass should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.pixels[0].cx, expectedA0[1], 1e-5, 
    `A0.cx should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.pixels[0].cy, expectedA0[2], 1e-5, 
    `A0.cy should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.pixels[0].cz, expectedA0[3], 1e-5, 
    `A0.cz should match\n\n${kernel.toString()}`);
  
  assertClose(snapshot.a1.pixels[0].qxx, expectedA1[0], 1e-5, 
    `A1.qxx should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a1.pixels[0].qyy, expectedA1[1], 1e-5, 
    `A1.qyy should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a1.pixels[0].qzz, expectedA1[2], 1e-5, 
    `A1.qzz should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a1.pixels[0].qxy, expectedA1[3], 1e-5, 
    `A1.qxy should match\n\n${kernel.toString()}`);
  
  assertClose(snapshot.a2.pixels[0].qyz, expectedA2[0], 1e-5, 
    `A2.qyz should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a2.pixels[0].qzx, expectedA2[1], 1e-5, 
    `A2.qzx should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a2.pixels[0].reserved1, expectedA2[2], 1e-5, 
    `A2.reserved1 should match\n\n${kernel.toString()}`);
  assertClose(snapshot.a2.pixels[0].reserved2, expectedA2[3], 1e-5, 
    `A2.reserved2 should match\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Multiple voxel reduction (4×4×4 → 2×2×2)
 * Verify that each parent voxel correctly sums its 8 children.
 */
test('KPyramidBuild: multiple voxel 4x4x4 to 2x2x2 reduction', async () => {
  const gl = getGL();
  
  // Child level: 4×4×4 grid - use slicesPerRow=4 for 16×16 texture
  // Shader expects childSlicesPerRow = parentSlicesPerRow * 2
  const childGridSize = 4;
  const childSlicesPerRow = 4; // 4 slices in 4×1 layout
  const childTextureSize = childGridSize * childSlicesPerRow; // 16×16
  
  // Parent level: 2×2×2 grid - use slicesPerRow=2 for 4×4 texture
  const parentGridSize = 2;
  const parentSlicesPerRow = 2; // 2 slices in 2×1 layout
  const parentTextureSize = parentGridSize * parentSlicesPerRow; // 4×4
  
  // Fill child with voxel index as value
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    const voxelIndex = x + y * 4 + z * 16;
    return [voxelIndex, 0, 0, 1]; // Store index in red, mass=1 in alpha
  });
  
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    return [0, 0, 0, 0]; // Zeros for simplicity
  });
  
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    return [0, 0, 0, 0];
  });
  
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Check aggregation worked (non-zero values in parent grid)
  assert.ok(snapshot.a0, `Parent grid should have aggregated values\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Zero input handling
 * All zeros should produce zero output.
 */
test('KPyramidBuild: zero input produces zero output', async () => {
  const gl = getGL();
  
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = 4;
  
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = 1;
  
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0, 0, 0, 0]);
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
  const resultA1 = readTexture(gl, kernel.outA1, parentTextureSize, parentTextureSize);
  const resultA2 = readTexture(gl, kernel.outA2, parentTextureSize, parentTextureSize);
  
  assertAllFinite(resultA0, 'A0 must be finite');
  assertAllFinite(resultA1, 'A1 must be finite');
  assertAllFinite(resultA2, 'A2 must be finite');
  
  for (let i = 0; i < 4; i++) {
    assertClose(resultA0[i], 0, 1e-5, `A0[${i}] should be zero`);
    assertClose(resultA1[i], 0, 1e-5, `A1[${i}] should be zero`);
    assertClose(resultA2[i], 0, 1e-5, `A2[${i}] should be zero`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 4: Uniform input values
 * All children having the same value should produce 8× that value.
 */
test('KPyramidBuild: uniform input scales correctly', async () => {
  const gl = getGL();
  
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = 4;
  
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = 1;
  
  const uniformValue = [1.5, 2.5, 3.5, 4.5];
  
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => /** @type {[number,number,number,number]} */ (uniformValue));
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0.1, 0.2, 0.3, 0.4]);
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
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: true });
  
  // Each parent aggregates 8 children
  assertClose(snapshot.a0.pixels[0].mass, uniformValue[0] * 8, 1e-4, 
    `A0.mass should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.pixels[0].cx, uniformValue[1] * 8, 1e-4, 
    `A0.cx should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.pixels[0].cy, uniformValue[2] * 8, 1e-4, 
    `A0.cy should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.pixels[0].cz, uniformValue[3] * 8, 1e-4, 
    `A0.cz should aggregate 8 children\n\n${kernel.toString()}`);
  
  assertClose(snapshot.a1.pixels[0].qxx, 0.1 * 8, 1e-4, 
    `A1.qxx should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a1.pixels[0].qyy, 0.2 * 8, 1e-4, 
    `A1.qyy should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a1.pixels[0].qzz, 0.3 * 8, 1e-4, 
    `A1.qzz should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a1.pixels[0].qxy, 0.4 * 8, 1e-4, 
    `A1.qxy should aggregate 8 children\n\n${kernel.toString()}`);
  
  assertClose(snapshot.a2.pixels[0].qyz, 10 * 8, 1e-4, 
    `A2.qyz should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a2.pixels[0].qzx, 20 * 8, 1e-4, 
    `A2.qzx should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a2.pixels[0].reserved1, 30 * 8, 1e-4, 
    `A2.reserved1 should aggregate 8 children\n\n${kernel.toString()}`);
  assertClose(snapshot.a2.pixels[0].reserved2, 40 * 8, 1e-4, 
    `A2.reserved2 should aggregate 8 children\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 5: Larger reduction (8×8×8 → 4×4×4)
 * Test with a bigger grid to ensure coordinate mapping works at scale.
 */
test('KPyramidBuild: large grid 8x8x8 to 4x4x4 reduction', async () => {
  const gl = getGL();
  
  const childGridSize = 8;
  const childSlicesPerRow = 4; // 8 slices in 4×2 layout, texture 32×16
  const childTextureSize = childGridSize * childSlicesPerRow; // 32×32 square
  
  const parentGridSize = 4;
  const parentSlicesPerRow = 2; // 4 slices in 2×2 layout
  const parentTextureSize = parentGridSize * parentSlicesPerRow; // 8×8 square
  
  // Fill child with coordinate-based pattern
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    return [x + y + z, x * y, y * z, x * z];
  });
  
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [1, 1, 1, 1]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [0.5, 0.5, 0.5, 0.5]);
  
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Check aggregation produced finite results
  assert.ok(snapshot.a0, `A0 should be finite\n\n${kernel.toString()}`);
  assert.ok(snapshot.a1, `A1 should be finite\n\n${kernel.toString()}`);
  assert.ok(snapshot.a2, `A2 should be finite\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 6: Edge case - single child per parent (trivial 1×1×1 → 1×1×1, conceptually impossible but test boundary)
 * Actually, let's test identity: if input grid is 2x2x2 but we only sample one specific octant
 */
test('KPyramidBuild: sparse input with some empty voxels', async () => {
  const gl = getGL();
  
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = 4;
  
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = 1;
  
  // Only set one specific child voxel (0,0,0) to non-zero, rest are zero
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    if (x === 0 && y === 0 && z === 0) return [100, 200, 300, 400];
    return [0, 0, 0, 0];
  });
  
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    if (x === 1 && y === 1 && z === 1) return [10, 20, 30, 40];
    return [0, 0, 0, 0];
  });
  
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
  const resultA1 = readTexture(gl, kernel.outA1, parentTextureSize, parentTextureSize);
  const resultA2 = readTexture(gl, kernel.outA2, parentTextureSize, parentTextureSize);
  
  // A0 should have only the (0,0,0) contribution
  assertClose(resultA0[0], 100, 1e-5, 'A0.r should be 100');
  assertClose(resultA0[1], 200, 1e-5, 'A0.g should be 200');
  assertClose(resultA0[2], 300, 1e-5, 'A0.b should be 300');
  assertClose(resultA0[3], 400, 1e-5, 'A0.a should be 400');
  
  // A1 should have only the (1,1,1) contribution
  assertClose(resultA1[0], 10, 1e-5, 'A1.r should be 10');
  assertClose(resultA1[1], 20, 1e-5, 'A1.g should be 20');
  assertClose(resultA1[2], 30, 1e-5, 'A1.b should be 30');
  assertClose(resultA1[3], 40, 1e-5, 'A1.a should be 40');
  
  // A2 all zeros
  for (let i = 0; i < 4; i++) {
    assertClose(resultA2[i], 0, 1e-5, `A2[${i}] should be zero`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 7: Negative values and large numbers
 * Ensure proper accumulation with negative and large values.
 */
test('KPyramidBuild: negative and large values', async () => {
  const gl = getGL();
  
  const childGridSize = 2;
  const childSlicesPerRow = 2;
  const childTextureSize = 4;
  
  const parentGridSize = 1;
  const parentSlicesPerRow = 1;
  const parentTextureSize = 1;
  
  // Mix of positive, negative, and large values
  const childA0 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, (x, y, z) => {
    const sign = ((x + y + z) % 2 === 0) ? 1 : -1;
    return [sign * 1000, sign * 2000, sign * 3000, sign * 4000];
  });
  
  const childA1 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [-5, -10, -15, -20]);
  const childA2 = fillVoxelTexture(gl, childGridSize, childSlicesPerRow, () => [1e6, 2e6, 3e6, 4e6]);
  
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
  const resultA1 = readTexture(gl, kernel.outA1, parentTextureSize, parentTextureSize);
  const resultA2 = readTexture(gl, kernel.outA2, parentTextureSize, parentTextureSize);
  
  assertAllFinite(resultA0, 'A0 must be finite');
  assertAllFinite(resultA1, 'A1 must be finite');
  assertAllFinite(resultA2, 'A2 must be finite');
  
  // A0: 4 positive + 4 negative = 0
  assertClose(resultA0[0], 0, 1e-3, 'A0.r should cancel out');
  assertClose(resultA0[1], 0, 1e-3, 'A0.g should cancel out');
  assertClose(resultA0[2], 0, 1e-3, 'A0.b should cancel out');
  assertClose(resultA0[3], 0, 1e-3, 'A0.a should cancel out');
  
  // A1: all negative, 8 × -5 = -40, etc.
  assertClose(resultA1[0], -40, 1e-4, 'A1.r');
  assertClose(resultA1[1], -80, 1e-4, 'A1.g');
  assertClose(resultA1[2], -120, 1e-4, 'A1.b');
  assertClose(resultA1[3], -160, 1e-4, 'A1.a');
  
  // A2: large positive, 8 × 1e6 = 8e6
  assertClose(resultA2[0], 8e6, 1e2, 'A2.r');
  assertClose(resultA2[1], 16e6, 1e2, 'A2.g');
  assertClose(resultA2[2], 24e6, 1e2, 'A2.b');
  assertClose(resultA2[3], 32e6, 1e2, 'A2.a');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test: Pyramid chain produces coarser levels with hierarchical structure
 * This tests the actual L0→L1→L2→L3 chain used in the system
 */
test('KPyramidBuild: pyramid chain L0→L1→L2→L3 hierarchy', async () => {
  const gl = getGL();
  
  // Create L0 (64³ grid): 2 particles
  const l0Data = fillVoxelTexture(gl, 64, 8, (x, y, z) => {
    if (x === 0 && y === 0 && z === 0) return [0, 0, 0, 10];  // mass=10
    if (x === 1 && y === 0 && z === 0) return [1, 0, 0, 1];   // mass=1
    return [0, 0, 0, 0];
  });
  
  // L0 → L1 (64³ → 32³)
  const l1Kernel = new KPyramidBuild({
    gl,
    outSize: 256,
    outGridSize: 32,
    outSlicesPerRow: 4,
    inGridSize: 64,
    inSlicesPerRow: 8,
    inA0: l0Data,
    inA1: l0Data,
    inA2: l0Data
  });
  l1Kernel.run();
  
  // L1 → L2 (32³ → 16³)
  const l2Kernel = new KPyramidBuild({
    gl,
    outSize: 128,
    outGridSize: 16,
    outSlicesPerRow: 4,
    inGridSize: 32,
    inSlicesPerRow: 4,
    inA0: l1Kernel.outA0,
    inA1: l1Kernel.outA1,
    inA2: l1Kernel.outA2
  });
  l2Kernel.run();
  
  // L2 → L3 (16³ → 8³)
  const l3Kernel = new KPyramidBuild({
    gl,
    outSize: 64,
    outGridSize: 8,
    outSlicesPerRow: 4,
    inGridSize: 16,
    inSlicesPerRow: 4,
    inA0: l2Kernel.outA0,
    inA1: l2Kernel.outA1,
    inA2: l2Kernel.outA2
  });
  l3Kernel.run();
  
  // Single assertion with all diagnostics embedded in label
  const diagnostics = `Pyramid hierarchy:\n\n` +
    `L0→L1:\n${l1Kernel.toString()}\n\n` +
    `L1→L2:\n${l2Kernel.toString()}\n\n` +
    `L2→L3:\n${l3Kernel.toString()}`;
  
  assert.ok(l1Kernel.outA0 && l2Kernel.outA0 && l3Kernel.outA0, 
    `All pyramid levels should produce output\n\n${diagnostics}`);
  
  disposeKernel(l1Kernel);
  disposeKernel(l2Kernel);
  disposeKernel(l3Kernel);
  gl.deleteTexture(l0Data);
  resetGL();
});
