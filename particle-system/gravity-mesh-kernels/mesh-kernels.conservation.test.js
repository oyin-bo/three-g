// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemMeshKernels } from './particle-system-mesh-kernels.js';

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
 * Read all particle data from GPU textures
 * @param {ParticleSystemMeshKernels} system
 * @param {number} particleCount
 */
function readAllParticleData(system, particleCount) {
  const gl = system.gl;
  const texWidth = system.textureWidth;
  
  // Read position texture
  const posTex = system.positionTexture;
  const posFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  
  const posPixels = new Float32Array(texWidth * system.textureHeight * 4);
  gl.readPixels(0, 0, texWidth, system.textureHeight, gl.RGBA, gl.FLOAT, posPixels);
  
  // Read velocity texture
  const velTex = system.velocityTexture;
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  
  const velPixels = new Float32Array(texWidth * system.textureHeight * 4);
  gl.readPixels(0, 0, texWidth, system.textureHeight, gl.RGBA, gl.FLOAT, velPixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(posFBO);
  
  const particles = [];
  for (let i = 0; i < particleCount; i++) {
    particles.push({
      position: /** @type {[number, number, number, number]} */ ([
        posPixels[i * 4 + 0],
        posPixels[i * 4 + 1],
        posPixels[i * 4 + 2],
        posPixels[i * 4 + 3]
      ]),
      velocity: /** @type {[number, number, number, number]} */ ([
        velPixels[i * 4 + 0],
        velPixels[i * 4 + 1],
        velPixels[i * 4 + 2],
        velPixels[i * 4 + 3]
      ])
    });
  }
  
  return particles;
}

/**
 * Compute total kinetic energy
 * @param {Array<{position: [number, number, number, number], velocity: [number, number, number, number]}>} particles
 * @returns {number}
 */
function computeKineticEnergy(particles) {
  let totalKE = 0;
  for (const p of particles) {
    const vx = p.velocity[0];
    const vy = p.velocity[1];
    const vz = p.velocity[2];
    const mass = p.position[3];
    totalKE += 0.5 * mass * (vx * vx + vy * vy + vz * vz);
  }
  return totalKE;
}

/**
 * Compute total potential energy
 * @param {Array<{position: [number, number, number, number], velocity: [number, number, number, number]}>} particles
 * @param {number} gravityStrength
 * @param {number} softening
 * @returns {number}
 */
function computePotentialEnergy(particles, gravityStrength, softening) {
  let totalPE = 0;
  const eps2 = softening * softening;
  
  for (let i = 0; i < particles.length; i++) {
    for (let j = i + 1; j < particles.length; j++) {
      const dx = particles[j].position[0] - particles[i].position[0];
      const dy = particles[j].position[1] - particles[i].position[1];
      const dz = particles[j].position[2] - particles[i].position[2];
      const r2 = dx * dx + dy * dy + dz * dz + eps2;
      const r = Math.sqrt(r2);
      
      const mi = particles[i].position[3];
      const mj = particles[j].position[3];
      
      totalPE -= gravityStrength * mi * mj / r;
    }
  }
  
  return totalPE;
}

/**
 * Compute total momentum
 * @param {Array<{position: [number, number, number, number], velocity: [number, number, number, number]}>} particles
 * @returns {[number, number, number]}
 */
function computeTotalMomentum(particles) {
  let px = 0, py = 0, pz = 0;
  for (const p of particles) {
    const mass = p.position[3];
    px += mass * p.velocity[0];
    py += mass * p.velocity[1];
    pz += mass * p.velocity[2];
  }
  return [px, py, pz];
}

/**
 * Compute total angular momentum
 * @param {Array<{position: [number, number, number, number], velocity: [number, number, number, number]}>} particles
 * @returns {[number, number, number]}
 */
function computeAngularMomentum(particles) {
  let Lx = 0, Ly = 0, Lz = 0;
  for (const p of particles) {
    const mass = p.position[3];
    const x = p.position[0], y = p.position[1], z = p.position[2];
    const vx = p.velocity[0], vy = p.velocity[1], vz = p.velocity[2];
    
    Lx += mass * (y * vz - z * vy);
    Ly += mass * (z * vx - x * vz);
    Lz += mass * (x * vy - y * vx);
  }
  return [Lx, Ly, Lz];
}

/**
 * Dispose system and cleanup
 * @param {ParticleSystemMeshKernels} system
 * @param {HTMLCanvasElement} canvas
 */
function disposeSystem(system, canvas) {
  system.dispose();
  canvas.remove();
}

/**
 * Test 1: Energy conservation
 */
test('mesh-kernels.conservation: energy is approximately conserved', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create 4 particles in a square
  const positions = new Float32Array(16);
  positions.set([
    -0.5, -0.5, 0, 1.0,
     0.5, -0.5, 0, 1.0,
    -0.5,  0.5, 0, 1.0,
     0.5,  0.5, 0, 1.0
  ]);
  
  const velocities = new Float32Array(16);
  velocities.set([
     0.1, 0.1, 0, 0,
    -0.1, 0.1, 0, 0,
     0.1, -0.1, 0, 0,
    -0.1, -0.1, 0, 0
  ]);
  
  const gravityStrength = 0.001;
  const softening = 0.15;
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: gravityStrength,
    softening: softening,
    mesh: { gridSize: 64, assignment: 'ngp' }
  });
  
  // Calculate initial energy
  const initialParticles = readAllParticleData(system, 4);
  const initialKE = computeKineticEnergy(initialParticles);
  const initialPE = computePotentialEnergy(initialParticles, gravityStrength, softening);
  const initialEnergy = initialKE + initialPE;
  
  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  // Calculate final energy
  const finalParticles = readAllParticleData(system, 4);
  const finalKE = computeKineticEnergy(finalParticles);
  const finalPE = computePotentialEnergy(finalParticles, gravityStrength, softening);
  const finalEnergy = finalKE + finalPE;
  
  const energyDrift = Math.abs((finalEnergy - initialEnergy) / initialEnergy);
  
  // Mesh methods have grid artifacts, allow ~25% drift
  assert.ok(energyDrift < 0.25, 
    `Energy drift should be reasonable: ${(energyDrift * 100).toFixed(2)}%`);
  
  disposeSystem(system, canvas);
});

/**
 * Test 2: Momentum conservation
 */
test('mesh-kernels.conservation: momentum is conserved', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create 3 particles with various velocities
  const positions = new Float32Array(16);
  positions.set([
    -0.7, 0, 0, 1.0,
     0.3, 0.5, 0, 1.0,
     0.4, -0.6, 0, 1.0
  ]);
  
  const velocities = new Float32Array(16);
  velocities.set([
     0.15, 0.1, 0.05, 0,
    -0.1, 0.05, -0.03, 0,
    -0.05, -0.15, -0.02, 0
  ]);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.15,
    mesh: { gridSize: 64, assignment: 'cic' }
  });
  
  const initialParticles = readAllParticleData(system, 3);
  const [initialPx, initialPy, initialPz] = computeTotalMomentum(initialParticles);
  
  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  const finalParticles = readAllParticleData(system, 3);
  const [finalPx, finalPy, finalPz] = computeTotalMomentum(finalParticles);
  
  const momentumDriftX = Math.abs(finalPx - initialPx);
  const momentumDriftY = Math.abs(finalPy - initialPy);
  const momentumDriftZ = Math.abs(finalPz - initialPz);
  
  // Momentum should be well conserved
  assert.ok(momentumDriftX < 0.01, `Momentum X drift: ${momentumDriftX.toFixed(6)}`);
  assert.ok(momentumDriftY < 0.01, `Momentum Y drift: ${momentumDriftY.toFixed(6)}`);
  assert.ok(momentumDriftZ < 0.01, `Momentum Z drift: ${momentumDriftZ.toFixed(6)}`);
  
  disposeSystem(system, canvas);
});

/**
 * Test 3: Angular momentum conservation
 */
test('mesh-kernels.conservation: angular momentum is conserved', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create 3 particles in triangular orbit
  const positions = new Float32Array(16);
  const sqrt3 = Math.sqrt(3);
  positions.set([
     0,    1,   0, 1.0,
    -sqrt3/2, -0.5, 0, 1.0,
     sqrt3/2, -0.5, 0, 1.0
  ]);
  
  // Give circular velocities
  const velocities = new Float32Array(16);
  const v0 = 0.12;
  velocities.set([
    -v0, 0, 0, 0,
     v0*0.5, -v0*sqrt3/2, 0, 0,
     v0*0.5,  v0*sqrt3/2, 0, 0
  ]);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.0005,
    softening: 0.15,
    mesh: { gridSize: 64, assignment: 'cic' }
  });
  
  const initialParticles = readAllParticleData(system, 3);
  const [initialLx, initialLy, initialLz] = computeAngularMomentum(initialParticles);
  
  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  const finalParticles = readAllParticleData(system, 3);
  const [finalLx, finalLy, finalLz] = computeAngularMomentum(finalParticles);
  
  const angularDriftX = Math.abs(finalLx - initialLx);
  const angularDriftY = Math.abs(finalLy - initialLy);
  const angularDriftZ = Math.abs(finalLz - initialLz);
  
  // Angular momentum should be well conserved
  const initialL = Math.sqrt(initialLx**2 + initialLy**2 + initialLz**2);
  const relativeDrift = Math.sqrt(angularDriftX**2 + angularDriftY**2 + angularDriftZ**2) / (initialL + 1e-10);
  
  assert.ok(relativeDrift < 0.05, 
    `Angular momentum relative drift: ${(relativeDrift * 100).toFixed(2)}%`);
  
  disposeSystem(system, canvas);
});
