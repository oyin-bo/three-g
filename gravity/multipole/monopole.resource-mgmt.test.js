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
 * Test 1: Disposal cleanup verification
 */
test('monopole-kernels.resource-mgmt: dispose cleans up all GPU resources', async () => {
  const { canvas, gl } = createTestCanvas();

  const particleCount = 100;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);

  let seed = 999;
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

  const system = new GravityMonopole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  // Run a few steps to ensure system is fully initialized
  for (let i = 0; i < 5; i++) {
    system.step();
  }

  // Collect references to GPU resources before disposal
  const posTexture = system.positionTexture;
  const posTextureWrite = system.positionTextureWrite;
  const velTexture = system.velocityTexture;
  const velTextureWrite = system.velocityTextureWrite;

  // Kernels own internal resources (aggregator, pyramid, traversal)
  // We'll verify they dispose properly
  const hasAggregatorKernel = !!system.aggregatorKernel;
  const hasPyramidKernels = system.pyramidKernels && system.pyramidKernels.length > 0;
  const hasTraversalKernel = !!system.traversalKernel;
  const hasIntegratorKernels = !!system.velocityKernel && !!system.positionKernel;

  // Dispose system
  system.dispose();

  // Verify particle textures are deleted
  assert.ok(!gl.isTexture(posTexture), `Position texture should be deleted`);
  assert.ok(!gl.isTexture(posTextureWrite), `Position write texture should be deleted`);
  assert.ok(!gl.isTexture(velTexture), `Velocity texture should be deleted`);
  assert.ok(!gl.isTexture(velTextureWrite), `Velocity write texture should be deleted`);

  // Verify no GL errors after disposal
  const glError = gl.getError();
  assert.strictEqual(glError, gl.NO_ERROR, `No GL errors after disposal: got ${glError}`);

  // Verify kernels existed (just a sanity check they were initialized)
  assert.ok(hasAggregatorKernel, 'Aggregator kernel should have been created');
  assert.ok(hasPyramidKernels, 'Pyramid kernels should have been created');
  assert.ok(hasTraversalKernel, 'Traversal kernel should have been created');
  assert.ok(hasIntegratorKernels, 'Integrator kernels should have been created');

  canvas.remove();
});

/**
 * Test 2: Texture reuse (system recreation)
 */
test('monopole-kernels.resource-mgmt: system can be recreated with same context', async () => {
  const { canvas, gl } = createTestCanvas();

  const particleCount = 50;

  function createParticleData() {
    const textureWidth = Math.ceil(Math.sqrt(particleCount));
    const textureHeight = Math.ceil(particleCount / textureWidth);
    const positions = new Float32Array(textureWidth * textureHeight * 4);
    const velocities = new Float32Array(textureWidth * textureHeight * 4);

    let seed = 111 + Math.random() * 1000;
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

    return { positions, velocities };
  }

  // Create and dispose first system
  {
    const data = createParticleData();
    const system1 = new GravityMonopole({
      gl,
      particleData: data,
      worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.2
    });

    for (let i = 0; i < 5; i++) {
      system1.step();
    }

    system1.dispose();

    // Check no GL errors
    let glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `No GL errors after first system disposal: ${glError}`);
  }

  // Create second system with same context
  {
    const data = createParticleData();
    const system2 = new GravityMonopole({
      gl,
      particleData: data,
      worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.2
    });

    // Should work without issues
    for (let i = 0; i < 5; i++) {
      system2.step();
    }

    // Read data to verify it's working
    const texWidth = system2.textureWidth;
    const texHeight = system2.textureHeight;
    const posTex = system2.positionTexture;

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);

    const positions = new Float32Array(texWidth * texHeight * 4);
    gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, positions);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);

    // Verify data is finite
    let allFinite = true;
    for (let i = 0; i < particleCount * 4; i++) {
      if (!isFinite(positions[i])) {
        allFinite = false;
        break;
      }
    }

    assert.ok(allFinite, 'Second system should produce finite results');

    system2.dispose();

    // Check no GL errors
    let glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `No GL errors after second system disposal: ${glError}`);
  }

  // Create third system to verify context is still usable
  {
    const data = createParticleData();
    const system3 = new GravityMonopole({
      gl,
      particleData: data,
      worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.2
    });

    system3.step();

    const glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `Third system should work: ${glError}`);

    system3.dispose();
  }

  canvas.remove();
});

/**
 * Test 3: Concurrent systems (multiple contexts)
 */
test('monopole-kernels.resource-mgmt: multiple systems with different contexts', async () => {
  const { canvas: canvas1, gl: gl1 } = createTestCanvas();
  const { canvas: canvas2, gl: gl2 } = createTestCanvas();

  const particleCount = 25;

  function createParticleData(seed) {
    const textureWidth = Math.ceil(Math.sqrt(particleCount));
    const textureHeight = Math.ceil(particleCount / textureWidth);
    const positions = new Float32Array(textureWidth * textureHeight * 4);
    const velocities = new Float32Array(textureWidth * textureHeight * 4);

    let s = /** @type {number} */ (seed);
    function random() {
      s = (s * 1664525 + 1013904223) | 0;
      return (s >>> 0) / 4294967296;
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

    return { positions, velocities };
  }

  // Create systems on different contexts
  const system1 = new GravityMonopole({
    gl: gl1,
    particleData: createParticleData(42),
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  const system2 = new GravityMonopole({
    gl: gl2,
    particleData: createParticleData(123),
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  // Step both systems independently
  for (let i = 0; i < 3; i++) {
    system1.step();
    system2.step();
  }

  // Verify both produce valid results
  const texWidth1 = system1.textureWidth;
  const texHeight1 = system1.textureHeight;
  const posTex1 = system1.positionTexture;

  const fbo1 = gl1.createFramebuffer();
  gl1.bindFramebuffer(gl1.FRAMEBUFFER, fbo1);
  gl1.framebufferTexture2D(gl1.FRAMEBUFFER, gl1.COLOR_ATTACHMENT0, gl1.TEXTURE_2D, posTex1, 0);
  const positions1 = new Float32Array(texWidth1 * texHeight1 * 4);
  gl1.readPixels(0, 0, texWidth1, texHeight1, gl1.RGBA, gl1.FLOAT, positions1);
  gl1.bindFramebuffer(gl1.FRAMEBUFFER, null);
  gl1.deleteFramebuffer(fbo1);

  const texWidth2 = system2.textureWidth;
  const texHeight2 = system2.textureHeight;
  const posTex2 = system2.positionTexture;

  const fbo2 = gl2.createFramebuffer();
  gl2.bindFramebuffer(gl2.FRAMEBUFFER, fbo2);
  gl2.framebufferTexture2D(gl2.FRAMEBUFFER, gl2.COLOR_ATTACHMENT0, gl2.TEXTURE_2D, posTex2, 0);
  const positions2 = new Float32Array(texWidth2 * texHeight2 * 4);
  gl2.readPixels(0, 0, texWidth2, texHeight2, gl2.RGBA, gl2.FLOAT, positions2);
  gl2.bindFramebuffer(gl2.FRAMEBUFFER, null);
  gl2.deleteFramebuffer(fbo2);

  // Verify both are finite
  let allFinite1 = true;
  for (let i = 0; i < particleCount * 4; i++) {
    if (!isFinite(positions1[i])) {
      allFinite1 = false;
      break;
    }
  }

  let allFinite2 = true;
  for (let i = 0; i < particleCount * 4; i++) {
    if (!isFinite(positions2[i])) {
      allFinite2 = false;
      break;
    }
  }

  assert.ok(allFinite1, 'System 1 should produce finite results');
  assert.ok(allFinite2, 'System 2 should produce finite results');

  // Dispose both
  system1.dispose();
  system2.dispose();

  // Verify contexts still valid
  const glError1 = gl1.getError();
  const glError2 = gl2.getError();
  assert.strictEqual(glError1, gl1.NO_ERROR, `GL1 should have no errors: ${glError1}`);
  assert.strictEqual(glError2, gl2.NO_ERROR, `GL2 should have no errors: ${glError2}`);

  canvas1.remove();
  canvas2.remove();
});
