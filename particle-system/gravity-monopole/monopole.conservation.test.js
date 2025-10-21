// @ts-check

/**
 * Monopole Integration Tests - Conservation Laws
 * 
 * Validates approximate conservation laws over extended simulation periods.
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
 * Generate random particles
 * @param {number} count
 * @param {number[]} bounds
 * @param {number} velocityScale
 * @param {number} seed
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function generateRandomParticles(count, bounds, velocityScale, seed = 12345) {
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
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = (random() - 0.5) * velocityScale;
    velocities[i * 4 + 1] = (random() - 0.5) * velocityScale;
    velocities[i * 4 + 2] = (random() - 0.5) * velocityScale;
    velocities[i * 4 + 3] = 0.0;
  }
  
  return { positions, velocities };
}

/**
 * Generate spherically symmetric rotating particles
 * @param {number} count
 * @param {number} radius
 * @param {number} angularVelocity
 * @param {number} seed
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function generateRotatingParticles(count, radius, angularVelocity, seed = 12345) {
  let rngState = seed;
  function random() {
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return rngState / 4294967296;
  }
  
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    // Random position in sphere
    const r = Math.pow(random(), 1/3) * radius;
    const theta = random() * Math.PI * 2;
    const phi = Math.acos(2 * random() - 1);
    
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    
    positions[i * 4 + 0] = x;
    positions[i * 4 + 1] = y;
    positions[i * 4 + 2] = z;
    positions[i * 4 + 3] = 1.0;
    
    // Solid body rotation about z-axis: v = ω × r
    const rxy = Math.sqrt(x*x + y*y);
    const vMag = angularVelocity * rxy;
    
    velocities[i * 4 + 0] = -y / rxy * vMag;
    velocities[i * 4 + 1] = x / rxy * vMag;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
  }
  
  return { positions, velocities };
}

/**
 * Compute total momentum
 * @param {Float32Array} velocities
 * @param {Float32Array} positions
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
 * Compute angular momentum
 * @param {Float32Array} positions
 * @param {Float32Array} velocities
 * @param {number} particleCount
 * @returns {number[]} [Lx, Ly, Lz]
 */
function computeAngularMomentum(positions, velocities, particleCount) {
  let Lx = 0, Ly = 0, Lz = 0;
  
  for (let i = 0; i < particleCount; i++) {
    const mass = positions[i * 4 + 3];
    const x = positions[i * 4 + 0];
    const y = positions[i * 4 + 1];
    const z = positions[i * 4 + 2];
    const vx = velocities[i * 4 + 0];
    const vy = velocities[i * 4 + 1];
    const vz = velocities[i * 4 + 2];
    
    // L = r × (m*v)
    Lx += mass * (y * vz - z * vy);
    Ly += mass * (z * vx - x * vz);
    Lz += mass * (x * vy - y * vx);
  }
  
  return [Lx, Ly, Lz];
}

/**
 * Compute kinetic energy
 * @param {Float32Array} velocities
 * @param {Float32Array} positions
 * @param {number} particleCount
 * @returns {number}
 */
function computeKineticEnergy(velocities, positions, particleCount) {
  let ke = 0;
  
  for (let i = 0; i < particleCount; i++) {
    const mass = positions[i * 4 + 3];
    const vx = velocities[i * 4 + 0];
    const vy = velocities[i * 4 + 1];
    const vz = velocities[i * 4 + 2];
    const v2 = vx*vx + vy*vy + vz*vz;
    
    ke += 0.5 * mass * v2;
  }
  
  return ke;
}

/**
 * Compute potential energy
 * @param {Float32Array} positions
 * @param {number} particleCount
 * @param {number} softening
 * @param {number} gravityStrength
 * @returns {number}
 */
function computePotentialEnergy(positions, particleCount, softening, gravityStrength) {
  let pe = 0;
  const eps2 = softening * softening;
  
  for (let i = 0; i < particleCount; i++) {
    const mass_i = positions[i * 4 + 3];
    const xi = positions[i * 4 + 0];
    const yi = positions[i * 4 + 1];
    const zi = positions[i * 4 + 2];
    
    for (let j = i + 1; j < particleCount; j++) {
      const mass_j = positions[j * 4 + 3];
      const xj = positions[j * 4 + 0];
      const yj = positions[j * 4 + 1];
      const zj = positions[j * 4 + 2];
      
      const dx = xi - xj;
      const dy = yi - yj;
      const dz = zi - zj;
      const r2 = dx*dx + dy*dy + dz*dz + eps2;
      const r = Math.sqrt(r2);
      
      pe -= gravityStrength * mass_i * mass_j / r;
    }
  }
  
  return pe;
}

/**
 * Compute momentum drift
 * @param {number[]} initialMomentum
 * @param {number[]} currentMomentum
 * @returns {number}
 */
function computeMomentumDrift(initialMomentum, currentMomentum) {
  const dp = [
    currentMomentum[0] - initialMomentum[0],
    currentMomentum[1] - initialMomentum[1],
    currentMomentum[2] - initialMomentum[2]
  ];
  
  const driftMag = Math.sqrt(dp[0]*dp[0] + dp[1]*dp[1] + dp[2]*dp[2]);
  const initialMag = Math.sqrt(
    initialMomentum[0]*initialMomentum[0] +
    initialMomentum[1]*initialMomentum[1] +
    initialMomentum[2]*initialMomentum[2]
  );
  
  // If initial momentum is near zero, use absolute drift
  if (initialMag < 1e-6) {
    return driftMag;
  }
  
  return driftMag / initialMag;
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
 * Test 1: Momentum Conservation
 * Verify total momentum is conserved over extended simulation.
 */
export async function testMomentumConservation() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // 10 particles with random positions and velocities
  const particleData = generateRandomParticles(10, [-2, 2], 0.5, 999);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData,
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Record initial momentum
  const initial = readAllParticleData(system);
  const initialMomentum = computeTotalMomentum(initial.velocities, initial.positions, 10);
  
  const samples = [];
  
  // Step 1000 times, sample every 100 steps
  for (let i = 0; i < 1000; i++) {
    system.compute();
    
    if (i % 100 === 99) {
      const data = readAllParticleData(system);
      const momentum = computeTotalMomentum(data.velocities, data.positions, 10);
      const drift = computeMomentumDrift(initialMomentum, momentum);
      samples.push({ step: i + 1, momentum, drift });
    }
  }
  
  // Verify all samples within 1% of initial momentum
  for (const sample of samples) {
    if (!(sample.drift < 0.01)) {
      throw new Error(`Momentum drift too large at step ${sample.step}: ${sample.drift}`);
    }
  }
  
  // Check drift doesn't grow linearly (numerical stability)
  const firstDrift = samples[0].drift;
  const lastDrift = samples[samples.length - 1].drift;
  const driftGrowth = lastDrift / (firstDrift + 1e-10);
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'momentum conservation',
    samples,
    maxDrift: Math.max(...samples.map(s => s.drift)),
    driftGrowth
  };
}

/**
 * Test 2: Angular Momentum Conservation
 * Verify angular momentum conserved for symmetric rotating system.
 */
export async function testAngularMomentumConservation() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // 20 particles in spherically symmetric distribution, rotating about z-axis
  const particleData = generateRotatingParticles(20, 2.0, 0.1, 888);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData,
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Record initial angular momentum
  const initial = readAllParticleData(system);
  const initialL = computeAngularMomentum(initial.positions, initial.velocities, 20);
  const initialL_mag = Math.sqrt(initialL[0]*initialL[0] + initialL[1]*initialL[1] + initialL[2]*initialL[2]);
  
  const samples = [];
  
  // Step 1000 times, sample every 100 steps
  for (let i = 0; i < 1000; i++) {
    system.compute();
    
    if (i % 100 === 99) {
      const data = readAllParticleData(system);
      const L = computeAngularMomentum(data.positions, data.velocities, 20);
      const L_mag = Math.sqrt(L[0]*L[0] + L[1]*L[1] + L[2]*L[2]);
      const drift = Math.abs(L_mag - initialL_mag) / initialL_mag;
      
      samples.push({
        step: i + 1,
        L,
        L_mag,
        drift,
        Lx_drift: Math.abs(L[0] - initialL[0]),
        Ly_drift: Math.abs(L[1] - initialL[1])
      });
    }
  }
  
  // Verify magnitude within 1% of initial
  for (const sample of samples) {
    if (!(sample.drift < 0.01)) {
      throw new Error(`Angular momentum drift too large at step ${sample.step}: ${sample.drift}`);
    }
  }
  
  // Check no precession (Lx, Ly remain near zero for z-axis rotation)
  const maxLxDrift = Math.max(...samples.map(s => s.Lx_drift));
  const maxLyDrift = Math.max(...samples.map(s => s.Ly_drift));
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'angular momentum conservation',
    samples,
    maxDrift: Math.max(...samples.map(s => s.drift)),
    maxLxDrift,
    maxLyDrift
  };
}

/**
 * Test 3: Energy Conservation
 * Verify total energy (KE + PE) approximately conserved.
 */
export async function testEnergyConservation() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // 50 particles in bound configuration
  const particleData = generateRandomParticles(50, [-2, 2], 0.3, 777);
  
  const gravityStrength = 0.0003;
  const softening = 0.2;
  
  const system = new ParticleSystemMonopole(gl, {
    particleData,
    dt: 0.01,
    gravityStrength,
    softening
  });
  
  // Calculate initial energy
  const initial = readAllParticleData(system);
  const initialKE = computeKineticEnergy(initial.velocities, initial.positions, 50);
  const initialPE = computePotentialEnergy(initial.positions, 50, softening, gravityStrength);
  const initialE = initialKE + initialPE;
  
  const samples = [];
  
  // Step 1000 times, sample every 100 steps
  for (let i = 0; i < 1000; i++) {
    system.compute();
    
    if (i % 100 === 99) {
      const data = readAllParticleData(system);
      const ke = computeKineticEnergy(data.velocities, data.positions, 50);
      const pe = computePotentialEnergy(data.positions, 50, softening, gravityStrength);
      const totalE = ke + pe;
      const drift = Math.abs(totalE - initialE) / Math.abs(initialE);
      
      samples.push({
        step: i + 1,
        ke,
        pe,
        totalE,
        drift
      });
    }
  }
  
  // Verify energy drift < 5% (looser tolerance due to softening and time integration)
  for (const sample of samples) {
    if (!(sample.drift < 0.05)) {
      throw new Error(`Energy drift too large at step ${sample.step}: ${sample.drift}`);
    }
  }
  
  // Check if drift is systematic or oscillatory
  const drifts = samples.map(s => s.drift);
  const avgDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
  const driftVariance = drifts.reduce((sum, d) => sum + (d - avgDrift) ** 2, 0) / drifts.length;
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'energy conservation',
    samples,
    maxDrift: Math.max(...drifts),
    avgDrift,
    driftVariance
  };
}

/**
 * Run all conservation tests
 * @returns {Promise<object>} Test results
 */
export async function runAllTests() {
  const results = [];
  
  console.log('Running monopole conservation integration tests...');
  
  try {
    results.push(await testMomentumConservation());
    console.log('✓ Test 1: Momentum conservation');
  } catch (e) {
    console.error('✗ Test 1 failed:', e.message);
    results.push({ passed: false, test: 'momentum conservation', error: e.message });
  }
  
  try {
    results.push(await testAngularMomentumConservation());
    console.log('✓ Test 2: Angular momentum conservation');
  } catch (e) {
    console.error('✗ Test 2 failed:', e.message);
    results.push({ passed: false, test: 'angular momentum conservation', error: e.message });
  }
  
  try {
    results.push(await testEnergyConservation());
    console.log('✓ Test 3: Energy conservation');
  } catch (e) {
    console.error('✗ Test 3 failed:', e.message);
    results.push({ passed: false, test: 'energy conservation', error: e.message });
  }
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  console.log(`\nResults: ${passed}/${total} tests passed`);
  
  return { passed, total, results };
}
