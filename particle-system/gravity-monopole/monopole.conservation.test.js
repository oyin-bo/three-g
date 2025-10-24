// @ts-check

/**
 * Conservation tests for monopole particle system.
 * Tests physical invariants: momentum, energy, angular momentum.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  createTestCanvas,
  createGLContext,
  cleanupGL,
  generateRandomParticles,
  readAllParticleData,
  assertAllFinite,
  computeTotalMomentum,
  computeKineticEnergy,
  computePotentialEnergy,
  computeAngularMomentum
} from '../test-utils-integration.js';

import { ParticleSystemMonopole } from './particle-system-monopole.js';

/**
 * Test 1: Momentum conservation
 * Total momentum should remain constant in isolated system.
 */
test('monopole conservation: momentum', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const count = 50;
  const particleData = generateRandomParticles(
    count,
    { min: [-2, -2, -2], max: [2, 2, 2] },
    0.5,  // velocity scale
    23456
  );
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: particleData,
    worldBounds: { min: [-8, -8, -8], max: [8, 8, 8] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2,
    damping: 0.0  // No damping for conservation
  });
  
  // Record initial momentum
  const initialData = readAllParticleData(system);
  const masses = particleData.masses;
  const initialMomentum = computeTotalMomentum(initialData.velocities, masses);
  
  // Simulate
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  const finalMomentum = computeTotalMomentum(finalData.velocities, masses);
  
  // Verify momentum conservation
  const momentumError = [
    Math.abs(finalMomentum[0] - initialMomentum[0]),
    Math.abs(finalMomentum[1] - initialMomentum[1]),
    Math.abs(finalMomentum[2] - initialMomentum[2])
  ];
  
  const maxError = Math.max(...momentumError);
  assert.ok(maxError < 1e-3, `Momentum should be conserved: max error ${maxError}`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 2: Energy conservation
 * Total energy (kinetic + potential) should remain approximately constant.
 */
test('monopole conservation: energy', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const count = 20;
  const particleData = generateRandomParticles(
    count,
    { min: [-1, -1, -1], max: [1, 1, 1] },
    0.2,  // small velocity scale
    34567
  );
  
  const G = 0.0003;
  const softening = 0.2;
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: particleData,
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.005,  // Smaller timestep for better energy conservation
    gravityStrength: G,
    softening: softening,
    damping: 0.0
  });
  
  // Record initial energy
  const initialData = readAllParticleData(system);
  const masses = particleData.masses;
  const initialKE = computeKineticEnergy(initialData.velocities, masses);
  const initialPE = computePotentialEnergy(initialData.positions, masses, softening, G);
  const initialTotalEnergy = initialKE + initialPE;
  
  // Simulate
  const energySamples = [initialTotalEnergy];
  for (let i = 0; i < 200; i++) {
    system.compute();
    
    if (i % 20 === 0) {
      const data = readAllParticleData(system);
      const ke = computeKineticEnergy(data.velocities, masses);
      const pe = computePotentialEnergy(data.positions, masses, softening, G);
      energySamples.push(ke + pe);
    }
  }
  
  // Verify energy conservation (allow some drift due to numerical integration)
  const finalEnergy = energySamples[energySamples.length - 1];
  const energyError = Math.abs(finalEnergy - initialTotalEnergy) / Math.abs(initialTotalEnergy);
  
  assert.ok(energyError < 0.1, `Energy should be approximately conserved: error ${(energyError * 100).toFixed(2)}%`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 3: Angular momentum conservation
 * Total angular momentum should remain constant in isolated system.
 */
test('monopole conservation: angular momentum', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Create particles with rotational symmetry
  const count = 30;
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  const masses = new Float32Array(count);
  
  let seed = 45678;
  function seededRandom() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  
  // Create particles in rotating disk
  for (let i = 0; i < count; i++) {
    const r = 0.5 + seededRandom() * 1.5;
    const theta = seededRandom() * 2 * Math.PI;
    const z = (seededRandom() - 0.5) * 0.2;
    
    const x = r * Math.cos(theta);
    const y = r * Math.sin(theta);
    
    positions[i * 4 + 0] = x;
    positions[i * 4 + 1] = y;
    positions[i * 4 + 2] = z;
    positions[i * 4 + 3] = 1.0;
    
    // Tangential velocity (circular motion)
    const v = 0.3;
    velocities[i * 4 + 0] = -v * Math.sin(theta);
    velocities[i * 4 + 1] = v * Math.cos(theta);
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
    
    masses[i] = 1.0;
  }
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2,
    damping: 0.0
  });
  
  // Record initial angular momentum
  const initialData = readAllParticleData(system);
  const initialL = computeAngularMomentum(initialData.positions, initialData.velocities, masses);
  
  // Simulate
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  const finalL = computeAngularMomentum(finalData.positions, finalData.velocities, masses);
  
  // Verify angular momentum conservation
  const Lerror = [
    Math.abs(finalL[0] - initialL[0]),
    Math.abs(finalL[1] - initialL[1]),
    Math.abs(finalL[2] - initialL[2])
  ];
  
  const maxLerror = Math.max(...Lerror);
  const initialLmag = Math.sqrt(initialL[0] * initialL[0] + initialL[1] * initialL[1] + initialL[2] * initialL[2]);
  const relativeError = maxLerror / (initialLmag + 1e-10);
  
  assert.ok(relativeError < 0.1, `Angular momentum should be conserved: relative error ${(relativeError * 100).toFixed(2)}%`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});
