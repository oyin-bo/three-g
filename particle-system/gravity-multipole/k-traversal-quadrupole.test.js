// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KTraversalQuadrupole } from './k-traversal-quadrupole.js';
import { KAggregator } from './k-aggregator.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

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
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelA0: [levelA0],
    inLevelA1: [levelA1],
    inLevelA2: [levelA2],
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
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  assertAllFinite(result, 'Force must be finite');
  
  // Force should be zero (no other mass)
  assertClose(result[0], 0.0, 1e-5, 'Force x');
  assertClose(result[1], 0.0, 1e-5, 'Force y');
  assertClose(result[2], 0.0, 1e-5, 'Force z');
  
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
  
  const octreeA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const octreeA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const octreeA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const aggregator = new KAggregator({
    gl,
    inPosition: posTex,
    outA0: octreeA0,
    outA1: octreeA1,
    outA2: octreeA2,
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
    inLevelA0: [octreeA0],
    inLevelA1: [octreeA1],
    inLevelA2: [octreeA2],
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
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  assertAllFinite(result, 'Force must be finite');
  
  // First particle should feel force in +x direction (toward second particle)
  // Force magnitude should be proportional to G * m1 * m2 / r^2
  // With distance 2, masses 1, G=0.0003, softening 0.2: expect small positive force
  assert.ok(result[0] > 0, 'First particle should feel attraction in +x');
  
  // Second particle should feel force in -x direction
  assert.ok(result[4] < 0, 'Second particle should feel attraction in -x');
  
  // Y and Z forces should be near zero
  assertClose(result[1], 0.0, 1e-4, 'First particle force y should be ~0');
  assertClose(result[2], 0.0, 1e-4, 'First particle force z should be ~0');
  assertClose(result[5], 0.0, 1e-4, 'Second particle force y should be ~0');
  assertClose(result[6], 0.0, 1e-4, 'Second particle force z should be ~0');
  
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
  
  const octreeA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const octreeA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const octreeA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const aggregator = new KAggregator({
    gl,
    inPosition: posTex,
    outA0: octreeA0,
    outA1: octreeA1,
    outA2: octreeA2,
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
    inLevelA0: [octreeA0],
    inLevelA1: [octreeA1],
    inLevelA2: [octreeA2],
    outForce: outForceQuad,
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
  
  kernelQuad.run();
  
  const resultQuad = readTexture(gl, outForceQuad, particleTexWidth, particleTexHeight);
  
  assertAllFinite(resultQuad, 'Quadrupole force must be finite');
  
  // Test with quadrupoles disabled (monopole only)
  const outForceMono = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const kernelMono = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    inLevelA1: [octreeA1],
    inLevelA2: [octreeA2],
    outForce: outForceMono,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.0003,
    softening: 0.2,
    enableQuadrupoles: false
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
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KTraversalQuadrupole({
    gl,
    inPosition: posTex,
    inLevelA0: [level0A0, level1A0],
    inLevelA1: [level0A1, level1A1],
    inLevelA2: [level0A2, level1A2],
    outForce,
    particleTexWidth,
    particleTexHeight,
    numLevels: 2,
    levelConfigs,
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.0003,
    softening: 0.2,
    enableQuadrupoles: true
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
  
  const octreeA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const octreeA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const octreeA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const aggregator = new KAggregator({
    gl,
    inPosition: posTex,
    outA0: octreeA0,
    outA1: octreeA1,
    outA2: octreeA2,
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
    inLevelA0: [octreeA0],
    inLevelA1: [octreeA1],
    inLevelA2: [octreeA2],
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
