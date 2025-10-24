// @ts-check

/**
 * Known-solutions integration tests for monopole particle system.
 * Tests against analytical solutions where exact behavior is known.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  createTestCanvas,
  createGLContext,
  cleanupGL,
  setupBinaryOrbit,
  readAllParticleData,
  assertAllFinite,
  assertVector3Near,
  computeCenterOfMass,
  sampleTrajectory
} from '../test-utils-integration.js';

import { ParticleSystemMonopole } from './particle-system-monopole.js';

/**
 * Test 1: Binary orbit (circular)
 * Two equal masses in circular orbit should maintain orbital properties.
 */
test('monopole known-solutions: binary circular orbit', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const G = 0.0003;
  const mass1 = 1.0;
  const mass2 = 1.0;
  const separation = 2.0;
  
  const particleData = setupBinaryOrbit(mass1, mass2, separation, 0.0, G);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: particleData,
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: G,
    softening: 0.05  // Small softening for more accurate orbits
  });
  
  // Calculate expected orbital period: T = 2π√(a³/GM)
  const a = separation / 2.0;
  const totalMass = mass1 + mass2;
  const period = 2 * Math.PI * Math.sqrt(Math.pow(separation, 3) / (G * totalMass));
  
  // Sample positions every 0.1 T for 2 full orbits
  const samples = [];
  const duration = 2 * period;
  const interval = period * 0.1;
  
  let time = 0;
  while (time < duration) {
    const data = readAllParticleData(system);
    samples.push({ time, data });
    
    const steps = Math.ceil(interval / system.options.dt);
    for (let i = 0; i < steps; i++) {
      system.compute();
    }
    time += interval;
  }
  
  // Verify all sampled positions are finite
  for (const sample of samples) {
    assertAllFinite(sample.data.positions, `Positions at t=${sample.time.toFixed(2)} must be finite`);
    assertAllFinite(sample.data.velocities, `Velocities at t=${sample.time.toFixed(2)} must be finite`);
  }
  
  // Verify center of mass remains at origin
  const masses = particleData.masses;
  for (const sample of samples) {
    const com = computeCenterOfMass(sample.data.positions, masses);
    assertVector3Near(com, [0, 0, 0], 0.1, `COM at t=${sample.time.toFixed(2)} should be near origin`);
  }
  
  // Verify orbital radius remains approximately constant
  const initialR0 = Math.sqrt(
    particleData.positions[0] * particleData.positions[0] +
    particleData.positions[1] * particleData.positions[1] +
    particleData.positions[2] * particleData.positions[2]
  );
  
  const finalData = samples[samples.length - 1].data;
  const finalR0 = Math.sqrt(
    finalData.positions[0] * finalData.positions[0] +
    finalData.positions[1] * finalData.positions[1] +
    finalData.positions[2] * finalData.positions[2]
  );
  
  const radiusError = Math.abs(finalR0 - initialR0) / initialR0;
  assert.ok(radiusError < 0.2, `Orbital radius should be preserved: error ${radiusError.toFixed(4)}`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 2: Radial fall
 * Two particles released from rest should fall toward each other.
 */
test('monopole known-solutions: radial fall', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const positions = new Float32Array([
    -1.0, 0.0, 0.0, 1.0,  // particle 1 at x=-1
     1.0, 0.0, 0.0, 1.0   // particle 2 at x=+1
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
  
  // Sample trajectory
  const samples = [];
  for (let i = 0; i < 100; i++) {
    const data = readAllParticleData(system);
    samples.push(data);
    system.compute();
  }
  
  // Verify separation decreases monotonically
  for (let i = 1; i < samples.length; i++) {
    const prevSep = Math.abs(samples[i-1].positions[4] - samples[i-1].positions[0]);
    const currSep = Math.abs(samples[i].positions[4] - samples[i].positions[0]);
    
    assert.ok(currSep <= prevSep, `Separation should decrease: step ${i}`);
  }
  
  // Verify velocities increase (particles accelerate)
  const initialSpeed = Math.abs(samples[0].velocities[0]);
  const finalSpeed = Math.abs(samples[samples.length - 1].velocities[0]);
  assert.ok(finalSpeed > initialSpeed, `Particles should accelerate: ${initialSpeed} -> ${finalSpeed}`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 3: Escape trajectory
 * Particle with high initial velocity should escape.
 */
test('monopole known-solutions: escape trajectory', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const G = 0.0003;
  const M = 10.0; // Large central mass
  const m = 1.0;  // Small test particle
  const r0 = 2.0; // Initial separation
  
  // Escape velocity: v_esc = sqrt(2GM/r)
  const vEsc = Math.sqrt(2 * G * M / r0);
  const vInitial = vEsc * 1.5; // 1.5x escape velocity
  
  const positions = new Float32Array([
    0.0, 0.0, 0.0, M,      // central mass
    r0,  0.0, 0.0, m       // test particle
  ]);
  const velocities = new Float32Array([
    0.0, 0.0, 0.0, 0.0,    // central mass stationary
    0.0, vInitial, 0.0, 0.0  // test particle moving tangentially
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-20, -20, -20], max: [20, 20, 20] },
    dt: 0.01,
    gravityStrength: G,
    softening: 0.1,
    maxSpeed: 10.0
  });
  
  // Initial separation
  const initialSep = r0;
  
  // Simulate
  for (let i = 0; i < 200; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  
  // Calculate final separation
  const dx = finalData.positions[4] - finalData.positions[0];
  const dy = finalData.positions[5] - finalData.positions[1];
  const dz = finalData.positions[6] - finalData.positions[2];
  const finalSep = Math.sqrt(dx * dx + dy * dy + dz * dz);
  
  // Verify particle has moved away (separation increased)
  assert.ok(finalSep > initialSep, `Particle should escape: initial ${initialSep} -> final ${finalSep}`);
  
  // Verify all values are finite
  assertAllFinite(finalData.positions, 'Positions must be finite');
  assertAllFinite(finalData.velocities, 'Velocities must be finite');
  
  system.dispose();
  cleanupGL(canvas, gl);
});
