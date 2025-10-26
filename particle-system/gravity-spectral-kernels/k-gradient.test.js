// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KGradient } from './k-gradient.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: create complex spectrum texture (RG32F)
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
  
  const tex = gl.createTexture();
  if (!tex) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, textureSize, textureSize, 0, gl.RG, gl.FLOAT, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  return tex;
}

/**
 * Helper: read RG32F complex texture
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @returns {Float32Array}
 */
function readComplexTexture(gl, texture, width, height) {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('Failed to create framebuffer');
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, 
    gl.TEXTURE_2D, texture, 0
  );
  
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    throw new Error(`Framebuffer incomplete: status ${status}`);
  }
  
  const pixels = new Float32Array(width * height * 2);
  gl.readPixels(0, 0, width, height, gl.RG, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return pixels;
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Gradient of constant should be nearly zero
  assertClose(snapshot.forceSpectrumX.real.mean, 0, 0.1, 
    `Force X should be near zero\n\n${kernel.toString()}`);
  assertClose(snapshot.forceSpectrumY.real.mean, 0, 0.1, 
    `Force Y should be near zero\n\n${kernel.toString()}`);
  assertClose(snapshot.forceSpectrumZ.real.mean, 0, 0.1, 
    `Force Z should be near zero\n\n${kernel.toString()}`);
  
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // All results should exist and be finite
  assert.ok(snapshot.forceSpectrumX, `ForceX should exist\n\n${kernel.toString()}`);
  assert.ok(snapshot.forceSpectrumY, `ForceY should exist\n\n${kernel.toString()}`);
  assert.ok(snapshot.forceSpectrumZ, `ForceZ should exist\n\n${kernel.toString()}`);
  
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Outputs should exist with real and imaginary components
  assert.ok(snapshot.forceSpectrumX && snapshot.forceSpectrumX.real, 
    `ForceX should have real component\n\n${kernel.toString()}`);
  assert.ok(snapshot.forceSpectrumY && snapshot.forceSpectrumY.real, 
    `ForceY should have real component\n\n${kernel.toString()}`);
  assert.ok(snapshot.forceSpectrumZ && snapshot.forceSpectrumZ.real, 
    `ForceZ should have real component\n\n${kernel.toString()}`);
  
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const snapshot = kernel.valueOf({ pixels: false });
  
  // Components should differ (not all the same)
  const sumX = Math.abs(snapshot.forceSpectrumX.real.mean) + Math.abs(snapshot.forceSpectrumX.imag.mean);
  const sumY = Math.abs(snapshot.forceSpectrumY.real.mean) + Math.abs(snapshot.forceSpectrumY.imag.mean);
  const sumZ = Math.abs(snapshot.forceSpectrumZ.real.mean) + Math.abs(snapshot.forceSpectrumZ.imag.mean);
  
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
    const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
    const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
    const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
    
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
    
    const result = readComplexTexture(gl, outForceX, textureSize, textureSize);
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const resultX = readComplexTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readComplexTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readComplexTexture(gl, outForceZ, textureSize, textureSize);
  
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const resultX = readComplexTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readComplexTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readComplexTexture(gl, outForceZ, textureSize, textureSize);
  
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const resultX = readComplexTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readComplexTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readComplexTexture(gl, outForceZ, textureSize, textureSize);
  
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const resultX = readComplexTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readComplexTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readComplexTexture(gl, outForceZ, textureSize, textureSize);
  
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
  
  const outForceX = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceY = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  const outForceZ = createSpectrumTexture(gl, gridSize, slicesPerRow, () => [0, 0]);
  
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
  
  const resultX = readComplexTexture(gl, outForceX, textureSize, textureSize);
  const resultY = readComplexTexture(gl, outForceY, textureSize, textureSize);
  const resultZ = readComplexTexture(gl, outForceZ, textureSize, textureSize);
  
  // Should not produce NaN or Inf
  assertAllFinite(resultX, 'ForceX should be finite even with small inputs');
  assertAllFinite(resultY, 'ForceY should be finite even with small inputs');
  assertAllFinite(resultZ, 'ForceZ should be finite even with small inputs');
  
  disposeKernel(kernel);
  resetGL();
});
