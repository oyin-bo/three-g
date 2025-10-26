// @ts-check

/**
 * Unit tests for KBoundsReduce kernel.
 * Tests hierarchical GPU bounds reduction for particle systems.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { 
  getGL, 
  createTestTexture, 
  readTexture, 
  assertClose, 
  assertAllFinite,
  disposeKernel,
  resetGL
} from '../test-utils.js';

import { KBoundsReduce } from './k-bounds-reduce.js';

/**
 * Test 1: Compute bounds for simple particle set
 * Four particles at unit cube corners should produce bounds [0,0,0] to [1,1,1]
 */
test('KBoundsReduce: simple particle set', async () => {
  const gl = getGL();
  const width = 2, height = 2;
  const particleCount = 4;
  
  // Create 4 particles: (0,0,0), (1,0,0), (0,1,0), (0,0,1)
  const positions = new Float32Array([
    0, 0, 0, 1,  // particle 0
    1, 0, 0, 1,  // particle 1
    0, 1, 0, 1,  // particle 2
    0, 0, 1, 1   // particle 3
  ]);
  
  const posTex = createTestTexture(gl, width, height, positions);
  
  const kernel = new KBoundsReduce({
    gl,
    inPosition: posTex,
    particleTexWidth: width,
    particleTexHeight: height,
    particleCount
  });
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: true });
  
  // Read bounds texture (2×1): pixel 0 = min, pixel 1 = max
  const minBounds = snapshot.bounds?.pixels?.[0];
  const maxBounds = snapshot.bounds?.pixels?.[1];
  
  assert.ok(minBounds, 'Min bounds should exist');
  assert.ok(maxBounds, 'Max bounds should exist');
  
  assertClose(minBounds.x, 0, 1e-5, `Min X\n\n${kernel.toString()}`);
  assertClose(minBounds.y, 0, 1e-5, `Min Y\n\n${kernel.toString()}`);
  assertClose(minBounds.z, 0, 1e-5, `Min Z\n\n${kernel.toString()}`);
  assertClose(maxBounds.x, 1, 1e-5, `Max X\n\n${kernel.toString()}`);
  assertClose(maxBounds.y, 1, 1e-5, `Max Y\n\n${kernel.toString()}`);
  assertClose(maxBounds.z, 1, 1e-5, `Max Z\n\n${kernel.toString()}`);
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Handle negative coordinates
 * Bounds should correctly span negative and positive regions
 */
test('KBoundsReduce: negative coordinates', async () => {
  const gl = getGL();
  const width = 2, height = 2;
  const particleCount = 4;
  
  const positions = new Float32Array([
    -2, -3, -4, 1,
    2, 3, 4, 1,
    0, 0, 0, 1,
    1, 1, 1, 1
  ]);
  
  const posTex = createTestTexture(gl, width, height, positions);
  
  const kernel = new KBoundsReduce({
    gl,
    inPosition: posTex,
    particleTexWidth: width,
    particleTexHeight: height,
    particleCount
  });
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: true });
  const minBounds = snapshot.bounds?.pixels?.[0];
  const maxBounds = snapshot.bounds?.pixels?.[1];
  
  assert.ok(minBounds && maxBounds, 'Bounds should exist');
  
  assertClose(minBounds.x, -2, 1e-5, 'Min X');
  assertClose(minBounds.y, -3, 1e-5, 'Min Y');
  assertClose(minBounds.z, -4, 1e-5, 'Min Z');
  assertClose(maxBounds.x, 2, 1e-5, 'Max X');
  assertClose(maxBounds.y, 3, 1e-5, 'Max Y');
  assertClose(maxBounds.z, 4, 1e-5, 'Max Z');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Ignore zero-mass particles
 * Particles with mass=0 should not contribute to bounds
 */
test('KBoundsReduce: ignore zero-mass particles', async () => {
  const gl = getGL();
  const width = 2, height = 2;
  const particleCount = 4;
  
  const positions = new Float32Array([
    -10, -10, -10, 0,  // zero mass - should be ignored
    1, 1, 1, 1,
    2, 2, 2, 1,
    3, 3, 3, 1
  ]);
  
  const posTex = createTestTexture(gl, width, height, positions);
  
  const kernel = new KBoundsReduce({
    gl,
    inPosition: posTex,
    particleTexWidth: width,
    particleTexHeight: height,
    particleCount
  });
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: true });
  const minBounds = snapshot.bounds?.pixels?.[0];
  const maxBounds = snapshot.bounds?.pixels?.[1];
  
  assert.ok(minBounds && maxBounds, 'Bounds should exist');
  
  // Bounds should be [1,1,1] to [3,3,3], ignoring (-10,-10,-10)
  assertClose(minBounds.x, 1, 1e-5, 'Min X should ignore zero-mass particle');
  assertClose(minBounds.y, 1, 1e-5, 'Min Y should ignore zero-mass particle');
  assertClose(minBounds.z, 1, 1e-5, 'Min Z should ignore zero-mass particle');
  assertClose(maxBounds.x, 3, 1e-5, 'Max X');
  assertClose(maxBounds.y, 3, 1e-5, 'Max Y');
  assertClose(maxBounds.z, 3, 1e-5, 'Max Z');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 4: Single particle
 * Min and max should be identical for a single particle
 */
test('KBoundsReduce: single particle', async () => {
  const gl = getGL();
  const width = 1, height = 1;
  const particleCount = 1;
  
  const positions = new Float32Array([
    5, -3, 7, 1
  ]);
  
  const posTex = createTestTexture(gl, width, height, positions);
  
  const kernel = new KBoundsReduce({
    gl,
    inPosition: posTex,
    particleTexWidth: width,
    particleTexHeight: height,
    particleCount
  });
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: true });
  const minBounds = snapshot.bounds?.pixels?.[0];
  const maxBounds = snapshot.bounds?.pixels?.[1];
  
  assert.ok(minBounds && maxBounds, 'Bounds should exist');
  
  // Min and max should be the same
  assertClose(minBounds.x, 5, 1e-5, 'Min X = particle X');
  assertClose(minBounds.y, -3, 1e-5, 'Min Y = particle Y');
  assertClose(minBounds.z, 7, 1e-5, 'Min Z = particle Z');
  assertClose(maxBounds.x, 5, 1e-5, 'Max X = particle X');
  assertClose(maxBounds.y, -3, 1e-5, 'Max Y = particle Y');
  assertClose(maxBounds.z, 7, 1e-5, 'Max Z = particle Z');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 5: Larger particle set (multi-level reduction)
 * Test with more particles to exercise hierarchical reduction
 */
test('KBoundsReduce: larger particle set', async () => {
  const gl = getGL();
  const width = 4, height = 4;
  const particleCount = 16;
  
  // Create 16 particles in a systematic pattern
  const positions = new Float32Array(64);
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (i % 4) - 1.5;     // x: -1.5 to 1.5
    positions[i * 4 + 1] = Math.floor(i / 4) - 1.5;  // y: -1.5 to 1.5
    positions[i * 4 + 2] = i * 0.1;           // z: 0 to 1.5
    positions[i * 4 + 3] = 1;                 // mass
  }
  
  const posTex = createTestTexture(gl, width, height, positions);
  
  const kernel = new KBoundsReduce({
    gl,
    inPosition: posTex,
    particleTexWidth: width,
    particleTexHeight: height,
    particleCount
  });
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: true });
  const minBounds = snapshot.bounds?.pixels?.[0];
  const maxBounds = snapshot.bounds?.pixels?.[1];
  
  assert.ok(minBounds && maxBounds, 'Bounds should exist');
  
  assertClose(minBounds.x, -1.5, 1e-5, 'Min X');
  assertClose(minBounds.y, -1.5, 1e-5, 'Min Y');
  assertClose(minBounds.z, 0, 1e-5, 'Min Z');
  assertClose(maxBounds.x, 1.5, 1e-5, 'Max X');
  assertClose(maxBounds.y, 1.5, 1e-5, 'Max Y');
  assertClose(maxBounds.z, 1.5, 1e-5, 'Max Z');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 6: All zero-mass particles
 * Should handle gracefully when all particles are ignored
 */
test('KBoundsReduce: all zero-mass particles', async () => {
  const gl = getGL();
  const width = 2, height = 2;
  const particleCount = 4;
  
  const positions = new Float32Array([
    10, 10, 10, 0,
    -5, -5, -5, 0,
    0, 0, 0, 0,
    100, 100, 100, 0
  ]);
  
  const posTex = createTestTexture(gl, width, height, positions);
  
  const kernel = new KBoundsReduce({
    gl,
    inPosition: posTex,
    particleTexWidth: width,
    particleTexHeight: height,
    particleCount
  });
  
  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: true });
  const minBounds = snapshot.bounds?.pixels?.[0];
  const maxBounds = snapshot.bounds?.pixels?.[1];
  
  assert.ok(minBounds && maxBounds, 'Bounds should exist');
  
  // With all zero-mass particles, bounds should remain at initial extreme values
  // or produce some default behavior - verify no NaN/Inf
  assertAllFinite([minBounds.x, minBounds.y, minBounds.z], 'Min bounds should be finite');
  assertAllFinite([maxBounds.x, maxBounds.y, maxBounds.z], 'Max bounds should be finite');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Export function for running all tests (for REPL runner)
 * @param {WebGL2RenderingContext} glContext
 * @returns {Promise<object>}
 */
export async function runTests(glContext) {
  // Note: When run from browser REPL via daebug, the daebug test runner
  // will handle execution. This function is for programmatic access if needed.
  return { status: 'tests loaded' };
}


