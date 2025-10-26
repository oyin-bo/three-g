// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { GravityQuadrupole } from './gravity-quadrupole.js';

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
 * Read all particle data
 * @param {GravityQuadrupole} system
 * @param {number} count
 * @returns {{positions: Float32Array, velocities: Float32Array}}
 */
function readAllParticleData(system, count) {
  const gl = system.gl;
  const texWidth = system.textureWidth;
  const texHeight = system.textureHeight;
  
  const posTex = system.positionTexture;
  const velTex = system.velocityTexture;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  const positions = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, positions);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, velocities);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return { positions, velocities };
}

/**
 * Compute kinetic energy
 * @param {Float32Array} velocities
 * @param {Float32Array} positions
 * @param {number} count
 * @returns {number}
 */
function computeKineticEnergy(velocities, positions, count) {
  let KE = 0;
  for (let i = 0; i < count; i++) {
    const mass = positions[i * 4 + 3];
    const vx = velocities[i * 4 + 0];
    const vy = velocities[i * 4 + 1];
    const vz = velocities[i * 4 + 2];
    KE += 0.5 * mass * (vx*vx + vy*vy + vz*vz);
  }
  return KE;
}

/**
 * Compute potential energy
 * @param {Float32Array} positions
 * @param {number} count
 * @param {number} G
 * @param {number} softening
 * @returns {number}
 */
function computePotentialEnergy(positions, count, G, softening) {
  let PE = 0;
  const eps2 = softening * softening;
  
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const dx = positions[j * 4 + 0] - positions[i * 4 + 0];
      const dy = positions[j * 4 + 1] - positions[i * 4 + 1];
      const dz = positions[j * 4 + 2] - positions[i * 4 + 2];
      const r2 = dx*dx + dy*dy + dz*dz + eps2;
      const r = Math.sqrt(r2);
      
      const mi = positions[i * 4 + 3];
      const mj = positions[j * 4 + 3];
      
      PE -= G * mi * mj / r;
    }
  }
  return PE;
}

/**
 * Compute total momentum
 * @param {Float32Array} velocities
 * @param {Float32Array} positions
 * @param {number} count
 * @returns {[number, number, number]}
 */
function computeTotalMomentum(velocities, positions, count) {
  let px = 0, py = 0, pz = 0;
  
  for (let i = 0; i < count; i++) {
    const mass = positions[i * 4 + 3];
    px += velocities[i * 4 + 0] * mass;
    py += velocities[i * 4 + 1] * mass;
    pz += velocities[i * 4 + 2] * mass;
  }
  
  return [px, py, pz];
}

/**
 * Compute angular momentum
 * @param {Float32Array} positions
 * @param {Float32Array} velocities
 * @param {number} count
 * @returns {[number, number, number]}
 */
function computeAngularMomentum(positions, velocities, count) {
  let Lx = 0, Ly = 0, Lz = 0;
  
  for (let i = 0; i < count; i++) {
    const mass = positions[i * 4 + 3];
    const x = positions[i * 4 + 0];
    const y = positions[i * 4 + 1];
    const z = positions[i * 4 + 2];
    const vx = velocities[i * 4 + 0];
    const vy = velocities[i * 4 + 1];
    const vz = velocities[i * 4 + 2];
    
    // L = r × p = r × (m*v)
    Lx += mass * (y * vz - z * vy);
    Ly += mass * (z * vx - x * vz);
    Lz += mass * (x * vy - y * vx);
  }
  
  return [Lx, Ly, Lz];
}

/**
 * Test 1: Energy conservation in isolated system
 */
test('quadrupole-kernels.conservation: energy approximately conserved over time', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 50;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  
  // Create initial distribution (padded to texture size)
  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);
  
  let seed = 789;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }
  
  for (let i = 0; i < particleCount; i++) {
    const theta = random() * 2 * Math.PI;
    const phi = Math.acos(2 * random() - 1);
    const r = random() * 2.0 + 0.5;
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = (random() - 0.5) * 0.2;
    velocities[i * 4 + 1] = (random() - 0.5) * 0.2;
    velocities[i * 4 + 2] = (random() - 0.5) * 0.2;
    velocities[i * 4 + 3] = 0;
  }
  
  const G = 0.0003;
  const softening = 0.15;
  
  const system = new GravityQuadrupole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: G,
    softening: softening,
    damping: 0.0 // No damping for energy conservation
  });
  
  // Compute initial energy
  const initialData = readAllParticleData(system, particleCount);
  const initialKE = computeKineticEnergy(initialData.velocities, initialData.positions, particleCount);
  const initialPE = computePotentialEnergy(initialData.positions, particleCount, G, softening);
  const initialE = initialKE + initialPE;
  
  // Sample energy over time
  const energySamples = [initialE];
  const numSteps = 100;
  
  for (let step = 0; step < numSteps; step++) {
    system.step();
    
    if (step % 10 === 0) {
      const data = readAllParticleData(system, particleCount);
      const KE = computeKineticEnergy(data.velocities, data.positions, particleCount);
      const PE = computePotentialEnergy(data.positions, particleCount, G, softening);
      energySamples.push(KE + PE);
    }
  }
  
  // Check energy drift
  const finalE = energySamples[energySamples.length - 1];
  const energyDrift = Math.abs(finalE - initialE);
  const relDrift = energyDrift / Math.abs(initialE);
  
  // Quadrupole should show better energy conservation than monopole (higher accuracy)
  // Allow slightly less drift than monopole (0.2) due to better accuracy
  assert.ok(relDrift < 0.18, 
    `Energy should be well conserved (quadrupole with higher accuracy): initial=${initialE.toExponential(3)}, final=${finalE.toExponential(3)}, relDrift=${relDrift.toFixed(3)}`);
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 2: Momentum conservation
 */
test('quadrupole-kernels.conservation: momentum conserved in isolated system', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 30;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  
  // Create symmetric distribution to minimize initial momentum (padded to texture size)
  const positions = new Float32Array(textureWidth * textureHeight * 4);
  const velocities = new Float32Array(textureWidth * textureHeight * 4);
  
  let seed = 234;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }
  
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (random() - 0.5) * 4;
    positions[i * 4 + 1] = (random() - 0.5) * 4;
    positions[i * 4 + 2] = (random() - 0.5) * 4;
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = (random() - 0.5) * 0.1;
    velocities[i * 4 + 1] = (random() - 0.5) * 0.1;
    velocities[i * 4 + 2] = (random() - 0.5) * 0.1;
    velocities[i * 4 + 3] = 0;
  }
  
  const system = new GravityQuadrupole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-6, -6, -6], max: [6, 6, 6] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Compute initial momentum
  const initialData = readAllParticleData(system, particleCount);
  const initialP = computeTotalMomentum(initialData.velocities, initialData.positions, particleCount);
  
  // Step simulation
  for (let i = 0; i < 100; i++) {
    system.step();
  }
  
  // Compute final momentum
  const finalData = readAllParticleData(system, particleCount);
  const finalP = computeTotalMomentum(finalData.velocities, finalData.positions, particleCount);
  
  // Check momentum conservation
  const dpx = Math.abs(finalP[0] - initialP[0]);
  const dpy = Math.abs(finalP[1] - initialP[1]);
  const dpz = Math.abs(finalP[2] - initialP[2]);
  const dp = Math.sqrt(dpx*dpx + dpy*dpy + dpz*dpz);
  
  const initialPMag = Math.sqrt(initialP[0]**2 + initialP[1]**2 + initialP[2]**2);
  const relChange = initialPMag > 1e-6 ? dp / initialPMag : dp;
  
  assert.ok(relChange < 0.1 || dp < 0.01, 
    `Momentum should be conserved: initial=[${initialP.map(x=>x.toFixed(4))}], final=[${finalP.map(x=>x.toFixed(4))}], dp=${dp.toFixed(4)}`);
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 3: Angular momentum conservation
 */
test('quadrupole-kernels.conservation: angular momentum conserved in rotating system', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 20;
  
  // Create rotating disk configuration
  const positions = new Float32Array(particleCount * 4);
  const velocities = new Float32Array(particleCount * 4);
  
  let seed = 567;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }
  
  const omega = 0.1; // angular velocity
  
  for (let i = 0; i < particleCount; i++) {
    const r = 0.5 + random() * 1.5;
    const theta = random() * 2 * Math.PI;
    
    // Position in disk (z ≈ 0)
    positions[i * 4 + 0] = r * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(theta);
    positions[i * 4 + 2] = (random() - 0.5) * 0.2; // small z variation
    positions[i * 4 + 3] = 1.0;
    
    // Circular velocity
    velocities[i * 4 + 0] = -omega * r * Math.sin(theta);
    velocities[i * 4 + 1] =  omega * r * Math.cos(theta);
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }
  
  const system = new GravityQuadrupole({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.15
  });
  
  // Compute initial angular momentum
  const initialData = readAllParticleData(system, particleCount);
  const initialL = computeAngularMomentum(initialData.positions, initialData.velocities, particleCount);
  
  // Step simulation
  for (let i = 0; i < 100; i++) {
    system.step();
  }
  
  // Compute final angular momentum
  const finalData = readAllParticleData(system, particleCount);
  const finalL = computeAngularMomentum(finalData.positions, finalData.velocities, particleCount);
  
  // Check angular momentum conservation
  const dLx = Math.abs(finalL[0] - initialL[0]);
  const dLy = Math.abs(finalL[1] - initialL[1]);
  const dLz = Math.abs(finalL[2] - initialL[2]);
  const dL = Math.sqrt(dLx*dLx + dLy*dLy + dLz*dLz);
  
  const initialLMag = Math.sqrt(initialL[0]**2 + initialL[1]**2 + initialL[2]**2);
  const relChange = dL / initialLMag;
  
  // Quadrupole should show better angular momentum conservation
  assert.ok(relChange < 0.12, 
    `Angular momentum should be well conserved (quadrupole): initial=[${initialL.map(x=>x.toFixed(3))}], final=[${finalL.map(x=>x.toFixed(3))}], relChange=${relChange.toFixed(3)}`);
  
  system.dispose();
  canvas.remove();
});

