// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KGradient } from './k-gradient.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

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
 * Test 1: Zero potential produces zero force
 */
test('KGradient: zero potential produces zero force', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow; // 8×8
  
  // Create zero potential spectrum
  const inPotentialSpectrum = createComplexTexture(gl, textureSize, () => [0.0, 0.0]);
  const outForceSpectrumX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum,
    outForceSpectrumX,
    outForceSpectrumY,
    outForceSpectrumZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  
  // Run gradient computation
  kernel.run();
  
  // Read results
  const resultX = readTexture(gl, outForceSpectrumX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceSpectrumY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceSpectrumZ, textureSize, textureSize);
  
  // All force components should be zero
  for (let i = 0; i < resultX.length; i++) {
    assertClose(resultX[i], 0.0, 1e-5, `ForceX[${i}] should be zero`);
    assertClose(resultY[i], 0.0, 1e-5, `ForceY[${i}] should be zero`);
    assertClose(resultZ[i], 0.0, 1e-5, `ForceZ[${i}] should be zero`);
  }
  
  assertAllFinite(resultX, 'ForceX should be finite');
  assertAllFinite(resultY, 'ForceY should be finite');
  assertAllFinite(resultZ, 'ForceZ should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPotentialSpectrum);
  gl.deleteTexture(outForceSpectrumX);
  gl.deleteTexture(outForceSpectrumY);
  gl.deleteTexture(outForceSpectrumZ);
  resetGL();
});

/**
 * Test 2: DC potential produces zero force
 * Constant potential has zero gradient
 */
test('KGradient: DC potential produces zero force', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create DC-only potential spectrum (constant potential)
  const inPotentialSpectrum = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 0 && y === 0) return [100.0, 0.0]; // Large DC component
    return [0.0, 0.0];
  });
  const outForceSpectrumX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum,
    outForceSpectrumX,
    outForceSpectrumY,
    outForceSpectrumZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceSpectrumX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceSpectrumY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceSpectrumZ, textureSize, textureSize);
  
  // DC mode has zero gradient, so all forces should be zero
  for (let i = 0; i < resultX.length; i++) {
    assertClose(resultX[i], 0.0, 0.1, `ForceX[${i}] should be ~zero for DC`);
    assertClose(resultY[i], 0.0, 0.1, `ForceY[${i}] should be ~zero for DC`);
    assertClose(resultZ[i], 0.0, 0.1, `ForceZ[${i}] should be ~zero for DC`);
  }
  
  assertAllFinite(resultX, 'ForceX should be finite');
  assertAllFinite(resultY, 'ForceY should be finite');
  assertAllFinite(resultZ, 'ForceZ should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPotentialSpectrum);
  gl.deleteTexture(outForceSpectrumX);
  gl.deleteTexture(outForceSpectrumY);
  gl.deleteTexture(outForceSpectrumZ);
  resetGL();
});

/**
 * Test 3: Single frequency mode produces proportional gradient
 * For a pure wave, gradient magnitude should be proportional to k
 */
test('KGradient: single frequency produces gradient', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create a single frequency mode in X direction (k_x = 1)
  const inPotentialSpectrum = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 1 && y === 0) return [1.0, 0.0]; // k_x = 1 mode
    return [0.0, 0.0];
  });
  const outForceSpectrumX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum,
    outForceSpectrumX,
    outForceSpectrumY,
    outForceSpectrumZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceSpectrumX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceSpectrumY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceSpectrumZ, textureSize, textureSize);
  
  // Force in X direction should be non-zero at (1,0)
  const idx = 1 * 4; // x=1, y=0
  const forceXReal = resultX[idx + 0];
  const forceXImag = resultX[idx + 1];
  const forceXMag = Math.sqrt(forceXReal * forceXReal + forceXImag * forceXImag);
  
  assert.ok(forceXMag > 0, 'Force in X should be non-zero for k_x mode');
  
  // Forces in Y and Z should be near zero at this mode
  const forceYMag = Math.sqrt(resultY[idx + 0] ** 2 + resultY[idx + 1] ** 2);
  const forceZMag = Math.sqrt(resultZ[idx + 0] ** 2 + resultZ[idx + 1] ** 2);
  
  assertClose(forceYMag, 0.0, 0.01, 'Force in Y should be ~zero for k_x mode');
  assertClose(forceZMag, 0.0, 0.01, 'Force in Z should be ~zero for k_x mode');
  
  assertAllFinite(resultX, 'ForceX should be finite');
  assertAllFinite(resultY, 'ForceY should be finite');
  assertAllFinite(resultZ, 'ForceZ should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPotentialSpectrum);
  gl.deleteTexture(outForceSpectrumX);
  gl.deleteTexture(outForceSpectrumY);
  gl.deleteTexture(outForceSpectrumZ);
  resetGL();
});

/**
 * Test 4: Multiple frequency modes
 */
test('KGradient: multiple frequency modes', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create multiple frequency components
  const inPotentialSpectrum = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 1 && y === 0) return [1.0, 0.0];    // k_x mode
    if (x === 0 && y === 1) return [0.5, 0.0];    // k_y mode
    if (x === 1 && y === 1) return [0.3, 0.3];    // diagonal mode
    return [0.0, 0.0];
  });
  const outForceSpectrumX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum,
    outForceSpectrumX,
    outForceSpectrumY,
    outForceSpectrumZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceSpectrumX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceSpectrumY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceSpectrumZ, textureSize, textureSize);
  
  // Check that each mode has corresponding non-zero forces
  const checkMode = (x, y, label) => {
    const idx = (y * textureSize + x) * 4;
    const fxMag = Math.sqrt(resultX[idx] ** 2 + resultX[idx + 1] ** 2);
    const fyMag = Math.sqrt(resultY[idx] ** 2 + resultY[idx + 1] ** 2);
    const fzMag = Math.sqrt(resultZ[idx] ** 2 + resultZ[idx + 1] ** 2);
    const totalMag = Math.sqrt(fxMag ** 2 + fyMag ** 2 + fzMag ** 2);
    
    assert.ok(totalMag > 0 || (x === 0 && y === 0), `${label} should produce non-zero force`);
  };
  
  checkMode(1, 0, 'k_x mode');
  checkMode(0, 1, 'k_y mode');
  checkMode(1, 1, 'diagonal mode');
  
  assertAllFinite(resultX, 'ForceX should be finite');
  assertAllFinite(resultY, 'ForceY should be finite');
  assertAllFinite(resultZ, 'ForceZ should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPotentialSpectrum);
  gl.deleteTexture(outForceSpectrumX);
  gl.deleteTexture(outForceSpectrumY);
  gl.deleteTexture(outForceSpectrumZ);
  resetGL();
});

/**
 * Test 5: Gradient operator is linear
 * ∇(aφ₁ + bφ₂) = a∇φ₁ + b∇φ₂
 */
test('KGradient: linearity of gradient operator', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create two different potential spectra
  const potential1 = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 1 && y === 0) return [1.0, 0.0];
    return [0.0, 0.0];
  });
  
  const potential2 = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 0 && y === 1) return [1.0, 0.0];
    return [0.0, 0.0];
  });
  
  // Combined potential (sum of both)
  const potentialSum = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 1 && y === 0) return [1.0, 0.0];
    if (x === 0 && y === 1) return [1.0, 0.0];
    return [0.0, 0.0];
  });
  
  // Create output textures for each
  const forceX1 = createTestTexture(gl, textureSize, textureSize, null);
  const forceY1 = createTestTexture(gl, textureSize, textureSize, null);
  const forceZ1 = createTestTexture(gl, textureSize, textureSize, null);
  
  const forceX2 = createTestTexture(gl, textureSize, textureSize, null);
  const forceY2 = createTestTexture(gl, textureSize, textureSize, null);
  const forceZ2 = createTestTexture(gl, textureSize, textureSize, null);
  
  const forceXSum = createTestTexture(gl, textureSize, textureSize, null);
  const forceYSum = createTestTexture(gl, textureSize, textureSize, null);
  const forceZSum = createTestTexture(gl, textureSize, textureSize, null);
  
  // Compute gradients
  const kernel1 = new KGradient({
    gl,
    inPotentialSpectrum: potential1,
    outForceSpectrumX: forceX1,
    outForceSpectrumY: forceY1,
    outForceSpectrumZ: forceZ1,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  kernel1.run();
  
  const kernel2 = new KGradient({
    gl,
    inPotentialSpectrum: potential2,
    outForceSpectrumX: forceX2,
    outForceSpectrumY: forceY2,
    outForceSpectrumZ: forceZ2,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  kernel2.run();
  
  const kernelSum = new KGradient({
    gl,
    inPotentialSpectrum: potentialSum,
    outForceSpectrumX: forceXSum,
    outForceSpectrumY: forceYSum,
    outForceSpectrumZ: forceZSum,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  kernelSum.run();
  
  // Read results
  const fx1 = readTexture(gl, forceX1, textureSize, textureSize);
  const fx2 = readTexture(gl, forceX2, textureSize, textureSize);
  const fxSum = readTexture(gl, forceXSum, textureSize, textureSize);
  
  // Check linearity: ∇(φ₁ + φ₂) ≈ ∇φ₁ + ∇φ₂
  for (let i = 0; i < textureSize * textureSize; i++) {
    const expected = fx1[i * 4] + fx2[i * 4];
    const actual = fxSum[i * 4];
    assertClose(actual, expected, 0.01, `Linearity at pixel ${i} real part`);
    
    const expectedImag = fx1[i * 4 + 1] + fx2[i * 4 + 1];
    const actualImag = fxSum[i * 4 + 1];
    assertClose(actualImag, expectedImag, 0.01, `Linearity at pixel ${i} imag part`);
  }
  
  // Cleanup
  disposeKernel(kernel1);
  disposeKernel(kernel2);
  disposeKernel(kernelSum);
  gl.deleteTexture(potential1);
  gl.deleteTexture(potential2);
  gl.deleteTexture(potentialSum);
  gl.deleteTexture(forceX1);
  gl.deleteTexture(forceY1);
  gl.deleteTexture(forceZ1);
  gl.deleteTexture(forceX2);
  gl.deleteTexture(forceY2);
  gl.deleteTexture(forceZ2);
  gl.deleteTexture(forceXSum);
  gl.deleteTexture(forceYSum);
  gl.deleteTexture(forceZSum);
  resetGL();
});

/**
 * Test 6: World size affects gradient magnitude
 * Smaller world size → larger k values → larger gradients
 */
test('KGradient: world size scaling', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create same potential for both tests
  const createPotential = () => createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 1 && y === 0) return [1.0, 0.0];
    return [0.0, 0.0];
  });
  
  const potential1 = createPotential();
  const forceX1 = createTestTexture(gl, textureSize, textureSize, null);
  const forceY1 = createTestTexture(gl, textureSize, textureSize, null);
  const forceZ1 = createTestTexture(gl, textureSize, textureSize, null);
  
  const potential2 = createPotential();
  const forceX2 = createTestTexture(gl, textureSize, textureSize, null);
  const forceY2 = createTestTexture(gl, textureSize, textureSize, null);
  const forceZ2 = createTestTexture(gl, textureSize, textureSize, null);
  
  // Large world size
  const kernel1 = new KGradient({
    gl,
    inPotentialSpectrum: potential1,
    outForceSpectrumX: forceX1,
    outForceSpectrumY: forceY1,
    outForceSpectrumZ: forceZ1,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [10.0, 10.0, 10.0]
  });
  kernel1.run();
  
  // Small world size (2.5x smaller)
  const kernel2 = new KGradient({
    gl,
    inPotentialSpectrum: potential2,
    outForceSpectrumX: forceX2,
    outForceSpectrumY: forceY2,
    outForceSpectrumZ: forceZ2,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  kernel2.run();
  
  const fx1 = readTexture(gl, forceX1, textureSize, textureSize);
  const fx2 = readTexture(gl, forceX2, textureSize, textureSize);
  
  // Read force at k=1 mode
  const idx = 1 * 4;
  const mag1 = Math.sqrt(fx1[idx] ** 2 + fx1[idx + 1] ** 2);
  const mag2 = Math.sqrt(fx2[idx] ** 2 + fx2[idx + 1] ** 2);
  
  // Smaller world → larger k → larger force
  assert.ok(mag2 > mag1, 'Smaller world size should produce larger gradient magnitude');
  
  // Check ratio is approximately inverse of world size ratio
  const ratio = mag2 / mag1;
  const expectedRatio = 10.0 / 4.0; // 2.5
  assertClose(ratio, expectedRatio, 0.5, 'Force scaling should match world size ratio');
  
  // Cleanup
  disposeKernel(kernel1);
  disposeKernel(kernel2);
  gl.deleteTexture(potential1);
  gl.deleteTexture(potential2);
  gl.deleteTexture(forceX1);
  gl.deleteTexture(forceY1);
  gl.deleteTexture(forceZ1);
  gl.deleteTexture(forceX2);
  gl.deleteTexture(forceY2);
  gl.deleteTexture(forceZ2);
  resetGL();
});

/**
 * Test 7: Gradient of pure imaginary potential
 */
test('KGradient: imaginary potential produces imaginary force', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Create pure imaginary potential spectrum
  const inPotentialSpectrum = createComplexTexture(gl, textureSize, (x, y) => {
    if (x === 1 && y === 0) return [0.0, 1.0]; // Pure imaginary k_x mode
    return [0.0, 0.0];
  });
  const outForceSpectrumX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceSpectrumZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum,
    outForceSpectrumX,
    outForceSpectrumY,
    outForceSpectrumZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [4.0, 4.0, 4.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceSpectrumX, textureSize, textureSize);
  
  // For imaginary potential, gradient should also be imaginary
  const idx = 1 * 4;
  const forceXReal = resultX[idx + 0];
  const forceXImag = resultX[idx + 1];
  
  // Should have non-zero imaginary component
  assert.ok(Math.abs(forceXImag) > 0.01, 'Imaginary potential should produce imaginary force');
  
  assertAllFinite(resultX, 'Force should be finite');
  
  // Cleanup
  disposeKernel(kernel);
  gl.deleteTexture(inPotentialSpectrum);
  gl.deleteTexture(outForceSpectrumX);
  gl.deleteTexture(outForceSpectrumY);
  gl.deleteTexture(outForceSpectrumZ);
  resetGL();
});
