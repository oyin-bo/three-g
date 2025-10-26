// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';

import { GravityMonopole } from './gravity-monopole.js';

/**
 * Create offscreen canvas with WebGL2 context
 * @returns {{canvas: HTMLCanvasElement, gl: WebGL2RenderingContext}}
 */
function createTestCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const gl = canvas.getContext('webgl2');

  if (!gl) {
    throw new Error('WebGL2 not supported');
  }

  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) {
    throw new Error('EXT_color_buffer_float not supported');
  }

  return { canvas, gl };
}

/**
 * Read all particle data
 * @param {GravityMonopole} system
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function readAllParticleData(system) {
  const gl = system.gl;
  const texWidth = system.textureWidth;
  const texHeight = system.textureHeight;

  const posTex = system.positionTexture;
  const velTex = system.velocityTexture;

  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  const positions = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, positions);

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, velocities);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);

  return { positions, velocities };
}

/**
 * Check all values are finite
 * @param {Float32Array} array
 * @returns {boolean}
 */
function allFinite(array) {
  for (let i = 0; i < array.length; i++) {
    if (!isFinite(array[i])) return false;
  }
  return true;
}

/**
 * Test 1: High velocity particles
 */
test('monopole-kernels.stability: high velocity particles remain stable', async () => {
  const { canvas, gl } = createTestCanvas();

  const particleCount = 20;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);

  // Create particles with high velocities (padded to texture size)
  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);

  let seed = 111;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }

  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (random() - 0.5) * 6;
    positions[i * 4 + 1] = (random() - 0.5) * 6;
    positions[i * 4 + 2] = (random() - 0.5) * 6;
    positions[i * 4 + 3] = 1.0;

    // High velocities
    velocities[i * 4 + 0] = (random() - 0.5) * 4.0;
    velocities[i * 4 + 1] = (random() - 0.5) * 4.0;
    velocities[i * 4 + 2] = (random() - 0.5) * 4.0;
    velocities[i * 4 + 3] = 0;
  }

  const system = new GravityMonopole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-20, -20, -20], max: [20, 20, 20] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.3,
    maxSpeed: 10.0, // Allow high speeds
    maxAccel: 5.0
  });

  // Step simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }

  // Check stability - no NaN or Inf
  const finalData = readAllParticleData(system);

  assert.ok(allFinite(finalData.positions), 'Positions should remain finite with high velocities');
  assert.ok(allFinite(finalData.velocities), 'Velocities should remain finite with high velocities');

  // Count particles that diverged to extreme positions
  let extremeCount = 0;
  for (let i = 0; i < particleCount; i++) {
    const x = finalData.positions[i * 4 + 0];
    const y = finalData.positions[i * 4 + 1];
    const z = finalData.positions[i * 4 + 2];
    const r = Math.sqrt(x * x + y * y + z * z);
    if (r > 50) extremeCount++;
  }

  // Most particles should still be in reasonable range
  const retentionRate = (particleCount - extremeCount) / particleCount;
  assert.ok(retentionRate > 0.5,
    `At least 50% particles should remain in simulation: ${(retentionRate * 100).toFixed(1)}%`);

  system.dispose();
  canvas.remove();
});

/**
 * Test 2: Very small timestep
 */
test('monopole-kernels.stability: very small timestep produces stable results', async () => {
  const { canvas, gl } = createTestCanvas();

  const particleCount = 10;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);

  const positions = new Float32Array(textureWidth * textureHeight * 4);
  positions.set([
    -1, 0, 0, 1.0,
    1, 0, 0, 1.0,
    0, -1, 0, 1.0,
    0, 1, 0, 1.0,
    0, 0, -1, 1.0,
    0, 0, 1, 1.0,
    -0.5, -0.5, 0, 1.0,
    0.5, -0.5, 0, 1.0,
    -0.5, 0.5, 0, 1.0,
    0.5, 0.5, 0, 1.0
  ]);

  const velocities = new Float32Array(textureWidth * textureHeight * 4); // all zeros

  // Very small timestep
  const system = new GravityMonopole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.0001, // Very small timestep
    gravityStrength: 0.0003,
    softening: 0.15
  });

  // Many steps to simulate same total time
  for (let i = 0; i < 1000; i++) {
    system.step();
  }

  // Check stability
  const finalData = readAllParticleData(system);

  assert.ok(allFinite(finalData.positions), 'Positions finite with small timestep');
  assert.ok(allFinite(finalData.velocities), 'Velocities finite with small timestep');

  // Verify particles moved (not stuck)
  let totalMovement = 0;
  for (let i = 0; i < particleCount; i++) {
    const dx = finalData.positions[i * 4 + 0] - positions[i * 4 + 0];
    const dy = finalData.positions[i * 4 + 1] - positions[i * 4 + 1];
    const dz = finalData.positions[i * 4 + 2] - positions[i * 4 + 2];
    totalMovement += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  assert.ok(totalMovement > 0.001,
    `Particles should move with small timestep: total movement=${totalMovement.toFixed(6)}`);

  system.dispose();
  canvas.remove();
});

/**
 * Test 3: Very large timestep
 */
test('monopole-kernels.stability: large timestep handled without crash', async () => {
  const { canvas, gl } = createTestCanvas();

  const particleCount = 10;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);

  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);

  let seed = 333;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }

  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (random() - 0.5) * 4;
    positions[i * 4 + 1] = (random() - 0.5) * 4;
    positions[i * 4 + 2] = (random() - 0.5) * 4;
    positions[i * 4 + 3] = 1.0;

    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }

  // Large timestep
  const system = new GravityMonopole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-10, -10, -10], max: [10, 10, 10] },
    dt: 0.5, // Large timestep
    gravityStrength: 0.0003,
    softening: 0.5, // Increase softening to help stability
    maxSpeed: 20.0,
    maxAccel: 10.0
  });

  // Step a few times - should not crash even if results are inaccurate
  let crashed = false;
  try {
    for (let i = 0; i < 20; i++) {
      system.step();
    }
  } catch (e) {
    crashed = true;
  }

  assert.ok(!crashed, 'System should not crash with large timestep');

  // Check for GL errors
  const glError = gl.getError();
  assert.strictEqual(glError, gl.NO_ERROR, `No GL errors with large timestep: ${glError}`);

  // Results may be inaccurate but should be finite
  const finalData = readAllParticleData(system);

  // At minimum, should not have NaN values
  let hasNaN = false;
  for (let i = 0; i < finalData.positions.length; i++) {
    if (isNaN(finalData.positions[i]) || isNaN(finalData.velocities[i])) {
      hasNaN = true;
      break;
    }
  }

  assert.ok(!hasNaN, 'No NaN values even with large timestep');

  system.dispose();
  canvas.remove();
});

/**
 * Test 4: Extreme particle counts (boundary testing)
 */
test('monopole-kernels.stability: handles single and minimal particle counts', async () => {
  const { canvas, gl } = createTestCanvas();

  // Test with 1 particle
  {
    const positions = new Float32Array(4);  // 1x1 texture = 4 floats
    positions.set([0, 0, 0, 1.0]);
    const velocities = new Float32Array(4);  // Padded to match texture

    const system = new GravityMonopole({
      gl,
      particleData: { positions, velocities },
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.15
    });

    // Should not crash with single particle
    for (let i = 0; i < 10; i++) {
      system.step();
    }

    const data = readAllParticleData(system);
    assert.ok(allFinite(data.positions), 'Single particle positions finite');
    assert.ok(allFinite(data.velocities), 'Single particle velocities finite');

    system.dispose();
  }

  // Test with 2 particles (minimal interaction)
  {
    const positions = new Float32Array(8);  // 2x2 texture = 8 floats
    positions.set([-1, 0, 0, 1.0, 1, 0, 0, 1.0]);
    const velocities = new Float32Array(8);  // Padded to match texture
    velocities.set([0, 0.1, 0, 0, 0, -0.1, 0, 0]);

    const system = new GravityMonopole({
      gl,
      particleData: { positions, velocities },
      worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.15
    });

    for (let i = 0; i < 50; i++) {
      system.step();
    }

    const data = readAllParticleData(system);
    assert.ok(allFinite(data.positions), 'Two particle positions finite');
    assert.ok(allFinite(data.velocities), 'Two particle velocities finite');

    system.dispose();
  }

  canvas.remove();
});
