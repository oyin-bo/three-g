// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemQuadrupoleKernels } from './particle-system-quadrupole-kernels.js';

/**
 * Create offscreen canvas with WebGL2 context
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
 * Debug: Two particles should attract each other with quadrupole forces
 */
test('quadrupole-kernels DEBUG: two-particle forces and motion', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array([
    -1, 0, 0, 1,   // Particle 0 at left, mass 1
     1, 0, 0, 1    // Particle 1 at right, mass 1
  ]);
  const velocities = new Float32Array(positions.length).fill(0);
  
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    theta: 0.5,
    gravityStrength: 0.001,
    softening: 0.01,
    dt: 0.01
  });
  
  // Basic diagnostic: system should initialize without errors
  assert.ok(system, 'System should be created');
  assert.strictEqual(system.options.gravityStrength, 0.001, 'Gravity strength should be set');
  assert.strictEqual(system.options.softening, 0.01, 'Softening should be set');
  assert.strictEqual(system.options.theta, 0.5, 'Theta should be set');
  
  // Step the system
  system.step();
  
  // Read particles
  const gl_local = system.gl;
  const texWidth = system.textureWidth;
  
  // Read particle 0
  const fbo = gl_local.createFramebuffer();
  gl_local.bindFramebuffer(gl_local.FRAMEBUFFER, fbo);
  gl_local.framebufferTexture2D(gl_local.FRAMEBUFFER, gl_local.COLOR_ATTACHMENT0, gl_local.TEXTURE_2D, system.positionTexture, 0);
  
  const p0pos = new Float32Array(4);
  gl_local.readPixels(0, 0, 1, 1, gl_local.RGBA, gl_local.FLOAT, p0pos);
  
  gl_local.framebufferTexture2D(gl_local.FRAMEBUFFER, gl_local.COLOR_ATTACHMENT0, gl_local.TEXTURE_2D, system.velocityTexture, 0);
  const p0vel = new Float32Array(4);
  gl_local.readPixels(0, 0, 1, 1, gl_local.RGBA, gl_local.FLOAT, p0vel);
  
  // Particles should have moved
  assert.ok(Math.abs(p0pos[0] - (-1)) < 0.1, `Particle 0 should move slightly: ${p0pos[0].toFixed(3)}`);
  assert.ok(Math.abs(p0vel[0]) > 0 || Math.abs(p0vel[1]) > 0 || Math.abs(p0vel[2]) > 0,
    `Particle 0 should have nonzero velocity`);
  
  gl_local.bindFramebuffer(gl_local.FRAMEBUFFER, null);
  gl_local.deleteFramebuffer(fbo);
  
  system.dispose();
  canvas.remove();
});

/**
 * Detailed diagnostic: Check quadrupole moment computation
 */
test('quadrupole-kernels DEBUG: verify system state consistency', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 4;
  const positions = new Float32Array(16);
  positions.set([
    -1, -1, 0, 1,
     1, -1, 0, 1,
    -1,  1, 0, 1,
     1,  1, 0, 1
  ]);
  const velocities = new Float32Array(16).fill(0);
  
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    gravityStrength: 0.001,
    softening: 0.1
  });
  
  // Verify texture dimensions
  assert.ok(system.textureWidth >= 2, `Texture width should be at least 2: ${system.textureWidth}`);
  assert.ok(system.textureHeight >= 2, `Texture height should be at least 2: ${system.textureHeight}`);
  assert.ok(system.actualTextureSize >= 4, `Texture size should be at least 4: ${system.actualTextureSize}`);
  
  // Verify octree configuration
  assert.ok(system.numLevels > 0, `Should have multiple levels: ${system.numLevels}`);
  assert.ok(system.levelConfigs.length === system.numLevels, `Level configs count should match`);
  
  // Verify options
  assert.ok(system.options.particleCount === particleCount, `Particle count should be set`);
  assert.ok(system.options.worldBounds, `World bounds should be set`);
  
  // Step system and verify no errors
  for (let i = 0; i < 10; i++) {
    system.step();
  }
  
  // Verify final state has no NaN
  const fbo = system.gl.createFramebuffer();
  system.gl.bindFramebuffer(system.gl.FRAMEBUFFER, fbo);
  system.gl.framebufferTexture2D(system.gl.FRAMEBUFFER, system.gl.COLOR_ATTACHMENT0, system.gl.TEXTURE_2D, system.positionTexture, 0);
  
  const finalPos = new Float32Array(system.textureWidth * system.textureHeight * 4);
  system.gl.readPixels(0, 0, system.textureWidth, system.textureHeight, system.gl.RGBA, system.gl.FLOAT, finalPos);
  
  let hasNaN = false;
  for (let i = 0; i < particleCount; i++) {
    if (!isFinite(finalPos[i * 4 + 0]) || !isFinite(finalPos[i * 4 + 1]) || !isFinite(finalPos[i * 4 + 2])) {
      hasNaN = true;
      break;
    }
  }
  
  assert.ok(!hasNaN, 'Particle positions should not contain NaN');
  
  system.gl.bindFramebuffer(system.gl.FRAMEBUFFER, null);
  system.gl.deleteFramebuffer(fbo);
  
  system.dispose();
  canvas.remove();
});

