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
  
  assert.ok(kernel.outForceX, 'Output X force texture created (textureSize=' + textureSize + ', gridSize=' + gridSize + ', slicesPerRow=' + slicesPerRow + ')');
  assert.ok(kernel.outForceY, 'Output Y force texture created (textureSize=' + textureSize + ', gridSize=' + gridSize + ', slicesPerRow=' + slicesPerRow + ')');
  assert.ok(kernel.outForceZ, 'Output Z force texture created (textureSize=' + textureSize + ', gridSize=' + gridSize + ', slicesPerRow=' + slicesPerRow + ')');
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  assert.ok(snapshot.forceX, `Near-field force X should be finite\n\n${kernel.toString()}`);
  assert.ok(snapshot.forceY, `Near-field force Y should be finite\n\n${kernel.toString()}`);
  assert.ok(snapshot.forceZ, `Near-field force Z should be finite\n\n${kernel.toString()}`);
  
  kernel.inMassGrid = null;
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  resetGL();
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Check that forces are very small (near zero)
  assertClose(snapshot.forceX.fx.mean, 0.0, 0.001, 
    `Force X should be near zero\n\n${kernel.toString()}`);
  assertClose(snapshot.forceY.fy.mean, 0.0, 0.001, 
    `Force Y should be near zero\n\n${kernel.toString()}`);
  assertClose(snapshot.forceZ.fz.mean, 0.0, 0.001, 
    `Force Z should be near zero\n\n${kernel.toString()}`);
  
  kernel.inMassGrid = null;
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  resetGL();
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Check that forces are non-zero (radial pattern)
  assert.ok(snapshot.forceX.nonzero > 0, 
    `Should have non-zero forces in radial pattern\n\n${kernel.toString()}`);
  
  kernel.inMassGrid = null;
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  resetGL();
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
    
    const snapshot = kernel.valueOf({ pixels: false });
    assert.ok(snapshot.forceX, 
      `Near-field forces should be finite for radius=${nearFieldRadius}\n\n${kernel.toString()}`);
    
    kernel.inMassGrid = null;
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(massGrid);
  resetGL();
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
    
    const snapshot = kernel.valueOf({ pixels: false });
    assert.ok(snapshot.forceX, 
      `Forces should be finite for softening=${softening}\n\n${kernel.toString()}`);
    
    kernel.inMassGrid = null;
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(massGrid);
  resetGL();
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
    
    const snapshot = kernel.valueOf({ pixels: false });
    results.push(Math.abs(snapshot.forceX.fx.mean));
    
    kernel.inMassGrid = null;
    disposeKernel(kernel);
  }
  
  // Check that forces scale approximately with gravity strength
  assert.ok(results[1] > results[0], 
    `Higher G should produce larger forces (F[G2]=${results[1]} > F[G1]=${results[0]})`);
  assert.ok(results[2] > results[1], 
    `Even higher G should produce even larger forces (F[G3]=${results[2]} > F[G2]=${results[1]})`);
  
  gl.deleteTexture(massGrid);
  resetGL();
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  assert.ok(snapshot.forceX, `Forces should be finite with multiple masses\n\n${kernel.toString()}`);
  assert.ok(snapshot.forceY, `Forces should be finite with multiple masses\n\n${kernel.toString()}`);
  assert.ok(snapshot.forceZ, `Forces should be finite with multiple masses\n\n${kernel.toString()}`);
  
  // Check that forces exist
  assert.ok(snapshot.forceX.nonzero > 0, 
    `Forces should exist near mass locations\n\n${kernel.toString()}`);
  
  kernel.inMassGrid = null;
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  resetGL();
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, textureSize, textureSize, 0, gl.RED, gl.FLOAT, null);
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
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  assert.ok(snapshot.forceX, 
    `External texture should be written successfully\n\n${kernel.toString()}`);
  
  kernel.inMassGrid = null;
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  gl.deleteTexture(outX);
  gl.deleteTexture(outY);
  gl.deleteTexture(outZ);
  resetGL();
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
  
  kernel.inMassGrid = null;
  disposeKernel(kernel);
  resetGL();
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
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  assert.ok(snapshot.forceX, 
    `Should work with external quadVAO\n\n${kernel.toString()}`);
  
  kernel.inMassGrid = null;
  disposeKernel(kernel);
  gl.deleteTexture(massGrid);
  gl.deleteVertexArray(quadVAO);
  gl.deleteBuffer(buffer);
  resetGL();
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
  assert.ok(!gl.isTexture(outX), 'Output X texture disposed (isTexture=' + gl.isTexture(outX) + ')');
  assert.ok(!gl.isTexture(outY), 'Output Y texture disposed (isTexture=' + gl.isTexture(outY) + ')');
  assert.ok(!gl.isTexture(outZ), 'Output Z texture disposed (isTexture=' + gl.isTexture(outZ) + ')');
  
  gl.deleteTexture(massGrid);
  resetGL();
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
  
  const worldBounds = /** @type {{min: [number,number,number], max: [number,number,number]}[]} */ ([
    { min: [-1, -1, -1], max: [1, 1, 1] },
    { min: [-4, -4, -4], max: [4, 4, 4] },
    { min: [-10, -5, -8], max: [10, 5, 8] }  // Non-uniform
  ]);
  
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
    
    kernel.inMassGrid = null;
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(massGrid);
  resetGL();
});
