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
 * Generate uniform particle distribution in a cube (padded to texture size)
 * @param {number} count
 * @param {[number,number,number]} min
 * @param {[number,number,number]} max
 * @param {number} seed
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function generateUniformParticles(count, min, max, seed = 42) {
  // Simple seeded random
  let s = seed;
  function random() {
    s = (s * 1664525 + 1013904223) | 0;
    return (s >>> 0) / 4294967296;
  }

  const textureWidth = Math.ceil(Math.sqrt(count));
  const textureHeight = Math.ceil(count / textureWidth);
  const textureSize = textureWidth * textureHeight * 4;

  const positions = new Float32Array(textureSize);
  const velocities = new Float32Array(textureSize);

  for (let i = 0; i < count; i++) {
    positions[i * 4 + 0] = min[0] + random() * (max[0] - min[0]);
    positions[i * 4 + 1] = min[1] + random() * (max[1] - min[1]);
    positions[i * 4 + 2] = min[2] + random() * (max[2] - min[2]);
    positions[i * 4 + 3] = 1.0; // mass

    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }

  return { positions, velocities };
}

/**
 * Read all particle data from GPU
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

  // Read positions
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  const positions = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, positions);

  // Read velocities
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, velocities);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);

  return { positions, velocities };
}

/**
 * Compute center of mass
 * @param {Float32Array} positions
 * @param {number} count
 * @returns {[number, number, number]}
 */
function computeCenterOfMass(positions, count) {
  let cx = 0, cy = 0, cz = 0;
  let totalMass = 0;

  for (let i = 0; i < count; i++) {
    const mass = positions[i * 4 + 3];
    cx += positions[i * 4 + 0] * mass;
    cy += positions[i * 4 + 1] * mass;
    cz += positions[i * 4 + 2] * mass;
    totalMass += mass;
  }

  return [cx / totalMass, cy / totalMass, cz / totalMass];
}

/**
 * Compute total momentum
 * @param {Float32Array} velocities
 * @param {Float32Array} positions
 * @param {number} count
 * @returns {[number, number, number]}
 */
function computeTotalMomentum(velocities, positions, count) {
  let px = 0, py = 0, pz = 0;

  for (let i = 0; i < count; i++) {
    const mass = positions[i * 4 + 3];
    px += velocities[i * 4 + 0] * mass;
    py += velocities[i * 4 + 1] * mass;
    pz += velocities[i * 4 + 2] * mass;
  }

  return [px, py, pz];
}

/**
 * Assert all values are finite
 * @param {Float32Array} array
 * @param {string} message
 */
function assertAllFinite(array, message) {
  for (let i = 0; i < array.length; i++) {
    if (!isFinite(array[i])) {
      throw new Error(`${message}: array[${i}] = ${array[i]}`);
    }
  }
}

/**
 * Assert all values bounded
 * @param {Float32Array} array
 * @param {number} maxValue
 * @param {string} message
 */
function assertBounded(array, maxValue, message) {
  for (let i = 0; i < array.length; i++) {
    if (Math.abs(array[i]) > maxValue) {
      throw new Error(`${message}: array[${i}] = ${array[i]} exceeds ${maxValue}`);
    }
  }
}

/**
 * Test 1: 100 particles uniform distribution stability
 */
test('monopole-kernels.large-scale: 100 particles remain stable over 100 steps', async () => {
  const { canvas, gl } = createTestCanvas();

  const particleCount = 100;
  const { positions, velocities } = generateUniformParticles(
    particleCount,
    [-4, -4, -4],
    [4, 4, 4],
    42
  );

  const system = new GravityMonopole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  // Record initial state
  const initialData = readAllParticleData(system);
  const initialCOM = computeCenterOfMass(initialData.positions, particleCount);
  const initialMomentum = computeTotalMomentum(initialData.velocities, initialData.positions, particleCount);

  // Step 100 times
  for (let i = 0; i < 100; i++) {
    system.step();
  }

  // Read final state
  const finalData = readAllParticleData(system);

  // Verify all positions finite
  assertAllFinite(finalData.positions, 'All positions should be finite');

  // Verify all velocities finite and bounded
  assertAllFinite(finalData.velocities, 'All velocities should be finite');
  assertBounded(finalData.velocities, 10.0, 'All velocities should be bounded');

  // Check center of mass drift
  const finalCOM = computeCenterOfMass(finalData.positions, particleCount);
  const comDrift = Math.sqrt(
    (finalCOM[0] - initialCOM[0]) ** 2 +
    (finalCOM[1] - initialCOM[1]) ** 2 +
    (finalCOM[2] - initialCOM[2]) ** 2
  );

  assert.ok(comDrift < 0.1, `Center of mass drift should be small: ${comDrift.toFixed(4)} < 0.1`);

  // Check momentum conservation (approximate)
  const finalMomentum = computeTotalMomentum(finalData.velocities, finalData.positions, particleCount);
  const momentumChange = Math.sqrt(
    (finalMomentum[0] - initialMomentum[0]) ** 2 +
    (finalMomentum[1] - initialMomentum[1]) ** 2 +
    (finalMomentum[2] - initialMomentum[2]) ** 2
  );

  // Allow small momentum drift per step
  const perStepDrift = momentumChange / 100;
  assert.ok(perStepDrift < 1e-3, `Per-step momentum drift should be small: ${perStepDrift.toExponential(2)} < 1e-3`);

  system.dispose();
  canvas.remove();
});

/**
 * Test 2: 1000 particles clustered (Plummer-like)
 */
test('monopole-kernels.large-scale: 1000 particles clustered remain bound', async () => {
  const { canvas, gl } = createTestCanvas();

  const particleCount = 1000;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);

  // Generate Plummer-like distribution (dense center, sparse edges) (padded to texture size)
  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);

  let seed = 123;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }

  const a = 1.0; // scale radius
  for (let i = 0; i < particleCount; i++) {
    // Plummer radius distribution: r = a / sqrt(u^(-2/3) - 1)
    const u = random();
    const r = a / Math.sqrt(Math.pow(u, -2 / 3) - 1);

    // Random direction
    const theta = random() * 2 * Math.PI;
    const phi = Math.acos(2 * random() - 1);

    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0;

    // Small random velocities
    velocities[i * 4 + 0] = (random() - 0.5) * 0.1;
    velocities[i * 4 + 1] = (random() - 0.5) * 0.1;
    velocities[i * 4 + 2] = (random() - 0.5) * 0.1;
    velocities[i * 4 + 3] = 0;
  }

  const system = new GravityMonopole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-10, -10, -10], max: [10, 10, 10] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.15
  });

  // Step 200 times
  for (let i = 0; i < 200; i++) {
    system.step();
  }

  // Read final state
  const finalData = readAllParticleData(system);

  // Verify system remains bound (no escape velocity)
  let maxSpeed = 0;
  for (let i = 0; i < particleCount; i++) {
    const vx = finalData.velocities[i * 4 + 0];
    const vy = finalData.velocities[i * 4 + 1];
    const vz = finalData.velocities[i * 4 + 2];
    const speed = Math.sqrt(vx ** 2 + vy ** 2 + vz ** 2);
    maxSpeed = Math.max(maxSpeed, speed);
  }

  // Escape velocity should be bounded for bound system
  assert.ok(maxSpeed < 5.0, `Max speed should be bounded (system bound): ${maxSpeed.toFixed(3)} < 5.0`);

  // Verify no numerical artifacts
  assertAllFinite(finalData.positions, 'Positions should be finite');
  assertAllFinite(finalData.velocities, 'Velocities should be finite');

  system.dispose();
  canvas.remove();
});

/**
 * Test 3: 10,000 particles with hierarchy (core + halo)
 */
test('monopole-kernels.large-scale: 10000 particles with hierarchy maintain structure', async () => {
  const { canvas, gl } = createTestCanvas();

  const coreCount = 100;
  const haloCount = 9900;
  const totalCount = coreCount + haloCount;
  const textureWidth = Math.ceil(Math.sqrt(totalCount));
  const textureHeight = Math.ceil(totalCount / textureWidth);

  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);

  let seed = 456;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }

  // Dense core: 100 particles in radius 1.0, mass 10.0
  for (let i = 0; i < coreCount; i++) {
    const theta = random() * 2 * Math.PI;
    const phi = Math.acos(2 * random() - 1);
    const r = random() * 1.0;

    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 10.0; // heavy core particles

    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }

  // Diffuse halo: 9900 particles in radius 10.0, mass 1.0
  for (let i = coreCount; i < totalCount; i++) {
    const theta = random() * 2 * Math.PI;
    const phi = Math.acos(2 * random() - 1);
    const r = 1.0 + random() * 9.0; // radius 1.0 to 10.0

    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0; // light halo particles

    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }

  const system = new GravityMonopole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-12, -12, -12], max: [12, 12, 12] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });

  // Step 100 times
  for (let i = 0; i < 100; i++) {
    system.step();
  }

  // Read final state
  const finalData = readAllParticleData(system);

  // Verify hierarchical structure maintained (no artificial mixing)
  // Core particles should remain in core region
  let coreParticlesInCore = 0;
  for (let i = 0; i < coreCount; i++) {
    const x = finalData.positions[i * 4 + 0];
    const y = finalData.positions[i * 4 + 1];
    const z = finalData.positions[i * 4 + 2];
    const r = Math.sqrt(x ** 2 + y ** 2 + z ** 2);

    // Allow some expansion but core should stay relatively central
    if (r < 3.0) {
      coreParticlesInCore++;
    }
  }

  const coreRetention = coreParticlesInCore / coreCount;
  assert.ok(coreRetention > 0.5,
    `Core particles should remain relatively central: ${(coreRetention * 100).toFixed(1)}% in r < 3.0`);

  // Verify no crashes or numerical issues with large particle count
  assertAllFinite(finalData.positions, 'Positions finite with large particle count');
  assertAllFinite(finalData.velocities, 'Velocities finite with large particle count');

  system.dispose();
  canvas.remove();
});
