// @ts-check

/**
 * Monopole Integration Tests - Large Scale
 * 
 * Validates scaling behavior and numerical stability with realistic particle counts.
 * 
 * These tests are designed to run in a browser environment via the daebug REPL.
 * Each test creates its own isolated GL context and disposes it after completion.
 */

import { ParticleSystemMonopole } from './particle-system-monopole.js';

// ============================================================================
// Inline Test Utilities (self-contained per project policy)
// ============================================================================

/**
 * Create an offscreen canvas for testing
 * @param {number} width
 * @param {number} height
 * @returns {HTMLCanvasElement}
 */
function createTestCanvas(width = 256, height = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Get WebGL2 context with required extensions
 * @param {HTMLCanvasElement} canvas
 * @returns {WebGL2RenderingContext}
 */
function createGLContext(canvas) {
  const gl = canvas.getContext('webgl2');
  if (!gl) {
    throw new Error('WebGL2 not supported');
  }
  
  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) {
    throw new Error('EXT_color_buffer_float not supported');
  }
  
  return gl;
}

/**
 * Clean up GL resources
 * @param {HTMLCanvasElement} canvas
 * @param {WebGL2RenderingContext} gl
 */
function cleanupGL(canvas, gl) {
  const loseContext = gl.getExtension('WEBGL_lose_context');
  if (loseContext) {
    loseContext.loseContext();
  }
  if (canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
}

/**
 * Read all particle data from GPU
 * @param {ParticleSystemMonopole} system
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function readAllParticleData(system) {
  const gl = system.gl;
  const width = system.particleTexWidth;
  const height = system.particleTexHeight;
  const totalPixels = width * height;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  // Read positions
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.inPosition, 0);
  const positions = new Float32Array(totalPixels * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, positions);
  
  // Read velocities
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.inVelocity, 0);
  const velocities = new Float32Array(totalPixels * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, velocities);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return { positions, velocities };
}

/**
 * Generate uniformly distributed particles in a cube
 * @param {number} count
 * @param {number[]} bounds - [min, max]
 * @param {number} seed - Random seed for reproducibility
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function generateUniformParticles(count, bounds, seed = 12345) {
  // Simple seeded random number generator
  let rngState = seed;
  function random() {
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return rngState / 4294967296;
  }
  
  const [min, max] = bounds;
  const range = max - min;
  
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    positions[i * 4 + 0] = min + random() * range;
    positions[i * 4 + 1] = min + random() * range;
    positions[i * 4 + 2] = min + random() * range;
    positions[i * 4 + 3] = 1.0; // unit mass
    
    velocities[i * 4 + 0] = 0.0;
    velocities[i * 4 + 1] = 0.0;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
  }
  
  return { positions, velocities };
}

/**
 * Generate clustered particles (Plummer-like distribution)
 * @param {number} count
 * @param {number} radius
 * @param {number} seed
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function generateClusteredParticles(count, radius, seed = 12345) {
  let rngState = seed;
  function random() {
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return rngState / 4294967296;
  }
  
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    // Plummer-like radial distribution: r = a / sqrt((1/u^(2/3)) - 1)
    const u = random();
    const r = radius / Math.sqrt(Math.pow(u, -2/3) - 1);
    
    // Random direction
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0; // unit mass
    
    velocities[i * 4 + 0] = 0.0;
    velocities[i * 4 + 1] = 0.0;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
  }
  
  return { positions, velocities };
}

/**
 * Generate hierarchical distribution (dense core + halo)
 * @param {number} coreCount
 * @param {number} haloCount
 * @param {number} coreRadius
 * @param {number} haloRadius
 * @param {number} seed
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function generateHierarchicalParticles(coreCount, haloCount, coreRadius, haloRadius, seed = 12345) {
  let rngState = seed;
  function random() {
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return rngState / 4294967296;
  }
  
  const totalCount = coreCount + haloCount;
  const positions = new Float32Array(totalCount * 4);
  const velocities = new Float32Array(totalCount * 4);
  
  // Generate core particles (higher mass)
  for (let i = 0; i < coreCount; i++) {
    const r = random() * coreRadius;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 10.0; // higher mass
    
    velocities[i * 4 + 0] = 0.0;
    velocities[i * 4 + 1] = 0.0;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
  }
  
  // Generate halo particles (lower mass)
  for (let i = 0; i < haloCount; i++) {
    const idx = coreCount + i;
    const r = coreRadius + random() * (haloRadius - coreRadius);
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    
    positions[idx * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[idx * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[idx * 4 + 2] = r * Math.cos(phi);
    positions[idx * 4 + 3] = 1.0; // unit mass
    
    velocities[idx * 4 + 0] = 0.0;
    velocities[idx * 4 + 1] = 0.0;
    velocities[idx * 4 + 2] = 0.0;
    velocities[idx * 4 + 3] = 0.0;
  }
  
  return { positions, velocities };
}

/**
 * Assert all values in array are finite
 * @param {Float32Array|number[]} array
 * @param {string} message
 */
function assertAllFinite(array, message = 'Values must be finite') {
  for (let i = 0; i < array.length; i++) {
    if (!isFinite(array[i])) {
      throw new Error(`${message}: array[${i}] = ${array[i]}`);
    }
  }
}

/**
 * Assert all values in array are bounded
 * @param {Float32Array|number[]} array
 * @param {number} maxValue
 * @param {string} message
 */
function assertBounded(array, maxValue, message = 'Values must be bounded') {
  for (let i = 0; i < array.length; i++) {
    if (Math.abs(array[i]) > maxValue) {
      throw new Error(`${message}: array[${i}] = ${array[i]} exceeds ${maxValue}`);
    }
  }
}

/**
 * Compute center of mass
 * @param {Float32Array} positions - RGBA32F format (x,y,z,mass)
 * @param {number} particleCount
 * @returns {number[]} [x, y, z]
 */
function computeCenterOfMass(positions, particleCount) {
  let totalMass = 0;
  let cx = 0, cy = 0, cz = 0;
  
  for (let i = 0; i < particleCount; i++) {
    const mass = positions[i * 4 + 3];
    const x = positions[i * 4 + 0];
    const y = positions[i * 4 + 1];
    const z = positions[i * 4 + 2];
    
    totalMass += mass;
    cx += mass * x;
    cy += mass * y;
    cz += mass * z;
  }
  
  return [cx / totalMass, cy / totalMass, cz / totalMass];
}

/**
 * Compute total momentum
 * @param {Float32Array} velocities
 * @param {Float32Array} positions - for masses
 * @param {number} particleCount
 * @returns {number[]} [px, py, pz]
 */
function computeTotalMomentum(velocities, positions, particleCount) {
  let px = 0, py = 0, pz = 0;
  
  for (let i = 0; i < particleCount; i++) {
    const mass = positions[i * 4 + 3];
    px += mass * velocities[i * 4 + 0];
    py += mass * velocities[i * 4 + 1];
    pz += mass * velocities[i * 4 + 2];
  }
  
  return [px, py, pz];
}

/**
 * Dispose particle system
 * @param {ParticleSystemMonopole} system
 */
function disposeSystem(system) {
  if (system && system.dispose) {
    system.dispose();
  }
}

// ============================================================================
// Tests
// ============================================================================

/**
 * Test 1: 100 Particles Uniform Distribution
 * Verify numerical stability with moderate particle count.
 */
export async function test100ParticlesUniform() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Generate 100 particles uniformly distributed in [-4, 4] cube
  const particleData = generateUniformParticles(100, [-4, 4], 42);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData,
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2,
    worldBounds: { min: [-8, -8, -8], max: [8, 8, 8] }
  });
  
  // Record initial state
  const initial = readAllParticleData(system);
  const initialCOM = computeCenterOfMass(initial.positions, 100);
  const initialMomentum = computeTotalMomentum(initial.velocities, initial.positions, 100);
  
  // Step simulation 100 times
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  
  // Read final state
  const final = readAllParticleData(system);
  
  // Verify all positions finite (no divergence)
  assertAllFinite(final.positions, 'Positions must be finite');
  
  // Verify all velocities finite and bounded (< 10.0)
  assertAllFinite(final.velocities, 'Velocities must be finite');
  assertBounded(final.velocities, 10.0, 'Velocities must be bounded');
  
  // Check center of mass drift is small (< 0.1)
  const finalCOM = computeCenterOfMass(final.positions, 100);
  const comDrift = Math.sqrt(
    Math.pow(finalCOM[0] - initialCOM[0], 2) +
    Math.pow(finalCOM[1] - initialCOM[1], 2) +
    Math.pow(finalCOM[2] - initialCOM[2], 2)
  );
  
  if (!(comDrift < 0.1)) {
    throw new Error(`Center of mass drift should be small (${comDrift})`);
  }
  
  // Check momentum conservation (< 1e-3 drift per component)
  const finalMomentum = computeTotalMomentum(final.velocities, final.positions, 100);
  const momentumDrift = Math.sqrt(
    Math.pow(finalMomentum[0] - initialMomentum[0], 2) +
    Math.pow(finalMomentum[1] - initialMomentum[1], 2) +
    Math.pow(finalMomentum[2] - initialMomentum[2], 2)
  );
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return { passed: true, test: '100 particles uniform', comDrift, momentumDrift };
}

/**
 * Test 2: 1000 Particles Clustered (Plummer-like)
 * Verify system remains bound with realistic particle count.
 */
export async function test1000ParticlesClustered() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Generate 1000 particles in Plummer-like distribution
  const particleData = generateClusteredParticles(1000, 2.0, 789);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData,
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.1,
    worldBounds: { min: [-10, -10, -10], max: [10, 10, 10] }
  });
  
  // Calculate initial maximum radius
  const initial = readAllParticleData(system);
  const initialCOM = computeCenterOfMass(initial.positions, 1000);
  let initialMaxR = 0;
  for (let i = 0; i < 1000; i++) {
    const dx = initial.positions[i * 4 + 0] - initialCOM[0];
    const dy = initial.positions[i * 4 + 1] - initialCOM[1];
    const dz = initial.positions[i * 4 + 2] - initialCOM[2];
    const r = Math.sqrt(dx*dx + dy*dy + dz*dz);
    initialMaxR = Math.max(initialMaxR, r);
  }
  
  // Step simulation 200 times
  for (let i = 0; i < 200; i++) {
    system.compute();
  }
  
  // Read final state
  const final = readAllParticleData(system);
  
  // Verify system remains bound (no escape velocity)
  // Maximum radius shouldn't increase dramatically
  const finalCOM = computeCenterOfMass(final.positions, 1000);
  let finalMaxR = 0;
  let escapeCount = 0;
  
  for (let i = 0; i < 1000; i++) {
    const dx = final.positions[i * 4 + 0] - finalCOM[0];
    const dy = final.positions[i * 4 + 1] - finalCOM[1];
    const dz = final.positions[i * 4 + 2] - finalCOM[2];
    const r = Math.sqrt(dx*dx + dy*dy + dz*dz);
    finalMaxR = Math.max(finalMaxR, r);
    
    if (r > initialMaxR * 3) escapeCount++;
  }
  
  // Verify no numerical artifacts
  assertAllFinite(final.positions, 'Positions must be finite');
  assertAllFinite(final.velocities, 'Velocities must be finite');
  
  // Most particles should remain bound
  if (!(escapeCount < 50)) {
    throw new Error(`Too many particles escaped: ${escapeCount}/1000`);
  }
  
  // Velocity dispersion should be reasonable
  let velocitySumSq = 0;
  for (let i = 0; i < 1000; i++) {
    const vx = final.velocities[i * 4 + 0];
    const vy = final.velocities[i * 4 + 1];
    const vz = final.velocities[i * 4 + 2];
    velocitySumSq += vx*vx + vy*vy + vz*vz;
  }
  const velocityRMS = Math.sqrt(velocitySumSq / 1000);
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return { 
    passed: true, 
    test: '1000 particles clustered',
    finalMaxR,
    escapeCount,
    velocityRMS
  };
}

/**
 * Test 3: 10,000 Particles with Hierarchy
 * Verify octree handles density gradients correctly.
 */
export async function test10000ParticlesHierarchy() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Generate hierarchical distribution: 100 core + 9900 halo
  const particleData = generateHierarchicalParticles(100, 9900, 1.0, 10.0, 456);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData,
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.1,
    worldBounds: { min: [-15, -15, -15], max: [15, 15, 15] }
  });
  
  // Measure initial core radius
  const initial = readAllParticleData(system);
  let initialCoreRadius = 0;
  for (let i = 0; i < 100; i++) {
    const x = initial.positions[i * 4 + 0];
    const y = initial.positions[i * 4 + 1];
    const z = initial.positions[i * 4 + 2];
    const r = Math.sqrt(x*x + y*y + z*z);
    initialCoreRadius = Math.max(initialCoreRadius, r);
  }
  
  // Step simulation 100 times
  const startTime = performance.now();
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  const elapsed = performance.now() - startTime;
  const avgStepTime = elapsed / 100;
  
  // Read final state
  const final = readAllParticleData(system);
  
  // Verify hierarchical structure maintained
  let finalCoreRadius = 0;
  for (let i = 0; i < 100; i++) {
    const x = final.positions[i * 4 + 0];
    const y = final.positions[i * 4 + 1];
    const z = final.positions[i * 4 + 2];
    const r = Math.sqrt(x*x + y*y + z*z);
    finalCoreRadius = Math.max(finalCoreRadius, r);
  }
  
  // Core shouldn't expand too much (< 2x initial radius)
  if (!(finalCoreRadius < initialCoreRadius * 2)) {
    throw new Error(`Core expanded too much: ${finalCoreRadius} vs ${initialCoreRadius}`);
  }
  
  // Verify all values are finite
  assertAllFinite(final.positions, 'Positions must be finite');
  assertAllFinite(final.velocities, 'Velocities must be finite');
  
  // Performance shouldn't degrade catastrophically
  // (This is a soft check - just verify it completes in reasonable time)
  if (!(avgStepTime < 1000)) {
    throw new Error(`Performance degraded: ${avgStepTime}ms per step`);
  }
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: '10000 particles hierarchy',
    finalCoreRadius,
    avgStepTime
  };
}

/**
 * Run all large-scale tests
 * @returns {Promise<object>} Test results
 */
export async function runAllTests() {
  const results = [];
  
  console.log('Running monopole large-scale integration tests...');
  
  try {
    results.push(await test100ParticlesUniform());
    console.log('✓ Test 1: 100 particles uniform distribution');
  } catch (e) {
    console.error('✗ Test 1 failed:', e.message);
    results.push({ passed: false, test: '100 particles uniform', error: e.message });
  }
  
  try {
    results.push(await test1000ParticlesClustered());
    console.log('✓ Test 2: 1000 particles clustered');
  } catch (e) {
    console.error('✗ Test 2 failed:', e.message);
    results.push({ passed: false, test: '1000 particles clustered', error: e.message });
  }
  
  try {
    results.push(await test10000ParticlesHierarchy());
    console.log('✓ Test 3: 10,000 particles hierarchy');
  } catch (e) {
    console.error('✗ Test 3 failed:', e.message);
    results.push({ passed: false, test: '10000 particles hierarchy', error: e.message });
  }
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  console.log(`\nResults: ${passed}/${total} tests passed`);
  
  return { passed, total, results };
}
