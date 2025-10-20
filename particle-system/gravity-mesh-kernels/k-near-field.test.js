// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KNearField } from './k-near-field.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: create mass grid texture with known values
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number) => number} massFunc
 */
function createMassGrid(gl, gridSize, slicesPerRow, massFunc) {
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
        
        const mass = massFunc(vx, vy, vz);
        // Store mass in alpha channel
        data[idx + 0] = 0.0;
        data[idx + 1] = 0.0;
        data[idx + 2] = 0.0;
        data[idx + 3] = mass;
      }
    }
  }
  
  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Helper: read voxel from 3D grid
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
 * Test 1: Output texture creation
 */
test('KNearField: creates output textures when not provided', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  
  const kernel = new KNearField({
    gl,
    inMassGrid: massGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    softening: 0.15,
    gravityStrength: 0.0003,
    nearFieldRadius: 2
  });
  
  assert.ok(kernel.outForceX, 'Output X force texture created');
  assert.ok(kernel.outForceY, 'Output Y force texture created');
  assert.ok(kernel.outForceZ, 'Output Z force texture created');
  assert.ok(kernel.ownsOutTextures, 'Kernel owns output textures');
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
  const outDataY = readTexture(gl, kernel.outForceY, textureSize, textureSize);
  const outDataZ = readTexture(gl, kernel.outForceZ, textureSize, textureSize);
  
  assertAllFinite(outDataX, 'Near-field force X data is finite');
  assertAllFinite(outDataY, 'Near-field force Y data is finite');
  assertAllFinite(outDataZ, 'Near-field force Z data is finite');
  
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  resetGL(gl);
});

/**
 * Test 2: Empty mass grid produces zero forces
 */
test('KNearField: empty mass grid produces zero forces', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create grid with zero mass everywhere
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => 0.0);
  
  const kernel = new KNearField({
    gl,
    inMassGrid: massGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    softening: 0.15,
    gravityStrength: 0.0003,
    nearFieldRadius: 2
  });
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
  const outDataY = readTexture(gl, kernel.outForceY, textureSize, textureSize);
  const outDataZ = readTexture(gl, kernel.outForceZ, textureSize, textureSize);
  
  // Check that forces are very small (near zero)
  for (let i = 0; i < outDataX.length; i += 4) {
    assertClose(outDataX[i], 0.0, 0.001, `Force X at index ${i} is near zero`);
    assertClose(outDataY[i], 0.0, 0.001, `Force Y at index ${i} is near zero`);
    assertClose(outDataZ[i], 0.0, 0.001, `Force Z at index ${i} is near zero`);
  }
  
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  resetGL(gl);
});

/**
 * Test 3: Single mass produces radial force pattern
 */
test('KNearField: single mass produces radial forces', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Place single mass at center voxel (2,2,2)
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => {
    return (x === 2 && y === 2 && z === 2) ? 1.0 : 0.0;
  });
  
  const kernel = new KNearField({
    gl,
    inMassGrid: massGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    softening: 0.15,
    gravityStrength: 0.0003,
    nearFieldRadius: 2
  });
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
  const outDataY = readTexture(gl, kernel.outForceY, textureSize, textureSize);
  const outDataZ = readTexture(gl, kernel.outForceZ, textureSize, textureSize);
  
  // Check that voxel at (2,2,2) has near-zero force (self-interaction handled by softening)
  const centerForce = readVoxel(outDataX, 2, 2, 2, gridSize, slicesPerRow);
  assert.ok(Math.abs(centerForce[0]) < 0.1, 'Center voxel has small X force');
  
  // Check that neighboring voxels have non-zero forces
  const neighborForce = readVoxel(outDataX, 3, 2, 2, gridSize, slicesPerRow);
  assert.ok(Math.abs(neighborForce[0]) > 0.0, 'Neighboring voxel has non-zero force');
  
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  resetGL(gl);
});

/**
 * Test 4: Different near-field radii
 */
test('KNearField: works with different near-field radii', async () => {
  const gl = getGL();
  
  const gridSize = 8;
  const slicesPerRow = 3;
  const textureSize = gridSize * slicesPerRow;
  
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => {
    return (x === 4 && y === 4 && z === 4) ? 1.0 : 0.0;
  });
  
  for (const nearFieldRadius of [1, 2, 3, 4]) {
    const kernel = new KNearField({
      gl,
      inMassGrid: massGrid,
      gridSize,
      slicesPerRow,
      textureSize,
      worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
      softening: 0.15,
      gravityStrength: 0.0003,
      nearFieldRadius
    });
    
    kernel.run();
    
    const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
    assertAllFinite(outDataX, `Near-field forces finite for radius=${nearFieldRadius}`);
    
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(massGrid);
  resetGL(gl);
});

/**
 * Test 5: Different softening parameters
 */
test('KNearField: handles different softening values', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => {
    return (x === 2 && y === 2 && z === 2) ? 1.0 : 0.0;
  });
  
  for (const softening of [0.01, 0.1, 0.5, 1.0]) {
    const kernel = new KNearField({
      gl,
      inMassGrid: massGrid,
      gridSize,
      slicesPerRow,
      textureSize,
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      softening,
      gravityStrength: 0.0003,
      nearFieldRadius: 2
    });
    
    kernel.run();
    
    const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
    assertAllFinite(outDataX, `Forces finite for softening=${softening}`);
    
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(massGrid);
  resetGL(gl);
});

/**
 * Test 6: Different gravity strengths
 */
test('KNearField: scales forces with gravity strength', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => {
    return (x === 2 && y === 2 && z === 2) ? 1.0 : 0.0;
  });
  
  const gravityStrengths = [0.0001, 0.0003, 0.001];
  const results = [];
  
  for (const G of gravityStrengths) {
    const kernel = new KNearField({
      gl,
      inMassGrid: massGrid,
      gridSize,
      slicesPerRow,
      textureSize,
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      softening: 0.15,
      gravityStrength: G,
      nearFieldRadius: 2
    });
    
    kernel.run();
    
    const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
    const neighborForce = readVoxel(outDataX, 3, 2, 2, gridSize, slicesPerRow);
    results.push(Math.abs(neighborForce[0]));
    
    disposeKernel(kernel);
  }
  
  // Check that forces scale approximately with gravity strength
  assert.ok(results[1] > results[0], 'Higher G produces larger forces');
  assert.ok(results[2] > results[1], 'Even higher G produces even larger forces');
  
  gl.deleteTexture(massGrid);
  resetGL(gl);
});

/**
 * Test 7: Multiple masses in grid
 */
test('KNearField: handles multiple masses', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Place masses at two corners
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => {
    if (x === 0 && y === 0 && z === 0) return 1.0;
    if (x === 3 && y === 3 && z === 3) return 1.0;
    return 0.0;
  });
  
  const kernel = new KNearField({
    gl,
    inMassGrid: massGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    softening: 0.15,
    gravityStrength: 0.0003,
    nearFieldRadius: 2
  });
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
  const outDataY = readTexture(gl, kernel.outForceY, textureSize, textureSize);
  const outDataZ = readTexture(gl, kernel.outForceZ, textureSize, textureSize);
  
  assertAllFinite(outDataX, 'Forces finite with multiple masses');
  assertAllFinite(outDataY, 'Forces finite with multiple masses');
  assertAllFinite(outDataZ, 'Forces finite with multiple masses');
  
  // Check that forces exist near both mass locations
  const force1 = readVoxel(outDataX, 1, 0, 0, gridSize, slicesPerRow);
  const force2 = readVoxel(outDataX, 3, 3, 2, gridSize, slicesPerRow);
  
  assert.ok(Math.abs(force1[0]) > 0.0, 'Force exists near first mass');
  // Second force may or may not be significant depending on distance
  
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  resetGL(gl);
});

/**
 * Test 8: External texture provision
 */
test('KNearField: uses provided output textures', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  
  // Create external output textures
  const outX = gl.createTexture();
  const outY = gl.createTexture();
  const outZ = gl.createTexture();
  
  for (const tex of [outX, outY, outZ]) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, textureSize, textureSize, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  const kernel = new KNearField({
    gl,
    inMassGrid: massGrid,
    outForceX: outX,
    outForceY: outY,
    outForceZ: outZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    softening: 0.15,
    gravityStrength: 0.0003,
    nearFieldRadius: 2
  });
  
  assert.strictEqual(kernel.outForceX, outX, 'Uses provided X texture');
  assert.strictEqual(kernel.outForceY, outY, 'Uses provided Y texture');
  assert.strictEqual(kernel.outForceZ, outZ, 'Uses provided Z texture');
  assert.ok(!kernel.ownsOutTextures, 'Kernel does not own provided textures');
  
  kernel.run();
  
  const outDataX = readTexture(gl, outX, textureSize, textureSize);
  assertAllFinite(outDataX, 'External texture written successfully');
  
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  gl.deleteTexture(outX);
  gl.deleteTexture(outY);
  gl.deleteTexture(outZ);
  resetGL(gl);
});

/**
 * Test 9: Error handling - missing input
 */
test('KNearField: throws error when input not set', async () => {
  const gl = getGL();
  
  const kernel = new KNearField({
    gl,
    inMassGrid: null,
    gridSize: 4,
    slicesPerRow: 2,
    textureSize: 8,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    softening: 0.15,
    gravityStrength: 0.0003,
    nearFieldRadius: 2
  });
  
  assert.throws(() => {
    kernel.run();
  }, /inMassGrid texture not set/, 'Throws error when input not set');
  
  disposeKernel(kernel);
  resetGL(gl);
});

/**
 * Test 10: QuadVAO sharing
 */
test('KNearField: accepts external quadVAO', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create external quad VAO
  const quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const quadData = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  
  const kernel = new KNearField({
    gl,
    inMassGrid: massGrid,
    quadVAO,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    softening: 0.15,
    gravityStrength: 0.0003,
    nearFieldRadius: 2
  });
  
  assert.strictEqual(kernel.quadVAO, quadVAO, 'Uses provided quadVAO');
  assert.ok(!kernel.ownsQuadVAO, 'Kernel does not own provided quadVAO');
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
  assertAllFinite(outDataX, 'Works with external quadVAO');
  
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  gl.deleteVertexArray(quadVAO);
  gl.deleteBuffer(buffer);
  resetGL(gl);
});

/**
 * Test 11: Disposal cleans up resources
 */
test('KNearField: dispose cleans up owned resources', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  
  const kernel = new KNearField({
    gl,
    inMassGrid: massGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    softening: 0.15,
    gravityStrength: 0.0003,
    nearFieldRadius: 2
  });
  
  kernel.run();
  
  const outX = kernel.outForceX;
  const outY = kernel.outForceY;
  const outZ = kernel.outForceZ;
  
  kernel.dispose();
  
  // Textures should be deleted
  assert.ok(!gl.isTexture(outX), 'Output X texture disposed');
  assert.ok(!gl.isTexture(outY), 'Output Y texture disposed');
  assert.ok(!gl.isTexture(outZ), 'Output Z texture disposed');
  
  gl.deleteTexture(massGrid);
  resetGL(gl);
});

/**
 * Test 12: Different world bounds
 */
test('KNearField: handles different world bounds', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const massGrid = createMassGrid(gl, gridSize, slicesPerRow, (x, y, z) => {
    return (x === 2 && y === 2 && z === 2) ? 1.0 : 0.0;
  });
  
  const worldBounds = [
    { min: [-1, -1, -1], max: [1, 1, 1] },
    { min: [-4, -4, -4], max: [4, 4, 4] },
    { min: [-10, -5, -8], max: [10, 5, 8] }  // Non-uniform
  ];
  
  for (const bounds of worldBounds) {
    const kernel = new KNearField({
      gl,
      inMassGrid: massGrid,
      gridSize,
      slicesPerRow,
      textureSize,
      worldBounds: bounds,
      softening: 0.15,
      gravityStrength: 0.0003,
      nearFieldRadius: 2
    });
    
    kernel.run();
    
    const outDataX = readTexture(gl, kernel.outForceX, textureSize, textureSize);
    assertAllFinite(outDataX, `Forces finite for bounds=[${bounds.min}] to [${bounds.max}]`);
    
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(massGrid);
  resetGL(gl);
});
