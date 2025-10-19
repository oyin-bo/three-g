// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KDeposit } from './k-deposit.js';
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
 * Test 1: Single particle deposition
 */
test('KDeposit: single particle deposition', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle at (0, 0, 0) in world space
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]); // x, y, z, mass
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow; // 8×8
  
  const outMassGrid = createTestTexture(gl, textureSize, textureSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    outMassGrid,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds,
    assignment: 'NGP'
  });
  
  // Run the kernel
  kernel.run();
  
  // Read back results
  const result = readTexture(gl, outMassGrid, textureSize, textureSize);
  
  // Check that particle was deposited at center voxel (2, 2, 2)
  const centerVoxel = readVoxel(result, 2, 2, 2, gridSize, slicesPerRow);
  
  // For NGP, the entire mass should be in one voxel
  assertClose(centerVoxel[0], 1.0, 0.01, 'Center voxel should have mass 1.0');
  
  // Check that result is finite
  assertAllFinite(result, 'All mass values should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  gl.deleteTexture(outMassGrid);
});

/**
 * Test 2: Multiple particles at different positions
 */
test('KDeposit: multiple particles', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Three particles at different locations
  const posData = new Float32Array([
    -1.0, -1.0, -1.0, 1.0,  // particle 0
     1.0,  1.0,  1.0, 1.0,  // particle 1
     0.0,  0.0,  0.0, 2.0,  // particle 2 (double mass)
     0.0,  0.0,  0.0, 0.0   // padding
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const outMassGrid = createTestTexture(gl, textureSize, textureSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    outMassGrid,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds,
    assignment: 'NGP'
  });
  
  // Run the kernel
  kernel.run();
  
  // Read back results
  const result = readTexture(gl, outMassGrid, textureSize, textureSize);
  
  // Check total mass
  let totalMass = 0;
  for (let i = 0; i < result.length; i += 4) {
    totalMass += result[i];
  }
  
  assertClose(totalMass, 4.0, 0.1, 'Total mass should be 4.0 (1 + 1 + 2)');
  
  // Check that result is finite
  assertAllFinite(result, 'All mass values should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  gl.deleteTexture(outMassGrid);
});

/**
 * Test 3: CIC assignment scheme
 */
test('KDeposit: CIC assignment', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle at center
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const outMassGrid = createTestTexture(gl, textureSize, textureSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    outMassGrid,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds,
    assignment: 'CIC'
  });
  
  // Run the kernel
  kernel.run();
  
  // Read back results
  const result = readTexture(gl, outMassGrid, textureSize, textureSize);
  
  // For CIC, mass should be distributed across 8 voxels
  // Check total mass
  let totalMass = 0;
  for (let i = 0; i < result.length; i += 4) {
    totalMass += result[i];
  }
  
  assertClose(totalMass, 1.0, 0.1, 'Total mass should be conserved (1.0)');
  
  // Check that result is finite
  assertAllFinite(result, 'All mass values should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  gl.deleteTexture(outMassGrid);
});
