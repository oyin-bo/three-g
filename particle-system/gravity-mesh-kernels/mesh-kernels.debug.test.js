// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemMeshKernels } from './particle-system-mesh-kernels.js';

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
 * Test 1: Read position texture
 */
test('mesh-kernels.debug: can read position texture', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([1.5, 2.5, 3.5, 1.0,  -1.0, -2.0, -3.0, 2.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.positionTexture, 0);
  
  const pixels = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  assert.strictEqual(pixels[0], 1.5, 'Position X[0] should match');
  assert.strictEqual(pixels[1], 2.5, 'Position Y[0] should match');
  assert.strictEqual(pixels[2], 3.5, 'Position Z[0] should match');
  assert.strictEqual(pixels[3], 1.0, 'Mass[0] should match');
  
  assert.strictEqual(pixels[4], -1.0, 'Position X[1] should match');
  assert.strictEqual(pixels[5], -2.0, 'Position Y[1] should match');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 2: Read velocity texture
 */
test('mesh-kernels.debug: can read velocity texture', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  
  const velocities = new Float32Array(8);
  velocities.set([0.5, -0.5, 0.3, 0,  -0.2, 0.7, -0.1, 0]);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityTexture, 0);
  
  const pixels = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  assert.strictEqual(pixels[0], 0.5, 'Velocity X[0] should match');
  assert.strictEqual(pixels[1], -0.5, 'Velocity Y[0] should match');
  assert.strictEqual(pixels[2], 0.3, 'Velocity Z[0] should match');
  
  assert.strictEqual(pixels[4], -0.2, 'Velocity X[1] should match');
  assert.strictEqual(pixels[5], 0.7, 'Velocity Y[1] should match');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 3: Texture dimensions
 */
test('mesh-kernels.debug: texture dimensions match particle count', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 50;
  const texWidth = Math.ceil(Math.sqrt(particleCount));
  const texHeight = Math.ceil(particleCount / texWidth);
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  assert.strictEqual(system.textureWidth, texWidth, 'Texture width should match');
  assert.strictEqual(system.textureHeight, texHeight, 'Texture height should match');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 4: Frame counter
 */
test('mesh-kernels.debug: step increments frame count', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const initialFrame = system.frameCount;
  
  system.step();
  assert.strictEqual(system.frameCount, initialFrame + 1, 'Frame count should increment');
  
  system.step();
  system.step();
  assert.strictEqual(system.frameCount, initialFrame + 3, 'Frame count should increment each step');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 5: Grid size property
 */
test('mesh-kernels.debug: grid size property matches constructor', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const gridSize = 128;
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: gridSize, assignment: 'cic' }
  });
  
  assert.ok(system, 'System should be created with gridSize parameter');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 6: State changes
 */
test('mesh-kernels.debug: multiple steps change particle state', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([-1, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityTexture, 0);
  
  const initialVel = new Float32Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, initialVel);
  
  for (let i = 0; i < 10; i++) {
    system.step();
  }
  
  const finalVel = new Float32Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, finalVel);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  const velDiff = Math.abs(finalVel[0] - initialVel[0]) + 
                  Math.abs(finalVel[1] - initialVel[1]) + 
                  Math.abs(finalVel[2] - initialVel[2]);
  
  assert.ok(velDiff > 0.001, 
    `Velocities should change after simulation: diff=${velDiff.toFixed(6)}`);
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 7: Assignment method parameter
 */
test('mesh-kernels.debug: assignment method parameter works', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const systemNGP = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'ngp' }
  });
  
  assert.ok(systemNGP, 'System should accept ngp assignment method');
  systemNGP.dispose();
  
  const posCIC = new Float32Array(positions);
  const velCIC = new Float32Array(velocities);
  
  const systemCIC = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions: posCIC, velocities: velCIC },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  assert.ok(systemCIC, 'System should accept cic assignment method');
  systemCIC.dispose();
  
  canvas.remove();
});
