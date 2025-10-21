// @ts-check

/**
 * Large-scale integration tests for monopole particle system.
 * Tests scaling behavior and numerical stability with realistic particle counts.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  createTestCanvas,
  createGLContext,
  cleanupGL,
  generateUniformParticles,
  readAllParticleData,
  assertAllFinite,
  assertBounded,
  computeCenterOfMass,
  computeTotalMomentum
} from '../test-utils-integration.js';

import { ParticleSystemMonopole } from './particle-system-monopole.js';

/**
 * Test 1: 100 particles uniform distribution
 * Verify stability with moderate particle count.
 */
test('monopole large-scale: 100 particles uniform', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const count = 100;
  const particleData = generateUniformParticles(
    count,
    { min: [-4, -4, -4], max: [4, 4, 4] },
    12345
  );
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: particleData,
    worldBounds: { min: [-8, -8, -8], max: [8, 8, 8] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Record initial state
  const initialData = readAllParticleData(system);
  const masses = particleData.masses;
  const initialCOM = computeCenterOfMass(initialData.positions, masses);
  const initialMomentum = computeTotalMomentum(initialData.velocities, masses);
  
  // Step simulation
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  
  // Verify all positions and velocities are finite
  assertAllFinite(finalData.positions, 'Positions must be finite');
  assertAllFinite(finalData.velocities, 'Velocities must be finite');
  
  // Verify velocities are bounded
  assertBounded(finalData.velocities, 10.0, 'Velocities should be bounded');
  
  // Verify center of mass drift is small
  const finalCOM = computeCenterOfMass(finalData.positions, masses);
  const comDrift = Math.sqrt(
    Math.pow(finalCOM[0] - initialCOM[0], 2) +
    Math.pow(finalCOM[1] - initialCOM[1], 2) +
    Math.pow(finalCOM[2] - initialCOM[2], 2)
  );
  assert.ok(comDrift < 0.1, `COM drift should be small: ${comDrift}`);
  
  // Verify momentum conservation (approximate)
  const finalMomentum = computeTotalMomentum(finalData.velocities, masses);
  const momentumError = Math.sqrt(
    Math.pow(finalMomentum[0] - initialMomentum[0], 2) +
    Math.pow(finalMomentum[1] - initialMomentum[1], 2) +
    Math.pow(finalMomentum[2] - initialMomentum[2], 2)
  );
  assert.ok(momentumError < 1e-3, `Momentum should be conserved: error ${momentumError}`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 2: 1000 particles clustered
 * Dense center with sparse edges (Plummer-like distribution).
 */
test('monopole large-scale: 1000 particles clustered', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const count = 1000;
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  const masses = new Float32Array(count);
  
  // Plummer-like distribution: r = a / sqrt((random^(-2/3)) - 1)
  // Simplified version: exponential decay
  let seed = 54321;
  function seededRandom() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  
  for (let i = 0; i < count; i++) {
    const u = seededRandom();
    const r = Math.pow(u, 1/3) * 4.0; // Concentrated toward center
    const theta = seededRandom() * 2 * Math.PI;
    const phi = Math.acos(2 * seededRandom() - 1);
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = 0.0;
    velocities[i * 4 + 1] = 0.0;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
    
    masses[i] = 1.0;
  }
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-8, -8, -8], max: [8, 8, 8] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Calculate initial velocity dispersion
  const initialData = readAllParticleData(system);
  let initialVDisp = 0;
  for (let i = 0; i < count; i++) {
    const vx = initialData.velocities[i * 4 + 0];
    const vy = initialData.velocities[i * 4 + 1];
    const vz = initialData.velocities[i * 4 + 2];
    initialVDisp += vx * vx + vy * vy + vz * vz;
  }
  initialVDisp = Math.sqrt(initialVDisp / count);
  
  // Step simulation
  for (let i = 0; i < 200; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  
  // Verify all values are finite
  assertAllFinite(finalData.positions, 'Positions must be finite');
  assertAllFinite(finalData.velocities, 'Velocities must be finite');
  
  // Calculate final velocity dispersion
  let finalVDisp = 0;
  for (let i = 0; i < count; i++) {
    const vx = finalData.velocities[i * 4 + 0];
    const vy = finalData.velocities[i * 4 + 1];
    const vz = finalData.velocities[i * 4 + 2];
    finalVDisp += vx * vx + vy * vy + vz * vz;
  }
  finalVDisp = Math.sqrt(finalVDisp / count);
  
  // Velocity dispersion should increase (virial equilibrium approach)
  assert.ok(finalVDisp > initialVDisp, `Velocity dispersion should increase: ${initialVDisp} -> ${finalVDisp}`);
  
  // Verify system remains bound (no escape velocities)
  assertBounded(finalData.velocities, 10.0, 'Velocities should remain bounded');
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 3: 10,000 particles with hierarchy
 * Small dense core + diffuse halo to stress-test octree.
 */
test('monopole large-scale: 10000 particles hierarchy', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const coreCount = 100;
  const haloCount = 9900;
  const totalCount = coreCount + haloCount;
  
  const positions = new Float32Array(totalCount * 4);
  const velocities = new Float32Array(totalCount * 4);
  const masses = new Float32Array(totalCount);
  
  let seed = 99999;
  function seededRandom() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  
  // Core particles: dense, heavy
  for (let i = 0; i < coreCount; i++) {
    const r = seededRandom() * 1.0;
    const theta = seededRandom() * 2 * Math.PI;
    const phi = Math.acos(2 * seededRandom() - 1);
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 10.0; // heavier
    
    velocities[i * 4 + 0] = 0.0;
    velocities[i * 4 + 1] = 0.0;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
    
    masses[i] = 10.0;
  }
  
  // Halo particles: diffuse, lighter
  for (let i = coreCount; i < totalCount; i++) {
    const r = 1.0 + seededRandom() * 9.0;
    const theta = seededRandom() * 2 * Math.PI;
    const phi = Math.acos(2 * seededRandom() - 1);
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0; // lighter
    
    velocities[i * 4 + 0] = 0.0;
    velocities[i * 4 + 1] = 0.0;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
    
    masses[i] = 1.0;
  }
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-16, -16, -16], max: [16, 16, 16] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Step simulation (fewer steps due to particle count)
  const startTime = performance.now();
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  const elapsed = performance.now() - startTime;
  
  // Read final state
  const finalData = readAllParticleData(system);
  
  // Verify all values are finite
  assertAllFinite(finalData.positions, 'Positions must be finite');
  assertAllFinite(finalData.velocities, 'Velocities must be finite');
  
  // Check performance didn't degrade catastrophically (rough check)
  const avgStepTime = elapsed / 100;
  assert.ok(avgStepTime < 1000, `Average step time should be reasonable: ${avgStepTime.toFixed(2)}ms`);
  
  // Verify hierarchical structure maintained (check core stays compact)
  let coreSpread = 0;
  for (let i = 0; i < coreCount; i++) {
    const x = finalData.positions[i * 4 + 0];
    const y = finalData.positions[i * 4 + 1];
    const z = finalData.positions[i * 4 + 2];
    coreSpread += Math.sqrt(x * x + y * y + z * z);
  }
  coreSpread /= coreCount;
  
  // Core should remain relatively compact
  assert.ok(coreSpread < 5.0, `Core should remain compact: ${coreSpread}`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});
