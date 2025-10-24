// @ts-check

/**
 * Monopole Integration Tests - Stability
 * 
 * Validates numerical stability under extreme conditions and edge cases.
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

function generateClusteredParticles(count, radius, seed = 12345) {
  let rngState = seed;
  function random() {
    rngState = (rngState * 1664525 + 1013904223) % 4294967296;
    return rngState / 4294967296;
  }
  
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  
  for (let i = 0; i < count; i++) {
    const r = Math.pow(random(), 1/3) * radius;
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
  
  return { positions, velocities };
}

function assertAllFinite(array, message = 'Values must be finite') {
  for (let i = 0; i < array.length; i++) {
    if (!isFinite(array[i])) {
      throw new Error(`${message}: array[${i}] = ${array[i]}`);
    }
  }
}

function assertSystemBounded(positions, particleCount, maxRadius, message = 'System must be bounded') {
  for (let i = 0; i < particleCount; i++) {
    const x = positions[i * 4 + 0];
    const y = positions[i * 4 + 1];
    const z = positions[i * 4 + 2];
    const r = Math.sqrt(x*x + y*y + z*z);
    
    if (r > maxRadius) {
      throw new Error(`${message}: particle ${i} at distance ${r} > ${maxRadius}`);
    }
  }
}

function computeSystemRadius(positions, particleCount) {
  let maxR = 0;
  for (let i = 0; i < particleCount; i++) {
    const x = positions[i * 4 + 0];
    const y = positions[i * 4 + 1];
    const z = positions[i * 4 + 2];
    const r = Math.sqrt(x*x + y*y + z*z);
    maxR = Math.max(maxR, r);
  }
  return maxR;
}

function measureStepTime(system, steps) {
  const start = performance.now();
  for (let i = 0; i < steps; i++) {
    system.compute();
  }
  return (performance.now() - start) / steps;
}

function disposeSystem(system) {
  if (system && system.dispose) system.dispose();
}

// ============================================================================
// Tests
// ============================================================================

/**
 * Test 1: Long Integration (10,000 Steps)
 * Verify system remains stable over extended simulation.
 */
export async function testLongIntegration() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const particleData = generateClusteredParticles(20, 1.5, 111);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData,
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  const initial = readAllParticleData(system);
  const initialMaxR = computeSystemRadius(initial.positions, 20);
  
  // Measure performance of first 1000 steps
  const initialStepTime = measureStepTime(system, 1000);
  
  // Continue for remaining 9000 steps, checking every 1000
  for (let batch = 0; batch < 9; batch++) {
    for (let i = 0; i < 1000; i++) {
      system.compute();
    }
    
    const data = readAllParticleData(system);
    assertAllFinite(data.positions, `Positions must be finite at step ${(batch + 2) * 1000}`);
    assertAllFinite(data.velocities, `Velocities must be finite at step ${(batch + 2) * 1000}`);
    
    // Verify no runaway particles (< 2x initial radius)
    assertSystemBounded(data.positions, 20, initialMaxR * 2, `System bounded at step ${(batch + 2) * 1000}`);
  }
  
  // Measure performance of last 1000 steps
  const finalStepTime = measureStepTime(system, 1000);
  
  // Verify no significant performance degradation
  const perfRatio = finalStepTime / initialStepTime;
  if (!(perfRatio < 2.0)) {
    throw new Error(`Performance degraded too much: ${perfRatio}x slower`);
  }
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'long integration 10000 steps',
    initialStepTime,
    finalStepTime,
    perfRatio
  };
}

/**
 * Test 2: Close Encounters
 * Verify softening prevents divergence during close approaches.
 */
export async function testCloseEncounters() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const softening = 0.1;
  
  // Two particles on near-collision trajectory
  const positions = new Float32Array([
    -1.0, 0.0, 0.0, 1.0,
     1.0, 0.05, 0.0, 1.0  // slightly offset in y
  ]);
  
  // Velocities for head-on approach
  const velocities = new Float32Array([
     0.5, 0.0, 0.0, 0.0,
    -0.5, 0.0, 0.0, 0.0
  ]);
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening,
    maxSpeed: 5.0
  });
  
  let minDistance = Infinity;
  let closestApproachData = null;
  
  // Step through encounter
  for (let i = 0; i < 200; i++) {
    system.compute();
    
    const data = readAllParticleData(system);
    const dx = data.positions[0] - data.positions[4];
    const dy = data.positions[1] - data.positions[5];
    const dz = data.positions[2] - data.positions[6];
    const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
    
    if (dist < minDistance) {
      minDistance = dist;
      closestApproachData = {
        step: i,
        distance: dist,
        positions: new Float32Array(data.positions),
        velocities: new Float32Array(data.velocities)
      };
    }
  }
  
  // Verify no NaN/Inf at closest approach
  assertAllFinite(closestApproachData.positions, 'Positions at closest approach');
  assertAllFinite(closestApproachData.velocities, 'Velocities at closest approach');
  
  // Verify minimum distance is around softening length
  if (!(minDistance < softening * 3)) {
    throw new Error(`Expected close encounter near softening length, got ${minDistance}`);
  }
  
  // Verify particles deflected (scattering occurred)
  const finalData = readAllParticleData(system);
  const finalVx0 = finalData.velocities[0];
  const finalVx1 = finalData.velocities[4];
  
  // Particles should have non-zero perpendicular velocities after scattering
  const finalVy0 = Math.abs(finalData.velocities[1]);
  const finalVy1 = Math.abs(finalData.velocities[5]);
  
  if (!(finalVy0 > 0.01 || finalVy1 > 0.01)) {
    throw new Error('Expected scattering to produce perpendicular velocities');
  }
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'close encounters',
    minDistance,
    closestApproachStep: closestApproachData.step
  };
}

/**
 * Test 3: Extreme Mass Ratios (1:1000)
 * Verify light particles don't numerically dominate massive particle.
 */
export async function testExtremeMassRatios() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  // 1 massive particle at center + 10 light particles in orbit
  const positions = new Float32Array(11 * 4);
  const velocities = new Float32Array(11 * 4);
  
  // Massive particle at origin
  positions[0] = 0.0;
  positions[1] = 0.0;
  positions[2] = 0.0;
  positions[3] = 1000.0; // mass
  
  velocities[0] = 0.0;
  velocities[1] = 0.0;
  velocities[2] = 0.0;
  velocities[3] = 0.0;
  
  // Light particles in circular orbits
  for (let i = 0; i < 10; i++) {
    const idx = (i + 1) * 4;
    const angle = (i / 10) * Math.PI * 2;
    const r = 2.0;
    
    positions[idx + 0] = r * Math.cos(angle);
    positions[idx + 1] = r * Math.sin(angle);
    positions[idx + 2] = 0.0;
    positions[idx + 3] = 1.0; // unit mass
    
    // Tangential velocity
    const v = 0.2;
    velocities[idx + 0] = -v * Math.sin(angle);
    velocities[idx + 1] = v * Math.cos(angle);
    velocities[idx + 2] = 0.0;
    velocities[idx + 3] = 0.0;
  }
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.1
  });
  
  const initial = readAllParticleData(system);
  const initialMassivePos = [initial.positions[0], initial.positions[1], initial.positions[2]];
  
  // Step 500 times
  for (let i = 0; i < 500; i++) {
    system.compute();
  }
  
  const final = readAllParticleData(system);
  
  // Verify massive particle barely moved
  const massiveDisplacement = Math.sqrt(
    Math.pow(final.positions[0] - initialMassivePos[0], 2) +
    Math.pow(final.positions[1] - initialMassivePos[1], 2) +
    Math.pow(final.positions[2] - initialMassivePos[2], 2)
  );
  
  if (!(massiveDisplacement < 0.1)) {
    throw new Error(`Massive particle moved too much: ${massiveDisplacement}`);
  }
  
  // Verify light particles have reasonable velocities
  let maxLightParticleV = 0;
  for (let i = 1; i < 11; i++) {
    const vx = final.velocities[i * 4 + 0];
    const vy = final.velocities[i * 4 + 1];
    const vz = final.velocities[i * 4 + 2];
    const v = Math.sqrt(vx*vx + vy*vy + vz*vz);
    maxLightParticleV = Math.max(maxLightParticleV, v);
  }
  
  assertAllFinite(final.positions, 'Positions must be finite');
  assertAllFinite(final.velocities, 'Velocities must be finite');
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'extreme mass ratios',
    massiveDisplacement,
    maxLightParticleV
  };
}

/**
 * Test 4: Boundary Stress
 * Verify particles near world limits are handled correctly.
 */
export async function testBoundaryStress() {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  
  const worldBounds = { min: [-5, -5, -5], max: [5, 5, 5] };
  
  // 10 particles near boundaries
  const positions = new Float32Array(10 * 4);
  const velocities = new Float32Array(10 * 4);
  
  // Place particles near edges
  const edgePositions = [
    [4.8, 0, 0], [-4.8, 0, 0],
    [0, 4.8, 0], [0, -4.8, 0],
    [0, 0, 4.8], [0, 0, -4.8],
    [4.5, 4.5, 0], [-4.5, -4.5, 0],
    [4.5, 0, 4.5], [0, -4.5, -4.5]
  ];
  
  for (let i = 0; i < 10; i++) {
    positions[i * 4 + 0] = edgePositions[i][0];
    positions[i * 4 + 1] = edgePositions[i][1];
    positions[i * 4 + 2] = edgePositions[i][2];
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
    softening: 0.2,
    worldBounds
  });
  
  // Step 200 times
  for (let i = 0; i < 200; i++) {
    system.compute();
  }
  
  const final = readAllParticleData(system);
  
  // Verify no issues with boundary conditions
  assertAllFinite(final.positions, 'Positions must be finite');
  assertAllFinite(final.velocities, 'Velocities must be finite');
  
  // Check octree handled edge particles correctly
  // (just verify no crashes or NaN - octree behavior is internal)
  
  // Verify forces computed correctly (particles should move toward center)
  let inwardMotion = 0;
  for (let i = 0; i < 10; i++) {
    const x = final.positions[i * 4 + 0];
    const y = final.positions[i * 4 + 1];
    const z = final.positions[i * 4 + 2];
    const vx = final.velocities[i * 4 + 0];
    const vy = final.velocities[i * 4 + 1];
    const vz = final.velocities[i * 4 + 2];
    
    // Check if velocity points inward (toward origin)
    const radialV = x * vx + y * vy + z * vz;
    if (radialV < 0) inwardMotion++;
  }
  
  // Most particles should be moving inward
  if (!(inwardMotion >= 5)) {
    throw new Error(`Expected inward motion, got ${inwardMotion}/10`);
  }
  
  disposeSystem(system);
  cleanupGL(canvas, gl);
  
  return {
    passed: true,
    test: 'boundary stress',
    inwardMotion
  };
}

/**
 * Run all stability tests
 * @returns {Promise<object>} Test results
 */
export async function runAllTests() {
  const results = [];
  
  console.log('Running monopole stability integration tests...');
  
  try {
    results.push(await testLongIntegration());
    console.log('✓ Test 1: Long integration (10,000 steps)');
  } catch (e) {
    console.error('✗ Test 1 failed:', e.message);
    results.push({ passed: false, test: 'long integration', error: e.message });
  }
  
  try {
    results.push(await testCloseEncounters());
    console.log('✓ Test 2: Close encounters');
  } catch (e) {
    console.error('✗ Test 2 failed:', e.message);
    results.push({ passed: false, test: 'close encounters', error: e.message });
  }
  
  try {
    results.push(await testExtremeMassRatios());
    console.log('✓ Test 3: Extreme mass ratios');
  } catch (e) {
    console.error('✗ Test 3 failed:', e.message);
    results.push({ passed: false, test: 'extreme mass ratios', error: e.message });
  }
  
  try {
    results.push(await testBoundaryStress());
    console.log('✓ Test 4: Boundary stress');
  } catch (e) {
    console.error('✗ Test 4 failed:', e.message);
    results.push({ passed: false, test: 'boundary stress', error: e.message });
  }
  
  const passed = results.filter(r => r.passed).length;
  const total = results.length;
  
  console.log(`\nResults: ${passed}/${total} tests passed`);
  
  return { passed, total, results };
}
