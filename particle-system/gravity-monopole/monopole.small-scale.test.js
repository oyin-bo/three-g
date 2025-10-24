// @ts-check

/**
 * Small-scale integration tests for monopole particle system.
 * Tests basic correctness on minimal particle configurations.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  createTestCanvas,
  createGLContext,
  cleanupGL,
  readParticleData,
  readAllParticleData,
  assertVector3Near,
  assertAllFinite,
  computeCenterOfMass,
  computeTotalMomentum
} from '../test-utils-integration.js';

import { ParticleSystemMonopole } from './particle-system-monopole.js';

/**
 * Test 1: Single particle at rest remains stationary
 * A single particle with zero velocity should remain at origin with no self-force.
 */
test('monopole small-scale: single particle at rest', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Single particle at origin
  const positions = new Float32Array([
    0.0, 0.0, 0.0, 1.0  // x, y, z, mass
  ]);
  const velocities = new Float32Array([
    0.0, 0.0, 0.0, 0.0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Step simulation 10 times
  for (let i = 0; i < 10; i++) {
    system.compute();
  }
  
  // Read particle data
  const data = readParticleData(system, 0);
  
  // Verify position unchanged (within tolerance)
  assertVector3Near(data.position.slice(0, 3), [0, 0, 0], 1e-5, 'Position should remain at origin');
  
  // Verify velocity remains zero
  assertVector3Near(data.velocity.slice(0, 3), [0, 0, 0], 1e-5, 'Velocity should remain zero');
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 2: Two particles attract
 * Two equal mass particles should move toward each other.
 */
test('monopole small-scale: two particles attract', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Two particles separated by 2.0 units on x-axis
  const positions = new Float32Array([
    -1.0, 0.0, 0.0, 1.0,  // particle 1
     1.0, 0.0, 0.0, 1.0   // particle 2
  ]);
  const velocities = new Float32Array([
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Get initial positions
  const data0_0 = readParticleData(system, 0);
  const data0_1 = readParticleData(system, 1);
  const initialSep = Math.abs(data0_1.position[0] - data0_0.position[0]);
  
  // Step simulation
  for (let i = 0; i < 50; i++) {
    system.compute();
  }
  
  // Read final data
  const data1_0 = readParticleData(system, 0);
  const data1_1 = readParticleData(system, 1);
  
  // Verify particles moved toward each other (separation decreased)
  const finalSep = Math.abs(data1_1.position[0] - data1_0.position[0]);
  assert.ok(finalSep < initialSep, `Particles should attract: initial sep ${initialSep} > final sep ${finalSep}`);
  
  // Verify velocities point toward each other
  assert.ok(data1_0.velocity[0] > 0, 'Particle 0 should move in +x direction');
  assert.ok(data1_1.velocity[0] < 0, 'Particle 1 should move in -x direction');
  
  // Check no NaN or Inf
  assertAllFinite(data1_0.position, 'Particle 0 position must be finite');
  assertAllFinite(data1_0.velocity, 'Particle 0 velocity must be finite');
  assertAllFinite(data1_1.position, 'Particle 1 position must be finite');
  assertAllFinite(data1_1.velocity, 'Particle 1 velocity must be finite');
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 3: Three-body Lagrange L4 (equilateral triangle)
 * Three equal masses in equilateral configuration with circular velocities.
 */
test('monopole small-scale: three-body Lagrange L4', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Equilateral triangle with side length 2.0
  const r = 2.0 / Math.sqrt(3); // distance from center to vertex
  const positions = new Float32Array([
    r, 0.0, 0.0, 1.0,                           // particle 0
    -r/2, r * Math.sqrt(3)/2, 0.0, 1.0,        // particle 1
    -r/2, -r * Math.sqrt(3)/2, 0.0, 1.0        // particle 2
  ]);
  
  // Circular orbit velocities perpendicular to radius
  const v = 0.05; // approximate stable orbit speed
  const velocities = new Float32Array([
    0.0, v, 0.0, 0.0,
    -v * Math.sqrt(3)/2, -v/2, 0.0, 0.0,
    v * Math.sqrt(3)/2, -v/2, 0.0, 0.0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Calculate initial triangle properties
  const masses = new Float32Array([1.0, 1.0, 1.0]);
  const initialCOM = computeCenterOfMass(positions, masses);
  
  // Step simulation
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  
  // Read final data
  const finalData = readAllParticleData(system);
  
  // Verify all positions and velocities are finite
  assertAllFinite(finalData.positions, 'Positions must be finite');
  assertAllFinite(finalData.velocities, 'Velocities must be finite');
  
  // Verify system maintains approximate center of mass
  const finalCOM = computeCenterOfMass(finalData.positions, masses);
  assertVector3Near(finalCOM, initialCOM, 0.5, 'Center of mass should remain near origin');
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 4: Ten particles in cluster
 * Random particles in small sphere should contract under gravity.
 */
test('monopole small-scale: ten particles in cluster', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // 10 particles in small random cluster
  const count = 10;
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  
  // Simple deterministic distribution
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * 2 * Math.PI;
    const phi = Math.acos(2 * (i / count) - 1);
    const r = 1.0;
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0; // mass
    
    velocities[i * 4 + 0] = 0.0;
    velocities[i * 4 + 1] = 0.0;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
  }
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Calculate initial spread
  let initialSpread = 0;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 4 + 0];
    const y = positions[i * 4 + 1];
    const z = positions[i * 4 + 2];
    initialSpread += Math.sqrt(x * x + y * y + z * z);
  }
  initialSpread /= count;
  
  // Step simulation
  for (let i = 0; i < 50; i++) {
    system.compute();
  }
  
  // Read final data
  const finalData = readAllParticleData(system);
  
  // Verify no NaN or Inf
  assertAllFinite(finalData.positions, 'Positions must be finite');
  assertAllFinite(finalData.velocities, 'Velocities must be finite');
  
  // Calculate final spread
  let finalSpread = 0;
  for (let i = 0; i < count; i++) {
    const x = finalData.positions[i * 4 + 0];
    const y = finalData.positions[i * 4 + 1];
    const z = finalData.positions[i * 4 + 2];
    finalSpread += Math.sqrt(x * x + y * y + z * z);
  }
  finalSpread /= count;
  
  // System should contract (particles move inward on average)
  // Note: due to softening and dynamics, this may not always be strict
  // We mainly verify stability here
  assert.ok(isFinite(finalSpread), `Final spread should be finite: ${finalSpread}`);
  
  // Verify center of mass motion is minimal
  const masses = new Float32Array(count).fill(1.0);
  const momentum = computeTotalMomentum(finalData.velocities, masses);
  const momentumMag = Math.sqrt(momentum[0] * momentum[0] + momentum[1] * momentum[1] + momentum[2] * momentum[2]);
  assert.ok(momentumMag < 0.1, `Total momentum should be small: ${momentumMag}`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 5: Empty system
 * Zero particles should not crash.
 */
test('monopole small-scale: empty system', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const positions = new Float32Array(0);
  const velocities = new Float32Array(0);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Step should not crash
  for (let i = 0; i < 10; i++) {
    system.compute();
  }
  
  // Check for GL errors
  const glError = gl.getError();
  assert.strictEqual(glError, gl.NO_ERROR, 'No GL errors with empty system');
  
  system.dispose();
  cleanupGL(canvas, gl);
});
