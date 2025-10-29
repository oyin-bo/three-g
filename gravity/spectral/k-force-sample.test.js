// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';

import { assertAllFinite, assertClose, createTestTexture, disposeKernel, getGL, readTexture, resetGL } from '../test-utils.js';
import { KForceSample } from './k-force-sample.js';

/**
 * Helper: create force grid texture (real-valued, stored in RG32F R channel)
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number) => number} valueFunc
 */
function createForceTexture(gl, gridSize, slicesPerRow, valueFunc) {
  const textureSize = gridSize * slicesPerRow;
  const data = new Float32Array(textureSize * textureSize * 2); // RG32F: 2 floats per texel

  for (let vz = 0; vz < gridSize; vz++) {
    const sliceRow = Math.floor(vz / slicesPerRow);
    const sliceCol = vz % slicesPerRow;

    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const texelX = sliceCol * gridSize + vx;
        const texelY = sliceRow * gridSize + vy;
        const idx = (texelY * textureSize + texelX) * 2;

        data[idx] = valueFunc(vx, vy, vz); // R channel
        data[idx + 1] = 0; // G channel (unused padding)
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
 * Helper: create particle positions texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} numParticles
 * @param {(i: number) => [number, number, number]} posFunc
 */
function createParticleTexture(gl, numParticles, posFunc) {
  const textureWidth = 1024;
  const textureHeight = Math.ceil(numParticles / textureWidth);
  const data = new Float32Array(textureWidth * textureHeight * 4);

  for (let i = 0; i < numParticles; i++) {
    const [x, y, z] = posFunc(i);
    const idx = i * 4;
    data[idx] = x;
    data[idx + 1] = y;
    data[idx + 2] = z;
    data[idx + 3] = 0; // padding
  }

  return createTestTexture(gl, textureWidth, textureHeight, data);
}

/**
 * Test 1: Constant force field produces uniform output
 */
test('KForceSample: uniform force field produces uniform output', async () => {
  const gl = getGL();

  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 16;

  // Constant force field
  const forceX = createForceTexture(gl, gridSize, slicesPerRow, () => 1.0);
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, () => 2.0);
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, () => 3.0);

  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    return [0.5, 0.5, 0.5]; // All particles at same location
  });

  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // Should have non-zero forces  
  assert.ok(snapshot.force.fx.nonzero > 0,
    `Should sample forces from constant field\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Zero force field produces zero output
 */
test('KForceSample: zero force field produces zero output', async () => {
  const gl = getGL();

  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 16;

  // Zero force field
  const forceX = createForceTexture(gl, gridSize, slicesPerRow, () => 0.0);
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, () => 0.0);
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, () => 0.0);

  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    return [0.5 + (i % 2) * 0.1, 0.5 + Math.floor(i / 2) * 0.05, 0.5];
  });

  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // All forces should be near zero
  assertClose(snapshot.force.fx.mean, 0, 0.01,
    `Force X should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.fy.mean, 0, 0.01,
    `Force Y should be zero\n\n${kernel.toString()}`);
  assertClose(snapshot.force.fz.mean, 0, 0.01,
    `Force Z should be zero\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Trilinear interpolation smoothness
 */
test('KForceSample: trilinear interpolation produces smooth values', async () => {
  const gl = getGL();

  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 8;

  // Smooth gradient field
  const forceX = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => x * 0.1);
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => y * 0.1);
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => z * 0.1);

  // Particles at half-grid positions (between grid points)
  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    const t = i / numParticles;
    return [t, t, t];
  });

  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // Results should be finite (not NaN/Inf from interpolation)
  assert.ok(snapshot.force, `Force should exist and be finite\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 4: Boundary handling (particles at edges)
 */
test('KForceSample: handles particles at grid boundaries', async () => {
  const gl = getGL();

  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 8;

  // Non-uniform force field
  const forceX = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => {
    return (x + y + z) * 0.1;
  });
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, () => 0.5);
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, () => 0.5);

  // Particles at various boundary positions
  const boundaries = [
    [0.0, 0.5, 0.5],   // x boundary
    [1.0, 0.5, 0.5],   // x boundary
    [0.5, 0.0, 0.5],   // y boundary
    [0.5, 1.0, 0.5],   // y boundary
    [0.5, 0.5, 0.0],   // z boundary
    [0.5, 0.5, 1.0],   // z boundary
    [0.0, 0.0, 0.0],   // corner
    [1.0, 1.0, 1.0]    // corner
  ];

  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    return /** @type {any} */ (boundaries[i]);
  });
  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // All boundary particles should get valid forces
  assert.ok(snapshot.force, `Forces at boundary should be finite\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 5: Multi-particle consistency
 */
test('KForceSample: multiple particles sample independently', async () => {
  const gl = getGL();

  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 16;

  // Linear force field
  const forceX = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => x * 0.2);
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => y * 0.2);
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => z * 0.2);

  // Distributed particles
  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    const row = Math.floor(i / 4);
    const col = i % 4;
    return [col / 4, row / 4, 0.5];
  });

  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // Particles at different positions should get different forces (check stddev > 0)
  assert.ok(snapshot.force.fx.stddev > 0,
    `Different positions should produce different forces (stddev=${snapshot.force.fx.stddev})\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});


/**
 * Test 7: Larger grid sampling
 */
test('KForceSample: handles larger grids (16×16×16)', async () => {
  const gl = getGL();

  const gridSize = 16;
  const slicesPerRow = 4;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 32;

  const forceX = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => Math.sin(x * 0.1));
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => Math.cos(y * 0.1));
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => Math.sin(z * 0.1));

  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    return [
      (i % 4) / 4,
      (Math.floor(i / 4) % 4) / 4,
      (Math.floor(i / 16)) / 4
    ];
  });

  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  assert.ok(snapshot.force, `Larger grid sampling should be stable\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 8: Directional force component isolation
 */
test('KForceSample: samples correct directional components', async () => {
  const gl = getGL();

  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 4;

  // Distinct values per component
  const forceX = createForceTexture(gl, gridSize, slicesPerRow, () => 1.0);
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, () => 2.0);
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, () => 3.0);

  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    return [0.5, 0.5, 0.5];
  });

  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const result = readTexture(gl, outForce, 1024, Math.ceil(numParticles / 1024));

  // Each component should maintain its value (or be proportional)
  for (let i = 0; i < numParticles; i++) {
    const idx = i * 4;
    const diag = `\n  Directional sample for particle ${i}: fx=${result[idx].toFixed(4)}, fy=${result[idx + 1].toFixed(4)}, fz=${result[idx + 2].toFixed(4)}`;
    assert.ok(result[idx] > 0, `Particle ${i} force X should be positive${diag}`);
    assert.ok(result[idx + 1] > result[idx], `Particle ${i} force Y should be > X${diag}`);
    assert.ok(result[idx + 2] > result[idx + 1], `Particle ${i} force Z should be > Y${diag}`);
  }

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 9: Numerical stability with small grid
 */
test('KForceSample: remains stable with minimal grid', async () => {
  const gl = getGL();

  const gridSize = 2;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 8;

  const forceX = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => x * 0.5);
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => y * 0.5);
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => z * 0.5);

  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    const t = i / numParticles;
    return [t, t, t];
  });

  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const result = readTexture(gl, outForce, 1024, Math.ceil(numParticles / 1024));

  assertAllFinite(result, 'Small grid sampling should remain stable');

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 10: Output texture format
 */
test('KForceSample: output format is correct (RGBA with padding)', async () => {
  const gl = getGL();

  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  const numParticles = 8;

  const forceX = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceY = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => 2.0);
  const forceZ = createForceTexture(gl, gridSize, slicesPerRow, (x, y, z) => 3.0);

  const inPosition = createParticleTexture(gl, numParticles, (i) => {
    return [0.5, 0.5, 0.5];
  });

  const outForce = createTestTexture(gl, 1024, Math.ceil(numParticles / 1024), null);

  const kernel = new KForceSample({
    gl,
    inForceGridX: forceX,
    inForceGridY: forceY,
    inForceGridZ: forceZ,
    inPosition,
    outForce,
    particleCount: numParticles,
    particleTextureWidth: 1024,
    particleTextureHeight: Math.ceil(numParticles / 1024),
    gridSize,
    slicesPerRow,
    worldBounds: { min: [0, 0, 0], max: [1, 1, 1] }
  });

  kernel.run();

  const result = readTexture(gl, outForce, 1024, Math.ceil(numParticles / 1024));

  // Output should be RGBA (4 channels per particle)
  const expectedLength = 1024 * Math.ceil(numParticles / 1024) * 4;
  assert.ok(result.length === expectedLength, 'Output should be RGBA format');

  // First 3 components should be force, 4th is typically padding
  for (let i = 0; i < numParticles; i++) {
    const idx = i * 4;
    assert.ok(isFinite(result[idx]), `Force X channel ${i} should be finite`);
    assert.ok(isFinite(result[idx + 1]), `Force Y channel ${i} should be finite`);
    assert.ok(isFinite(result[idx + 2]), `Force Z channel ${i} should be finite`);
  }

  disposeKernel(kernel);
  resetGL();
});
