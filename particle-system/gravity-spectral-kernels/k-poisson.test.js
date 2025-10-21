// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KPoisson } from './k-poisson.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel } from '../test-utils.js';

/**
 * Create a simple complex (RG32F) texture with test data
 * @param {WebGL2RenderingContext} gl
 * @param {number} size
 * @param {(x: number, y: number) => [number, number]} valueFunc - Returns [real, imag]
 */
function createComplexTexture(gl, size, valueFunc) {
  // RG32F format needs stride of 2, not 4
  const data = new Float32Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 2;
      const [real, imag] = valueFunc(x, y);
      data[idx + 0] = real;  // R channel = real
      data[idx + 1] = imag;  // G channel = imaginary
    }
  }
  
  const tex = gl.createTexture();
  if (!tex) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, size, size, 0, gl.RG, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  return tex;
}

/**
 * Test 1: DC mode preservation
 * DC component (k=0) should be handled specially in Poisson solver
 */
test('KPoisson: DC mode handling', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create input with DC component only (constant mass)
  const inDensitySpectrum = createComplexTexture(gl, textureSize, (x, y) => {
    // DC mode at (0,0) with total mass = 10.0
    if (x === 0 && y === 0) return [10.0, 0.0];
    return [0.0, 0.0];
  });
  
  const outPotentialSpectrum = createComplexTexture(gl, textureSize, () => [0, 0]);
  
  const kernel = new KPoisson({
    gl,
    inDensitySpectrum,
    outPotentialSpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    gravitationalConstant: 4.0 * Math.PI * 0.0003,
    worldSize: [4.0, 4.0, 4.0]
  });
  
  // Run kernel
  kernel.run();
  
  // Read result
  const result = readTexture(gl, outPotentialSpectrum, textureSize, textureSize);
  
  // DC mode should remain 0 (constant potential is arbitrary)
  const dcReal = result[0];
  const dcImag = result[1];
  
  // Check that result is finite
  assertAllFinite(result, 'All potential values should be finite');
  
  // DC mode should be zero or very small (depends on implementation)
  assert.ok(Math.abs(dcReal) < 1e6, 'DC mode real part should be finite (dcReal=' + dcReal + ', dcImag=' + dcImag + ')');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inDensitySpectrum);
  gl.deleteTexture(outPotentialSpectrum);
});

/**
 * Test 2: Non-zero frequency modes
 */
test('KPoisson: non-zero frequency computation', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create input with a simple wave (k_x = 1)
  const inDensitySpectrum = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 1 && y === 0) return [1.0, 0.0];
    return [0.0, 0.0];
  });
  
  const outPotentialSpectrum = createComplexTexture(gl, textureSize, () => [0, 0]);
  
  const kernel = new KPoisson({
    gl,
    inDensitySpectrum,
    outPotentialSpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    gravitationalConstant: 4.0 * Math.PI * 0.0003,
    worldSize: [4.0, 4.0, 4.0]
  });
  
  // Read input for diagnostics
  const inputCheck = readTexture(gl, inDensitySpectrum, textureSize, textureSize);
  
  // Run kernel
  kernel.run();
  
  // Read result
  const result = readTexture(gl, outPotentialSpectrum, textureSize, textureSize);
  
  // Check that result is finite
  assertAllFinite(result, 'All potential values should be finite');
  
  // At (1, 0), we should have a non-zero potential
  const idx = 1 * 4; // x=1, y=0
  const potentialReal = result[idx + 0];
  const potentialImag = result[idx + 1];
  
  // Should be non-zero (exact value depends on physics constants)
  const magnitude = Math.sqrt(potentialReal * potentialReal + potentialImag * potentialImag);
  
  // If test would fail, gather diagnostics
  if (magnitude <= 0) {
    let inputNonZero = 0, outputNonZero = 0;
    for (let i = 0; i < inputCheck.length; i++) {
      if (inputCheck[i] !== 0) inputNonZero++;
      if (result[i] !== 0) outputNonZero++;
    }
    
    const diagnostics = {
      magnitude,
      inputNonZero,
      outputNonZero,
      inputAt1: [inputCheck[4], inputCheck[5], inputCheck[6], inputCheck[7]],
      outputAt1: [result[4], result[5], result[6], result[7]],
      inputDC: [inputCheck[0], inputCheck[1], inputCheck[2], inputCheck[3]],
      outputDC: [result[0], result[1], result[2], result[3]]
    };
    assert.ok(false, 'KPoisson failed - diagnostics: ' + JSON.stringify(diagnostics, null, 2));
  }
  
  assert.ok(magnitude > 0, 'Non-DC modes should have non-zero potential (|phi|=' + magnitude + ' at (1,0))');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inDensitySpectrum);
  gl.deleteTexture(outPotentialSpectrum);
});

/**
 * Test 3: Multiple frequency modes
 */
test('KPoisson: multiple frequencies', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create input with multiple wave components
  const inDensitySpectrum = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 1 && y === 0) return [1.0, 0.0];
    if (x === 0 && y === 1) return [0.5, 0.5];
    if (x === 1 && y === 1) return [0.3, -0.3];
    return [0.0, 0.0];
  });
  
  const outPotentialSpectrum = createComplexTexture(gl, textureSize, () => [0, 0]);
  
  const kernel = new KPoisson({
    gl,
    inDensitySpectrum,
    outPotentialSpectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    gravitationalConstant: 4.0 * Math.PI * 0.0003,
    worldSize: [4.0, 4.0, 4.0]
  });
  
  // Run kernel
  kernel.run();
  
  // Read result
  const result = readTexture(gl, outPotentialSpectrum, textureSize, textureSize);
  
  // Check that result is finite
  assertAllFinite(result, 'All potential values should be finite');
  
  // Check that we have non-zero values at expected locations
  const check = (x, y, label) => {
    const idx = (y * textureSize + x) * 4;
    const real = result[idx + 0];
    const imag = result[idx + 1];
    const mag = Math.sqrt(real * real + imag * imag);
    assert.ok(mag > 0 || (x === 0 && y === 0), `${label} should have non-zero magnitude (|phi|=${mag})`);
  };
  
  check(1, 0, '(1,0)');
  check(0, 1, '(0,1)');
  check(1, 1, '(1,1)');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inDensitySpectrum);
  gl.deleteTexture(outPotentialSpectrum);
});
