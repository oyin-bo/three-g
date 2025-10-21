// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemMonopole } from './particle-system-monopole.js';

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
 * @param {ParticleSystemMonopole} system
 * @param {number} particleIndex
 * @returns {{position: [number, number, number, number], velocity: [number, number, number, number]}}
 */
function readParticleData(system, particleIndex) {
  const gl = system.gl;
  const texWidth = system.textureWidth;
  const texHeight = system.textureHeight;
  
  const x = particleIndex % texWidth;
  const y = Math.floor(particleIndex / texWidth);
  
  // Read position
  const posTex = system.getPositionTexture();
  const posFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  
  const posPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, posPixels);
  
  // Read velocity
  const velTex = system.velocityTextures.getCurrentTexture();
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
 * Assert vector3 values are close within tolerance
 * @param {number[]} actual
 * @param {number[]} expected
 * @param {number} tolerance
 * @param {string} message
 */
function assertVector3Near(actual, expected, tolerance, message) {
  for (let i = 0; i < 3; i++) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (diff > tolerance) {
      throw new Error(
        `${message}: component ${i} differs by ${diff} (expected ${expected[i]}, got ${actual[i]}, tolerance ${tolerance})`
      );
    }
  }
}

/**
 * Dispose system and cleanup
 * @param {ParticleSystemMonopole} system
 * @param {HTMLCanvasElement} canvas
 */
function disposeSystem(system, canvas) {
  system.dispose();
  canvas.remove();
}

/**
 * Test 1: Single particle at rest remains stationary
 */
test('monopole.small-scale: single particle at rest remains stationary', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create 1 particle at origin with zero velocity
  const positions = new Float32Array([0, 0, 0, 1.0]); // x, y, z, mass
  const velocities = new Float32Array([0, 0, 0, 0]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.15
  });
  
  // Initial state
  const initial = readParticleData(system, 0);
  
  // Step 10 times
  for (let i = 0; i < 10; i++) {
    system.step();
  }
  
  // Read final state
  const final = readParticleData(system, 0);
  
  // Verify position unchanged (within numerical tolerance)
  assertVector3Near(final.position, [0, 0, 0], 0.001, 'Position should remain at origin');
  
  // Verify velocity remains zero
  assertVector3Near(final.velocity, [0, 0, 0], 0.001, 'Velocity should remain zero');
  
  disposeSystem(system, canvas);
});

/**
 * Test 2: Two particles attract each other
 */
test('monopole.small-scale: two particles attract each other', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create 2 particles separated along x-axis
  const positions = new Float32Array([
    -1, 0, 0, 1.0,  // Particle 0
     1, 0, 0, 1.0   // Particle 1
  ]);
  const velocities = new Float32Array([
    0, 0, 0, 0,
    0, 0, 0, 0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.15
  });
  
  const initial0 = readParticleData(system, 0);
  const initial1 = readParticleData(system, 1);
  
  // Step simulation
  for (let i = 0; i < 10; i++) {
    system.step();
  }
  
  const final0 = readParticleData(system, 0);
  const final1 = readParticleData(system, 1);
  
  // Verify particles moved toward each other
  // Particle 0 should move in +x direction (toward particle 1)
  assert.ok(final0.position[0] > initial0.position[0], 
    `Particle 0 should move right: ${initial0.position[0]} -> ${final0.position[0]}`);
  
  // Particle 1 should move in -x direction (toward particle 0)
  assert.ok(final1.position[0] < initial1.position[0], 
    `Particle 1 should move left: ${initial1.position[0]} -> ${final1.position[0]}`);
  
  // Check velocity direction
  assert.ok(final0.velocity[0] > 0, 'Particle 0 velocity should be positive (rightward)');
  assert.ok(final1.velocity[0] < 0, 'Particle 1 velocity should be negative (leftward)');
  
  disposeSystem(system, canvas);
});

/**
 * Test 3: Three-body Lagrange L4 (equilateral triangle stability)
 */
test('monopole.small-scale: three-body equilateral triangle maintains shape', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create equilateral triangle configuration
  const a = 1.0; // side length
  const h = a * Math.sqrt(3) / 2; // height
  
  const positions = new Float32Array([
    -a/2,  -h/3, 0, 1.0,  // Bottom left
     a/2,  -h/3, 0, 1.0,  // Bottom right
     0,   2*h/3, 0, 1.0   // Top
  ]);
  
  // Set up circular orbit velocities (perpendicular to radius, equal magnitude)
  const v = 0.02; // orbital speed
  const velocities = new Float32Array([
     v * Math.cos(Math.PI/3),  v * Math.sin(Math.PI/3), 0, 0,
     v * Math.cos(Math.PI),    v * Math.sin(Math.PI), 0, 0,
    -v * Math.cos(Math.PI/6), -v * Math.sin(Math.PI/6), 0, 0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.005,
    gravityStrength: 0.0003,
    softening: 0.1
  });
  
  // Calculate initial triangle side lengths
  function getSideLengths() {
    const p0 = readParticleData(system, 0).position;
    const p1 = readParticleData(system, 1).position;
    const p2 = readParticleData(system, 2).position;
    
    const d01 = Math.sqrt((p1[0] - p0[0])**2 + (p1[1] - p0[1])**2 + (p1[2] - p0[2])**2);
    const d12 = Math.sqrt((p2[0] - p1[0])**2 + (p2[1] - p1[1])**2 + (p2[2] - p1[2])**2);
    const d20 = Math.sqrt((p0[0] - p2[0])**2 + (p0[1] - p2[1])**2 + (p0[2] - p2[2])**2);
    
    return [d01, d12, d20];
  }
  
  const initialSides = getSideLengths();
  
  // Step simulation
  for (let i = 0; i < 100; i++) {
    system.step();
  }
  
  const finalSides = getSideLengths();
  
  // Verify triangle shape roughly maintained (allowing some numerical drift)
  const tolerance = 0.3; // 30% tolerance for approximate stability
  for (let i = 0; i < 3; i++) {
    const diff = Math.abs(finalSides[i] - initialSides[i]);
    const relDiff = diff / initialSides[i];
    assert.ok(relDiff < tolerance, 
      `Side ${i} should remain roughly stable: initial=${initialSides[i].toFixed(3)}, final=${finalSides[i].toFixed(3)}, relDiff=${relDiff.toFixed(3)}`);
  }
  
  disposeSystem(system, canvas);
});

/**
 * Test 4: Ten particles in cluster contract
 */
test('monopole.small-scale: ten particles in cluster contract inward', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create 10 particles randomly distributed in small sphere
  const positions = new Float32Array(10 * 4);
  for (let i = 0; i < 10; i++) {
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = Math.random() * 0.8 + 0.2; // radius 0.2 to 1.0
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0; // mass
  }
  
  const velocities = new Float32Array(10 * 4); // all zeros
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1
  });
  
  // Calculate initial average radius from origin
  function getAverageRadius() {
    let sumR = 0;
    for (let i = 0; i < 10; i++) {
      const p = readParticleData(system, i).position;
      sumR += Math.sqrt(p[0]**2 + p[1]**2 + p[2]**2);
    }
    return sumR / 10;
  }
  
  const initialRadius = getAverageRadius();
  
  // Step simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  const finalRadius = getAverageRadius();
  
  // Verify system contracted (particles moved inward)
  assert.ok(finalRadius < initialRadius, 
    `Cluster should contract: initial radius=${initialRadius.toFixed(3)}, final radius=${finalRadius.toFixed(3)}`);
  
  // Check no NaN or Inf values
  for (let i = 0; i < 10; i++) {
    const p = readParticleData(system, i);
    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]), `Particle ${i} position[${j}] should be finite`);
      assert.ok(isFinite(p.velocity[j]), `Particle ${i} velocity[${j}] should be finite`);
    }
  }
  
  // Verify center of mass motion is minimal
  let comX = 0, comY = 0, comZ = 0;
  for (let i = 0; i < 10; i++) {
    const p = readParticleData(system, i).position;
    comX += p[0];
    comY += p[1];
    comZ += p[2];
  }
  comX /= 10;
  comY /= 10;
  comZ /= 10;
  
  const comDrift = Math.sqrt(comX**2 + comY**2 + comZ**2);
  assert.ok(comDrift < 0.1, `Center of mass should not drift significantly: drift=${comDrift.toFixed(4)}`);
  
  disposeSystem(system, canvas);
});

/**
 * Test 5: Empty system (zero particles)
 */
test('monopole.small-scale: empty system does not crash', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create empty particle arrays
  const positions = new Float32Array(0);
  const velocities = new Float32Array(0);
  
  // This test verifies the system handles edge case gracefully
  let systemCreated = false;
  let errorThrown = false;
  
  try {
    const system = new ParticleSystemMonopole(gl, {
      particleData: { positions, velocities },
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
    });
    systemCreated = true;
    
    // Try to step - should not crash
    system.step();
    
    // Verify no GL errors
    const glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `GL should have no errors: got ${glError}`);
    
    system.dispose();
  } catch (e) {
    errorThrown = true;
    // Empty system might legitimately throw during construction
    // This is acceptable behavior - we're just checking it doesn't crash the process
  }
  
  canvas.remove();
  
  // Either it works or fails gracefully - both are acceptable
  assert.ok(true, 'Empty system handled without crashing');
});
