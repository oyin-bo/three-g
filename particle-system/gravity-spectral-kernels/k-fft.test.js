// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KFFT } from './k-fft.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Create a real-valued test texture (RGBA32F format)
 * @param {WebGL2RenderingContext} gl
 * @param {number} size
 * @param {(x: number, y: number) => number} valueFunc - Returns real value
 */
function createRealTexture(gl, size, valueFunc) {
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const value = valueFunc(x, y);
      data[idx + 0] = value;  // R channel = real value
      data[idx + 1] = 0;      // G unused
      data[idx + 2] = 0;      // B unused
      data[idx + 3] = 0;      // A unused
    }
  }
  return createTestTexture(gl, size, size, data);
}

/**
 * Create a complex-valued test texture (RGBA32F format, using RG channels)
 * @param {WebGL2RenderingContext} gl
 * @param {number} size
 * @param {(x: number, y: number) => [number, number]} valueFunc - Returns [real, imag]
 */
function createComplexTexture(gl, size, valueFunc) {
  const data = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const [real, imag] = valueFunc(x, y);
      data[idx + 0] = real;   // R channel = real
      data[idx + 1] = imag;   // G channel = imaginary
      data[idx + 2] = 0;      // B unused
      data[idx + 3] = 0;      // A unused
    }
  }
  return createTestTexture(gl, size, size, data);
}

/**
 * Test 1: Forward FFT of constant signal (DC component only)
 */
test('KFFT: forward FFT of constant signal', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow; // 8×8
  
  // Create constant real input (value = 1.0 everywhere)
  const inReal = createRealTexture(gl, textureSize, () => 1.0);
  const outComplex = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KFFT({
    gl,
    inReal,
    outComplex,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  
  // Run forward FFT
  kernel.run();
  
  // Read result
  const result = readTexture(gl, outComplex, textureSize, textureSize);
  
  // For constant input, all frequency components should be zero except DC
  // DC component (0,0) should have value ≈ N³ (gridSize³ = 64)
  const dcReal = result[0];
  const dcImag = result[1];
  
  const expectedDC = gridSize * gridSize * gridSize; // 4³ = 64
  assertClose(dcReal, expectedDC, 1.0, 'DC component real part should equal total count');
  assertClose(dcImag, 0.0, 0.01, 'DC component imaginary part should be zero');
  
  // Check that result is finite
  assertAllFinite(result, 'All FFT values should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inReal);
  gl.deleteTexture(outComplex);
  resetGL();
});

/**
 * Test 2: Inverse FFT of DC component recovers constant
 */
test('KFFT: inverse FFT of DC component', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create complex input with only DC component
  const inComplex = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 0 && y === 0) return [64.0, 0.0]; // DC = N³
    return [0.0, 0.0];
  });
  const outReal = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KFFT({
    gl,
    inComplex,
    outReal,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: true
  });
  
  // Run inverse FFT
  kernel.run();
  
  // Read result
  const result = readTexture(gl, outReal, textureSize, textureSize);
  
  // Should recover constant value (normalized by 1/N³)
  // Expected value ≈ 1.0 (DC/N³ = 64/64)
  for (let i = 0; i < textureSize * textureSize; i++) {
    const val = result[i * 4];
    assertClose(val, 1.0, 0.01, `Pixel ${i} should be ~1.0 after inverse FFT`);
  }
  
  assertAllFinite(result, 'All inverse FFT values should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inComplex);
  gl.deleteTexture(outReal);
  resetGL();
});

/**
 * Test 3: Forward-inverse roundtrip preserves signal
 */
test('KFFT: forward-inverse roundtrip', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create a non-trivial real input (simple gradient)
  const inReal = createRealTexture(gl, textureSize, (x, y) => x * 0.1 + y * 0.2);
  const spectrum = createTestTexture(gl, textureSize, textureSize, null);
  const outReal = createTestTexture(gl, textureSize, textureSize, null);
  
  // Forward FFT
  const kernelFwd = new KFFT({
    gl,
    inReal,
    outComplex: spectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  kernelFwd.run();
  
  // Inverse FFT
  const kernelInv = new KFFT({
    gl,
    inComplex: spectrum,
    outReal,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: true
  });
  kernelInv.run();
  
  // Read original and recovered data
  const original = readTexture(gl, inReal, textureSize, textureSize);
  const recovered = readTexture(gl, outReal, textureSize, textureSize);
  
  // Check that roundtrip preserves values
  for (let i = 0; i < textureSize * textureSize; i++) {
    const origVal = original[i * 4];
    const recovVal = recovered[i * 4];
    assertClose(recovVal, origVal, 0.01, `Pixel ${i} should be preserved in roundtrip`);
  }
  
  assertAllFinite(recovered, 'Recovered values should be finite');
  
  // Cleanup
  disposeKernel(kernelFwd);
  disposeKernel(kernelInv);
  gl.deleteTexture(inReal);
  gl.deleteTexture(spectrum);
  gl.deleteTexture(outReal);
  resetGL();
});

/**
 * Test 4: Zero input produces zero output
 */
test('KFFT: zero input produces zero output', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create zero real input
  const inReal = createRealTexture(gl, textureSize, () => 0.0);
  const outComplex = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KFFT({
    gl,
    inReal,
    outComplex,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outComplex, textureSize, textureSize);
  
  // All values should be zero
  for (let i = 0; i < result.length; i++) {
    assertClose(result[i], 0.0, 1e-5, `Element ${i} should be zero`);
  }
  
  assertAllFinite(result, 'Zero FFT result should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inReal);
  gl.deleteTexture(outComplex);
  resetGL();
});

/**
 * Test 5: Single frequency mode
 */
test('KFFT: single frequency mode', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create a pure cosine wave along one axis (k=1 mode)
  // cos(2πx/N) for x in voxel grid
  const inReal = createRealTexture(gl, textureSize, (x, y) => {
    // Map texture coords to voxel coords
    const voxelX = x % gridSize;
    const phase = (2 * Math.PI * voxelX) / gridSize;
    return Math.cos(phase);
  });
  const outComplex = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KFFT({
    gl,
    inReal,
    outComplex,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outComplex, textureSize, textureSize);
  
  // The spectrum should have peaks at k=1 and k=N-1 (complex conjugate)
  // Most other components should be near zero
  assertAllFinite(result, 'Single frequency FFT should be finite');
  
  // Check that at least some non-DC components are non-zero
  let hasNonZeroFrequency = false;
  for (let i = 1; i < textureSize * textureSize; i++) {
    const real = result[i * 4 + 0];
    const imag = result[i * 4 + 1];
    const magnitude = Math.sqrt(real * real + imag * imag);
    if (magnitude > 0.1) {
      hasNonZeroFrequency = true;
      break;
    }
  }
  
  assert.ok(hasNonZeroFrequency, 'Should have non-zero frequency components for cosine wave');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inReal);
  gl.deleteTexture(outComplex);
  resetGL();
});

/**
 * Test 6: Parseval's theorem (energy conservation)
 * Total energy in time domain equals total energy in frequency domain
 */
test('KFFT: energy conservation (Parseval)', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create a random-ish signal
  const inReal = createRealTexture(gl, textureSize, (x, y) => 
    Math.sin(x * 0.5) * Math.cos(y * 0.3) + 0.5
  );
  const outComplex = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KFFT({
    gl,
    inReal,
    outComplex,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  
  kernel.run();
  
  const originalData = readTexture(gl, inReal, textureSize, textureSize);
  const spectrumData = readTexture(gl, outComplex, textureSize, textureSize);
  
  // Compute time-domain energy (sum of squares)
  let timeEnergy = 0;
  for (let i = 0; i < textureSize * textureSize; i++) {
    const val = originalData[i * 4];
    timeEnergy += val * val;
  }
  
  // Compute frequency-domain energy (sum of |spectrum|²)
  let freqEnergy = 0;
  for (let i = 0; i < textureSize * textureSize; i++) {
    const real = spectrumData[i * 4 + 0];
    const imag = spectrumData[i * 4 + 1];
    freqEnergy += real * real + imag * imag;
  }
  
  // Normalize by N³ (FFT unnormalized)
  const N3 = gridSize * gridSize * gridSize;
  freqEnergy /= N3;
  
  // Energies should be approximately equal
  assertClose(freqEnergy, timeEnergy, timeEnergy * 0.1, 'Energy should be conserved by FFT');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inReal);
  gl.deleteTexture(outComplex);
  resetGL();
});

/**
 * Test 7: Delta function transforms to all ones
 */
test('KFFT: delta function spectrum', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create delta function at origin (1 at (0,0,0), 0 elsewhere)
  const inReal = createRealTexture(gl, textureSize, (x, y) => 
    (x === 0 && y === 0) ? 1.0 : 0.0
  );
  const outComplex = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KFFT({
    gl,
    inReal,
    outComplex,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  
  kernel.run();
  
  const result = readTexture(gl, outComplex, textureSize, textureSize);
  
  // FFT of delta should be constant (all real parts ≈ 1, all imag ≈ 0)
  for (let i = 0; i < textureSize * textureSize; i++) {
    const real = result[i * 4 + 0];
    const imag = result[i * 4 + 1];
    
    // Real part should be ~1.0, imaginary should be ~0
    assertClose(real, 1.0, 0.1, `Real part at ${i} should be ~1.0 for delta FFT`);
    assertClose(imag, 0.0, 0.1, `Imaginary part at ${i} should be ~0 for delta FFT`);
  }
  
  assertAllFinite(result, 'Delta FFT should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inReal);
  gl.deleteTexture(outComplex);
  resetGL();
});
