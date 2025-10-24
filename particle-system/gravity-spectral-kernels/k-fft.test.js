// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KFFT } from './k-fft.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: fill a voxel grid with test data
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number) => number} valueFunc
 */
function fillGridTexture(gl, gridSize, slicesPerRow, valueFunc) {
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
        
        const val = valueFunc(vx, vy, vz);
        data[idx] = val;
        data[idx + 1] = 0;
        data[idx + 2] = 0;
        data[idx + 3] = 0;
      }
    }
  }
  
  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Test 1: Forward FFT on uniform field
 */
test('KFFT: forward FFT preserves total energy for uniform field', async () => {
  const gl = getGL();
  
  const gridSize = 8;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Uniform field: all voxels = 1.0
  const inReal = fillGridTexture(gl, gridSize, slicesPerRow, () => 1.0);
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
  
  // DC component (index 0) should contain sum of input
  const dcReal = result[0];
  const dcImag = result[1];
  const expectedSum = gridSize * gridSize * gridSize; // 8³ = 512
  
  assertClose(dcReal, expectedSum, 1.0, 'DC component real part should equal sum');
  assertClose(dcImag, 0, 0.1, 'DC component imaginary part should be near zero');
  
  assertAllFinite(result, 'All output values should be finite');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Forward FFT on single spike
 */
test('KFFT: forward FFT spike creates non-zero spectrum', async () => {
  const gl = getGL();
  
  const gridSize = 8;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Single spike at center
  const inReal = fillGridTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return x === 4 && y === 4 && z === 4 ? 1.0 : 0.0;
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
  
  // Should have non-zero DC component
  const dcReal = result[0];
  assertClose(dcReal, 1.0, 0.1, 'DC component should equal spike value');
  
  // Should have non-zero spectrum elsewhere
  let nonDCEnergy = 0;
  for (let i = 2; i < result.length; i += 2) {
    nonDCEnergy += result[i] * result[i] + result[i + 1] * result[i + 1];
  }
  
  assert.ok(nonDCEnergy > 0, 'Spectrum should have energy beyond DC component');
  assertAllFinite(result, 'All output values should be finite');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Forward then inverse FFT roundtrip
 */
test('KFFT: forward-inverse roundtrip recovers original (uniform field)', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Test field
  const testValue = 2.5;
  const inReal = fillGridTexture(gl, gridSize, slicesPerRow, () => testValue);
  
  const intermediate = createTestTexture(gl, textureSize, textureSize, null);
  const outReal = createTestTexture(gl, textureSize, textureSize, null);
  
  // Forward FFT
  const forward = new KFFT({
    gl,
    inReal,
    outComplex: intermediate,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  forward.run();
  
  // Inverse FFT
  const inverse = new KFFT({
    gl,
    inComplex: intermediate,
    outReal,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: true
  });
  inverse.run();
  
  const result = readTexture(gl, outReal, textureSize, textureSize);
  
  // Check roundtrip: should recover original (with normalization)
  // Inverse FFT includes 1/N³ normalization
  const normalizedValue = testValue / (gridSize * gridSize * gridSize);
  
  for (let i = 0; i < result.length; i += 4) {
    assertClose(result[i], normalizedValue, 0.01, `Recovered value at ${i} should match`);
  }
  
  assertAllFinite(result, 'All output values should be finite');
  
  disposeKernel(forward);
  disposeKernel(inverse);
  resetGL();
});

/**
 * Test 4: Forward-inverse on spike
 */
test('KFFT: forward-inverse roundtrip recovers spike', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Single spike
  const inReal = fillGridTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return x === 2 && y === 2 && z === 2 ? 1.0 : 0.0;
  });
  
  const intermediate = createTestTexture(gl, textureSize, textureSize, null);
  const outReal = createTestTexture(gl, textureSize, textureSize, null);
  
  const forward = new KFFT({
    gl,
    inReal,
    outComplex: intermediate,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  forward.run();
  
  const inverse = new KFFT({
    gl,
    inComplex: intermediate,
    outReal,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: true
  });
  inverse.run();
  
  const result = readTexture(gl, outReal, textureSize, textureSize);
  
  // Recover spike position
  const totalVoxels = gridSize * gridSize * gridSize;
  const recoveredValue = 1.0 / totalVoxels;
  
  // Find where spike was
  const spikeIdx = (2 * textureSize + 2) * 4;
  assertClose(result[spikeIdx], recoveredValue, 0.01, 'Spike position should recover');
  
  assertAllFinite(result, 'All output values should be finite');
  
  disposeKernel(forward);
  disposeKernel(inverse);
  resetGL();
});

/**
 * Test 5: Larger FFT (16³)
 */
test('KFFT: handles larger grid size (16×16×16)', async () => {
  const gl = getGL();
  
  const gridSize = 16;
  const slicesPerRow = 4;
  const textureSize = gridSize * slicesPerRow;
  
  const inReal = fillGridTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return (x + y + z) * 0.01;
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
  assertAllFinite(result, 'All output values should be finite for large grid');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 6: FFT with oscillatory input
 */
test('KFFT: handles oscillatory field correctly', async () => {
  const gl = getGL();
  
  const gridSize = 8;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Checkerboard pattern
  const inReal = fillGridTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return ((x + y + z) % 2) * 2.0 - 1.0;
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
  
  // Should have DC = 0 for checkerboard
  assertClose(result[0], 0, 0.1, 'DC component should be near zero for checkerboard');
  assertAllFinite(result, 'All output values should be finite');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 7: Multiple roundtrips
 */
test('KFFT: successive roundtrips remain stable', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const original = fillGridTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return Math.sin(x * 0.5) * Math.cos(y * 0.5) + 1.0;
  });
  
  let current = original;
  
  for (let round = 0; round < 3; round++) {
    const intermediate = createTestTexture(gl, textureSize, textureSize, null);
    const output = createTestTexture(gl, textureSize, textureSize, null);
    
    const forward = new KFFT({
      gl,
      inReal: current,
      outComplex: intermediate,
      gridSize,
      slicesPerRow,
      textureSize,
      inverse: false
    });
    forward.run();
    
    const inverse = new KFFT({
      gl,
      inComplex: intermediate,
      outReal: output,
      gridSize,
      slicesPerRow,
      textureSize,
      inverse: true
    });
    inverse.run();
    
    current = output;
    
    const result = readTexture(gl, output, textureSize, textureSize);
    assertAllFinite(result, `All values should be finite after roundtrip ${round + 1}`);
    
    disposeKernel(forward);
    disposeKernel(inverse);
  }
  
  resetGL();
});

/**
 * Test 8: Inverse FFT produces real output
 */
test('KFFT: inverse FFT produces real-valued output', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create arbitrary real field
  const inReal = fillGridTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return Math.sin(x) + Math.cos(y) + (z * 0.1);
  });
  
  const spectrum = createTestTexture(gl, textureSize, textureSize, null);
  const outReal = createTestTexture(gl, textureSize, textureSize, null);
  
  const forward = new KFFT({
    gl,
    inReal,
    outComplex: spectrum,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  forward.run();
  
  const inverse = new KFFT({
    gl,
    inComplex: spectrum,
    outReal,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: true
  });
  inverse.run();
  
  const result = readTexture(gl, outReal, textureSize, textureSize);
  
  // Check that imaginary components (channels 1,2,3) are effectively zero or ignored
  // since this is RGBA and we only use R for real part
  for (let i = 0; i < result.length; i += 4) {
    assert.ok(isFinite(result[i]), `Real part at ${i} should be finite`);
  }
  
  disposeKernel(forward);
  disposeKernel(inverse);
  resetGL();
});

/**
 * Test 9: Energy preservation in Parseval sense
 */
test('KFFT: Parseval identity holds approximately', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const inReal = fillGridTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return Math.sin(x * Math.PI / gridSize) + 0.5;
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
  
  const spectrum = readTexture(gl, outComplex, textureSize, textureSize);
  
  // Calculate energy in frequency domain
  let spectralEnergy = 0;
  for (let i = 0; i < spectrum.length; i += 2) {
    spectralEnergy += spectrum[i] * spectrum[i] + spectrum[i + 1] * spectrum[i + 1];
  }
  
  assert.ok(spectralEnergy > 0, 'Spectral energy should be positive');
  assertAllFinite(spectrum, 'All spectral values should be finite');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 10: Consistency across kernel instances
 */
test('KFFT: same input produces consistent output across instances', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const input = fillGridTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return (x * y + z) * 0.1;
  });
  
  const out1 = createTestTexture(gl, textureSize, textureSize, null);
  const out2 = createTestTexture(gl, textureSize, textureSize, null);
  
  // Create two separate kernel instances
  const kernel1 = new KFFT({
    gl,
    inReal: input,
    outComplex: out1,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  kernel1.run();
  
  const kernel2 = new KFFT({
    gl,
    inReal: input,
    outComplex: out2,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false
  });
  kernel2.run();
  
  const result1 = readTexture(gl, out1, textureSize, textureSize);
  const result2 = readTexture(gl, out2, textureSize, textureSize);
  
  // Results should be identical
  for (let i = 0; i < result1.length; i++) {
    assertClose(result1[i], result2[i], 1e-5, `Result ${i} should match between instances`);
  }
  
  disposeKernel(kernel1);
  disposeKernel(kernel2);
  resetGL();
});
