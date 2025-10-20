// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KGradient } from './k-gradient.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: create a test potential spectrum texture with known values
 * @param {WebGL2RenderingContext} gl
 * @param {number} textureSize
 * @param {(i: number, j: number) => [number, number]} valueFunc
 */
function createTestPotentialSpectrum(gl, textureSize, valueFunc) {
  const data = new Float32Array(textureSize * textureSize * 4);
  
  for (let j = 0; j < textureSize; j++) {
    for (let i = 0; i < textureSize; i++) {
      const idx = (j * textureSize + i) * 4;
      const [real, imag] = valueFunc(i, j);
      data[idx + 0] = real; // Real part
      data[idx + 1] = imag; // Imaginary part
      data[idx + 2] = 0.0;
      data[idx + 3] = 0.0;
    }
  }
  
  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Helper: read voxel from 3D grid laid out in 2D slices
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
test('KGradient: creates output textures when not provided', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => {
    return [1.0, 0.0]; // Simple constant spectrum
  });
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: potentialSpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8]
  });
  
  assert.ok(kernel.outForceSpectrumX, 'Output X force spectrum texture created');
  assert.ok(kernel.outForceSpectrumY, 'Output Y force spectrum texture created');
  assert.ok(kernel.outForceSpectrumZ, 'Output Z force spectrum texture created');
  assert.ok(kernel.ownsOutTextures, 'Kernel owns output textures');
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceSpectrumX, textureSize, textureSize);
  const outDataY = readTexture(gl, kernel.outForceSpectrumY, textureSize, textureSize);
  const outDataZ = readTexture(gl, kernel.outForceSpectrumZ, textureSize, textureSize);
  
  assertAllFinite(outDataX, 'Force spectrum X data is finite');
  assertAllFinite(outDataY, 'Force spectrum Y data is finite');
  assertAllFinite(outDataZ, 'Force spectrum Z data is finite');
  
  disposeKernel(kernel);
  gl.deleteTexture(potentialSpectrum);
  resetGL(gl);
});

/**
 * Test 2: Gradient produces non-zero output from non-zero potential
 */
test('KGradient: produces non-zero force spectra from potential', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create potential spectrum with non-zero k≠0 components
  const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => {
    // Add some structure in k-space
    if (i === 1 && j === 0) return [2.0, 1.0];
    if (i === 0 && j === 1) return [1.5, -0.5];
    return [0.0, 0.0];
  });
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: potentialSpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8]
  });
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceSpectrumX, textureSize, textureSize);
  const outDataY = readTexture(gl, kernel.outForceSpectrumY, textureSize, textureSize);
  const outDataZ = readTexture(gl, kernel.outForceSpectrumZ, textureSize, textureSize);
  
  // Check that we have some non-zero values in each component
  let hasNonZeroX = false, hasNonZeroY = false, hasNonZeroZ = false;
  for (let i = 0; i < outDataX.length; i += 4) {
    if (Math.abs(outDataX[i]) > 0.001 || Math.abs(outDataX[i + 1]) > 0.001) hasNonZeroX = true;
    if (Math.abs(outDataY[i]) > 0.001 || Math.abs(outDataY[i + 1]) > 0.001) hasNonZeroY = true;
    if (Math.abs(outDataZ[i]) > 0.001 || Math.abs(outDataZ[i + 1]) > 0.001) hasNonZeroZ = true;
  }
  
  assert.ok(hasNonZeroX, 'Force spectrum X has non-zero values');
  assert.ok(hasNonZeroY, 'Force spectrum Y has non-zero values');
  // Z may be zero if no k_z components
  
  disposeKernel(kernel);
  gl.deleteTexture(potentialSpectrum);
  resetGL(gl);
});

/**
 * Test 3: DC component (k=0) should be zero in gradient
 */
test('KGradient: DC component is zero', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create potential with only DC component
  const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => {
    if (i === 0 && j === 0) return [10.0, 0.0]; // DC component
    return [0.0, 0.0];
  });
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: potentialSpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8]
  });
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceSpectrumX, textureSize, textureSize);
  const outDataY = readTexture(gl, kernel.outForceSpectrumY, textureSize, textureSize);
  const outDataZ = readTexture(gl, kernel.outForceSpectrumZ, textureSize, textureSize);
  
  // DC component (0,0) should be zero in all force spectra
  assertClose(outDataX[0], 0.0, 0.001, 'Force X DC component is zero');
  assertClose(outDataY[0], 0.0, 0.001, 'Force Y DC component is zero');
  assertClose(outDataZ[0], 0.0, 0.001, 'Force Z DC component is zero');
  
  disposeKernel(kernel);
  gl.deleteTexture(potentialSpectrum);
  resetGL(gl);
});

/**
 * Test 4: Different world sizes affect gradient scaling
 */
test('KGradient: handles different world sizes', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => {
    if (i === 1 && j === 0) return [1.0, 0.0];
    return [0.0, 0.0];
  });
  
  const worldSizes = [
    [4, 4, 4],
    [8, 8, 8],
    [16, 16, 16],
    [10, 5, 8] // Non-uniform
  ];
  
  for (const worldSize of worldSizes) {
    const kernel = new KGradient({
      gl,
      inPotentialSpectrum: potentialSpectrum,
      gridSize,
      slicesPerRow,
      textureSize,
      worldSize: /** @type {[number,number,number]} */ (worldSize)
    });
    
    kernel.run();
    
    const outDataX = readTexture(gl, kernel.outForceSpectrumX, textureSize, textureSize);
    assertAllFinite(outDataX, `Force spectrum X is finite for worldSize=[${worldSize}]`);
    
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(potentialSpectrum);
  resetGL(gl);
});

/**
 * Test 5: Gradient with different grid sizes
 */
test('KGradient: works with different grid sizes', async () => {
  const gl = getGL();
  
  for (const gridSize of [4, 8, 16]) {
    const slicesPerRow = Math.ceil(Math.sqrt(gridSize));
    const textureSize = gridSize * slicesPerRow;
    
    const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => {
      if (i < gridSize && j < gridSize) return [1.0, 0.5];
      return [0.0, 0.0];
    });
    
    const kernel = new KGradient({
      gl,
      inPotentialSpectrum: potentialSpectrum,
      gridSize,
      slicesPerRow,
      textureSize,
      worldSize: [8, 8, 8]
    });
    
    kernel.run();
    
    const outDataX = readTexture(gl, kernel.outForceSpectrumX, textureSize, textureSize);
    assertAllFinite(outDataX, `Gradient output is finite for gridSize=${gridSize}`);
    
    disposeKernel(kernel);
    gl.deleteTexture(potentialSpectrum);
  }
  
  resetGL(gl);
});

/**
 * Test 6: External texture provision
 */
test('KGradient: uses provided output textures', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => [1.0, 0.0]);
  
  // Create external output textures
  const outX = gl.createTexture();
  const outY = gl.createTexture();
  const outZ = gl.createTexture();
  
  for (const tex of [outX, outY, outZ]) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, textureSize, textureSize, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: potentialSpectrum,
    outForceSpectrumX: outX,
    outForceSpectrumY: outY,
    outForceSpectrumZ: outZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8]
  });
  
  assert.strictEqual(kernel.outForceSpectrumX, outX, 'Uses provided X texture');
  assert.strictEqual(kernel.outForceSpectrumY, outY, 'Uses provided Y texture');
  assert.strictEqual(kernel.outForceSpectrumZ, outZ, 'Uses provided Z texture');
  assert.ok(!kernel.ownsOutTextures, 'Kernel does not own provided textures');
  
  kernel.run();
  
  const outDataX = readTexture(gl, outX, textureSize, textureSize);
  assertAllFinite(outDataX, 'External texture written successfully');
  
  disposeKernel(kernel);
  gl.deleteTexture(potentialSpectrum);
  gl.deleteTexture(outX);
  gl.deleteTexture(outY);
  gl.deleteTexture(outZ);
  resetGL(gl);
});

/**
 * Test 7: Error handling - missing input
 */
test('KGradient: throws error when input not set', async () => {
  const gl = getGL();
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: null,
    gridSize: 4,
    slicesPerRow: 2,
    textureSize: 8,
    worldSize: [8, 8, 8]
  });
  
  assert.throws(() => {
    kernel.run();
  }, /inPotentialSpectrum texture not set/, 'Throws error when input not set');
  
  disposeKernel(kernel);
  resetGL(gl);
});

/**
 * Test 8: Symmetric potential produces symmetric forces
 */
test('KGradient: symmetric potential produces expected force patterns', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create symmetric potential spectrum
  const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => {
    // Only real parts, symmetric pattern
    const kx = i < textureSize / 2 ? i : i - textureSize;
    const ky = j < textureSize / 2 ? j : j - textureSize;
    const k2 = kx * kx + ky * ky;
    if (k2 === 0) return [0.0, 0.0];
    return [1.0 / (k2 + 1), 0.0];
  });
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: potentialSpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8]
  });
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceSpectrumX, textureSize, textureSize);
  const outDataY = readTexture(gl, kernel.outForceSpectrumY, textureSize, textureSize);
  
  assertAllFinite(outDataX, 'Symmetric potential produces finite X forces');
  assertAllFinite(outDataY, 'Symmetric potential produces finite Y forces');
  
  disposeKernel(kernel);
  gl.deleteTexture(potentialSpectrum);
  resetGL(gl);
});

/**
 * Test 9: QuadVAO sharing
 */
test('KGradient: accepts external quadVAO', async () => {
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
  
  const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => [1.0, 0.0]);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: potentialSpectrum,
    quadVAO,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8]
  });
  
  assert.strictEqual(kernel.quadVAO, quadVAO, 'Uses provided quadVAO');
  assert.ok(!kernel.ownsQuadVAO, 'Kernel does not own provided quadVAO');
  
  kernel.run();
  
  const outDataX = readTexture(gl, kernel.outForceSpectrumX, textureSize, textureSize);
  assertAllFinite(outDataX, 'Works with external quadVAO');
  
  disposeKernel(kernel);
  gl.deleteTexture(potentialSpectrum);
  gl.deleteVertexArray(quadVAO);
  gl.deleteBuffer(buffer);
  resetGL(gl);
});

/**
 * Test 10: Disposal cleans up resources
 */
test('KGradient: dispose cleans up owned resources', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const potentialSpectrum = createTestPotentialSpectrum(gl, textureSize, (i, j) => [1.0, 0.0]);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: potentialSpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8]
  });
  
  kernel.run();
  
  const outX = kernel.outForceSpectrumX;
  const outY = kernel.outForceSpectrumY;
  const outZ = kernel.outForceSpectrumZ;
  
  kernel.dispose();
  
  // Textures should be deleted (checking isTexture returns false after delete)
  assert.ok(!gl.isTexture(outX), 'Output X texture disposed');
  assert.ok(!gl.isTexture(outY), 'Output Y texture disposed');
  assert.ok(!gl.isTexture(outZ), 'Output Z texture disposed');
  
  gl.deleteTexture(potentialSpectrum);
  resetGL(gl);
});
