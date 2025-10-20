// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KDeposit } from './k-deposit.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: read a specific voxel from a 3D texture laid out in 2D slices
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
 * Test 1: Single particle NGP deposit
 * One particle at known position should deposit correctly into one voxel.
 */
test('KDeposit: single particle NGP deposit', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle at (0, 0, 0) in world space with mass 1.0
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]); // x, y, z, mass
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow; // 8×8
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    assignment: 'ngp'
  });
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // Particle at (0,0,0) should map to center voxel (2,2,2) in 4³ grid
  // Grid spans [-2,2] in each dimension, so 0 is at center
  const centerVoxel = readVoxel(outData, 2, 2, 2, gridSize, slicesPerRow);
  
  assertClose(centerVoxel[3], 1.0, 0.01, 'Mass deposited to center voxel');
  
  // Check that only one voxel has mass
  let totalMass = 0;
  for (let vz = 0; vz < gridSize; vz++) {
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
        totalMass += voxel[3];
      }
    }
  }
  
  assertClose(totalMass, 1.0, 0.01, 'Total mass conserved');
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL(gl);
});

/**
 * Test 2: Multiple particles NGP deposit
 */
test('KDeposit: multiple particles NGP deposit', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Three particles at different positions
  const posData = new Float32Array([
    -1.0, -1.0, -1.0, 0.5,  // Particle 0
    0.0, 0.0, 0.0, 1.0,     // Particle 1
    1.0, 1.0, 1.0, 0.8,     // Particle 2
    0.0, 0.0, 0.0, 0.0      // Padding
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    assignment: 'ngp'
  });
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // Check total mass conservation
  let totalMass = 0;
  for (let vz = 0; vz < gridSize; vz++) {
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
        totalMass += voxel[3];
      }
    }
  }
  
  const expectedMass = 0.5 + 1.0 + 0.8;
  assertClose(totalMass, expectedMass, 0.01, 'Total mass conserved');
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL(gl);
});

/**
 * Test 3: CIC deposit with single particle
 */
test('KDeposit: single particle CIC deposit', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle slightly off-center to test CIC interpolation
  const posData = new Float32Array([0.25, 0.25, 0.25, 1.0]); // x, y, z, mass
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    assignment: 'cic'
  });
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // CIC should distribute mass to 8 neighboring voxels
  // Check that total mass is conserved
  let totalMass = 0;
  for (let vz = 0; vz < gridSize; vz++) {
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
        totalMass += voxel[3];
      }
    }
  }
  
  assertClose(totalMass, 1.0, 0.01, 'Total mass conserved with CIC');
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL(gl);
});

/**
 * Test 4: Output texture creation
 */
test('KDeposit: creates output texture when not provided', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize: 4,
    slicesPerRow: 2,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    assignment: 'ngp'
  });
  
  assert.ok(kernel.outGrid, 'Output texture created');
  assert.ok(kernel.ownsOutGrid, 'Kernel owns output texture');
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outGrid, 8, 8);
  assertAllFinite(outData, 'Output data is finite');
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL(gl);
});
