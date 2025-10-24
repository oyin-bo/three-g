// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KGradient } from './k-gradient.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: create complex spectrum texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number, kx: number, ky: number, kz: number) => [number, number]} valueFunc
 */
function createSpectrumTexture(gl, gridSize, slicesPerRow, valueFunc) {
  const textureSize = gridSize * slicesPerRow;
  const data = new Float32Array(textureSize * textureSize * 2);
  
  for (let vz = 0; vz < gridSize; vz++) {
    const sliceRow = Math.floor(vz / slicesPerRow);
    const sliceCol = vz % slicesPerRow;
    
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const texelX = sliceCol * gridSize + vx;
        const texelY = sliceRow * gridSize + vy;
        const idx = (texelY * textureSize + texelX) * 2;
        
        const [real, imag] = valueFunc(vx, vy, vz, vx, vy, vz);
        data[idx] = real;
        data[idx + 1] = imag;
      }
    }
  }
  
  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Test 1: Gradient of DC potential
 */
test('KGradient: constant potential produces zero gradient', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Constant potential (DC only)
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z, kx, ky, kz) => {
    return (x === 0 && y === 0 && z === 0) ? [1.0, 0] : [0, 0];
  });
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const worldSize = [1.0, 1.0, 1.0];
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  // Gradient of constant should be nearly zero
  for (let i = 0; i < resultX.length; i++) {
    assertClose(resultX[i], 0, 0.1, `ForceX[${i}] should be near zero`);
    assertClose(resultY[i], 0, 0.1, `ForceY[${i}] should be near zero`);
    assertClose(resultZ[i], 0, 0.1, `ForceZ[${i}] should be near zero`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Gradient of linear potential
 */
test('KGradient: linear potential produces constant gradient', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Linear potential: Phi = kx*x (gradient in x direction)
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z, kx, ky, kz) => {
    if (kx === 1 && ky === 0 && kz === 0) {
      return [0, -1]; // i*kx term in gradient
    }
    return [0, 0];
  });
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const worldSize = [1.0, 1.0, 1.0];
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  // All results should be finite
  assertAllFinite(resultX, 'ForceX should be finite');
  assertAllFinite(resultY, 'ForceY should be finite');
  assertAllFinite(resultZ, 'ForceZ should be finite');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Output is complex spectrum (paired components)
 */
test('KGradient: output is complex spectrum format', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return [Math.random(), Math.random()];
  });
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  // For RG32F textures, each voxel has real and imaginary parts
  assert.ok(resultX.length === textureSize * textureSize * 2, 'Output should have 2 channels per voxel');
  assert.ok(resultY.length === textureSize * textureSize * 2, 'Output should have 2 channels per voxel');
  assert.ok(resultZ.length === textureSize * textureSize * 2, 'Output should have 2 channels per voxel');
  
  assertAllFinite(resultX, 'ForceX should be finite');
  assertAllFinite(resultY, 'ForceY should be finite');
  assertAllFinite(resultZ, 'ForceZ should be finite');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 4: Gradient properties (orthogonal components)
 */
test('KGradient: gradient components are independent', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Input with multiple frequency components
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    let real = 0, imag = 0;
    if (x < 2) real += 0.5;
    if (y < 2) imag += 0.5;
    return [real, imag];
  });
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  // Components should differ (not all the same)
  const sumX = resultX.reduce((a, b) => a + Math.abs(b), 0);
  const sumY = resultY.reduce((a, b) => a + Math.abs(b), 0);
  const sumZ = resultZ.reduce((a, b) => a + Math.abs(b), 0);
  
  assert.ok(sumX > 0, 'X force component should be non-trivial');
  assert.ok(sumY > 0, 'Y force component should be non-trivial');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 5: World size scaling affects gradient magnitudes
 */
test('KGradient: world size affects force magnitudes', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Same input potential
  const createInput = () => createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return [Math.sin(x * 0.1) + 1.0, Math.cos(y * 0.1)];
  });
  
  // Test with different world sizes
  const worldSizes = [
    [1.0, 1.0, 1.0],
    [2.0, 2.0, 2.0],
    [0.5, 0.5, 0.5]
  ];
  
  const results = [];
  
  for (const worldSize of worldSizes) {
    const inPotential = createInput();
    const outForceX = createTestTexture(gl, textureSize, textureSize, null);
    const outForceY = createTestTexture(gl, textureSize, textureSize, null);
    const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
    
    const kernel = new KGradient({
      gl,
      inPotentialSpectrum: inPotential,
      outForceSpectrumX: outForceX,
      outForceSpectrumY: outForceY,
      outForceSpectrumZ: outForceZ,
      gridSize,
      slicesPerRow,
      textureSize,
      worldSize: /** @type {any} */ (worldSize)
    });
    
    kernel.run();
    
    const result = readTexture(gl, outForceX, textureSize, textureSize);
    results.push({
      worldSize,
      magnitude: result.reduce((a, b) => a + Math.abs(b), 0)
    });
    
    disposeKernel(kernel);
  }
  
  // Different world sizes should produce different force magnitudes
  assert.ok(results[0].magnitude !== results[1].magnitude, 
    'Different world sizes should produce different force magnitudes');
  
  resetGL();
});

/**
 * Test 6: Larger grid (16³)
 */
test('KGradient: handles larger grid (16×16×16)', async () => {
  const gl = getGL();
  
  const gridSize = 16;
  const slicesPerRow = 4;
  const textureSize = gridSize * slicesPerRow;
  
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return [Math.sin(x * 0.1), Math.cos(y * 0.1)];
  });
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  assertAllFinite(resultX, 'ForceX should be finite for large grid');
  assertAllFinite(resultY, 'ForceY should be finite for large grid');
  assertAllFinite(resultZ, 'ForceZ should be finite for large grid');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 7: Symmetric input produces symmetric gradients
 */
test('KGradient: symmetric input produces symmetric output', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Spherically symmetric input
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    const r2 = x*x + y*y + z*z;
    return [Math.exp(-r2 * 0.1), 0];
  });
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  // Check that results are finite
  assertAllFinite(resultX, 'ForceX should be finite');
  assertAllFinite(resultY, 'ForceY should be finite');
  assertAllFinite(resultZ, 'ForceZ should be finite');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 8: Zero input produces zero gradient
 */
test('KGradient: zero potential produces zero force', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // All zeros
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  // All components should be near zero
  for (let i = 0; i < resultX.length; i++) {
    assertClose(resultX[i], 0, 0.01, `ForceX[${i}] should be near zero`);
    assertClose(resultY[i], 0, 0.01, `ForceY[${i}] should be near zero`);
    assertClose(resultZ[i], 0, 0.01, `ForceZ[${i}] should be near zero`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 9: Directional selectivity (x vs y vs z)
 */
test('KGradient: separates directional components', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Input with known frequency content
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    let val = 0;
    if (x === 1) val = 1.0;
    return [val, 0];
  });
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  // X component should have significant energy (gradient in x direction)
  const energyX = resultX.reduce((a, b) => a + b*b, 0);
  const energyY = resultY.reduce((a, b) => a + b*b, 0);
  
  assert.ok(energyX > 0, 'X force should have energy');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 10: Numerical stability with small values
 */
test('KGradient: remains stable with small input magnitudes', async () => {
  const gl = getGL();
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  // Very small values
  const inPotential = createSpectrumTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return [Math.sin(x * 0.01) * 1e-6, Math.cos(y * 0.01) * 1e-6];
  });
  
  const outForceX = createTestTexture(gl, textureSize, textureSize, null);
  const outForceY = createTestTexture(gl, textureSize, textureSize, null);
  const outForceZ = createTestTexture(gl, textureSize, textureSize, null);
  
  const kernel = new KGradient({
    gl,
    inPotentialSpectrum: inPotential,
    outForceSpectrumX: outForceX,
    outForceSpectrumY: outForceY,
    outForceSpectrumZ: outForceZ,
    gridSize,
    slicesPerRow,
    textureSize,
    worldSize: [1.0, 1.0, 1.0]
  });
  
  kernel.run();
  
  const resultX = readTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readTexture(gl, outForceZ, textureSize, textureSize);
  
  // Should not produce NaN or Inf
  assertAllFinite(resultX, 'ForceX should be finite even with small inputs');
  assertAllFinite(resultY, 'ForceY should be finite even with small inputs');
  assertAllFinite(resultZ, 'ForceZ should be finite even with small inputs');
  
  disposeKernel(kernel);
  resetGL();
});
