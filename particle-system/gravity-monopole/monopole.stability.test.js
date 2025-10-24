// @ts-check

/**
 * Stability tests for monopole particle system.
 * Tests behavior under extreme conditions.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import {
  createTestCanvas,
  createGLContext,
  cleanupGL,
  readAllParticleData,
  assertAllFinite
} from '../test-utils-integration.js';

import { ParticleSystemMonopole } from './particle-system-monopole.js';

/**
 * Test 1: Close approach (near collision)
 * Particles approaching closely should not produce NaN/Inf.
 */
test('monopole stability: close approach', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Two particles very close together
  const positions = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    0.1, 0.0, 0.0, 1.0  // Only 0.1 units apart
  ]);
  
  // High initial velocities toward each other
  const velocities = new Float32Array([
    0.5, 0.0, 0.0, 0.0,   // Moving toward particle 2
   -0.5, 0.0, 0.0, 0.0    // Moving toward particle 1
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2,  // Softening prevents singularity
    maxSpeed: 10.0,
    maxAccel: 10.0
  });
  
  // Simulate through close approach
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  
  // Verify no NaN or Inf despite close approach
  assertAllFinite(finalData.positions, 'Positions must remain finite during close approach');
  assertAllFinite(finalData.velocities, 'Velocities must remain finite during close approach');
  
  // Verify system state is reasonable
  for (let i = 0; i < 2; i++) {
    const x = finalData.positions[i * 4 + 0];
    const y = finalData.positions[i * 4 + 1];
    const z = finalData.positions[i * 4 + 2];
    const r = Math.sqrt(x * x + y * y + z * z);
    
    assert.ok(r < 100, `Particle ${i} should remain in reasonable bounds: r=${r}`);
  }
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 2: Zero mass particles
 * Particles with zero mass should not cause issues.
 */
test('monopole stability: zero mass particles', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const positions = new Float32Array([
    0.0, 0.0, 0.0, 0.0,   // Zero mass
    1.0, 0.0, 0.0, 1.0,   // Normal mass
    2.0, 0.0, 0.0, 0.0    // Zero mass
  ]);
  
  const velocities = new Float32Array([
    0.0, 0.1, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, -0.1, 0.0, 0.0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Simulate
  for (let i = 0; i < 50; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  
  // Verify no NaN or Inf with zero mass particles
  assertAllFinite(finalData.positions, 'Positions must be finite with zero mass particles');
  assertAllFinite(finalData.velocities, 'Velocities must be finite with zero mass particles');
  
  // Zero mass particles should not significantly affect massive particle
  const p1_vx = finalData.velocities[4];  // Particle 1 x-velocity
  assert.ok(Math.abs(p1_vx) < 0.1, `Massive particle should not be significantly affected by zero mass: vx=${p1_vx}`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 3: Very large mass ratio
 * Extreme mass differences should be handled gracefully.
 */
test('monopole stability: large mass ratio', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const positions = new Float32Array([
    0.0, 0.0, 0.0, 1000.0,  // Very massive
    2.0, 0.0, 0.0, 0.001     // Very light
  ]);
  
  const velocities = new Float32Array([
    0.0, 0.0, 0.0, 0.0,
    0.0, 1.0, 0.0, 0.0  // Light particle in orbit
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-10, -10, -10], max: [10, 10, 10] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2,
    maxSpeed: 10.0
  });
  
  // Simulate
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  
  // Verify numerical stability with large mass ratio
  assertAllFinite(finalData.positions, 'Positions must be finite with large mass ratio');
  assertAllFinite(finalData.velocities, 'Velocities must be finite with large mass ratio');
  
  // Massive particle should barely move
  const massiveVel = Math.sqrt(
    finalData.velocities[0] * finalData.velocities[0] +
    finalData.velocities[1] * finalData.velocities[1] +
    finalData.velocities[2] * finalData.velocities[2]
  );
  assert.ok(massiveVel < 0.1, `Massive particle should remain nearly stationary: v=${massiveVel}`);
  
  system.dispose();
  cleanupGL(canvas, gl);
});

/**
 * Test 4: High-speed particles
 * Particles with very high velocities should be clamped appropriately.
 */
test('monopole stability: high speed particles', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const positions = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    1.0, 0.0, 0.0, 1.0,
    0.0, 1.0, 0.0, 1.0
  ]);
  
  // Very high initial velocities
  const velocities = new Float32Array([
    50.0, 0.0, 0.0, 0.0,
    0.0, 50.0, 0.0, 0.0,
    0.0, 0.0, 50.0, 0.0
  ]);
  
  const maxSpeed = 10.0;
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-100, -100, -100], max: [100, 100, 100] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2,
    maxSpeed: maxSpeed
  });
  
  // Simulate
  for (let i = 0; i < 50; i++) {
    system.compute();
  }
  
  // Read final state
  const finalData = readAllParticleData(system);
  
  // Verify no NaN or Inf
  assertAllFinite(finalData.positions, 'Positions must be finite with high-speed particles');
  assertAllFinite(finalData.velocities, 'Velocities must be finite with high-speed particles');
  
  // Verify all speeds are clamped to maxSpeed
  for (let i = 0; i < 3; i++) {
    const vx = finalData.velocities[i * 4 + 0];
    const vy = finalData.velocities[i * 4 + 1];
    const vz = finalData.velocities[i * 4 + 2];
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    
    assert.ok(speed <= maxSpeed * 1.01, `Particle ${i} speed should be clamped: ${speed} <= ${maxSpeed}`);
  }
  
  system.dispose();
  cleanupGL(canvas, gl);
});
