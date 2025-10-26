// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';

import { GravitySpectral } from './gravity-spectral';

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
 * Read particle data from GPU textures
 * @param {GravitySpectral} system
 * @param {number} particleIndex
 * @returns {{position: [number, number, number, number], velocity: [number, number, number, number]}}
 */
function readParticleData(system, particleIndex) {
  const gl = system.gl;
  const texWidth = system.textureWidth;

  const x = particleIndex % texWidth;
  const y = Math.floor(particleIndex / texWidth);

  // Read position
  const posTex = system.positionTexture;
  const posFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);

  const posPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, posPixels);

  // Read velocity
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
 * @param {GravitySpectral} system
 * @param {HTMLCanvasElement} canvas
 */
function disposeSystem(system, canvas) {
  system.dispose();
  canvas.remove();
}

/**
 * Test 1: Extreme velocities remain stable
 */
test('spectral-kernels.stability: high initial velocities remain bounded', async () => {
  const { canvas, gl } = createTestCanvas();

  // Create particles with high initial velocities
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

  const system = new GravitySpectral({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-10, -10, -10], max: [10, 10, 10] },
    dt: 0.005,
    gravityStrength: 0.0003,
    softening: 0.2,
    gridSize: 64
  });

  // Run simulation
  for (let i = 0; i < 100; i++) {
    system.step();
  }

  // Capture system state for diagnostics
  const diagFull = '\n\n' + system.toString();

  // Verify all particles have finite, reasonable values
  for (let i = 0; i < 4; i++) {
    const p = readParticleData(system, i);

    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]), `Particle ${i} position[${j}] should be finite` + diagFull);
      assert.ok(isFinite(p.velocity[j]), `Particle ${i} velocity[${j}] should be finite` + diagFull);
    }

    const speed = Math.sqrt(p.velocity[0] ** 2 + p.velocity[1] ** 2 + p.velocity[2] ** 2);
    assert.ok(speed < 20, `Particle ${i} velocity should remain bounded: speed=${speed.toFixed(3)}` + diagFull);
  }

  disposeSystem(system, canvas);
});

/**
 * Test 2: Very small timestep stability
 */
test('spectral-kernels.stability: very small timestep remains stable', async () => {
  const { canvas, gl } = createTestCanvas();

  const positions = new Float32Array(8);
  positions.set([-0.5, 0, 0, 1.0, 0.5, 0, 0, 1.0]);
  const velocities = new Float32Array(8);

  const system = new GravitySpectral({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.0001, // Very small timestep
    gravityStrength: 0.001,
    softening: 0.1,
    gridSize: 32
  });

  // Run many steps with tiny timestep
  for (let i = 0; i < 500; i++) {
    system.step();
  }

  // Capture system state for diagnostics
  const diagFull = '\n\n' + system.toString();

  // Verify particles still valid
  for (let i = 0; i < 2; i++) {
    const p = readParticleData(system, i);

    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]), `Position should be finite with tiny timestep` + diagFull);
      assert.ok(isFinite(p.velocity[j]), `Velocity should be finite with tiny timestep` + diagFull);
    }
  }

  disposeSystem(system, canvas);
});

/**
 * Test 3: Dense clustering stability
 */
test('spectral-kernels.stability: dense particle cluster remains stable', async () => {
  const { canvas, gl } = createTestCanvas();

  // Create 20 particles in very tight cluster
  const particleCount = 20;
  const texWidth = Math.ceil(Math.sqrt(particleCount));
  const texHeight = Math.ceil(particleCount / texWidth);

  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);

  for (let i = 0; i < particleCount; i++) {
    // Very small random offsets
    positions[i * 4 + 0] = (Math.random() - 0.5) * 0.2;
    positions[i * 4 + 1] = (Math.random() - 0.5) * 0.2;
    positions[i * 4 + 2] = (Math.random() - 0.5) * 0.2;
    positions[i * 4 + 3] = 1.0;
  }

  const system = new GravitySpectral({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.005,
    gravityStrength: 0.001,
    softening: 0.15, // Important for stability
    gridSize: 64
  });

  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }

  // Capture system state for diagnostics
  const diagFull = '\n\n' + system.toString();

  // Check that no particles have exploded
  let maxSpeed = 0;
  for (let i = 0; i < particleCount; i++) {
    const p = readParticleData(system, i);
    const speed = Math.sqrt(p.velocity[0] ** 2 + p.velocity[1] ** 2 + p.velocity[2] ** 2);
    maxSpeed = Math.max(maxSpeed, speed);

    assert.ok(isFinite(speed), `Particle ${i} speed should be finite` + diagFull);
  }

  assert.ok(maxSpeed < 5.0, `Dense cluster should not explode: maxSpeed=${maxSpeed.toFixed(3)}` + diagFull);

  disposeSystem(system, canvas);
});

/**
 * Test 4: Zero gravity remains stable
 */
test('spectral-kernels.stability: zero gravity strength produces no motion', async () => {
  const { canvas, gl } = createTestCanvas();

  const positions = new Float32Array(16);
  positions.set([
    -1, 0, 0, 1.0,
    1, 0, 0, 1.0,
    0, 1, 0, 1.0,
    0, -1, 0, 1.0
  ]);
  const velocities = new Float32Array(16);

  const system = new GravitySpectral({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.0, // No gravity
    softening: 0.1,
    gridSize: 32
  });

  const initial = [];
  for (let i = 0; i < 4; i++) {
    initial.push(readParticleData(system, i));
  }

  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }

  // Verify particles haven't moved
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
 * Test 5: Mass variation stability
 */
test('spectral-kernels.stability: widely varying particle masses remain stable', async () => {
  const { canvas, gl } = createTestCanvas();

  // Particles with very different masses
  const positions = new Float32Array(16);
  positions.set([
    0, 0, 0, 100.0,     // Very massive
    1, 0, 0, 1.0,       // Normal mass
    0, 1, 0, 0.01,      // Very light
    -1, -1, 0, 10.0     // Heavy
  ]);

  const velocities = new Float32Array(16);
  velocities.set([
    0, 0, 0, 0,
    0, 0.2, 0, 0,
    -0.2, 0, 0, 0,
    0.1, 0.1, 0, 0
  ]);

  const system = new GravitySpectral({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0005,
    softening: 0.2,
    gridSize: 64
  });

  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }

  // Capture system state for diagnostics
  const diagFull = '\n\n' + system.toString();

  // Verify all particles remain stable
  for (let i = 0; i < 4; i++) {
    const p = readParticleData(system, i);

    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]),
        `Particle ${i} position[${j}] should be finite with varying masses` + diagFull);
      assert.ok(isFinite(p.velocity[j]),
        `Particle ${i} velocity[${j}] should be finite with varying masses` + diagFull);
    }

    const speed = Math.sqrt(p.velocity[0] ** 2 + p.velocity[1] ** 2 + p.velocity[2] ** 2);
    assert.ok(speed < 3.0,
      `Particle ${i} should not have runaway velocity: speed=${speed.toFixed(3)}` + diagFull);
  }

  disposeSystem(system, canvas);
});

/**
 * Test 6: Boundary conditions stability
 */
test('spectral-kernels.stability: particles near world bounds remain stable', async () => {
  const { canvas, gl } = createTestCanvas();

  // Place particles near boundaries
  const positions = new Float32Array(16);
  positions.set([
    2.8, 0, 0, 1.0,      // Near +X boundary
    -2.8, 0, 0, 1.0,     // Near -X boundary
    0, 2.8, 0, 1.0,      // Near +Y boundary
    0, -2.8, 0, 1.0      // Near -Y boundary
  ]);

  const velocities = new Float32Array(16);
  velocities.set([
    -0.1, 0, 0, 0,
    0.1, 0, 0, 0,
    0, -0.1, 0, 0,
    0, 0.1, 0, 0
  ]);

  const system = new GravitySpectral({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.15,
    gridSize: 64
  });

  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }

  // Verify particles remain stable (spectral methods handle boundaries via grid)
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
