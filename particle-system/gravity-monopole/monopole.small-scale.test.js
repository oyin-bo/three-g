// @ts-check

/**
 * Monopole Integration Tests - Small Scale
 * 
 * Validates basic correctness on minimal particle configurations where behavior
 * is predictable and hand-verifiable.
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
 * Read particle data from GPU textures
 * @param {ParticleSystemMonopole} system
 * @param {number} particleIndex
 * @returns {{position: Float32Array, velocity: Float32Array}}
 */
function readParticleData(system, particleIndex) {
  const gl = system.gl;
  const width = system.particleTexWidth;
  const height = system.particleTexHeight;
  
  // Calculate texture coordinates
  const x = particleIndex % width;
  const y = Math.floor(particleIndex / width);
  
  // Read position texture
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  // Position
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.inPosition, 0);
  const posData = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, posData);
  
  // Velocity
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.inVelocity, 0);
  const velData = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, velData);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return {
    position: posData,
    velocity: velData
  };
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
 * Assert vector is near expected within tolerance
 * @param {Float32Array|number[]} actual
 * @param {number[]} expected
 * @param {number} tolerance
 * @param {string} message
 */
function assertVector3Near(actual, expected, tolerance, message = '') {
  const dx = actual[0] - expected[0];
  const dy = actual[1] - expected[1];
  const dz = actual[2] - expected[2];
  const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
  
  if (dist > tolerance) {
    throw new Error(
      `${message}\nExpected [${expected.join(', ')}], got [${actual[0]}, ${actual[1]}, ${actual[2]}]\nDistance: ${dist}, tolerance: ${tolerance}`
    );
  }
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
 * Test 1: Single Particle at Rest
 * Verify a single particle with zero velocity remains stationary.
 */
export async function testSingleParticleAtRest() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Create single particle at origin with zero velocity
  const positions = new Float32Array([
    0.0, 0.0, 0.0, 1.0  // x, y, z, mass
  ]);
  const velocities = new Float32Array([
    0.0, 0.0, 0.0, 0.0  // vx, vy, vz, unused
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Step simulation 10 times
  for (let i = 0; i < 10; i++) {
    system.compute();
  }
  
  // Read particle state
  const data = readParticleData(system, 0);
  
  // Verify position unchanged
  assertVector3Near(data.position, [0, 0, 0], 1e-5, 'Position should remain at origin');
  
  // Verify velocity remains zero
  assertVector3Near(data.velocity, [0, 0, 0], 1e-5, 'Velocity should remain zero');
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return { passed: true, test: 'single particle at rest' };
}

/**
 * Test 2: Two Particles Attract
 * Verify two particles with equal mass attract each other.
 */
export async function testTwoParticlesAttract() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Two particles separated by 2.0 units along x-axis
  const positions = new Float32Array([
    -1.0, 0.0, 0.0, 1.0,  // particle 0
     1.0, 0.0, 0.0, 1.0   // particle 1
  ]);
  const velocities = new Float32Array([
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.1
  });
  
  // Record initial positions
  const initial = readAllParticleData(system);
  const initialPos0 = [initial.positions[0], initial.positions[1], initial.positions[2]];
  const initialPos1 = [initial.positions[4], initial.positions[5], initial.positions[6]];
  
  // Step simulation
  for (let i = 0; i < 20; i++) {
    system.compute();
  }
  
  // Read final state
  const final = readAllParticleData(system);
  
  // Verify particles moved toward each other (x-coordinates should approach)
  if (!(final.positions[0] > initialPos0[0])) throw new Error('Particle 0 should move right (toward particle 1)');
  if (!(final.positions[4] < initialPos1[0])) throw new Error('Particle 1 should move left (toward particle 0)');
  
  // Verify velocities are non-zero and pointing toward each other
  if (!(final.velocities[0] > 0)) throw new Error('Particle 0 velocity should be positive (toward particle 1)');
  if (!(final.velocities[4] < 0)) throw new Error('Particle 1 velocity should be negative (toward particle 0)');
  
  // Verify all values are finite
  assertAllFinite(final.positions, 'Positions must be finite');
  assertAllFinite(final.velocities, 'Velocities must be finite');
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return { passed: true, test: 'two particles attract' };
}

/**
 * Test 3: Three-Body Lagrange L4
 * Three equal masses in equilateral triangle configuration.
 * This is a simplified test - just verify the triangle shape is maintained.
 */
export async function testThreeBodyEquilateralTriangle() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Equilateral triangle with side length 2.0
  const h = Math.sqrt(3) / 2; // height of equilateral triangle with side 1.0
  const positions = new Float32Array([
    -1.0,    -h/3, 0.0, 1.0,  // particle 0
     1.0,    -h/3, 0.0, 1.0,  // particle 1
     0.0,  2*h/3, 0.0, 1.0   // particle 2
  ]);
  
  // Initial velocities for circular rotation (approximate)
  const vMag = 0.02; // small tangential velocity
  const velocities = new Float32Array([
     0.0,  vMag, 0.0, 0.0,
     0.0,  vMag, 0.0, 0.0,
     0.0,  vMag, 0.0, 0.0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Calculate initial triangle side lengths
  const initial = readAllParticleData(system);
  const d01_init = Math.sqrt(
    Math.pow(initial.positions[0] - initial.positions[4], 2) +
    Math.pow(initial.positions[1] - initial.positions[5], 2) +
    Math.pow(initial.positions[2] - initial.positions[6], 2)
  );
  
  // Step simulation
  for (let i = 0; i < 50; i++) {
    system.compute();
  }
  
  // Read final state
  const final = readAllParticleData(system);
  
  // Calculate final triangle side length
  const d01_final = Math.sqrt(
    Math.pow(final.positions[0] - final.positions[4], 2) +
    Math.pow(final.positions[1] - final.positions[5], 2) +
    Math.pow(final.positions[2] - final.positions[6], 2)
  );
  
  // Verify triangle shape roughly maintained (within 20%)
  const ratio = d01_final / d01_init;
  if (!(ratio > 0.8 && ratio < 1.2)) {
    throw new Error(`Triangle side length should be maintained (ratio: ${ratio})`);
  }
  
  // Verify all values are finite
  assertAllFinite(final.positions, 'Positions must be finite');
  assertAllFinite(final.velocities, 'Velocities must be finite');
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return { passed: true, test: 'three-body equilateral triangle', ratio };
}

/**
 * Test 4: Ten Particles in Cluster
 * Random positions within small sphere, verify system contracts.
 */
export async function testTenParticlesInCluster() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // 10 particles randomly distributed in sphere radius 1.0
  const positions = new Float32Array(10 * 4);
  for (let i = 0; i < 10; i++) {
    // Simple random distribution
    const r = Math.random() * 0.8;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0; // mass
  }
  
  const velocities = new Float32Array(10 * 4); // all zeros
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Calculate initial center of mass
  const initial = readAllParticleData(system);
  const initialCOM = computeCenterOfMass(initial.positions, 10);
  
  // Calculate initial maximum radius
  let initialMaxR = 0;
  for (let i = 0; i < 10; i++) {
    const dx = initial.positions[i * 4 + 0] - initialCOM[0];
    const dy = initial.positions[i * 4 + 1] - initialCOM[1];
    const dz = initial.positions[i * 4 + 2] - initialCOM[2];
    const r = Math.sqrt(dx*dx + dy*dy + dz*dz);
    initialMaxR = Math.max(initialMaxR, r);
  }
  
  // Step simulation
  for (let i = 0; i < 50; i++) {
    system.compute();
  }
  
  // Read final state
  const final = readAllParticleData(system);
  
  // Verify no NaN or Inf
  assertAllFinite(final.positions, 'Positions must be finite');
  assertAllFinite(final.velocities, 'Velocities must be finite');
  
  // Calculate final center of mass
  const finalCOM = computeCenterOfMass(final.positions, 10);
  
  // Verify center of mass hasn't drifted much (< 0.1)
  const comDrift = Math.sqrt(
    Math.pow(finalCOM[0] - initialCOM[0], 2) +
    Math.pow(finalCOM[1] - initialCOM[1], 2) +
    Math.pow(finalCOM[2] - initialCOM[2], 2)
  );
  if (!(comDrift < 0.1)) {
    throw new Error(`Center of mass drift should be small (${comDrift})`);
  }
  
  // Verify particles have non-zero inward velocities (contraction)
  let inwardMotionCount = 0;
  for (let i = 0; i < 10; i++) {
    const dx = final.positions[i * 4 + 0] - finalCOM[0];
    const dy = final.positions[i * 4 + 1] - finalCOM[1];
    const dz = final.positions[i * 4 + 2] - finalCOM[2];
    const vx = final.velocities[i * 4 + 0];
    const vy = final.velocities[i * 4 + 1];
    const vz = final.velocities[i * 4 + 2];
    
    const radialVelocity = (dx * vx + dy * vy + dz * vz);
    if (radialVelocity < 0) inwardMotionCount++;
  }
  
  if (!(inwardMotionCount >= 5)) {
    throw new Error(`At least half particles should move inward (${inwardMotionCount}/10)`);
  }
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return { passed: true, test: 'ten particles in cluster', comDrift, inwardMotionCount };
}

/**
 * Test 5: Empty System
 * Verify system handles zero particles gracefully.
 */
export async function testEmptySystem() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Empty particle arrays
  const positions = new Float32Array(0);
  const velocities = new Float32Array(0);
  
  let system;
  let error = null;
  
  try {
    system = new ParticleSystemMonopole(gl, {
      particleData: { positions, velocities },
      dt: 0.01
    });
    
    // Try to step - should not crash
    system.compute();
    
    // Check for GL errors
    const glError = gl.getError();
    if (glError !== gl.NO_ERROR) {
      throw new Error('Should not have GL errors with empty system');
    }
    
  } catch (e) {
    error = e;
  }
  
  // Either system handles empty case gracefully, or throws a clear error
  // Both are acceptable behavior
  if (error) {
    const msg = error.message || String(error);
    if (!(msg.includes('particle') || msg.includes('empty') || msg.includes('count'))) {
      throw new Error('Error message should be clear about empty particle case: ' + msg);
    }
  }
  
  if (system) {
    disposeSystem(system);
  }
  cleanupGL(canvas, gl);
  
  return { passed: true, test: 'empty system', error: error ? error.message : null };
}

/**
 * Run all small-scale tests
 * @returns {Promise<object>} Test results
 */
export async function runAllTests() {
  const results = [];
  
  console.log('Running monopole small-scale integration tests...');
  
  try {
    results.push(await testSingleParticleAtRest());
    console.log('✓ Test 1: Single particle at rest');
  } catch (e) {
    console.error('✗ Test 1 failed:', e.message);
    results.push({ passed: false, test: 'single particle at rest', error: e.message });
  }
  
  try {
    results.push(await testTwoParticlesAttract());
    console.log('✓ Test 2: Two particles attract');
  } catch (e) {
    console.error('✗ Test 2 failed:', e.message);
    results.push({ passed: false, test: 'two particles attract', error: e.message });
  }
  
  try {
    results.push(await testThreeBodyEquilateralTriangle());
    console.log('✓ Test 3: Three-body equilateral triangle');
  } catch (e) {
    console.error('✗ Test 3 failed:', e.message);
    results.push({ passed: false, test: 'three-body equilateral triangle', error: e.message });
  }
  
  try {
    results.push(await testTenParticlesInCluster());
    console.log('✓ Test 4: Ten particles in cluster');
  } catch (e) {
    console.error('✗ Test 4 failed:', e.message);
    results.push({ passed: false, test: 'ten particles in cluster', error: e.message });
  }
  
  try {
    results.push(await testEmptySystem());
    console.log('✓ Test 5: Empty system');
  } catch (e) {
    console.error('✗ Test 5 failed:', e.message);
    results.push({ passed: false, test: 'empty system', error: e.message });
  }
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  console.log(`\nResults: ${passed}/${total} tests passed`);
  
  return { passed, total, results };
}
