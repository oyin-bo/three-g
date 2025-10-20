// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KPoisson } from './k-poisson.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: create a test density spectrum texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} textureSize
 */
function createTestDensitySpectrum(gl, textureSize) {
  const data = new Float32Array(textureSize * textureSize * 4);
  
  // Fill with simple test pattern
  // k=0 (DC) component should have some value
  data[0] = 1.0; // Real part
  data[1] = 0.0; // Imaginary part
  // Also seed a non-DC mode (next texel) so Poisson has non-zero output
  data[4] = 1.0; // Real part at (x=1,y=0)
  data[5] = 0.0; // Imag part
  
  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Test 1: Poisson creates output texture when not provided
 */
test('KPoisson: creates output texture when not provided', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const densitySpectrum = createTestDensitySpectrum(gl, textureSize);
  
  const kernel = new KPoisson({
    gl,
    inDensitySpectrum: densitySpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8],
    gravityStrength: 0.0003
  });
  
  assert.ok(kernel.outPotentialSpectrum, 'Output potential spectrum texture created');
  assert.ok(kernel.ownsOutTexture, 'Kernel owns output texture');
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outPotentialSpectrum, textureSize, textureSize);
  assertAllFinite(outData, 'Output potential spectrum data is finite');
  
  disposeKernel(kernel);
  gl.deleteTexture(densitySpectrum);
  resetGL(gl);
});

/**
 * Test 2: Poisson solver produces non-zero output
 */
test('KPoisson: produces non-zero potential from density', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const densitySpectrum = createTestDensitySpectrum(gl, textureSize);
  
  const kernel = new KPoisson({
    gl,
    inDensitySpectrum: densitySpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [8, 8, 8],
    gravityStrength: 0.0003
  });
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outPotentialSpectrum, textureSize, textureSize);
  
  // Check that we have some non-zero values
  let hasNonZero = false;
  for (let i = 0; i < outData.length; i += 4) {
    if (Math.abs(outData[i]) > 0.001 || Math.abs(outData[i + 1]) > 0.001) {
      hasNonZero = true;
      break;
    }
  }
  
  assert.ok(hasNonZero, 'Poisson output has non-zero values');
  assertAllFinite(outData, 'Poisson output is finite');
  
  disposeKernel(kernel);
  gl.deleteTexture(densitySpectrum);
  resetGL(gl);
});

/**
 * Test 3: Poisson with different split modes
 */
test('KPoisson: works with different split modes', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const densitySpectrum = createTestDensitySpectrum(gl, textureSize);
  
  for (const splitMode of [0, 1, 2]) {
    const kernel = new KPoisson({
      gl,
      inDensitySpectrum: densitySpectrum,
      gridSize,
      slicesPerRow,
      textureSize,
      worldSize: [8, 8, 8],
      gravityStrength: 0.0003,
      splitMode: /** @type {0|1|2} */ (splitMode),
      kCut: splitMode === 1 ? 0.5 : 0,
      gaussianSigma: splitMode === 2 ? 1.0 : 0
    });
    
    kernel.run();
    
    const outData = readTexture(gl, kernel.outPotentialSpectrum, textureSize, textureSize);
    assertAllFinite(outData, `Poisson output is finite for splitMode=${splitMode}`);
    
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(densitySpectrum);
  resetGL(gl);
});

/**
 * Test 4: Poisson with different world sizes
 */
test('KPoisson: handles different world sizes', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const densitySpectrum = createTestDensitySpectrum(gl, textureSize);
  
  const worldSizes = [
    [4, 4, 4],
    [8, 8, 8],
    [16, 16, 16],
    [10, 5, 8] // Non-uniform
  ];
  
  for (const worldSize of worldSizes) {
    const kernel = new KPoisson({
      gl,
      inDensitySpectrum: densitySpectrum,
      gridSize,
      slicesPerRow,
      textureSize,
      worldSize: /** @type {[number,number,number]} */ (worldSize),
      gravityStrength: 0.0003
    });
    
    kernel.run();
    
    const outData = readTexture(gl, kernel.outPotentialSpectrum, textureSize, textureSize);
    assertAllFinite(outData, `Poisson output is finite for worldSize=[${worldSize}]`);
    
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(densitySpectrum);
  resetGL(gl);
});

/**
 * Test 5: Poisson with different deconvolution orders
 */
test('KPoisson: works with different deconvolution orders', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const densitySpectrum = createTestDensitySpectrum(gl, textureSize);
  
  for (const deconvolveOrder of [0, 1, 2, 3]) {
    const kernel = new KPoisson({
      gl,
      inDensitySpectrum: densitySpectrum,
      gridSize,
      slicesPerRow,
      textureSize,
      worldSize: [8, 8, 8],
      gravityStrength: 0.0003,
      deconvolveOrder: /** @type {0|1|2|3} */ (deconvolveOrder)
    });
    
    kernel.run();
    
    const outData = readTexture(gl, kernel.outPotentialSpectrum, textureSize, textureSize);
    assertAllFinite(outData, `Poisson output is finite for deconvolveOrder=${deconvolveOrder}`);
    
    disposeKernel(kernel);
  }
  
  gl.deleteTexture(densitySpectrum);
  resetGL(gl);
});
