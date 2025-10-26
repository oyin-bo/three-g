// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
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
 * Helper: read a specific voxel from a texture
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
 * Test 1: Single particle aggregation
 * One particle at known position should deposit correctly into one voxel.
 */
test('KAggregator: single particle aggregation', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle at (0, 0, 0) in world space
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]); // x, y, z, mass
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow; // 8×8
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: true // Use for single particle test
  });
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Particle at (0,0,0) world → center voxel (2,2,2) in 4×4×4 grid
  // A0 should contain: (mass*x, mass*y, mass*z, mass)
  // Check via statistics - center of mass should be at origin with mass 1.0
  assertClose(snapshot.a0.cx.mean, 0.0, 1e-4, 
    `Center of mass X should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.cy.mean, 0.0, 1e-4, 
    `Center of mass Y should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.cz.mean, 0.0, 1e-4, 
    `Center of mass Z should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.a0.mass.mean, 1.0 / (gridSize ** 3), 1e-4, 
    `Average mass per voxel (one particle in ${gridSize**3} voxels)\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Multiple particles in same voxel
 * Particles that map to the same voxel should accumulate via blending.
 */
test('KAggregator: multiple particles same voxel with blending', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Three particles all in center voxel [2,2,2] (world range [0,1])
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,  // particle 0 at center
    0.1, 0.1, 0.1, 2.0,  // particle 1 slightly offset
    0.2, 0.2, 0.2, 1.5,  // particle 2 further offset (still in [0,1])
    0.0, 0.0, 0.0, 0.0   // unused
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: false // Enable blending
  });
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Total mass = 1.0 + 2.0 + 1.5 = 4.5
  // Total mass*x = 0*1 + 0.1*2 + 0.2*1.5 = 0 + 0.2 + 0.3 = 0.5
  // Mean across all voxels
  const totalMassX = snapshot.a0.cx.mean * gridSize ** 3;
  const totalMass = snapshot.a0.mass.mean * gridSize ** 3;
  
  assertClose(totalMassX, 0.5, 0.1, 
    `Sum mass*x should be 0.5 (got ${totalMassX})\n\n${kernel.toString()}`);
  assertClose(totalMass, 4.5, 0.1, 
    `Sum mass should be 4.5 (got ${totalMass})\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Particles in different voxels
 * Particles at different positions should map to different voxels.
 */
test('KAggregator: particles in different voxels', async () => {
  const gl = getGL();
  
  const particleCount = 4;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Four particles at corners of world space
  const posData = new Float32Array([
    -1.5, -1.5, -1.5, 1.0,  // corner 0,0,0
    1.5, 1.5, 1.5, 1.0,     // corner 3,3,3
    -1.5, 1.5, -1.5, 1.0,   // corner 0,3,0
    1.5, -1.5, 1.5, 1.0     // corner 3,0,3
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
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
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // With 4 particles of mass 1.0 each in a 4×4×4 grid (64 voxels)
  // Total mass = 4.0, distributed across 4 voxels (the corners where particles are)
  // nonzero voxels should be 4, most voxels should be zero
  const totalMass = snapshot.a0.mass.mean * gridSize ** 3;
  
  assertClose(totalMass, 4.0, 0.1, 
    `Total mass should be 4.0 (got ${totalMass})\n\n${kernel.toString()}`);
  
  // Check that most voxels are zero (only 4 occupied out of 64)
  assert.ok(snapshot.a0.mass.nearMin_5pc > gridSize ** 3 * 0.8, 
    `Most voxels should be empty (near min: ${snapshot.a0.mass.nearMin_5pc})\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 4: Quadrupole moments (A1, A2)
 * Verify second moments are calculated correctly.
 */
test('KAggregator: quadrupole moments', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Particle at (1, 1, 1) with mass 2
  const posData = new Float32Array([1.0, 1.0, 1.0, 2.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
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
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Particle at (1, 1, 1) with mass 2
  // Single particle so mean = total values divided by number of voxels
  // A0: (m*x, m*y, m*z, m) total = (2, 2, 2, 2)
  const totalCX = snapshot.a0.cx.mean * gridSize ** 3;
  const totalCY = snapshot.a0.cy.mean * gridSize ** 3;
  const totalCZ = snapshot.a0.cz.mean * gridSize ** 3;
  const totalMass = snapshot.a0.mass.mean * gridSize ** 3;
  
  assertClose(totalCX, 2.0, 0.1, `Sum m*x should be 2.0\n\n${kernel.toString()}`);
  assertClose(totalCY, 2.0, 0.1, `Sum m*y should be 2.0\n\n${kernel.toString()}`);
  assertClose(totalCZ, 2.0, 0.1, `Sum m*z should be 2.0\n\n${kernel.toString()}`);
  assertClose(totalMass, 2.0, 0.1, `Sum mass should be 2.0\n\n${kernel.toString()}`);
  
  // Check quadrupole moments (A1, A2)
  // A1: (m*x², m*y², m*z², m*xy) total = (2, 2, 2, 2)
  const totalXX = snapshot.a1.xx.mean * gridSize ** 3;
  const totalYY = snapshot.a1.yy.mean * gridSize ** 3;
  const totalZZ = snapshot.a1.zz.mean * gridSize ** 3;
  const totalXY = snapshot.a1.xy.mean * gridSize ** 3;
  
  assertClose(totalXX, 2.0, 0.1, `Sum m*x² should be 2.0\n\n${kernel.toString()}`);
  assertClose(totalYY, 2.0, 0.1, `Sum m*y² should be 2.0\n\n${kernel.toString()}`);
  assertClose(totalZZ, 2.0, 0.1, `Sum m*z² should be 2.0\n\n${kernel.toString()}`);
  assertClose(totalXY, 2.0, 0.1, `Sum m*xy should be 2.0\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 5: Out of bounds particles
 * Particles outside world bounds should be clamped or ignored.
 */
test('KAggregator: out of bounds particles', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  // One particle in bounds, one way out of bounds
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,    // in bounds
    100.0, 100.0, 100.0, 1.0 // far out of bounds
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
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
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Total mass should be 2.0 (both particles contribute, clamped to bounds)
  const totalMass = snapshot.a0.mass.mean * gridSize ** 3;
  assertClose(totalMass, 2.0, 0.1, 
    `Both particles should contribute (got ${totalMass})\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 6: Zero mass particles
 * Particles with zero mass should not contribute.
 */
test('KAggregator: zero mass particles', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 0.0,   // zero mass
    1.0, 1.0, 1.0, 3.0    // normal mass
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
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
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Only the particle with mass 3.0 should contribute
  const totalMass = snapshot.a0.mass.mean * gridSize ** 3;
  assertClose(totalMass, 3.0, 0.1, 
    `Only non-zero mass particle should contribute (got ${totalMass})\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 7: Large particle count
 * Stress test with many particles.
 */
test('KAggregator: large particle count', async () => {
  const gl = getGL();
  
  const particleCount = 100;
  const particleTexWidth = 10;
  const particleTexHeight = 10;
  
  // Create 100 particles distributed in a grid pattern
  const posData = new Float32Array(particleTexWidth * particleTexHeight * 4);
  for (let i = 0; i < particleCount; i++) {
    const x = (i % 10) / 5 - 1; // -1 to 1
    const y = Math.floor(i / 10) / 5 - 1;
    const z = 0;
    posData[i * 4 + 0] = x;
    posData[i * 4 + 1] = y;
    posData[i * 4 + 2] = z;
    posData[i * 4 + 3] = 1.0; // unit mass
  }
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 8;
  const slicesPerRow = 4;
  const octreeSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
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
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Count total mass in all voxels (should equal particle count, each has mass 1)
  const totalMass = snapshot.a0.mass.mean * gridSize ** 3;
  assertClose(totalMass, particleCount, 1e-1, 
    `Total mass should equal particle count ${particleCount} (got ${totalMass})\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});
