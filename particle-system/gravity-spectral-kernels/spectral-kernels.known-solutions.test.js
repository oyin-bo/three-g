// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemSpectralKernels } from './particle-system-spectral-kernels.js';

/**
 * Create offscreen canvas with WebGL2 context
 * @returns {{canvas: HTMLCanvasElement, gl: WebGL2RenderingContext}}
 */
function createTestCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const gl = canvas.getContext('webgl2');
  
  if (!gl) {
    throw new Error('WebGL2 not supported');
  }
  
  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) {
    throw new Error('EXT_color_buffer_float not supported');
  }
  
  return { canvas, gl };
}

/**
 * Read particle data from GPU textures
 * @param {ParticleSystemSpectralKernels} system
 * @param {number} particleIndex
 * @returns {{position: [number, number, number, number], velocity: [number, number, number, number]}}
 */
function readParticleData(system, particleIndex) {
  const gl = system.gl;
  const texWidth = system.textureWidth;
  
  const x = particleIndex % texWidth;
  const y = Math.floor(particleIndex / texWidth);
  
  // Read position
  const posTex = system.positionTexture;
  const posFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  
  const posPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, posPixels);
  
  // Read velocity
  const velTex = system.velocityTexture;
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  
  const velPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, velPixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(posFBO);
  
  return {
    position: [posPixels[0], posPixels[1], posPixels[2], posPixels[3]],
    velocity: [velPixels[0], velPixels[1], velPixels[2], velPixels[3]]
  };
}

/**
 * Dispose system and cleanup
 * @param {ParticleSystemSpectralKernels} system
 * @param {HTMLCanvasElement} canvas
 */
function disposeSystem(system, canvas) {
  system.dispose();
  canvas.remove();
}

/**
 * Test 1: Free fall - particle falls toward massive body
 */
test('spectral-kernels.known-solutions: particle falls toward massive body', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Large mass at origin, small test particle above it
  const positions = new Float32Array(8);
  positions.set([
    0, 0, 0, 100.0,  // Massive body
    0, 2, 0, 0.01    // Small test particle
  ]);
  const velocities = new Float32Array(8);
  
  const gravityStrength = 0.001;
  const softening = 0.1;
  const dt = 0.01;
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: dt,
    gravityStrength: gravityStrength,
    softening: softening,
    gridSize: 64
  });
  
  const initial = readParticleData(system, 1);
  
  // Simulate fall
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  const final = readParticleData(system, 1);
  
  // Particle should fall downward (negative y velocity)
  const diagFall = `\n  Free-fall diagnostics:\n` +
    `    Initial position: [${initial.position.map(v => v.toFixed(4)).join(', ')}]\n` +
    `    Final position:   [${final.position.map(v => v.toFixed(4)).join(', ')}]\n` +
    `    Initial velocity: [${initial.velocity.map(v => v.toFixed(4)).join(', ')}]\n` +
    `    Final velocity:   [${final.velocity.map(v => v.toFixed(4)).join(', ')}]`;

  assert.ok(final.velocity[1] < -0.01, 
    `Particle should fall downward: vy=${final.velocity[1].toFixed(4)}` + diagFall);
  
  // Particle should be closer to origin
  const initialDist = Math.sqrt(initial.position[0]**2 + initial.position[1]**2 + initial.position[2]**2);
  const finalDist = Math.sqrt(final.position[0]**2 + final.position[1]**2 + final.position[2]**2);
  
  assert.ok(finalDist < initialDist, 
    `Particle should move closer: ${initialDist.toFixed(3)} -> ${finalDist.toFixed(3)}` + diagFall);
  
  disposeSystem(system, canvas);
});

/**
 * Test 2: Circular orbit approximation
 */
test('spectral-kernels.known-solutions: circular orbit maintains approximate radius', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Central massive body and orbiting particle
  const r = 1.5;
  const M = 100.0;
  const m = 0.1;
  const G = 0.001;
  
  // Circular orbit velocity: v = sqrt(GM/r)
  const v = Math.sqrt(G * M / r) * 0.95; // Slightly less for stability
  
  const positions = new Float32Array(8);
  positions.set([
    0, 0, 0, M,
    r, 0, 0, m
  ]);
  
  const velocities = new Float32Array(8);
  velocities.set([
    0, 0, 0, 0,
    0, v, 0, 0
  ]);
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.005,
    gravityStrength: G,
    softening: 0.1,
    gridSize: 64
  });
  
  // Record distances over time
  const distances = [];
  const numSamples = 100;
  
  for (let i = 0; i < numSamples; i++) {
    system.step();
    
    if (i % 10 === 0) {
      const p = readParticleData(system, 1);
      const dist = Math.sqrt(p.position[0]**2 + p.position[1]**2 + p.position[2]**2);
      distances.push(dist);
    }
  }
  
  // Calculate average and variation
  const avgDist = distances.reduce((a, b) => a + b, 0) / distances.length;
  const maxDist = Math.max(...distances);
  const minDist = Math.min(...distances);
  const variation = (maxDist - minDist) / avgDist;
  
  // Orbit should stay reasonably circular (allowing for spectral method artifacts)
  const diagOrbit = `\n  Circular orbit diagnostics:\n` +
    `    Distances sampled: ${distances.map(d => d.toFixed(3)).join(', ')}\n` +
    `    Average distance: ${avgDist.toFixed(3)}\n` +
    `    Min/Max distance: ${minDist.toFixed(3)} / ${maxDist.toFixed(3)}`;

  assert.ok(variation < 0.4, 
    `Orbit should be reasonably circular: variation=${(variation * 100).toFixed(1)}%` + diagOrbit);
  
  // Average radius should be close to initial
  assert.ok(Math.abs(avgDist - r) / r < 0.2, 
    `Average radius should stay close to initial: ${r.toFixed(3)} -> ${avgDist.toFixed(3)}` + diagOrbit);
  
  disposeSystem(system, canvas);
});

/**
 * Test 3: Binary system - equal mass orbiting pair
 */
test('spectral-kernels.known-solutions: binary system orbits center of mass', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Two equal masses with circular velocities
  const separation = 2.0;
  const mass = 1.0;
  const G = 0.001;
  
  // Circular orbit velocity for binary: v = sqrt(GM/(2r))
  const v = Math.sqrt(G * mass / separation) * 0.9; // Reduced for stability
  
  const positions = new Float32Array(8);
  positions.set([
    -separation/2, 0, 0, mass,
     separation/2, 0, 0, mass
  ]);
  
  const velocities = new Float32Array(8);
  velocities.set([
    0, -v, 0, 0,
    0,  v, 0, 0
  ]);
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.005,
    gravityStrength: G,
    softening: 0.15,
    gridSize: 64
  });
  
  // Track center of mass motion
  const comPositions = [];
  const numSteps = 80;
  
  for (let i = 0; i < numSteps; i++) {
    system.step();
    
    if (i % 10 === 0) {
      const p0 = readParticleData(system, 0);
      const p1 = readParticleData(system, 1);
      
      const comX = (p0.position[0] * mass + p1.position[0] * mass) / (2 * mass);
      const comY = (p0.position[1] * mass + p1.position[1] * mass) / (2 * mass);
      const comZ = (p0.position[2] * mass + p1.position[2] * mass) / (2 * mass);
      
      comPositions.push([comX, comY, comZ]);
    }
  }
  
  // Center of mass should remain near origin
  for (const com of comPositions) {
    const drift = Math.sqrt(com[0]**2 + com[1]**2 + com[2]**2);
    const diagBinary = `\n  Binary COM diagnostics:\n` +
      comPositions.map((com, step) => `    Step ${step * 10}: [${com.map(v => v.toFixed(4)).join(', ')}]`).join('\n');

    assert.ok(drift < 0.3, 
      `Center of mass should stay near origin: drift=${drift.toFixed(4)}` + diagBinary);
  }
  
  disposeSystem(system, canvas);
});

/**
 * Test 4: Three-body Lagrange point stability (L4/L5)
 */
test('spectral-kernels.known-solutions: particle near L4 point shows bounded motion', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Two large masses in circular orbit, small particle at approximate L4 point
  const M1 = 50.0;
  const M2 = 50.0;
  const m = 0.01;
  const a = 1.5; // Semi-major axis
  const G = 0.0005;
  
  // Circular orbit velocity
  const v = Math.sqrt(G * (M1 + M2) / (2 * a)) * 0.85;
  
  // L4 is at 60 degrees ahead of M2
  const angle = Math.PI / 3; // 60 degrees
  
  const positions = new Float32Array(16);
  positions.set([
    -a/2, 0, 0, M1,
     a/2, 0, 0, M2,
     a/2 * Math.cos(angle), a/2 * Math.sin(angle), 0, m
  ]);
  
  const velocities = new Float32Array(16);
  velocities.set([
    0, -v, 0, 0,
    0,  v, 0, 0,
    -v * Math.sin(angle), v * Math.cos(angle), 0, 0
  ]);
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.005,
    gravityStrength: G,
    softening: 0.2,
    gridSize: 64
  });
  
  // Track test particle distance from L4 point
  const initialL4 = [
    a/2 * Math.cos(angle),
    a/2 * Math.sin(angle),
    0
  ];
  
  let maxDrift = 0;
  const numSteps = 60;
  
  for (let i = 0; i < numSteps; i++) {
    system.step();
    
    if (i % 5 === 0) {
      const p = readParticleData(system, 2);
      const drift = Math.sqrt(
        (p.position[0] - initialL4[0])**2 +
        (p.position[1] - initialL4[1])**2 +
        (p.position[2] - initialL4[2])**2
      );
      maxDrift = Math.max(maxDrift, drift);
    }
  }
  
  // Particle should stay in bounded region near L4 (allowing for spectral artifacts)
  const diagL4 = `\n  L4 stability diagnostics:\n` +
    `    Initial L4 point: [${initialL4.map(v => v.toFixed(3)).join(', ')}]\n` +
    `    Max drift: ${maxDrift.toFixed(3)}`;

  assert.ok(maxDrift < 1.0, 
    `Particle should remain bounded near L4: max drift=${maxDrift.toFixed(3)}` + diagL4);
  
  disposeSystem(system, canvas);
});

/**
 * Test 5: Escape velocity test
 */
test('spectral-kernels.known-solutions: particle with high velocity escapes massive body', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Massive body at origin, test particle with high velocity
  const M = 100.0;
  const m = 0.1;
  const r0 = 1.5;
  const G = 0.001;
  
  // Escape velocity: v_esc = sqrt(2GM/r)
  const v_escape = Math.sqrt(2 * G * M / r0);
  const v_test = v_escape * 1.3; // 30% above escape velocity
  
  const positions = new Float32Array(8);
  positions.set([
    0, 0, 0, M,
    r0, 0, 0, m
  ]);
  
  const velocities = new Float32Array(8);
  velocities.set([
    0, 0, 0, 0,
    0, v_test, 0, 0
  ]);
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: G,
    softening: 0.1,
    gridSize: 64
  });
  
  const initialDist = r0;
  
  // Simulate motion
  for (let i = 0; i < 100; i++) {
    system.step();
  }
  
  const final = readParticleData(system, 1);
  const finalDist = Math.sqrt(final.position[0]**2 + final.position[1]**2 + final.position[2]**2);
  
  // Particle should have escaped (moved significantly farther)
  const diagEscape = `\n  Escape diagnostics:\n` +
    `    Initial distance: ${initialDist.toFixed(3)}\n` +
    `    Final distance:   ${finalDist.toFixed(3)}\n` +
    `    Initial velocity: [0.0000, ${v_test.toFixed(4)}, 0.0000]\n` +
    `    Final velocity:   [${final.velocity.map(v => v.toFixed(4)).join(', ')}]`;

  assert.ok(finalDist > initialDist * 1.5, 
    `Particle should escape: ${initialDist.toFixed(3)} -> ${finalDist.toFixed(3)}` + diagEscape);
  
  // Velocity should still be substantial (not captured)
  const finalSpeed = Math.sqrt(final.velocity[0]**2 + final.velocity[1]**2 + final.velocity[2]**2);
  assert.ok(finalSpeed > v_test * 0.3, 
    `Particle should maintain substantial velocity: ${finalSpeed.toFixed(4)}` + diagEscape);
  
  disposeSystem(system, canvas);
});
