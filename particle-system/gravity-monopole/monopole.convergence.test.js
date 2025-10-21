// @ts-check

/**
 * Convergence tests for monopole particle system.
 * Tests refinement behavior as parameters are varied.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  createTestCanvas,
  createGLContext,
  cleanupGL,
  setupBinaryOrbit,
  readAllParticleData,
  assertAllFinite
} from '../test-utils-integration.js';

import { ParticleSystemMonopole } from './particle-system-monopole.js';

/**
 * Test 1: Theta refinement
 * Smaller theta (opening angle) should give more accurate results.
 */
test('monopole convergence: theta refinement', async () => {
  const G = 0.0003;
  const mass1 = 1.0;
  const mass2 = 1.0;
  const separation = 2.0;
  
  // Run simulation with different theta values
  const thetaValues = [0.8, 0.5, 0.3];
  const finalSeparations = [];
  
  for (const theta of thetaValues) {
    const canvas = createTestCanvas();
    const gl = createGLContext(canvas);
    
    const particleData = setupBinaryOrbit(mass1, mass2, separation, 0.0, G);
    
    const system = new ParticleSystemMonopole(gl, {
      particleData: particleData,
      worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
      dt: 0.01,
      gravityStrength: G,
      softening: 0.05,
      theta: theta
    });
    
    // Simulate one orbit
    for (let i = 0; i < 100; i++) {
      system.compute();
    }
    
    // Measure final separation
    const finalData = readAllParticleData(system);
    const dx = finalData.positions[4] - finalData.positions[0];
    const dy = finalData.positions[5] - finalData.positions[1];
    const dz = finalData.positions[6] - finalData.positions[2];
    const sep = Math.sqrt(dx * dx + dy * dy + dz * dz);
    
    finalSeparations.push(sep);
    
    system.dispose();
    cleanupGL(canvas, gl);
  }
  
  // Verify refinement: smaller theta gives results closer to initial separation
  const expectedSep = separation;
  const errors = finalSeparations.map(sep => Math.abs(sep - expectedSep));
  
  // Errors should generally decrease with smaller theta
  // (though not strictly monotonic due to other numerical factors)
  assert.ok(errors[2] <= errors[0] * 1.2, 
    `Smaller theta should improve accuracy: errors ${errors.map(e => e.toFixed(4)).join(', ')}`);
  
  console.log(`Theta refinement: ${thetaValues.map((t, i) => `θ=${t}: error=${errors[i].toFixed(4)}`).join(', ')}`);
});

/**
 * Test 2: Timestep refinement
 * Smaller timestep should give more accurate results.
 */
test('monopole convergence: timestep refinement', async () => {
  const G = 0.0003;
  const mass1 = 1.0;
  const mass2 = 1.0;
  const separation = 2.0;
  
  // Run simulation with different timesteps
  const timesteps = [0.02, 0.01, 0.005];
  const finalEnergies = [];
  
  for (const dt of timesteps) {
    const canvas = createTestCanvas();
    const gl = createGLContext(canvas);
    
    const particleData = setupBinaryOrbit(mass1, mass2, separation, 0.0, G);
    
    const system = new ParticleSystemMonopole(gl, {
      particleData: particleData,
      worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
      dt: dt,
      gravityStrength: G,
      softening: 0.05,
      damping: 0.0
    });
    
    // Simulate fixed physical time
    const physicalTime = 1.0;
    const steps = Math.ceil(physicalTime / dt);
    
    for (let i = 0; i < steps; i++) {
      system.compute();
    }
    
    // Calculate total energy
    const finalData = readAllParticleData(system);
    
    // Kinetic energy
    let ke = 0;
    const masses = particleData.masses;
    for (let i = 0; i < 2; i++) {
      const vx = finalData.velocities[i * 4 + 0];
      const vy = finalData.velocities[i * 4 + 1];
      const vz = finalData.velocities[i * 4 + 2];
      ke += 0.5 * masses[i] * (vx * vx + vy * vy + vz * vz);
    }
    
    // Potential energy
    const dx = finalData.positions[4] - finalData.positions[0];
    const dy = finalData.positions[5] - finalData.positions[1];
    const dz = finalData.positions[6] - finalData.positions[2];
    const r = Math.sqrt(dx * dx + dy * dy + dz * dz + 0.05 * 0.05);
    const pe = -G * masses[0] * masses[1] / r;
    
    const totalEnergy = ke + pe;
    finalEnergies.push(totalEnergy);
    
    system.dispose();
    cleanupGL(canvas, gl);
  }
  
  // Calculate initial energy for reference
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  const particleData = setupBinaryOrbit(mass1, mass2, separation, 0.0, G);
  
  let initialKE = 0;
  for (let i = 0; i < 2; i++) {
    const vx = particleData.velocities[i * 4 + 0];
    const vy = particleData.velocities[i * 4 + 1];
    const vz = particleData.velocities[i * 4 + 2];
    initialKE += 0.5 * particleData.masses[i] * (vx * vx + vy * vy + vz * vz);
  }
  const initialPE = -G * mass1 * mass2 / Math.sqrt(separation * separation + 0.05 * 0.05);
  const initialEnergy = initialKE + initialPE;
  
  cleanupGL(canvas, gl);
  
  // Verify smaller timesteps preserve energy better
  const energyErrors = finalEnergies.map(e => Math.abs(e - initialEnergy) / Math.abs(initialEnergy));
  
  console.log(`Timestep refinement: ${timesteps.map((dt, i) => `dt=${dt}: error=${(energyErrors[i] * 100).toFixed(2)}%`).join(', ')}`);
  
  // Smallest timestep should have smallest error (within reasonable tolerance)
  assert.ok(energyErrors[2] <= energyErrors[0] * 2.0,
    `Smaller timestep should improve energy conservation: errors ${energyErrors.map(e => (e * 100).toFixed(2) + '%').join(', ')}`);
});

/**
 * Test 3: Softening sensitivity
 * Results should converge as softening decreases (for well-separated particles).
 */
test('monopole convergence: softening sensitivity', async () => {
  // Two particles well-separated
  const positions = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    4.0, 0.0, 0.0, 1.0  // Far apart
  ]);
  const velocities = new Float32Array([
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0
  ]);
  
  const G = 0.0003;
  const softeningValues = [0.4, 0.2, 0.1];
  const finalVelocities = [];
  
  for (const softening of softeningValues) {
    const canvas = createTestCanvas();
    const gl = createGLContext(canvas);
    
    const system = new ParticleSystemMonopole(gl, {
      particleData: { 
        positions: new Float32Array(positions), 
        velocities: new Float32Array(velocities) 
      },
      worldBounds: { min: [-8, -8, -8], max: [8, 8, 8] },
      dt: 0.01,
      gravityStrength: G,
      softening: softening
    });
    
    // Simulate
    for (let i = 0; i < 50; i++) {
      system.compute();
    }
    
    // Read final velocity of particle 0
    const finalData = readAllParticleData(system);
    const vx = finalData.velocities[0];
    finalVelocities.push(vx);
    
    system.dispose();
    cleanupGL(canvas, gl);
  }
  
  // Calculate theoretical force without softening: F = G*m1*m2/r^2
  const r = 4.0;
  const theoreticalAccel = G * 1.0 / (r * r);
  const theoreticalVel = theoreticalAccel * 0.01 * 50;  // Simple estimate
  
  // Velocities should converge toward theoretical value as softening decreases
  const errors = finalVelocities.map(v => Math.abs(v - theoreticalVel));
  
  console.log(`Softening sensitivity: ${softeningValues.map((s, i) => `ε=${s}: v=${finalVelocities[i].toFixed(6)}`).join(', ')}`);
  console.log(`Theoretical velocity: ${theoreticalVel.toFixed(6)}`);
  
  // Smallest softening should give result closest to theoretical (for well-separated particles)
  assert.ok(errors[2] <= errors[0],
    `Smaller softening should approach theoretical value: errors ${errors.map(e => e.toFixed(6)).join(', ')}`);
});
