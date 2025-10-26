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
 * Read particle data
 * @param {ParticleSystemMeshKernels} system
 * @param {number} particleIndex
 */
function readParticleData(system, particleIndex) {
  const gl = system.gl;
  const texWidth = system.textureWidth;
  
  const x = particleIndex % texWidth;
  const y = Math.floor(particleIndex / texWidth);
  
  const posTex = system.positionTexture;
  const posFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  
  const posPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, posPixels);
  
  const velTex = system.velocityTexture;
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  
  const velPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, velPixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(posFBO);
  
  return {
    position: [posPixels[0], posPixels[1], posPixels[2], posPixels[3]],
    velocity: [velPixels[0], velPixels[1], velPixels[2], velPixels[3]]
  };
}

/**
 * Dispose system and cleanup
 * @param {ParticleSystemMeshKernels} system
 * @param {HTMLCanvasElement} canvas
 */
function disposeSystem(system, canvas) {
  system.dispose();
  canvas.remove();
}

/**
 * Test 1: High velocities
 */
test('mesh-kernels.stability: high initial velocities remain bounded', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(16);
  positions.set([
    -1, 0, 0, 1.0,
     1, 0, 0, 1.0,
     0, 1, 0, 1.0,
     0, -1, 0, 1.0
  ]);
  
  const velocities = new Float32Array(16);
  velocities.set([
     2, 1, 0.5, 0,
    -2, -1, -0.5, 0,
     1, -2, 0.3, 0,
    -1, 2, -0.3, 0
  ]);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-10, -10, -10], max: [10, 10, 10] },
    dt: 0.005,
    gravityStrength: 0.0003,
    softening: 0.2,
    mesh: { gridSize: 64, assignment: 'cic' }
  });
  
  for (let i = 0; i < 100; i++) {
    system.step();
  }
  
  for (let i = 0; i < 4; i++) {
    const p = readParticleData(system, i);
    
    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]), `Particle ${i} position[${j}] should be finite`);
      assert.ok(isFinite(p.velocity[j]), `Particle ${i} velocity[${j}] should be finite`);
    }
    
    const speed = Math.sqrt(p.velocity[0]**2 + p.velocity[1]**2 + p.velocity[2]**2);
    assert.ok(speed < 20, `Particle ${i} velocity should remain bounded: speed=${speed.toFixed(3)}`);
  }
  
  disposeSystem(system, canvas);
});

/**
 * Test 2: Very small timestep
 */
test('mesh-kernels.stability: very small timestep remains stable', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([-0.5, 0, 0, 1.0,  0.5, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.0001,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  for (let i = 0; i < 500; i++) {
    system.step();
  }
  
  for (let i = 0; i < 2; i++) {
    const p = readParticleData(system, i);
    
    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]), `Position should be finite with tiny timestep`);
      assert.ok(isFinite(p.velocity[j]), `Velocity should be finite with tiny timestep`);
    }
  }
  
  disposeSystem(system, canvas);
});

/**
 * Test 3: Dense clustering
 */
test('mesh-kernels.stability: dense particle cluster remains stable', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 20;
  const texWidth = Math.ceil(Math.sqrt(particleCount));
  const texHeight = Math.ceil(particleCount / texWidth);
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (Math.random() - 0.5) * 0.2;
    positions[i * 4 + 1] = (Math.random() - 0.5) * 0.2;
    positions[i * 4 + 2] = (Math.random() - 0.5) * 0.2;
    positions[i * 4 + 3] = 1.0;
  }
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.005,
    gravityStrength: 0.001,
    softening: 0.15,
    mesh: { gridSize: 64, assignment: 'cic' }
  });
  
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  let maxSpeed = 0;
  for (let i = 0; i < particleCount; i++) {
    const p = readParticleData(system, i);
    const speed = Math.sqrt(p.velocity[0]**2 + p.velocity[1]**2 + p.velocity[2]**2);
    maxSpeed = Math.max(maxSpeed, speed);
    
    assert.ok(isFinite(speed), `Particle ${i} speed should be finite`);
  }
  
  assert.ok(maxSpeed < 5.0, `Dense cluster should not explode: maxSpeed=${maxSpeed.toFixed(3)}`);
  
  disposeSystem(system, canvas);
});

/**
 * Test 4: Zero gravity
 */
test('mesh-kernels.stability: zero gravity strength produces no motion', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(16);
  positions.set([
    -1, 0, 0, 1.0,
     1, 0, 0, 1.0,
     0, 1, 0, 1.0,
     0, -1, 0, 1.0
  ]);
  const velocities = new Float32Array(16);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.0,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const initial = [];
  for (let i = 0; i < 4; i++) {
    initial.push(readParticleData(system, i));
  }
  
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  for (let i = 0; i < 4; i++) {
    const p = readParticleData(system, i);
    
    for (let j = 0; j < 3; j++) {
      const posDiff = Math.abs(p.position[j] - initial[i].position[j]);
      assert.ok(posDiff < 0.001, 
        `Particle ${i} position[${j}] should not change with zero gravity: diff=${posDiff.toFixed(6)}`);
      
      const velDiff = Math.abs(p.velocity[j] - initial[i].velocity[j]);
      assert.ok(velDiff < 0.001, 
        `Particle ${i} velocity[${j}] should not change with zero gravity: diff=${velDiff.toFixed(6)}`);
    }
  }
  
  disposeSystem(system, canvas);
});

/**
 * Test 5: Mass variation
 */
test('mesh-kernels.stability: widely varying particle masses remain stable', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(16);
  positions.set([
    0, 0, 0, 100.0,
    1, 0, 0, 1.0,
    0, 1, 0, 0.01,
    -1, -1, 0, 10.0
  ]);
  
  const velocities = new Float32Array(16);
  velocities.set([
    0, 0, 0, 0,
    0, 0.2, 0, 0,
    -0.2, 0, 0, 0,
    0.1, 0.1, 0, 0
  ]);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0005,
    softening: 0.2,
    mesh: { gridSize: 64, assignment: 'cic' }
  });
  
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  for (let i = 0; i < 4; i++) {
    const p = readParticleData(system, i);
    
    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]), 
        `Particle ${i} position[${j}] should be finite with varying masses`);
      assert.ok(isFinite(p.velocity[j]), 
        `Particle ${i} velocity[${j}] should be finite with varying masses`);
    }
    
    const speed = Math.sqrt(p.velocity[0]**2 + p.velocity[1]**2 + p.velocity[2]**2);
    assert.ok(speed < 3.0, 
      `Particle ${i} should not have runaway velocity: speed=${speed.toFixed(3)}`);
  }
  
  disposeSystem(system, canvas);
});

/**
 * Test 6: Boundary conditions
 */
test('mesh-kernels.stability: particles near world bounds remain stable', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(16);
  positions.set([
    2.8, 0, 0, 1.0,
    -2.8, 0, 0, 1.0,
    0, 2.8, 0, 1.0,
    0, -2.8, 0, 1.0
  ]);
  
  const velocities = new Float32Array(16);
  velocities.set([
    -0.1, 0, 0, 0,
     0.1, 0, 0, 0,
     0, -0.1, 0, 0,
     0, 0.1, 0, 0
  ]);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.15,
    mesh: { gridSize: 64, assignment: 'cic' }
  });
  
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  for (let i = 0; i < 4; i++) {
    const p = readParticleData(system, i);
    
    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]), 
        `Particle ${i} near boundary should have finite position`);
      assert.ok(isFinite(p.velocity[j]), 
        `Particle ${i} near boundary should have finite velocity`);
    }
  }
  
  disposeSystem(system, canvas);
});
