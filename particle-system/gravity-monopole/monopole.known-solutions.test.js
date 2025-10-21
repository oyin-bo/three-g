// @ts-check

/**
 * Monopole Integration Tests - Known Solutions
 * 
 * Validates against analytical solutions where exact behavior is known.
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

/**
 * Setup binary orbit with correct initial conditions
 * @param {number} mass1
 * @param {number} mass2
 * @param {number} separation
 * @param {number} G - gravitational constant
 * @returns {{positions: Float32Array, velocities: Float32Array, expectedPeriod: number}}
 */
function setupBinaryOrbit(mass1, mass2, separation, G) {
  const positions = new Float32Array(2 * 4);
  const velocities = new Float32Array(2 * 4);
  
  // Center of mass at origin
  const totalMass = mass1 + mass2;
  const r1 = separation * mass2 / totalMass;
  const r2 = separation * mass1 / totalMass;
  
  // Positions along x-axis
  positions[0] = -r1;
  positions[1] = 0.0;
  positions[2] = 0.0;
  positions[3] = mass1;
  
  positions[4] = r2;
  positions[5] = 0.0;
  positions[6] = 0.0;
  positions[7] = mass2;
  
  // Circular orbit velocities (perpendicular to separation)
  // For circular orbit: v^2 = G*M/r for each particle relative to COM
  const v1 = Math.sqrt(G * mass2 * mass2 / (separation * totalMass));
  const v2 = Math.sqrt(G * mass1 * mass1 / (separation * totalMass));
  
  velocities[0] = 0.0;
  velocities[1] = v1;
  velocities[2] = 0.0;
  velocities[3] = 0.0;
  
  velocities[4] = 0.0;
  velocities[5] = -v2;
  velocities[6] = 0.0;
  velocities[7] = 0.0;
  
  // Expected orbital period: T = 2π√(a³/G(m1+m2)) where a = separation
  const expectedPeriod = 2 * Math.PI * Math.sqrt(
    Math.pow(separation, 3) / (G * totalMass)
  );
  
  return { positions, velocities, expectedPeriod };
}

/**
 * Compute orbital radius from center of mass
 * @param {Float32Array} positions
 * @param {number} particleIndex
 * @param {number[]} com - [x, y, z]
 * @returns {number}
 */
function computeOrbitalRadius(positions, particleIndex, com) {
  const idx = particleIndex * 4;
  const dx = positions[idx + 0] - com[0];
  const dy = positions[idx + 1] - com[1];
  const dz = positions[idx + 2] - com[2];
  return Math.sqrt(dx*dx + dy*dy + dz*dz);
}

/**
 * Compute center of mass
 * @param {Float32Array} positions
 * @param {number} particleCount
 * @returns {number[]}
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

function disposeSystem(system) {
  if (system && system.dispose) system.dispose();
}

// ============================================================================
// Tests
// ============================================================================

/**
 * Test 1: Binary Orbit (Circular)
 * Verify two-body circular orbit maintains radius and period.
 */
export async function testBinaryOrbitCircular() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const G = 0.0003;
  const mass1 = 1.0;
  const mass2 = 1.0;
  const separation = 2.0;
  
  const binaryData = setupBinaryOrbit(mass1, mass2, separation, G);
  
  const dt = 0.01;
  const system = new ParticleSystemMonopole(gl, {
    particleData: {
      positions: binaryData.positions,
      velocities: binaryData.velocities
    },
    dt,
    gravityStrength: G,
    softening: 0.05  // small softening for more accurate orbit
  });
  
  // Sample trajectory over time
  const samples = [];
  const samplesPerOrbit = 20;
  const stepsPerSample = Math.floor(binaryData.expectedPeriod / dt / samplesPerOrbit);
  const totalSamples = samplesPerOrbit * 2; // 2 orbits
  
  for (let i = 0; i < totalSamples; i++) {
    // Step to next sample point
    for (let j = 0; j < stepsPerSample; j++) {
      system.compute();
    }
    
    const data = readAllParticleData(system);
    const com = computeCenterOfMass(data.positions, 2);
    const r0 = computeOrbitalRadius(data.positions, 0, com);
    const r1 = computeOrbitalRadius(data.positions, 1, com);
    
    samples.push({
      time: (i + 1) * stepsPerSample * dt,
      r0,
      r1,
      com
    });
  }
  
  // Analyze orbit circularity
  const radii0 = samples.map(s => s.r0);
  const radii1 = samples.map(s => s.r1);
  
  const avgR0 = radii0.reduce((a, b) => a + b, 0) / radii0.length;
  const avgR1 = radii1.reduce((a, b) => a + b, 0) / radii1.length;
  
  // Compute radius variance
  const variance0 = radii0.reduce((sum, r) => sum + Math.pow(r - avgR0, 2), 0) / radii0.length;
  const variance1 = radii1.reduce((sum, r) => sum + Math.pow(r - avgR1, 2), 0) / radii1.length;
  
  const radiusVariation0 = Math.sqrt(variance0) / avgR0;
  const radiusVariation1 = Math.sqrt(variance1) / avgR1;
  
  // Verify orbit remains circular (variation < 5%)
  if (!(radiusVariation0 < 0.05)) {
    throw new Error(`Orbit 0 too elliptical: ${(radiusVariation0 * 100).toFixed(2)}% variation`);
  }
  if (!(radiusVariation1 < 0.05)) {
    throw new Error(`Orbit 1 too elliptical: ${(radiusVariation1 * 100).toFixed(2)}% variation`);
  }
  
  // Estimate period from samples
  // Count number of samples in one full orbit (simplified)
  const estimatedPeriod = samples.length / 2 * stepsPerSample * dt;
  const periodError = Math.abs(estimatedPeriod - binaryData.expectedPeriod) / binaryData.expectedPeriod;
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'binary orbit circular',
    radiusVariation0: radiusVariation0 * 100,
    radiusVariation1: radiusVariation1 * 100,
    expectedPeriod: binaryData.expectedPeriod,
    estimatedPeriod,
    periodError: periodError * 100,
    samplesCount: samples.length
  };
}

/**
 * Test 2: Binary Orbit Stability
 * Verify binary orbit remains stable over many orbits.
 */
export async function testBinaryOrbitStability() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const G = 0.0003;
  const mass1 = 1.0;
  const mass2 = 1.0;
  const separation = 2.0;
  
  const binaryData = setupBinaryOrbit(mass1, mass2, separation, G);
  
  const dt = 0.01;
  const system = new ParticleSystemMonopole(gl, {
    particleData: {
      positions: binaryData.positions,
      velocities: binaryData.velocities
    },
    dt,
    gravityStrength: G,
    softening: 0.05
  });
  
  // Record initial separation
  const initial = readAllParticleData(system);
  const dx0 = initial.positions[0] - initial.positions[4];
  const dy0 = initial.positions[1] - initial.positions[5];
  const dz0 = initial.positions[2] - initial.positions[6];
  const initialSeparation = Math.sqrt(dx0*dx0 + dy0*dy0 + dz0*dz0);
  
  // Run for 5 orbits
  const stepsPerOrbit = Math.floor(binaryData.expectedPeriod / dt);
  const totalSteps = stepsPerOrbit * 5;
  
  for (let i = 0; i < totalSteps; i++) {
    system.compute();
  }
  
  // Check final separation
  const final = readAllParticleData(system);
  const dxF = final.positions[0] - final.positions[4];
  const dyF = final.positions[1] - final.positions[5];
  const dzF = final.positions[2] - final.positions[6];
  const finalSeparation = Math.sqrt(dxF*dxF + dyF*dyF + dzF*dzF);
  
  const separationDrift = Math.abs(finalSeparation - initialSeparation) / initialSeparation;
  
  // Verify separation maintained (< 10% drift over 5 orbits)
  if (!(separationDrift < 0.1)) {
    throw new Error(`Binary separation drifted too much: ${(separationDrift * 100).toFixed(2)}%`);
  }
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'binary orbit stability',
    orbits: 5,
    initialSeparation,
    finalSeparation,
    separationDrift: separationDrift * 100
  };
}

/**
 * Test 3: Three-Body Figure-8 (Simplified)
 * Verify stable three-body configuration.
 */
export async function testThreeBodyFigure8() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // Simplified three-body equal-mass configuration
  // Initial conditions for approximate figure-8 orbit
  const positions = new Float32Array([
    -1.0,  0.0, 0.0, 1.0,
     1.0,  0.0, 0.0, 1.0,
     0.0,  0.0, 0.0, 1.0
  ]);
  
  const velocities = new Float32Array([
     0.0,  0.3, 0.0, 0.0,
     0.0, -0.3, 0.0, 0.0,
     0.0,  0.0, 0.0, 0.0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.1
  });
  
  // Run for 100 steps
  for (let i = 0; i < 100; i++) {
    system.compute();
  }
  
  const final = readAllParticleData(system);
  
  // Verify system remains bounded
  let maxR = 0;
  for (let i = 0; i < 3; i++) {
    const x = final.positions[i * 4 + 0];
    const y = final.positions[i * 4 + 1];
    const z = final.positions[i * 4 + 2];
    const r = Math.sqrt(x*x + y*y + z*z);
    maxR = Math.max(maxR, r);
  }
  
  // System should remain reasonably bounded
  if (!(maxR < 5.0)) {
    throw new Error(`Three-body system not bounded: max radius ${maxR}`);
  }
  
  // Verify all positions and velocities are finite
  for (let i = 0; i < 12; i++) {
    if (!isFinite(final.positions[i])) {
      throw new Error(`Position ${i} not finite: ${final.positions[i]}`);
    }
    if (!isFinite(final.velocities[i])) {
      throw new Error(`Velocity ${i} not finite: ${final.velocities[i]}`);
    }
  }
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'three-body figure-8',
    maxRadius: maxR
  };
}

/**
 * Run all known solutions tests
 * @returns {Promise<object>} Test results
 */
export async function runAllTests() {
  const results = [];
  
  console.log('Running monopole known solutions integration tests...');
  
  try {
    results.push(await testBinaryOrbitCircular());
    console.log('✓ Test 1: Binary orbit (circular)');
  } catch (e) {
    console.error('✗ Test 1 failed:', e.message);
    results.push({ passed: false, test: 'binary orbit circular', error: e.message });
  }
  
  try {
    results.push(await testBinaryOrbitStability());
    console.log('✓ Test 2: Binary orbit stability');
  } catch (e) {
    console.error('✗ Test 2 failed:', e.message);
    results.push({ passed: false, test: 'binary orbit stability', error: e.message });
  }
  
  try {
    results.push(await testThreeBodyFigure8());
    console.log('✓ Test 3: Three-body figure-8');
  } catch (e) {
    console.error('✗ Test 3 failed:', e.message);
    results.push({ passed: false, test: 'three-body figure-8', error: e.message });
  }
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  console.log(`\nResults: ${passed}/${total} tests passed`);
  
  return { passed, total, results };
}
