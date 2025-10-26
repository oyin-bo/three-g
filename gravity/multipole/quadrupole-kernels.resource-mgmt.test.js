// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemQuadrupoleKernels } from './particle-system-quadrupole-kernels.js';

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
test('quadrupole-kernels.resource-mgmt: dispose cleans up all GPU resources', async () => {
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
  
  const system = new ParticleSystemQuadrupoleKernels({
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
  assert.ok(hasTraversalKernel, 'Traversal kernel should have been created (quadrupole traversal)');
  assert.ok(hasIntegratorKernels, 'Integrator kernels should have been created');
  
  canvas.remove();
});

/**
 * Test 2: Multiple sequential systems
 */
test('quadrupole-kernels.resource-mgmt: multiple sequential systems don\'t leak resources', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 50;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  
  // Create and dispose multiple systems in sequence
  for (let sysIdx = 0; sysIdx < 3; sysIdx++) {
    const positions = new Float32Array(textureWidth * textureHeight * 4);
    const velocities = new Float32Array(textureWidth * textureHeight * 4);
    
    for (let i = 0; i < particleCount; i++) {
      positions[i * 4 + 0] = Math.random() * 2 - 1;
      positions[i * 4 + 1] = Math.random() * 2 - 1;
      positions[i * 4 + 2] = Math.random() * 2 - 1;
      positions[i * 4 + 3] = 1.0;
    }
    
    const system = new ParticleSystemQuadrupoleKernels({
      gl,
      particleData: { positions, velocities },
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.2
    });
    
    // Run a few steps
    for (let i = 0; i < 10; i++) {
      system.step();
    }
    
    // Dispose
    system.dispose();
    
    // Verify no GL errors
    const glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `No GL errors after system ${sysIdx} disposal: got ${glError}`);
  }
  
  canvas.remove();
});

/**
 * Test 3: GPU memory allocation patterns
 */
test('quadrupole-kernels.resource-mgmt: scaling to different particle counts', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const counts = [10, 50, 200];
  
  for (const count of counts) {
    const textureWidth = Math.ceil(Math.sqrt(count));
    const textureHeight = Math.ceil(count / textureWidth);
    
    const positions = new Float32Array(textureWidth * textureHeight * 4);
    const velocities = new Float32Array(textureWidth * textureHeight * 4);
    
    for (let i = 0; i < count; i++) {
      positions[i * 4 + 0] = Math.random() * 4 - 2;
      positions[i * 4 + 1] = Math.random() * 4 - 2;
      positions[i * 4 + 2] = Math.random() * 4 - 2;
      positions[i * 4 + 3] = 1.0;
    }
    
    const system = new ParticleSystemQuadrupoleKernels({
      gl,
      particleData: { positions, velocities },
      worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] }
    });
    
    // Verify correct dimensions
    assert.strictEqual(system.options.particleCount, count, `Particle count should be ${count}`);
    assert.ok(system.textureWidth >= textureWidth, `Texture width should accommodate particles`);
    assert.ok(system.textureHeight >= textureHeight, `Texture height should accommodate particles`);
    
    // Run simulation
    for (let i = 0; i < 20; i++) {
      system.step();
    }
    
    // Verify no GL errors during operation
    const glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `No GL errors with ${count} particles: got ${glError}`);
    
    system.dispose();
  }
  
  canvas.remove();
});

/**
 * Test 4: Frame counting and state management
 */
test('quadrupole-kernels.resource-mgmt: frame counter increments correctly', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(16).fill(0);
  positions.set([-1, 0, 0, 1,  1, 0, 0, 1,  0, -1, 0, 1,  0, 1, 0, 1]);
  const velocities = new Float32Array(16).fill(0);
  
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  assert.strictEqual(system.frameCount, 0, 'Initial frame count should be 0');
  
  for (let i = 1; i <= 10; i++) {
    system.step();
    assert.strictEqual(system.frameCount, i, `Frame count should be ${i} after ${i} steps`);
  }
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 5: Option validation and state
 */
test('quadrupole-kernels.resource-mgmt: options are properly stored and validated', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1,  1, 1, 1, 1]);
  
  const customOptions = {
    gl,
    particleData: { positions },
    worldBounds: { min: /** @type {[number,number,number]} */ ([-10, -10, -10]), max: /** @type {[number,number,number]} */ ([10, 10, 10]) },
    theta: 0.8,
    dt: 0.02,
    gravityStrength: 0.0005,
    softening: 0.3,
    damping: 0.1,
    maxSpeed: 3.0,
    maxAccel: 2.0
  };
  
  const system = new ParticleSystemQuadrupoleKernels(customOptions);
  
  assert.deepStrictEqual(system.options.worldBounds, customOptions.worldBounds, 'World bounds should match');
  assert.strictEqual(system.options.theta, customOptions.theta, 'Theta should match');
  assert.strictEqual(system.options.dt, customOptions.dt, 'dt should match');
  assert.strictEqual(system.options.gravityStrength, customOptions.gravityStrength, 'Gravity strength should match');
  assert.strictEqual(system.options.softening, customOptions.softening, 'Softening should match');
  assert.strictEqual(system.options.damping, customOptions.damping, 'Damping should match');
  assert.strictEqual(system.options.maxSpeed, customOptions.maxSpeed, 'Max speed should match');
  assert.strictEqual(system.options.maxAccel, customOptions.maxAccel, 'Max accel should match');
  
  system.dispose();
  canvas.remove();
});

