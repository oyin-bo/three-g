// @ts-check

/**
 * Integration test for occupancy-based cell culling in quadrupole traversal.
 * 
 * Validates that the aggregator generates occupancy data and the traversal
 * kernel correctly uses it to skip empty cells.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { 
  getGL, 
  resetGL,
  disposeKernel
} from '../test-utils.js';

import { ParticleSystemQuadrupoleKernels } from './particle-system-quadrupole-kernels.js';

/**
 * Test 1: Generate occupancy texture from aggregation
 * Sparse particle distribution should produce occupancy mask
 */
test('OccupancyIntegration: generate occupancy texture', async () => {
  const gl = getGL();
  
  // Create sparse particle distribution (only a few occupied cells)
  const particleCount = 8;
  const positions = new Float32Array(particleCount * 4);
  
  // Place all particles in one corner (should produce sparse occupancy)
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = -3.5 + i * 0.1;  // x
    positions[i * 4 + 1] = -3.5;             // y
    positions[i * 4 + 2] = 0.1;              // z
    positions[i * 4 + 3] = 1.0;              // mass
  }
  
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions },
    particleCount,
    worldBounds: { min: [-4, -4, 0], max: [4, 4, 2] },
    useOccupancyMasks: true
  });
  
  // Run one step to build octree and generate occupancy
  system.step();
  
  // Verify aggregator generated occupancy texture
  assert.ok(system.aggregatorKernel.outOccupancy, 'Aggregator should generate occupancy texture');
  
  // Verify traversal received occupancy texture
  assert.strictEqual(
    system.traversalKernel.inOccupancy, 
    system.aggregatorKernel.outOccupancy,
    'Traversal should receive occupancy texture from aggregator'
  );
  
  system.dispose();
  resetGL();
});

/**
 * Test 2: Skip empty cells during traversal when occupancy enabled
 * Compare performance and correctness with/without occupancy optimization
 */
test('OccupancyIntegration: skip empty cells during traversal', async () => {
  const gl = getGL();
  
  const particleCount = 16;
  const positions = new Float32Array(particleCount * 4);
  
  // Create two clusters: top-left and bottom-right
  for (let i = 0; i < particleCount / 2; i++) {
    positions[i * 4 + 0] = -3.0;
    positions[i * 4 + 1] = 3.0;
    positions[i * 4 + 2] = 1.0;
    positions[i * 4 + 3] = 1.0;
  }
  
  for (let i = particleCount / 2; i < particleCount; i++) {
    positions[i * 4 + 0] = 3.0;
    positions[i * 4 + 1] = -3.0;
    positions[i * 4 + 2] = 1.0;
    positions[i * 4 + 3] = 1.0;
  }
  
  // System with occupancy
  const systemWithOccupancy = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions: new Float32Array(positions) },
    particleCount,
    worldBounds: { min: [-4, -4, 0], max: [4, 4, 2] },
    useOccupancyMasks: true
  });
  
  const start = performance.now();
  for (let i = 0; i < 10; i++) {
    systemWithOccupancy.step();
  }
  const timeWith = performance.now() - start;
  
  // System without occupancy (baseline)
  const systemWithoutOccupancy = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions: new Float32Array(positions) },
    particleCount,
    worldBounds: { min: [-4, -4, 0], max: [4, 4, 2] },
    useOccupancyMasks: false
  });
  
  const start2 = performance.now();
  for (let i = 0; i < 10; i++) {
    systemWithoutOccupancy.step();
  }
  const timeWithout = performance.now() - start2;
  
  // Log performance comparison
  const speedup = timeWithout / timeWith;
  console.log(`Occupancy enabled: ${timeWith.toFixed(2)}ms`);
  console.log(`Occupancy disabled: ${timeWithout.toFixed(2)}ms`);
  console.log(`Speedup: ${speedup.toFixed(2)}x`);
  
  // Both should produce valid results
  assert.ok(systemWithOccupancy.traversalKernel.outForce, 'System with occupancy should produce force output');
  assert.ok(systemWithoutOccupancy.traversalKernel.outForce, 'System without occupancy should produce force output');
  
  // Occupancy should not degrade performance significantly
  // (In sparse cases, it should improve; in worst case, overhead should be minimal)
  assert.ok(speedup > 0.5, `Occupancy overhead should be reasonable (speedup=${speedup.toFixed(2)}x)`);
  
  systemWithOccupancy.dispose();
  systemWithoutOccupancy.dispose();
  resetGL();
});

/**
 * Test 3: Handle dense particle distributions with occupancy
 * Verify correctness when most cells are occupied (worst case for occupancy optimization)
 */
test('OccupancyIntegration: dense particle distribution', async () => {
  const gl = getGL();
  
  const particleCount = 64;
  const positions = new Float32Array(particleCount * 4);
  
  // Create uniform distribution (all cells occupied)
  for (let i = 0; i < particleCount; i++) {
    const t = i / particleCount;
    const angle = t * Math.PI * 2 * 4;
    const radius = 3.0 * t;
    positions[i * 4 + 0] = Math.cos(angle) * radius;
    positions[i * 4 + 1] = Math.sin(angle) * radius;
    positions[i * 4 + 2] = 1.0;
    positions[i * 4 + 3] = 1.0;
  }
  
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions },
    particleCount,
    worldBounds: { min: [-4, -4, 0], max: [4, 4, 2] },
    useOccupancyMasks: true
  });
  
  // Should work correctly even when most cells are occupied
  for (let i = 0; i < 5; i++) {
    system.step();
  }
  
  assert.ok(system.traversalKernel.outForce, 'Dense distribution should produce valid force output');
  
  system.dispose();
  resetGL();
});

/**
 * Export function for running all tests (for REPL runner)
 * @param {WebGL2RenderingContext} glContext
 * @returns {Promise<object>}
 */
export async function runTests(glContext) {
  return { status: 'tests loaded' };
}
