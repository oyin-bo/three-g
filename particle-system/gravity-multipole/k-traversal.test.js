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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Force should be zero (no other mass)
  assertClose(snapshot.force.fx.mean, 0.0, 1e-5, 
    `Force x should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.fy.mean, 0.0, 1e-5, 
    `Force y should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.fz.mean, 0.0, 1e-5, 
    `Force z should be zero\n\n${kernel.toString()}`);
  
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
  
  const aggregator = new KAggregator({
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
  
  //  Read octree to check aggregation results
  const octreeCheck = readTexture(gl, aggregator.outA0, octreeSize, octreeSize);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const kernel = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [aggregator.outA0],
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Particle 0 at (-1,0,0) should feel force toward particle 1 at (1,0,0)
  // Force should be in +x direction
  assert.ok(snapshot.force?.fx.mean > 0, 
    `Force on particle 0 should be in +x direction (mean=${snapshot.force?.fx.mean})\n\n${kernel.toString()}`);
  assertClose(snapshot.force.fy.mean, 0.0, 1e-3, 
    `Force y should be near zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.fz.mean, 0.0, 1e-3, 
    `Force z should be near zero\n\n${kernel.toString()}`);
  
  // Read raw texture for Newton's third law check (need individual particle forces)
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // Particle 1 should feel opposite force
  assert.ok(result[4] < 0, 
    `Force on particle 1 should be in -x direction (Fx1=${result[4]})\n\n${kernel.toString()}`);
  
  // Forces should be roughly equal magnitude (Newton's third law)
  assertClose(Math.abs(result[0]), Math.abs(result[4]), 1e-2, 
    `Forces should have equal magnitude\n\n${kernel.toString()}`);
  
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
  const snap1 = kernel1.valueOf({ pixels: false });
  
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
  const snap2 = kernel2.valueOf({ pixels: false });
  
  // Both should point in same direction (toward mass)
  const mag1 = snap1.totalForce;
  const mag2 = snap2.totalForce;
  
  assert.ok(mag1 > 0, 
    `Small theta should produce force (|F|=${mag1})\n\n${kernel1.toString()}`);
  assert.ok(mag2 > 0, 
    `Large theta should produce force (|F|=${mag2})\n\n${kernel2.toString()}`);
  
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
  const snap1 = kernel1.valueOf({ pixels: false });
  
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
  const snap2 = kernel2.valueOf({ pixels: false });
  
  const mag1 = snap1.totalForce;
  const mag2 = snap2.totalForce;
  
  // Strong gravity should produce 10x force
  assertClose(mag2 / mag1, 10.0, 0.5, 
    `Force should scale with gravity strength (mag1=${mag1}, mag2=${mag2})\n\nWeak gravity:\n${kernel1.toString()}\n\nStrong gravity:\n${kernel2.toString()}`);
  
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
  
  const aggregator = new KAggregator({
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
  
  const outForce1 = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  const outForce2 = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  // Small softening
  const kernel1 = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [aggregator.outA0],
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
  const snap1 = kernel1.valueOf({ pixels: false });
  
  // Large softening
  const kernel2 = new KTraversal({
    gl,
    inPosition: posTex,
    inLevelA0: [aggregator.outA0],
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
  const snap2 = kernel2.valueOf({ pixels: false });
  
  const mag1 = snap1.totalForce;
  const mag2 = snap2.totalForce;
  
  // Larger softening should reduce force magnitude
  assert.ok(mag2 < mag1, 
    `Larger softening should reduce force (|F_large|=${mag2} < |F_small|=${mag1})\n\nSmall softening:\n${kernel1.toString()}\n\nLarge softening:\n${kernel2.toString()}`);
  
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // All forces should be zero (no mass in octree)
  assertClose(snapshot.force.fx.mean, 0.0, 1e-5, 
    `Force x should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.fy.mean, 0.0, 1e-5, 
    `Force y should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.fz.mean, 0.0, 1e-5, 
    `Force z should be zero\n\n${kernel.toString()}`);
  
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Should produce some force from distributed mass
  const mag = snapshot.totalForce;
  assert.ok(mag > 0, 
    `Multi-level should produce force (|F|=${mag})\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});
