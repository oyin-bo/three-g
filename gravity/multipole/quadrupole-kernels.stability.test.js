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
 * Read all particle data
 * @param {ParticleSystemQuadrupoleKernels} system
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
test('quadrupole-kernels.stability: high velocity particles remain stable', async () => {
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
  
  const system = new ParticleSystemQuadrupoleKernels({
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
    const r = Math.sqrt(x*x + y*y + z*z);
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
test('quadrupole-kernels.stability: very small timestep produces stable results', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 10;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  
  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);
  
  // Simple setup: particles in small cube
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (i % 2 - 0.5) * 1.0;
    positions[i * 4 + 1] = (Math.floor(i / 2) % 2 - 0.5) * 1.0;
    positions[i * 4 + 2] = (Math.floor(i / 4) % 2 - 0.5) * 1.0;
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }
  
  // Very small timestep
  const dt = 0.0001;
  
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: dt,
    gravityStrength: 0.0003,
    softening: 0.1
  });
  
  // Step many times with small dt
  for (let i = 0; i < 1000; i++) {
    system.step();
  }
  
  const finalData = readAllParticleData(system);
  
  assert.ok(allFinite(finalData.positions), 'Positions should remain finite with very small timestep');
  assert.ok(allFinite(finalData.velocities), 'Velocities should remain finite with very small timestep');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 3: Extreme density (particles very close)
 */
test('quadrupole-kernels.stability: extreme density with softening remains stable', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 8;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  
  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);
  
  // Place particles very close together
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (i % 2) * 0.01 - 0.005;
    positions[i * 4 + 1] = (Math.floor(i / 2) % 2) * 0.01 - 0.005;
    positions[i * 4 + 2] = (Math.floor(i / 4) % 2) * 0.01 - 0.005;
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }
  
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-1, -1, -1], max: [1, 1, 1] },
    dt: 0.001,
    gravityStrength: 0.0001,
    softening: 0.02  // Softening prevents singularities
  });
  
  // Step multiple times
  for (let i = 0; i < 100; i++) {
    system.step();
  }
  
  const finalData = readAllParticleData(system);
  
  assert.ok(allFinite(finalData.positions), 'Positions should remain finite at high density');
  assert.ok(allFinite(finalData.velocities), 'Velocities should remain finite at high density');
  
  // Verify softening prevents blow-up (velocities should be reasonable)
  let maxVel = 0;
  for (let i = 0; i < particleCount; i++) {
    const vx = finalData.velocities[i * 4 + 0];
    const vy = finalData.velocities[i * 4 + 1];
    const vz = finalData.velocities[i * 4 + 2];
    const v = Math.sqrt(vx*vx + vy*vy + vz*vz);
    maxVel = Math.max(maxVel, v);
  }
  
  assert.ok(maxVel < 10.0, `Softening should prevent extreme velocities: maxVel=${maxVel.toFixed(2)}`);
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 4: Null velocity initialization
 */
test('quadrupole-kernels.stability: null velocities initialize correctly', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 5;
  const positions = new Float32Array(4 * 4);
  positions.set([
    -1, 0, 0, 1.0,
     1, 0, 0, 1.0,
     0, -1, 0, 1.0,
     0,  1, 0, 1.0,
     0,  0, 0, 1.0
  ]);
  
  // Don't pass velocities - should initialize to zero
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions, velocities: null },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  // Step a few times
  for (let i = 0; i < 10; i++) {
    system.step();
  }
  
  const finalData = readAllParticleData(system);
  
  assert.ok(allFinite(finalData.positions), 'Positions should be finite when velocities initialized to null');
  assert.ok(allFinite(finalData.velocities), 'Velocities should be finite when initialized to null');
  
  system.dispose();
  canvas.remove();
});

