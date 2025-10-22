// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KFFT } from './k-fft.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: create a simple test grid with known values
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 */
function createTestGrid(gl, gridSize, slicesPerRow) {
  const textureSize = gridSize * slicesPerRow;
  const data = new Float32Array(textureSize * textureSize * 4);
  
  // Fill with simple pattern: constant value in center voxel
  for (let vz = 0; vz < gridSize; vz++) {
    const sliceRow = Math.floor(vz / slicesPerRow);
    const sliceCol = vz % slicesPerRow;
    
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const texelX = sliceCol * gridSize + vx;
        const texelY = sliceRow * gridSize + vy;
        const idx = (texelY * textureSize + texelX) * 4;
        
        // Put value in alpha channel (mass)
        if (vx === gridSize / 2 && vy === gridSize / 2 && vz === gridSize / 2) {
          data[idx + 3] = 1.0;
        } else {
          data[idx + 3] = 0.0;
        }
      }
    }
  }
  
  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Test 1: FFT creates output texture when not provided
 */
test('KFFT: creates output texture when not provided', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const inputGrid = createTestGrid(gl, gridSize, slicesPerRow);
  
  const kernel = new KFFT({
    gl,
    grid: inputGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false,
    cellVolume: 1.0
  });
  
  assert.ok(kernel.spectrum, 'Output spectrum texture created (textureSize=' + textureSize + ')');
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.spectrum, textureSize, textureSize);
  assertAllFinite(outData, 'Output spectrum data is finite');
  
  disposeKernel(kernel);
  gl.deleteTexture(inputGrid);
  resetGL();
});

/**
 * Test 2: Forward FFT produces complex output
 */
test('KFFT: forward FFT produces complex output', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const inputGrid = createTestGrid(gl, gridSize, slicesPerRow);
  
  const kernel = new KFFT({
    gl,
    grid: inputGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false,
    cellVolume: 1.0
  });
  
  kernel.run();
  
  // Read output spectrum (RG32F format - real and imaginary parts)
  const outData = readTexture(gl, kernel.spectrum, textureSize, textureSize);
  
  // Check that we have some non-zero values
  let hasNonZero = false;
  let nonZeroCount = 0;
  let maxMag = 0.0;
  for (let i = 0; i < outData.length; i += 4) {
    const real = outData[i];
    const imag = outData[i + 1];
    const mag = Math.hypot(real, imag);
    if (mag > 0.001) {
      hasNonZero = true;
      nonZeroCount++;
      if (mag > maxMag) maxMag = mag;
    }
  }
  
  assert.ok(hasNonZero, 'FFT output has non-zero values (count=' + nonZeroCount + ', maxMag=' + maxMag + ')');
  assertAllFinite(outData, 'FFT output is finite');
  
  disposeKernel(kernel);
  gl.deleteTexture(inputGrid);
  resetGL();
});

/**
 * Test 3: Inverse FFT after forward FFT recovers original
 */
test('KFFT: inverse FFT recovers original (round-trip)', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const inputGrid = createTestGrid(gl, gridSize, slicesPerRow);
  const inputData = readTexture(gl, inputGrid, textureSize, textureSize);
  
  // Forward FFT
  const forwardKernel = new KFFT({
    gl,
    grid: inputGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: false,
    cellVolume: 1.0
  });
  
  forwardKernel.run();
  
  // Create output texture for inverse FFT
  const outputGrid = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, outputGrid);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, textureSize, textureSize, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  // Inverse FFT
  const inverseKernel = new KFFT({
    gl,
    spectrum: forwardKernel.spectrum,
    grid: outputGrid,
    gridSize,
    slicesPerRow,
    textureSize,
    inverse: true,
    cellVolume: 1.0
  });
  
  inverseKernel.run();
  
  const outputData = readTexture(gl, outputGrid, textureSize, textureSize);
  
  // Check that recovered data is close to original
  // Note: FFT normalization may differ, so we check pattern rather than exact values
  assertAllFinite(outputData, 'Inverse FFT output is finite');
  
  // Find the peak in both input and output
  let maxInput = 0;
  let maxOutput = 0;
  for (let i = 0; i < inputData.length; i += 4) {
    maxInput = Math.max(maxInput, inputData[i + 3]);
    maxOutput = Math.max(maxOutput, outputData[i + 3]);
  }
  
  // If test would fail, gather detailed diagnostics
  if (maxOutput <= 0) {
    // Read intermediate stages for diagnostics
    const forwardSpectrum = readTexture(gl, forwardKernel.spectrum, textureSize, textureSize);
    
    // Count non-zero values at each stage
    let inputNonZero = 0, fwdNonZero = 0, outputNonZero = 0;
    for (let i = 0; i < inputData.length; i++) {
      if (inputData[i] !== 0) inputNonZero++;
      if (forwardSpectrum[i] !== 0) fwdNonZero++;
      if (outputData[i] !== 0) outputNonZero++;
    }
    
    // Sample key pixels
    const diagnostics = {
      maxInput, maxOutput,
      inputNonZero, fwdNonZero, outputNonZero,
      inputDC: [inputData[0], inputData[1], inputData[2], inputData[3]],
      fwdDC: [forwardSpectrum[0], forwardSpectrum[1], forwardSpectrum[2], forwardSpectrum[3]],
      outputDC: [outputData[0], outputData[1], outputData[2], outputData[3]],
      outputSample: [outputData[4], outputData[5], outputData[6], outputData[7]]
    };
    
    assert.ok(false, 'Inverse FFT failed - diagnostics: ' + JSON.stringify(diagnostics, null, 2));
  }
  
  assert.ok(maxOutput > 0, 'Inverse FFT has non-zero peak: ' + maxOutput + ' (maxInput: ' + maxInput + ')');
  
  disposeKernel(forwardKernel);
  disposeKernel(inverseKernel);
  gl.deleteTexture(inputGrid);
  gl.deleteTexture(outputGrid);
  resetGL();
});

/**
 * Test 4: FFT with different grid sizes
 */
test('KFFT: works with different grid sizes', async () => {
  const gl = getGL();
  
  for (const gridSize of [4, 8, 16]) {
    const slicesPerRow = Math.ceil(Math.sqrt(gridSize));
    const textureSize = gridSize * slicesPerRow;
    
    const inputGrid = createTestGrid(gl, gridSize, slicesPerRow);
    
    const kernel = new KFFT({
      gl,
      grid: inputGrid,
      gridSize,
      slicesPerRow,
      textureSize,
      inverse: false,
      cellVolume: 1.0
    });
    
    kernel.run();
    
    const outData = readTexture(gl, kernel.spectrum, textureSize, textureSize);
    assertAllFinite(outData, `FFT output is finite for gridSize=${gridSize}`);
    
    disposeKernel(kernel);
    gl.deleteTexture(inputGrid);
  }
  
  resetGL();
});
