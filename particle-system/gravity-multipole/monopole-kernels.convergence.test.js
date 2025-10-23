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
 * Read particle data
 * @param {ParticleSystemMonopoleKernels} system
 * @param {number} index
 * @returns {{position: [number,number,number], velocity: [number,number,number]}}
 */
function readParticleData(system, index) {
  const gl = system.gl;
  const texWidth = system.textureWidth;
  const x = index % texWidth;
  const y = Math.floor(index / texWidth);
  
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
    position: [posPixels[0], posPixels[1], posPixels[2]],
    velocity: [velPixels[0], velPixels[1], velPixels[2]]
  };
}

/**
 * Test 1: Timestep refinement improves accuracy
 */
test('monopole-kernels.convergence: smaller timestep improves accuracy', async () => {
  // Reference configuration: two particles in free fall
  const initialPositions = new Float32Array(8);  // 2x2 texture = 8 floats
  initialPositions.set([
    2, 0, 0, 1.0,
    0, 0, 0, 10.0 // Heavy central mass
  ]);
  const initialVelocities = new Float32Array(8);  // Padded to match texture
  
  const G = 0.001;
  const targetTime = 0.5; // Total simulation time
  
  // Run with different timesteps
  const timesteps = [0.05, 0.01, 0.002];
  const finalPositions = [];
  
  for (const dt of timesteps) {
    const { canvas, gl } = createTestCanvas();
    
    const positions = new Float32Array(initialPositions);
    const velocities = new Float32Array(initialVelocities);
    
    const system = new ParticleSystemMonopoleKernels({
      gl,
      particleData: { positions, velocities },
      worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
      dt: dt,
      gravityStrength: G,
      softening: 0.1
    });
    
    const numSteps = Math.floor(targetTime / dt);
    for (let i = 0; i < numSteps; i++) {
      system.step();
    }
    
    const finalData = readParticleData(system, 0);
    finalPositions.push(finalData.position[0]); // x-coordinate
    
    system.dispose();
    canvas.remove();
  }
  
  // Check convergence: smaller timesteps should give more consistent results
  // The difference between successive refinements should decrease
  const diff1 = Math.abs(finalPositions[1] - finalPositions[0]); // dt=0.01 vs dt=0.05
  const diff2 = Math.abs(finalPositions[2] - finalPositions[1]); // dt=0.002 vs dt=0.01
  
  assert.ok(diff2 < diff1, 
    `Smaller timestep should converge: diff(0.01-0.05)=${diff1.toFixed(4)}, diff(0.002-0.01)=${diff2.toFixed(4)}`);
  
  // Results should show particle moved inward
  assert.ok(finalPositions[2] < initialPositions[0], 
    `Particle should fall inward: initial=${initialPositions[0]}, final=${finalPositions[2].toFixed(3)}`);
});

/**
 * Test 2: Theta parameter affects accuracy
 */
test('monopole-kernels.convergence: theta parameter controls approximation quality', async () => {
  // Test with clustered particles where theta affects force calculation
  const particleCount = 30;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  
  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);
  
  let seed = 888;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }
  
  // Create cluster at origin + test particle far away
  for (let i = 0; i < particleCount - 1; i++) {
    const theta = random() * 2 * Math.PI;
    const phi = Math.acos(2 * random() - 1);
    const r = random() * 0.5;
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }
  
  // Test particle far from cluster
  const testIdx = particleCount - 1;
  positions[testIdx * 4 + 0] = 5.0;
  positions[testIdx * 4 + 1] = 0;
  positions[testIdx * 4 + 2] = 0;
  positions[testIdx * 4 + 3] = 1.0;
  velocities[testIdx * 4 + 0] = 0;
  velocities[testIdx * 4 + 1] = 0;
  velocities[testIdx * 4 + 2] = 0;
  velocities[testIdx * 4 + 3] = 0;
  
  // Test with different theta values
  const thetaValues = [0.9, 0.5, 0.2];
  const testParticleFinalX = [];
  
  for (const theta of thetaValues) {
    const { canvas, gl } = createTestCanvas();
    
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemMonopoleKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-7, -7, -7], max: [7, 7, 7] },
      dt: 0.01,
      gravityStrength: 0.001,
      softening: 0.1,
      theta: theta
    });
    
    // Run simulation
    for (let i = 0; i < 50; i++) {
      system.step();
    }
    
    const finalData = readParticleData(system, testIdx);
    testParticleFinalX.push(finalData.position[0]);
    
    system.dispose();
    canvas.remove();
  }
  
  // Lower theta (more accurate) should give different result than higher theta
  const diff_high_mid = Math.abs(testParticleFinalX[1] - testParticleFinalX[0]);
  const diff_mid_low = Math.abs(testParticleFinalX[2] - testParticleFinalX[1]);
  
  // At least one difference should be measurable
  const maxDiff = Math.max(diff_high_mid, diff_mid_low);
  
  assert.ok(maxDiff > 0.001, 
    `Theta should affect results: theta=0.9→${testParticleFinalX[0].toFixed(4)}, 0.5→${testParticleFinalX[1].toFixed(4)}, 0.2→${testParticleFinalX[2].toFixed(4)}`);
  
  // All should show particle moved toward cluster
  for (let i = 0; i < 3; i++) {
    assert.ok(testParticleFinalX[i] < 5.0, 
      `Particle should move toward cluster (theta=${thetaValues[i]}): ${testParticleFinalX[i].toFixed(3)} < 5.0`);
  }
});

/**
 * Test 3: Softening parameter validation
 */
test('monopole-kernels.convergence: softening affects close encounters', async () => {
  // Two particles with close approach
  const positions = new Float32Array(8);  // 2x2 texture = 8 floats
  positions.set([-0.5, 0, 0, 1.0,  0.5, 0, 0, 1.0]);
  
  const velocities = new Float32Array(8);
  velocities.set([0.2, 0, 0, 0,  -0.2, 0, 0, 0]);
  
  const G = 0.001;
  const softeningValues = [0.01, 0.1, 0.5];
  const maxSpeeds = [];
  
  for (const softening of softeningValues) {
    const { canvas, gl } = createTestCanvas();
    
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemMonopoleKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
      dt: 0.005,
      gravityStrength: G,
      softening: softening,
      maxSpeed: 10.0
    });
    
    let maxSpeed = 0;
    
    // Run until close approach
    for (let i = 0; i < 100; i++) {
      system.step();
      
      const p0 = readParticleData(system, 0);
      const p1 = readParticleData(system, 1);
      
      const speed0 = Math.sqrt(p0.velocity[0]**2 + p0.velocity[1]**2 + p0.velocity[2]**2);
      const speed1 = Math.sqrt(p1.velocity[0]**2 + p1.velocity[1]**2 + p1.velocity[2]**2);
      
      maxSpeed = Math.max(maxSpeed, speed0, speed1);
    }
    
    maxSpeeds.push(maxSpeed);
    
    system.dispose();
    canvas.remove();
  }
  
  // Higher softening should result in lower peak velocities (less singular force)
  assert.ok(maxSpeeds[2] < maxSpeeds[0], 
    `Higher softening should reduce peak velocity: soft=0.01→${maxSpeeds[0].toFixed(3)}, 0.1→${maxSpeeds[1].toFixed(3)}, 0.5→${maxSpeeds[2].toFixed(3)}`);
  
  // All should have some acceleration
  for (let i = 0; i < 3; i++) {
    assert.ok(maxSpeeds[i] > 0.2, 
      `Particles should accelerate (softening=${softeningValues[i]}): max speed=${maxSpeeds[i].toFixed(3)} > 0.2`);
  }
});
