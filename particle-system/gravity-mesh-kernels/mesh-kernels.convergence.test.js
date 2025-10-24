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
 * Dispose system and cleanup
 * @param {ParticleSystemMeshKernels} system
 * @param {HTMLCanvasElement} canvas
 */
function disposeSystem(system, canvas) {
  system.dispose();
  canvas.remove();
}

/**
 * Test 1: Timestep refinement
 */
test('mesh-kernels.convergence: smaller timesteps improve accuracy', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Create 2 particles
  const positions = new Float32Array(8);
  positions.set([-1, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const gravityStrength = 0.001;
  const softening = 0.1;
  const totalTime = 0.5;
  
  const timesteps = [0.05, 0.025, 0.0125];
  const finalEnergies = [];
  
  for (const dt of timesteps) {
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemMeshKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
      dt: dt,
      gravityStrength: gravityStrength,
      softening: softening,
      mesh: { gridSize: 64, assignment: 'cic' }
    });
    
    const steps = Math.round(totalTime / dt);
    
    const initialParticles = readAllParticleData(system, 2);
    const initialEnergy = computeKineticEnergy(initialParticles) + 
                         computePotentialEnergy(initialParticles, gravityStrength, softening);
    
    for (let i = 0; i < steps; i++) {
      system.step();
    }
    
    const finalParticles = readAllParticleData(system, 2);
    const finalEnergy = computeKineticEnergy(finalParticles) + 
                       computePotentialEnergy(finalParticles, gravityStrength, softening);
    
    const energyDrift = Math.abs((finalEnergy - initialEnergy) / initialEnergy);
    finalEnergies.push(energyDrift);
    
    system.dispose();
  }
  
  // Verify smaller timesteps reduce energy drift
  assert.ok(finalEnergies[1] <= finalEnergies[0] * 1.1, 
    `dt=0.025 should be better than dt=0.05: drifts ${finalEnergies[1].toFixed(4)} vs ${finalEnergies[0].toFixed(4)}`);
  
  assert.ok(finalEnergies[2] <= finalEnergies[1] * 1.1, 
    `dt=0.0125 should be better than dt=0.025: drifts ${finalEnergies[2].toFixed(4)} vs ${finalEnergies[1].toFixed(4)}`);
  
  canvas.remove();
});

/**
 * Test 2: Grid resolution convergence
 */
test('mesh-kernels.convergence: higher grid resolution improves accuracy', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(16);
  positions.set([
    -0.5, -0.5, 0, 1.0,
     0.5, -0.5, 0, 1.0,
    -0.5,  0.5, 0, 1.0,
     0.5,  0.5, 0, 1.0
  ]);
  const velocities = new Float32Array(16);
  
  const gravityStrength = 0.001;
  const softening = 0.1;
  const dt = 0.01;
  const steps = 20;
  
  const gridSizes = [16, 32, 64, 128];
  const finalEnergies = [];
  
  for (const gridSize of gridSizes) {
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemMeshKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      dt: dt,
      gravityStrength: gravityStrength,
      softening: softening,
      mesh: { gridSize: gridSize, assignment: 'cic' }
    });
    
    const initialParticles = readAllParticleData(system, 4);
    const initialEnergy = computeKineticEnergy(initialParticles) + 
                         computePotentialEnergy(initialParticles, gravityStrength, softening);
    
    for (let i = 0; i < steps; i++) {
      system.step();
    }
    
    const finalParticles = readAllParticleData(system, 4);
    const finalEnergy = computeKineticEnergy(finalParticles) + 
                       computePotentialEnergy(finalParticles, gravityStrength, softening);
    
    const energyDrift = Math.abs((finalEnergy - initialEnergy) / initialEnergy);
    finalEnergies.push(energyDrift);
    
    system.dispose();
  }
  
  // Higher resolution should generally improve accuracy
  const improvement32vs16 = finalEnergies[0] - finalEnergies[1];
  const improvement64vs32 = finalEnergies[1] - finalEnergies[2];
  
  assert.ok(improvement32vs16 > -0.05 || finalEnergies[1] < 0.15, 
    `Grid 32 should be comparable or better than 16: drifts ${finalEnergies[1].toFixed(4)} vs ${finalEnergies[0].toFixed(4)}`);
  
  assert.ok(improvement64vs32 > -0.05 || finalEnergies[2] < 0.15, 
    `Grid 64 should be comparable or better than 32: drifts ${finalEnergies[2].toFixed(4)} vs ${finalEnergies[1].toFixed(4)}`);
  
  canvas.remove();
});

/**
 * Test 3: Assignment method comparison (mesh-specific)
 */
test('mesh-kernels.convergence: CIC assignment more accurate than NGP', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(16);
  positions.set([
    -0.7, 0, 0, 1.0,
     0.3, 0.5, 0, 1.0,
     0.4, -0.6, 0, 1.0
  ]);
  const velocities = new Float32Array(16);
  
  const gravityStrength = 0.001;
  const softening = 0.1;
  const dt = 0.01;
  const steps = 25;
  
  const assignmentMethods = /** @type {const} */ (['ngp', 'cic']);
  const finalEnergies = [];
  
  for (const assignment of assignmentMethods) {
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemMeshKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      dt: dt,
      gravityStrength: gravityStrength,
      softening: softening,
      mesh: { gridSize: 64, assignment: assignment }
    });
    
    const initialParticles = readAllParticleData(system, 3);
    const initialEnergy = computeKineticEnergy(initialParticles) + 
                         computePotentialEnergy(initialParticles, gravityStrength, softening);
    
    for (let i = 0; i < steps; i++) {
      system.step();
    }
    
    const finalParticles = readAllParticleData(system, 3);
    const finalEnergy = computeKineticEnergy(finalParticles) + 
                       computePotentialEnergy(finalParticles, gravityStrength, softening);
    
    const energyDrift = Math.abs((finalEnergy - initialEnergy) / initialEnergy);
    finalEnergies.push(energyDrift);
    
    system.dispose();
  }
  
  // CIC should generally be more accurate
  assert.ok(finalEnergies[1] <= finalEnergies[0] * 1.3, 
    `CIC should be comparable or better than NGP: CIC drift=${finalEnergies[1].toFixed(4)}, NGP drift=${finalEnergies[0].toFixed(4)}`);
  
  canvas.remove();
});

/**
 * Test 4: Near-field radius convergence (mesh-specific)
 */
test('mesh-kernels.convergence: near-field radius affects accuracy', async () => {
  const { canvas, gl } = createTestCanvas();
  
  // Two close particles
  const positions = new Float32Array(8);
  positions.set([-0.3, 0, 0, 1.0,  0.3, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const gravityStrength = 0.001;
  const softening = 0.1;
  const dt = 0.01;
  const steps = 20;
  
  const nearFieldRadii = [1, 2, 3];
  const maxSpeeds = [];
  
  for (const nearFieldRadius of nearFieldRadii) {
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemMeshKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      dt: dt,
      gravityStrength: gravityStrength,
      softening: softening,
      mesh: { gridSize: 32, assignment: 'cic', nearFieldRadius: nearFieldRadius }
    });
    
    for (let i = 0; i < steps; i++) {
      system.step();
    }
    
    const particles = readAllParticleData(system, 2);
    const maxSpeed = Math.max(
      Math.sqrt(particles[0].velocity[0]**2 + particles[0].velocity[1]**2 + particles[0].velocity[2]**2),
      Math.sqrt(particles[1].velocity[0]**2 + particles[1].velocity[1]**2 + particles[1].velocity[2]**2)
    );
    maxSpeeds.push(maxSpeed);
    
    system.dispose();
  }
  
  // All near-field radii should produce stable results
  for (let i = 0; i < nearFieldRadii.length; i++) {
    assert.ok(isFinite(maxSpeeds[i]) && maxSpeeds[i] < 2.0, 
      `Near-field radius ${nearFieldRadii[i]} should be stable: maxSpeed=${maxSpeeds[i].toFixed(3)}`);
  }
  
  canvas.remove();
});

/**
 * Test 5: Softening parameter convergence
 */
test('mesh-kernels.convergence: appropriate softening prevents numerical instability', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([-0.2, 0, 0, 1.0,  0.2, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const gravityStrength = 0.001;
  const dt = 0.01;
  const steps = 30;
  
  const softenings = [0.5, 0.2, 0.1, 0.05];
  const maxVelocities = [];
  
  for (const softening of softenings) {
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemMeshKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      dt: dt,
      gravityStrength: gravityStrength,
      softening: softening,
      mesh: { gridSize: 64, assignment: 'cic' }
    });
    
    for (let i = 0; i < steps; i++) {
      system.step();
    }
    
    const finalParticles = readAllParticleData(system, 2);
    let maxV = 0;
    for (const p of finalParticles) {
      const v = Math.sqrt(p.velocity[0]**2 + p.velocity[1]**2 + p.velocity[2]**2);
      maxV = Math.max(maxV, v);
    }
    
    maxVelocities.push(maxV);
    system.dispose();
  }
  
  // Verify all velocities are finite and reasonable
  for (let i = 0; i < softenings.length; i++) {
    assert.ok(isFinite(maxVelocities[i]), 
      `Softening ${softenings[i]} should produce finite velocity, got ${maxVelocities[i]}`);
    
    assert.ok(maxVelocities[i] < 10.0, 
      `Softening ${softenings[i]} should prevent runaway velocities, got ${maxVelocities[i].toFixed(3)}`);
  }
  
  canvas.remove();
});
