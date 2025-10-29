// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';

import { assertAllFinite, assertClose, createTestTexture, disposeKernel, getGL, readTexture, resetGL } from '../test-utils.js';
import { KDeposit } from './k-deposit.js';

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
  const particleTextureWidth = 1;
  const particleTextureHeight = 1;

  // Place particle at (0, 0, 0) in world space
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]); // x, y, z, mass
  const posTex = createTestTexture(gl, particleTextureWidth, particleTextureHeight, posData);

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
    particleTextureWidth,
    particleTextureHeight,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds,
    assignment: 'NGP'
  });

  const before = kernel.toString();

  // Run the kernel
  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // For NGP, the entire mass should be deposited (check total mass)
  const totalMass = snapshot.massGrid.mass.mean * gridSize ** 3;
  assertClose(totalMass, 1.0, 0.1,
    `Total mass should be 1.0 (got ${totalMass})

BEFORE: ${before}
AFTER: ${kernel}
`);

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
  const particleTextureWidth = 2;
  const particleTextureHeight = 2;

  // Three particles at different locations
  const posData = new Float32Array([
    -1.0, -1.0, -1.0, 1.0,  // particle 0
    1.0, 1.0, 1.0, 1.0,  // particle 1
    0.0, 0.0, 0.0, 2.0,  // particle 2 (double mass)
    0.0, 0.0, 0.0, 0.0   // padding
  ]);
  const posTex = createTestTexture(gl, particleTextureWidth, particleTextureHeight, posData);

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
    particleTextureWidth,
    particleTextureHeight,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds,
    assignment: 'NGP'
  });

  // Run the kernel
  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // Check total mass (1 + 1 + 2 = 4.0)
  const totalMass = snapshot.massGrid.mass.mean * gridSize ** 3;
  assertClose(totalMass, 4.0, 0.2,
    `Total mass should be 4.0 (got ${totalMass})\n\n${kernel.toString()}`);

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
  const particleTextureWidth = 1;
  const particleTextureHeight = 1;

  // Place particle at center
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTextureWidth, particleTextureHeight, posData);

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
    particleTextureWidth,
    particleTextureHeight,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds,
    assignment: 'CIC'
  });

  // Run the kernel
  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // For CIC, mass should be distributed across 8 voxels but total mass conserved
  const totalMass = snapshot.massGrid.mass.mean * gridSize ** 3;
  assertClose(totalMass, 1.0, 0.1,
    `Total mass should be conserved (got ${totalMass})\n\n${kernel.toString()}`);

  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  gl.deleteTexture(outMassGrid);
});
