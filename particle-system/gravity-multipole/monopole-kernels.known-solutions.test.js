// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemMonopoleKernels } from './particle-system-monopole-kernels.js';

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
 * Read particle position and velocity
 * @param {ParticleSystemMonopoleKernels} system
 * @param {number} particleIndex
 * @returns {{position: [number, number, number, number], velocity: [number, number, number, number]}}
 */
function readParticleData(system, particleIndex) {
  const gl = system.gl;
  const texWidth = system.textureWidth;
  const x = particleIndex % texWidth;
  const y = Math.floor(particleIndex / texWidth);
  
  const posTex = system.positionTexture;
  const velTex = system.velocityTexture;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  const posPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, posPixels);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  const velPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, velPixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return {
    position: [posPixels[0], posPixels[1], posPixels[2], posPixels[3]],
    velocity: [velPixels[0], velPixels[1], velPixels[2], velPixels[3]]
  };
}

/**
 * Test 1: Binary orbit (circular)
 */
test('monopole-kernels.known-solutions: binary circular orbit maintains separation', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Two equal masses in circular orbit
  const m = 1.0;
  const a = 1.0; // semi-major axis (separation / 2)
  const G = 0.001; // gravity strength
  
  // Circular orbit velocity: v = sqrt(G*M / (2*a)) where M = 2m
  const v = Math.sqrt(G * 2 * m / (2 * a));
  
  // Padded to 2x2 texture = 8 floats
  const positions = new Float32Array(8);
  positions.set([-a, 0, 0, m,  a, 0, 0, m]);
  
  const velocities = new Float32Array(8);
  velocities.set([0,  v, 0, 0,  0, -v, 0, 0]);
  
  const system = new ParticleSystemMonopoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: G,
    softening: 0.05
  });
  
  // Expected orbital period: T = 2*pi * sqrt(a^3 / (G*M))
  const M = 2 * m;
  const T = 2 * Math.PI * Math.sqrt(Math.pow(a, 3) / (G * M));
  const stepsPerOrbit = Math.ceil(T / 0.01);
  
  // Simulate 2 orbits
  const numOrbits = 2;
  const totalSteps = stepsPerOrbit * numOrbits;
  
  // Sample separation at regular intervals
  const sampleInterval = Math.floor(stepsPerOrbit / 10); // 10 samples per orbit
  const separations = [];
  
  for (let step = 0; step < totalSteps; step++) {
    if (step % sampleInterval === 0) {
      const p0 = readParticleData(system, 0).position;
      const p1 = readParticleData(system, 1).position;
      const sep = Math.sqrt(
        (p1[0] - p0[0])**2 +
        (p1[1] - p0[1])**2 +
        (p1[2] - p0[2])**2
      );
      separations.push(sep);
    }
    system.step();
  }
  
  // Expected separation is 2*a
  const expectedSep = 2 * a;
  
  // Check that separation remains roughly constant
  const avgSep = separations.reduce((a, b) => a + b, 0) / separations.length;
  const maxDev = Math.max(...separations.map(s => Math.abs(s - avgSep)));
  const relDev = maxDev / expectedSep;
  
  assert.ok(relDev < 0.2, 
    `Orbital separation should remain stable: avg=${avgSep.toFixed(3)}, expected=${expectedSep.toFixed(3)}, relDev=${relDev.toFixed(3)}`);
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 2: Binary orbit (eccentric)
 */
test('monopole-kernels.known-solutions: binary eccentric orbit shows periapse/apoapse', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Two equal masses in eccentric orbit
  const m = 1.0;
  const a = 1.0; // semi-major axis
  const e = 0.5; // eccentricity
  const G = 0.001;
  
  // Start at periapse (closest approach)
  const rp = a * (1 - e); // periapse distance from center
  
  // Velocity at periapse: v_p = sqrt(G*M*(1+e)/a)
  const M = 2 * m;
  const vp = Math.sqrt(G * M * (1 + e) / a);
  
  // Padded to 2x2 texture = 8 floats
  const positions = new Float32Array(8);
  positions.set([-rp, 0, 0, m,  rp, 0, 0, m]);
  
  const velocities = new Float32Array(8);
  velocities.set([0,  vp/2, 0, 0,  0, -vp/2, 0, 0]);
  
  const system = new ParticleSystemMonopoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.005,
    gravityStrength: G,
    softening: 0.05
  });
  
  // Track separation over time
  const separations = [];
  const T = 2 * Math.PI * Math.sqrt(Math.pow(a, 3) / (G * M));
  const stepsPerOrbit = Math.ceil(T / 0.005);
  
  for (let step = 0; step < stepsPerOrbit; step++) {
    const p0 = readParticleData(system, 0).position;
    const p1 = readParticleData(system, 1).position;
    const sep = Math.sqrt(
      (p1[0] - p0[0])**2 +
      (p1[1] - p0[1])**2 +
      (p1[2] - p0[2])**2
    );
    separations.push(sep);
    system.step();
  }
  
  // Find min and max separations
  const minSep = Math.min(...separations);
  const maxSep = Math.max(...separations);
  
  // Expected periapse and apoapse separations
  const expectedMin = 2 * a * (1 - e);
  const expectedMax = 2 * a * (1 + e);
  
  // Check that we see both periapse and apoapse
  const minError = Math.abs(minSep - expectedMin) / expectedMin;
  const maxError = Math.abs(maxSep - expectedMax) / expectedMax;
  
  assert.ok(minError < 0.3, 
    `Periapse separation should match: min=${minSep.toFixed(3)}, expected=${expectedMin.toFixed(3)}, error=${minError.toFixed(3)}`);
  
  assert.ok(maxError < 0.3, 
    `Apoapse separation should match: max=${maxSep.toFixed(3)}, expected=${expectedMax.toFixed(3)}, error=${maxError.toFixed(3)}`);
  
  // Verify eccentricity: max > min
  assert.ok(maxSep > minSep * 1.3, 
    `Orbit should be eccentric: max=${maxSep.toFixed(3)} > min=${minSep.toFixed(3)}`);
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 3: Free fall trajectory
 */
test('monopole-kernels.known-solutions: free fall matches analytical solution', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Single particle falling toward fixed mass at origin
  // Use test mass (very light) falling toward heavy mass
  
  const M = 100.0; // heavy central mass
  const m = 0.01;  // light test particle
  const r0 = 3.0;  // initial distance
  const G = 0.001;
  
  // Padded to 2x2 texture = 8 floats
  const positions = new Float32Array(8);
  positions.set([r0, 0, 0, m,  0, 0, 0, M]);
  
  const velocities = new Float32Array(8);
  velocities.set([0, 0, 0, 0,  0, 0, 0, 0]);
  
  const system = new ParticleSystemMonopoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.005,
    gravityStrength: G,
    softening: 0.1
  });
  
  // Analytical solution for free fall from rest:
  // r(t) = r0 * (1 - t/T)^(2/3) where T = pi/(2*sqrt(2)) * sqrt(r0^3 / (G*M))
  // For small times: r ≈ r0 - (1/2) * (G*M/r0^2) * t^2
  
  const expectedAccel = G * M / (r0 * r0);
  
  // Sample trajectory
  const dt = 0.005;
  const numSteps = 100;
  const samples = [];
  
  for (let step = 0; step < numSteps; step++) {
    const t = step * dt;
    const p0 = readParticleData(system, 0).position;
    const r = Math.sqrt(p0[0]**2 + p0[1]**2 + p0[2]**2);
    samples.push({ t, r, x: p0[0] });
    system.step();
  }
  
  // Check that particle moved inward
  assert.ok(samples[samples.length - 1].r < r0 - 0.1, 
    `Particle should fall inward: r0=${r0}, final_r=${samples[samples.length - 1].r.toFixed(3)}`);
  
  // Check acceleration matches expected value (approximately)
  // At t = 0.1s, expected displacement: x = r0 - 0.5 * a * t^2
  const t1 = 0.1;
  const step1 = Math.floor(t1 / dt);
  if (step1 < samples.length) {
    const actualDisp = r0 - samples[step1].r;
    const expectedDisp = 0.5 * expectedAccel * t1 * t1;
    const error = Math.abs(actualDisp - expectedDisp) / expectedDisp;
    
    // Allow larger tolerance due to numerical integration and softening
    assert.ok(error < 0.5, 
      `Displacement should roughly match analytical: actual=${actualDisp.toFixed(4)}, expected=${expectedDisp.toFixed(4)}, error=${error.toFixed(3)}`);
  }
  
  system.dispose();
  canvas.remove();
});
