// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KForceSample } from './k-force-sample.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: fill a 3D voxel texture laid out in 2D slices
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
 * Test 1: Zero force grid produces zero particle forces
 */
test('KForceSample: zero force grid', async () => {
  const gl = getGL();
  
  const particleCount = 4;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Create particles at various positions
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    1.0, 1.0, 1.0, 1.0,
    -1.0, -1.0, -1.0, 1.0,
    0.5, 0.5, 0.5, 1.0
  ]);
  const inPosition = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create zero force grids
  const inForceGridX = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  const inForceGridY = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  const inForceGridZ = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KForceSample({
    gl,
    inPosition,
    inForceGridX,
    inForceGridY,
    inForceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    accumulate: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // All forces should be zero
  for (let i = 0; i < particleCount; i++) {
    const fx = result[i * 4 + 0];
    const fy = result[i * 4 + 1];
    const fz = result[i * 4 + 2];
    
    assertClose(fx, 0.0, 1e-5, `Particle ${i} force X should be zero`);
    assertClose(fy, 0.0, 1e-5, `Particle ${i} force Y should be zero`);
    assertClose(fz, 0.0, 1e-5, `Particle ${i} force Z should be zero`);
  }
  
  assertAllFinite(result, 'All forces should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPosition);
  gl.deleteTexture(inForceGridX);
  gl.deleteTexture(inForceGridY);
  gl.deleteTexture(inForceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});

/**
 * Test 2: Uniform force field
 */
test('KForceSample: uniform force field', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Create particles at different positions
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    1.0, 0.0, 0.0, 1.0,
    0.0, 1.0, 0.0, 1.0,
    0.0, 0.0, 0.0, 0.0  // unused
  ]);
  const inPosition = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  // Create uniform force grids (constant values everywhere)
  const uniformForceX = 2.0;
  const uniformForceY = -1.5;
  const uniformForceZ = 3.0;
  
  const inForceGridX = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [uniformForceX, 0, 0, 0]);
  const inForceGridY = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [uniformForceY, 0, 0, 0]);
  const inForceGridZ = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [uniformForceZ, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KForceSample({
    gl,
    inPosition,
    inForceGridX,
    inForceGridY,
    inForceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    accumulate: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // All particles should experience the same uniform force
  for (let i = 0; i < particleCount; i++) {
    const fx = result[i * 4 + 0];
    const fy = result[i * 4 + 1];
    const fz = result[i * 4 + 2];
    
    assertClose(fx, uniformForceX, 0.1, `Particle ${i} force X should match uniform field`);
    assertClose(fy, uniformForceY, 0.1, `Particle ${i} force Y should match uniform field`);
    assertClose(fz, uniformForceZ, 0.1, `Particle ${i} force Z should match uniform field`);
  }
  
  assertAllFinite(result, 'All forces should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPosition);
  gl.deleteTexture(inForceGridX);
  gl.deleteTexture(inForceGridY);
  gl.deleteTexture(inForceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});

/**
 * Test 3: Linear force gradient
 * Force field increases linearly with position
 */
test('KForceSample: linear force gradient', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Create particles at known positions
  const posData = new Float32Array([
    -1.0, 0.0, 0.0, 1.0,  // left
    0.0, 0.0, 0.0, 1.0,   // center
    1.0, 0.0, 0.0, 1.0,   // right
    0.0, 0.0, 0.0, 0.0    // unused
  ]);
  const inPosition = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  // Create force grid with linear gradient in X direction
  // Force increases from left to right
  const inForceGridX = fillVoxelTexture(gl, gridSize, slicesPerRow, (vx, vy, vz) => {
    const force = vx; // 0, 1, 2, 3
    return [force, 0, 0, 0];
  });
  const inForceGridY = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  const inForceGridZ = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KForceSample({
    gl,
    inPosition,
    inForceGridX,
    inForceGridY,
    inForceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    accumulate: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // Forces should increase from left to right
  const forceLeft = result[0 * 4 + 0];
  const forceCenter = result[1 * 4 + 0];
  const forceRight = result[2 * 4 + 0];
  
  assert.ok(forceLeft < forceCenter, 'Force at left should be less than center');
  assert.ok(forceCenter < forceRight, 'Force at center should be less than right');
  
  assertAllFinite(result, 'All forces should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPosition);
  gl.deleteTexture(inForceGridX);
  gl.deleteTexture(inForceGridY);
  gl.deleteTexture(inForceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});

/**
 * Test 4: Particle at voxel center
 */
test('KForceSample: particle at voxel center', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle exactly at center of a voxel
  // For 4×4×4 grid in [-2,2] world, voxel centers are at -1.5, -0.5, 0.5, 1.5
  const posData = new Float32Array([0.5, 0.5, 0.5, 1.0]);
  const inPosition = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  // Create force grid with unique value at voxel (2,2,2)
  const targetForce = 5.0;
  const inForceGridX = fillVoxelTexture(gl, gridSize, slicesPerRow, (vx, vy, vz) => {
    if (vx === 2 && vy === 2 && vz === 2) return [targetForce, 0, 0, 0];
    return [0, 0, 0, 0];
  });
  const inForceGridY = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  const inForceGridZ = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KForceSample({
    gl,
    inPosition,
    inForceGridX,
    inForceGridY,
    inForceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    accumulate: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // Should sample the target voxel's value (with some interpolation)
  const fx = result[0];
  assert.ok(Math.abs(fx - targetForce) < 1.0, 'Force should be close to target voxel value');
  
  assertAllFinite(result, 'Force should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPosition);
  gl.deleteTexture(inForceGridX);
  gl.deleteTexture(inForceGridY);
  gl.deleteTexture(inForceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});

/**
 * Test 5: Accumulate mode
 */
test('KForceSample: accumulate mode', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    1.0, 1.0, 1.0, 1.0
  ]);
  const inPosition = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  const forceValue = 2.0;
  const inForceGridX = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [forceValue, 0, 0, 0]);
  const inForceGridY = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  const inForceGridZ = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  
  // Pre-fill output with initial values
  const initialForce = 1.0;
  const initialData = new Float32Array([
    initialForce, 0, 0, 0,
    initialForce, 0, 0, 0
  ]);
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, initialData);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KForceSample({
    gl,
    inPosition,
    inForceGridX,
    inForceGridY,
    inForceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    accumulate: true  // Enable accumulation
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // Forces should be accumulated (initial + sampled)
  for (let i = 0; i < particleCount; i++) {
    const fx = result[i * 4 + 0];
    const expected = initialForce + forceValue;
    assertClose(fx, expected, 0.5, `Particle ${i} should have accumulated force`);
  }
  
  assertAllFinite(result, 'Accumulated forces should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPosition);
  gl.deleteTexture(inForceGridX);
  gl.deleteTexture(inForceGridY);
  gl.deleteTexture(inForceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});

/**
 * Test 6: Out of bounds particles
 */
test('KForceSample: out of bounds particles', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Place particles: one in bounds, two out of bounds
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,     // in bounds
    10.0, 10.0, 10.0, 1.0,  // far out of bounds
    -10.0, -10.0, -10.0, 1.0, // far out of bounds
    0.0, 0.0, 0.0, 0.0      // unused
  ]);
  const inPosition = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  const inForceGridX = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [1.0, 0, 0, 0]);
  const inForceGridY = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  const inForceGridZ = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KForceSample({
    gl,
    inPosition,
    inForceGridX,
    inForceGridY,
    inForceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    accumulate: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // Out of bounds particles should be clamped to edge values
  // All should have finite forces (clamped to edge voxels)
  assertAllFinite(result, 'All forces should be finite even for out-of-bounds particles');
  
  // In-bounds particle should have the expected force
  const fx0 = result[0 * 4 + 0];
  assertClose(fx0, 1.0, 0.5, 'In-bounds particle should sample force correctly');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPosition);
  gl.deleteTexture(inForceGridX);
  gl.deleteTexture(inForceGridY);
  gl.deleteTexture(inForceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});

/**
 * Test 7: Multi-component force (X, Y, Z)
 */
test('KForceSample: multi-component force sampling', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const inPosition = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  // Create different force values for each component
  const forceX = 3.0;
  const forceY = -2.0;
  const forceZ = 4.5;
  
  const inForceGridX = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [forceX, 0, 0, 0]);
  const inForceGridY = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [forceY, 0, 0, 0]);
  const inForceGridZ = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [forceZ, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KForceSample({
    gl,
    inPosition,
    inForceGridX,
    inForceGridY,
    inForceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    accumulate: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // Check all three force components
  const fx = result[0];
  const fy = result[1];
  const fz = result[2];
  
  assertClose(fx, forceX, 0.5, 'Force X component should match');
  assertClose(fy, forceY, 0.5, 'Force Y component should match');
  assertClose(fz, forceZ, 0.5, 'Force Z component should match');
  
  assertAllFinite(result, 'All force components should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPosition);
  gl.deleteTexture(inForceGridX);
  gl.deleteTexture(inForceGridY);
  gl.deleteTexture(inForceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});

/**
 * Test 8: Many particles
 */
test('KForceSample: many particles stress test', async () => {
  const gl = getGL();
  
  const particleCount = 64;
  const particleTexWidth = 8;
  const particleTexHeight = 8;
  
  // Create particles in a grid pattern
  const posData = new Float32Array(particleTexWidth * particleTexHeight * 4);
  for (let i = 0; i < particleCount; i++) {
    const x = ((i % 8) / 4) - 1; // -1 to 1
    const y = (Math.floor(i / 8) / 4) - 1;
    const z = 0;
    posData[i * 4 + 0] = x;
    posData[i * 4 + 1] = y;
    posData[i * 4 + 2] = z;
    posData[i * 4 + 3] = 1.0;
  }
  const inPosition = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 8;
  const slicesPerRow = 4;
  
  const inForceGridX = fillVoxelTexture(gl, gridSize, slicesPerRow, (vx) => [vx * 0.1, 0, 0, 0]);
  const inForceGridY = fillVoxelTexture(gl, gridSize, slicesPerRow, (vx, vy) => [vy * 0.1, 0, 0, 0]);
  const inForceGridZ = fillVoxelTexture(gl, gridSize, slicesPerRow, () => [0, 0, 0, 0]);
  
  const outForce = createTestTexture(gl, particleTexWidth, particleTexHeight, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KForceSample({
    gl,
    inPosition,
    inForceGridX,
    inForceGridY,
    inForceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    accumulate: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  
  // Check that all forces are finite
  assertAllFinite(result, 'All forces should be finite for many particles');
  
  // Check that forces vary (not all the same)
  const forces = [];
  for (let i = 0; i < particleCount; i++) {
    const fx = result[i * 4 + 0];
    forces.push(fx);
  }
  
  const minForce = Math.min(...forces);
  const maxForce = Math.max(...forces);
  assert.ok(maxForce > minForce, 'Forces should vary across particles');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPosition);
  gl.deleteTexture(inForceGridX);
  gl.deleteTexture(inForceGridY);
  gl.deleteTexture(inForceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});
