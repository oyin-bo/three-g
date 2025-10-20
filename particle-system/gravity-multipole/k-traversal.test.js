// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KTraversal } from './k-traversal.js';
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
test('KTraversal: single particle no force', async () => {
  const gl = getGL();
  
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  // Create empty octree level
  const levelA0 = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [levelA0],
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
  
  // Force should be zero (no other mass)
  assertClose(result[0], 0.0, 1e-5, 'Force x');
  assertClose(result[1], 0.0, 1e-5, 'Force y');
  assertClose(result[2], 0.0, 1e-5, 'Force z');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Two particles - mutual gravitational attraction
 */
test('KTraversal: two particle interaction', async () => {
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
  
  const kernel = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    outForce,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 1.0,
    softening: 0.1
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  assertAllFinite(result, 'Force must be finite');
  
  // Particle 0 at (-1,0,0) should feel force toward particle 1 at (1,0,0)
  // Force should be in +x direction
  assert.ok(result[0] > 0, 'Force on particle 0 should be in +x direction');
  assertClose(result[1], 0.0, 1e-3, 'Force y should be near zero');
  assertClose(result[2], 0.0, 1e-3, 'Force z should be near zero');
  
  // Particle 1 should feel opposite force
  assert.ok(result[4] < 0, 'Force on particle 1 should be in -x direction');
  
  // Forces should be roughly equal magnitude (Newton's third law)
  assertClose(Math.abs(result[0]), Math.abs(result[4]), 1e-2, 'Forces should have equal magnitude');
  
  disposeKernel(kernel);
  disposeKernel(aggregator);
  resetGL();
});

/**
 * Test 3: Theta criterion - larger theta accepts more approximations
 */
test('KTraversal: theta criterion effect', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Test particle at origin
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  // Create octree with mass in one corner
  const octreeA0 = fillVoxelTexture(gl, gridSize, slicesPerRow, (vx, vy, vz) => {
    if (vx === 3 && vy === 3 && vz === 3) {
      // Mass at corner: (m*x, m*y, m*z, m)
      return [3.0, 3.0, 3.0, 1.0];
    }
    return [0, 0, 0, 0];
  });
  
  const outForce1 = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  const outForce2 = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  // Small theta (more accurate, less approximation)
  const kernel1 = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    outForce: outForce1,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.1,
    gravityStrength: 1.0,
    softening: 0.1
  });
  
  kernel1.run();
  const result1 = readTexture(gl, outForce1, particleTexWidth, particleTexHeight);
  
  // Large theta (more approximation)
  const kernel2 = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    outForce: outForce2,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 1.0,
    gravityStrength: 1.0,
    softening: 0.1
  });
  
  kernel2.run();
  const result2 = readTexture(gl, outForce2, particleTexWidth, particleTexHeight);
  
  // Both should produce finite forces
  assertAllFinite(result1, 'Small theta force finite');
  assertAllFinite(result2, 'Large theta force finite');
  
  // Both should point in same direction (toward mass)
  const mag1 = Math.sqrt(result1[0]**2 + result1[1]**2 + result1[2]**2);
  const mag2 = Math.sqrt(result2[0]**2 + result2[1]**2 + result2[2]**2);
  
  assert.ok(mag1 > 0, 'Small theta should produce force');
  assert.ok(mag2 > 0, 'Large theta should produce force');
  
  disposeKernel(kernel1);
  disposeKernel(kernel2);
  resetGL();
});

/**
 * Test 4: Gravity strength scaling
 */
test('KTraversal: gravity strength scaling', async () => {
  const gl = getGL();
  
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  // Octree with mass at corner
  const octreeA0 = fillVoxelTexture(gl, gridSize, slicesPerRow, (vx, vy, vz) => {
    if (vx === 3 && vy === 3 && vz === 3) {
      return [1.5, 1.5, 1.5, 1.0]; // mass at (1.5, 1.5, 1.5)
    }
    return [0, 0, 0, 0];
  });
  
  const outForce1 = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  const outForce2 = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  // Weak gravity
  const kernel1 = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    outForce: outForce1,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 0.1,
    softening: 0.1
  });
  
  kernel1.run();
  const result1 = readTexture(gl, outForce1, particleTexWidth, particleTexHeight);
  
  // Strong gravity (10x)
  const kernel2 = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    outForce: outForce2,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 1.0,
    softening: 0.1
  });
  
  kernel2.run();
  const result2 = readTexture(gl, outForce2, particleTexWidth, particleTexHeight);
  
  const mag1 = Math.sqrt(result1[0]**2 + result1[1]**2 + result1[2]**2);
  const mag2 = Math.sqrt(result2[0]**2 + result2[1]**2 + result2[2]**2);
  
  // Strong gravity should produce 10x force
  assertClose(mag2 / mag1, 10.0, 0.5, 'Force should scale with gravity strength');
  
  disposeKernel(kernel1);
  disposeKernel(kernel2);
  resetGL();
});

/**
 * Test 5: Softening parameter - prevents singularities
 */
test('KTraversal: softening prevents singularities', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  // Two particles very close together
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    0.01, 0.0, 0.0, 1.0
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
    disableFloatBlend: true
  });
  
  aggregator.run();
  
  const outForce1 = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  const outForce2 = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  // Small softening
  const kernel1 = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    outForce: outForce1,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 1.0,
    softening: 0.01
  });
  
  kernel1.run();
  const result1 = readTexture(gl, outForce1, particleTexWidth, particleTexHeight);
  
  // Large softening
  const kernel2 = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    outForce: outForce2,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 1.0,
    softening: 0.5
  });
  
  kernel2.run();
  const result2 = readTexture(gl, outForce2, particleTexWidth, particleTexHeight);
  
  assertAllFinite(result1, 'Small softening must be finite');
  assertAllFinite(result2, 'Large softening must be finite');
  
  const mag1 = Math.sqrt(result1[0]**2 + result1[1]**2 + result1[2]**2);
  const mag2 = Math.sqrt(result2[0]**2 + result2[1]**2 + result2[2]**2);
  
  // Larger softening should reduce force magnitude
  assert.ok(mag2 < mag1, 'Larger softening should reduce force');
  
  disposeKernel(kernel1);
  disposeKernel(kernel2);
  disposeKernel(aggregator);
  resetGL();
});

/**
 * Test 6: Zero mass in octree - no force
 */
test('KTraversal: zero mass octree', async () => {
  const gl = getGL();
  
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  const posData = new Float32Array([
    1.0, 1.0, 1.0, 1.0,
    -1.0, -1.0, -1.0, 1.0,
    0.5, 0.5, 0.5, 2.0,
    -0.5, -0.5, -0.5, 0.5
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  // Empty octree
  const octreeA0 = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0],
    outForce,
    particleTexWidth,
    particleTexHeight,
    numLevels: 1,
    levelConfigs: [{ size: octreeSize, gridSize, slicesPerRow }],
    worldBounds,
    theta: 0.5,
    gravityStrength: 1.0,
    softening: 0.1
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // All forces should be zero (no mass in octree)
  for (let i = 0; i < result.length; i += 4) {
    assertClose(result[i + 0], 0.0, 1e-5, `Particle ${i/4} force x`);
    assertClose(result[i + 1], 0.0, 1e-5, `Particle ${i/4} force y`);
    assertClose(result[i + 2], 0.0, 1e-5, `Particle ${i/4} force z`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 7: Multi-level octree traversal
 */
test('KTraversal: multi-level octree', async () => {
  const gl = getGL();
  
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  // Create two octree levels
  const gridSize0 = 4;
  const slicesPerRow0 = 2;
  const octreeSize0 = gridSize0 * slicesPerRow0;
  
  const gridSize1 = 2;
  const slicesPerRow1 = 1;
  const octreeSize1 = gridSize1 * slicesPerRow1;
  
  // L0: fine level with mass distributed
  const octreeA0_L0 = fillVoxelTexture(gl, gridSize0, slicesPerRow0, (vx, vy, vz) => {
    if ((vx + vy + vz) % 2 === 0) {
      return [0.25, 0.25, 0.25, 0.25];
    }
    return [0, 0, 0, 0];
  });
  
  // L1: coarse level (top of tree)
  const octreeA0_L1 = fillVoxelTexture(gl, gridSize1, slicesPerRow1, (vx, vy, vz) => {
    return [1.0, 1.0, 1.0, 1.0];
  });
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [octreeA0_L0, octreeA0_L1],
    outForce,
    particleTexWidth,
    particleTexHeight,
    numLevels: 2,
    levelConfigs: [
      { size: octreeSize0, gridSize: gridSize0, slicesPerRow: slicesPerRow0 },
      { size: octreeSize1, gridSize: gridSize1, slicesPerRow: slicesPerRow1 }
    ],
    worldBounds,
    theta: 0.5,
    gravityStrength: 1.0,
    softening: 0.1
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  assertAllFinite(result, 'Multi-level force must be finite');
  
  // Should produce some force from distributed mass
  const mag = Math.sqrt(result[0]**2 + result[1]**2 + result[2]**2);
  assert.ok(mag > 0, 'Multi-level should produce force');
  
  disposeKernel(kernel);
  resetGL();
});
