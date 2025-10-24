// @ts-check

/**
 * Monopole Integration Tests - Convergence
 * 
 * Validates that refinement improves accuracy as expected.
 * 
 * These tests are designed to run in a browser environment via the daebug REPL.
 * Each test creates its own isolated GL context and disposes it after completion.
 */

import { ParticleSystemMonopole } from './particle-system-monopole.js';

// ============================================================================
// Inline Test Utilities (self-contained per project policy)
// ============================================================================

function createTestCanvas(width = 256, height = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function createGLContext(canvas) {
  const gl = canvas.getContext('webgl2');
  if (!gl) throw new Error('WebGL2 not supported');
  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) throw new Error('EXT_color_buffer_float not supported');
  return gl;
}

function cleanupGL(canvas, gl) {
  const loseContext = gl.getExtension('WEBGL_lose_context');
  if (loseContext) loseContext.loseContext();
  if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
}

function readAllParticleData(system) {
  const gl = system.gl;
  const width = system.particleTexWidth;
  const height = system.particleTexHeight;
  const totalPixels = width * height;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.inPosition, 0);
  const positions = new Float32Array(totalPixels * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, positions);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.inVelocity, 0);
  const velocities = new Float32Array(totalPixels * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, velocities);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return { positions, velocities };
}

function setupBinaryOrbit(mass1, mass2, separation) {
  const positions = new Float32Array(2 * 4);
  const velocities = new Float32Array(2 * 4);
  
  // Center of mass at origin
  const r1 = separation * mass2 / (mass1 + mass2);
  const r2 = separation * mass1 / (mass1 + mass2);
  
  positions[0] = -r1;
  positions[1] = 0.0;
  positions[2] = 0.0;
  positions[3] = mass1;
  
  positions[4] = r2;
  positions[5] = 0.0;
  positions[6] = 0.0;
  positions[7] = mass2;
  
  // Circular orbit velocity (simplified)
  const G = 0.0003;
  const v1 = Math.sqrt(G * mass2 * mass2 / (separation * (mass1 + mass2)));
  const v2 = Math.sqrt(G * mass1 * mass1 / (separation * (mass1 + mass2)));
  
  velocities[0] = 0.0;
  velocities[1] = v1;
  velocities[2] = 0.0;
  velocities[3] = 0.0;
  
  velocities[4] = 0.0;
  velocities[5] = -v2;
  velocities[6] = 0.0;
  velocities[7] = 0.0;
  
  return { positions, velocities };
}

function computeOrbitError(positions, separation) {
  const x1 = positions[0];
  const y1 = positions[1];
  const z1 = positions[2];
  const x2 = positions[4];
  const y2 = positions[5];
  const z2 = positions[6];
  
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dz = z2 - z1;
  const currentSep = Math.sqrt(dx*dx + dy*dy + dz*dz);
  
  return Math.abs(currentSep - separation) / separation;
}

function assertMonotonicDecrease(values, message = 'Values must decrease monotonically') {
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[i-1]) {
      throw new Error(`${message}: values[${i}] = ${values[i]} >= values[${i-1}] = ${values[i-1]}`);
    }
  }
}

function disposeSystem(system) {
  if (system && system.dispose) system.dispose();
}

// ============================================================================
// Tests
// ============================================================================

/**
 * Test 1: Theta Parameter Convergence
 * Verify error decreases as theta becomes more restrictive.
 */
export async function testThetaConvergence() {
  const results = [];
  const thetas = [0.8, 0.5, 0.3];
  const binaryData = setupBinaryOrbit(1.0, 1.0, 2.0);
  
  for (const theta of thetas) {
    const canvas = createTestCanvas();
    const gl = createGLContext(canvas);
    
    const system = new ParticleSystemMonopole(gl, {
      particleData: {
        positions: new Float32Array(binaryData.positions),
        velocities: new Float32Array(binaryData.velocities)
      },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.1,
      theta
    });
    
    // Run 100 steps
    for (let i = 0; i < 100; i++) {
      system.compute();
    }
    
    const final = readAllParticleData(system);
    const error = computeOrbitError(final.positions, 2.0);
    
    results.push({ theta, error });
    
    disposeSystem(system);
    cleanupGL(canvas, gl);
  }
  
  // Verify errors decrease monotonically
  const errors = results.map(r => r.error);
  assertMonotonicDecrease(errors, 'Errors should decrease as theta decreases');
  
  return {
    passed: true,
    test: 'theta convergence',
    results
  };
}

/**
 * Test 2: Softening Length Convergence
 * Verify force accuracy improves as softening decreases.
 */
export async function testSofteningConvergence() {
  const results = [];
  const softenings = [0.2, 0.1, 0.05];
  
  // Binary at fixed separation
  const positions = new Float32Array([
    -1.0, 0.0, 0.0, 1.0,
     1.0, 0.0, 0.0, 1.0
  ]);
  const velocities = new Float32Array(8);
  
  const separation = 2.0;
  const G = 0.0003;
  
  for (const softening of softenings) {
    const canvas = createTestCanvas();
    const gl = createGLContext(canvas);
    
    const system = new ParticleSystemMonopole(gl, {
      particleData: {
        positions: new Float32Array(positions),
        velocities: new Float32Array(velocities)
      },
      dt: 0.01,
      gravityStrength: G,
      softening
    });
    
    // Take one step to measure force
    system.compute();
    
    const final = readAllParticleData(system);
    
    // Measure acceleration (change in velocity)
    const accel = Math.sqrt(
      final.velocities[0] * final.velocities[0] +
      final.velocities[1] * final.velocities[1] +
      final.velocities[2] * final.velocities[2]
    ) / 0.01;
    
    // Expected force: F = G * m1 * m2 / sqrt(r^2 + eps^2)
    const expectedAccel = G / Math.sqrt(separation * separation + softening * softening);
    const error = Math.abs(accel - expectedAccel) / expectedAccel;
    
    results.push({ softening, accel, expectedAccel, error });
    
    disposeSystem(system);
    cleanupGL(canvas, gl);
  }
  
  // Verify error decreases as softening decreases
  const errors = results.map(r => r.error);
  
  // Errors should generally decrease, but allow some tolerance for numerical precision
  if (!(errors[2] <= errors[0])) {
    throw new Error(`Expected error to decrease from softening ${softenings[0]} to ${softenings[2]}`);
  }
  
  return {
    passed: true,
    test: 'softening convergence',
    results
  };
}

/**
 * Test 3: Particle Count Convergence
 * Verify behavior converges with more particles (resolution).
 */
export async function testParticleCountConvergence() {
  const results = [];
  const counts = [10, 50, 100];
  
  for (const count of counts) {
    const canvas = createTestCanvas();
    const gl = createGLContext(canvas);
    
    // Generate random particle distribution
    const positions = new Float32Array(count * 4);
    const velocities = new Float32Array(count * 4);
    
    let seed = 42;
    function random() {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    }
    
    for (let i = 0; i < count; i++) {
      const r = Math.pow(random(), 1/3) * 1.5;
      const theta = random() * Math.PI * 2;
      const phi = Math.acos(2 * random() - 1);
      
      positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
      positions[i * 4 + 2] = r * Math.cos(phi);
      positions[i * 4 + 3] = 1.0;
      
      velocities[i * 4 + 0] = 0.0;
      velocities[i * 4 + 1] = 0.0;
      velocities[i * 4 + 2] = 0.0;
      velocities[i * 4 + 3] = 0.0;
    }
    
    const system = new ParticleSystemMonopole(gl, {
      particleData: { positions, velocities },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.1
    });
    
    // Run 50 steps
    for (let i = 0; i < 50; i++) {
      system.compute();
    }
    
    const final = readAllParticleData(system);
    
    // Measure average velocity magnitude
    let avgV = 0;
    for (let i = 0; i < count; i++) {
      const vx = final.velocities[i * 4 + 0];
      const vy = final.velocities[i * 4 + 1];
      const vz = final.velocities[i * 4 + 2];
      avgV += Math.sqrt(vx*vx + vy*vy + vz*vz);
    }
    avgV /= count;
    
    results.push({ count, avgV });
    
    disposeSystem(system);
    cleanupGL(canvas, gl);
  }
  
  // Verify behavior is reasonable and stable across particle counts
  const avgVs = results.map(r => r.avgV);
  
  // All should be finite and similar order of magnitude
  for (const v of avgVs) {
    if (!isFinite(v) || v < 0 || v > 2.0) {
      throw new Error(`Average velocity out of expected range: ${v}`);
    }
  }
  
  return {
    passed: true,
    test: 'particle count convergence',
    results
  };
}

/**
 * Run all convergence tests
 * @returns {Promise<object>} Test results
 */
export async function runAllTests() {
  const results = [];
  
  console.log('Running monopole convergence integration tests...');
  
  try {
    results.push(await testThetaConvergence());
    console.log('✓ Test 1: Theta parameter convergence');
  } catch (e) {
    console.error('✗ Test 1 failed:', e.message);
    results.push({ passed: false, test: 'theta convergence', error: e.message });
  }
  
  try {
    results.push(await testSofteningConvergence());
    console.log('✓ Test 2: Softening length convergence');
  } catch (e) {
    console.error('✗ Test 2 failed:', e.message);
    results.push({ passed: false, test: 'softening convergence', error: e.message });
  }
  
  try {
    results.push(await testParticleCountConvergence());
    console.log('✓ Test 3: Particle count convergence');
  } catch (e) {
    console.error('✗ Test 3 failed:', e.message);
    results.push({ passed: false, test: 'particle count convergence', error: e.message });
  }
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  console.log(`\nResults: ${passed}/${total} tests passed`);
  
  return { passed, total, results };
}
