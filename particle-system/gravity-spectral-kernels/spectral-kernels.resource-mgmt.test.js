// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemSpectralKernels } from './particle-system-spectral-kernels.js';

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
 * Test 1: Dispose cleans up WebGL resources
 */
test('spectral-kernels.resource-mgmt: dispose cleans up resources', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    gridSize: 32
  });
  
  // Get texture handles before disposal
  const posTex = system.positionTexture;
  const velTex = system.velocityTexture;
  
  assert.ok(gl.isTexture(posTex), 'Position texture should exist before dispose');
  assert.ok(gl.isTexture(velTex), 'Velocity texture should exist before dispose');
  
  // Dispose system
  system.dispose();
  
  // Textures should be deleted
  assert.ok(!gl.isTexture(posTex), 'Position texture should be deleted after dispose');
  assert.ok(!gl.isTexture(velTex), 'Velocity texture should be deleted after dispose');
  
  canvas.remove();
});

/**
 * Test 2: Multiple systems can coexist
 */
test('spectral-kernels.resource-mgmt: multiple systems can coexist', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions1 = new Float32Array(8);
  positions1.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities1 = new Float32Array(8);
  
  const positions2 = new Float32Array(8);
  positions2.set([2, 0, 0, 1.0,  3, 0, 0, 1.0]);
  const velocities2 = new Float32Array(8);
  
  const system1 = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions: positions1, velocities: velocities1 },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    gridSize: 32
  });
  
  const system2 = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions: positions2, velocities: velocities2 },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    gridSize: 32
  });
  
  // Both systems should work independently
  system1.step();
  system2.step();
  
  assert.ok(system1.frameCount === 1, 'System 1 should advance');
  assert.ok(system2.frameCount === 1, 'System 2 should advance');
  
  // Clean up
  system1.dispose();
  system2.dispose();
  
  canvas.remove();
});

/**
 * Test 3: Can recreate system after disposal
 */
test('spectral-kernels.resource-mgmt: can recreate system after disposal', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  // Create first system
  const system1 = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions: new Float32Array(positions), velocities: new Float32Array(velocities) },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    gridSize: 32
  });
  
  system1.step();
  assert.strictEqual(system1.frameCount, 1, 'First system should work');
  
  system1.dispose();
  
  // Create second system with same parameters
  const system2 = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions: new Float32Array(positions), velocities: new Float32Array(velocities) },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    gridSize: 32
  });
  
  system2.step();
  assert.strictEqual(system2.frameCount, 1, 'Second system should work after first disposed');
  
  system2.dispose();
  canvas.remove();
});

/**
 * Test 4: Large system cleanup
 */
test('spectral-kernels.resource-mgmt: large system disposes without errors', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 400;
  const texWidth = 20;
  const texHeight = 20;
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (Math.random() - 0.5) * 4;
    positions[i * 4 + 1] = (Math.random() - 0.5) * 4;
    positions[i * 4 + 2] = (Math.random() - 0.5) * 4;
    positions[i * 4 + 3] = 1.0;
  }
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.1,
    gridSize: 64
  });
  
  // Run a few steps
  for (let i = 0; i < 5; i++) {
    system.step();
  }
  
  // Should dispose without errors
  assert.doesNotThrow(() => {
    system.dispose();
  }, 'Large system should dispose cleanly');
  
  canvas.remove();
});

/**
 * Test 5: Dispose is idempotent
 */
test('spectral-kernels.resource-mgmt: calling dispose multiple times is safe', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    gridSize: 32
  });
  
  // Dispose multiple times should not throw
  assert.doesNotThrow(() => {
    system.dispose();
    system.dispose();
    system.dispose();
  }, 'Multiple dispose calls should be safe');
  
  canvas.remove();
});

/**
 * Test 6: Different grid sizes dispose correctly
 */
test('spectral-kernels.resource-mgmt: different grid sizes dispose correctly', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(16);
  positions.set([
    0, 0, 0, 1.0,
    1, 0, 0, 1.0,
    0, 1, 0, 1.0,
    -1, -1, 0, 1.0
  ]);
  const velocities = new Float32Array(16);
  
  const gridSizes = [16, 32, 64, 128];
  
  for (const gridSize of gridSizes) {
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemSpectralKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
      dt: 0.01,
      gravityStrength: 0.001,
      softening: 0.1,
      gridSize: gridSize
    });
    
    system.step();
    
    assert.doesNotThrow(() => {
      system.dispose();
    }, `System with gridSize=${gridSize} should dispose cleanly`);
  }
  
  canvas.remove();
});

/**
 * Test 7: Canvas removal after disposal
 */
test('spectral-kernels.resource-mgmt: canvas can be removed after system disposal', async () => {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const gl = canvas.getContext('webgl2');
  
  if (!gl) {
    throw new Error('WebGL2 not supported');
  }
  
  gl.getExtension('EXT_color_buffer_float');
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    gridSize: 32
  });
  
  system.step();
  system.dispose();
  
  // Should be safe to remove canvas
  assert.doesNotThrow(() => {
    canvas.remove();
  }, 'Canvas removal should be safe after system disposal');
});
