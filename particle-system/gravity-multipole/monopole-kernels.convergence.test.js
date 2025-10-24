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
  
  if (!posTex || !velTex) {
    throw new Error('Position or velocity texture not available');
  }
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  
  // Check framebuffer status
  const posStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (posStatus !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    throw new Error(`Position framebuffer incomplete: status=${posStatus}`);
  }
  
  const posPixels = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, posPixels);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  
  // Check framebuffer status for velocity
  const velStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (velStatus !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    throw new Error(`Velocity framebuffer incomplete: status=${velStatus}`);
  }
  
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
  
  // First check if simulation is running at all
  const particleMoved = Math.abs(finalPositions[2] - initialPositions[0]) > 1e-6;
  
  if (!particleMoved) {
    // If particle didn't move, there's a fundamental issue with the simulation
    // Skip convergence test but fail with diagnostic message
    assert.fail(`Simulation not working: particle did not move. Initial=${initialPositions[0]}, final=${finalPositions[2]}`);
  }
  
  // Only check convergence if there's actual movement
  assert.ok(diff2 < diff1 || (diff1 < 1e-4 && diff2 < 1e-4), 
    `Smaller timestep should converge: diff(0.01-0.05)=${diff1.toFixed(4)}, diff(0.002-0.01)=${diff2.toFixed(4)}`);
  
  // Results should show particle moved inward
  assert.ok(finalPositions[2] < initialPositions[0], 
    `Particle should fall inward: initial=${initialPositions[0]}, final=${finalPositions[2].toFixed(3)}`);
});

/**
 * Test 1.5: Basic simulation diagnostic
 * Simple check that physics is working at all before running convergence tests
 */
test('monopole-kernels.convergence: basic physics simulation works', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const initialPositions = new Float32Array(8);
  initialPositions.set([
    2, 0, 0, 1.0,
    0, 0, 0, 10.0
  ]);
  const initialVelocities = new Float32Array(8);
  
  const positions = new Float32Array(initialPositions);
  const velocities = new Float32Array(initialVelocities);
  
  const system = new ParticleSystemMonopoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.002,
    damping: 0.002
  });
  
  const initial = {
    p0: readParticleData(system, 0),
    p1: readParticleData(system, 1),
  };

  // Run 10 steps
  for (let i = 0; i < 10; i++) {
    system.step();
  }

  const final = {
    p0: readParticleData(system, 0),
    p1: readParticleData(system, 1),
  };

  // Voxel coordinate calculation
  /** @type {(pos: number[]) => number[]} */
  const getVoxelCoords = (pos) => {
    const worldMin = system.options.worldBounds.min;
    const worldMax = system.options.worldBounds.max;
    const gridSize = system.octreeGridSize;
    const norm = pos.map((p, i) => (p - worldMin[i]) / (worldMax[i] - worldMin[i]));
    return norm.map((n) => Math.floor(n * gridSize));
  };

  const initialVoxels = {
    p0: getVoxelCoords(initial.p0.position),
    p1: getVoxelCoords(initial.p1.position),
  };

  const p0_mass = initialPositions[3];
  const p1_mass = initialPositions[7];

  // Helper: get mass at a specific level for a particle position
  /** @type {(particlePos: number[], level: number) => number} */
  const getMassAtLevel = (particlePos, level) => {
    const gl = system.gl;
    const worldMin = system.options.worldBounds.min;
    const worldMax = system.options.worldBounds.max;
    const levelConfigs = system.levelConfigs;
    
    const config = levelConfigs[level];
    const gridSize = config.gridSize;
    const slicesPerRow = config.slicesPerRow;

    const norm = particlePos.map((p, i) => (p - worldMin[i]) / (worldMax[i] - worldMin[i]));
    const voxelCoord = norm.map((n) => Math.floor(n * gridSize));

    const sliceIndex = voxelCoord[2];
    const sliceRow = Math.floor(sliceIndex / slicesPerRow);
    const sliceCol = sliceIndex % slicesPerRow;
    const texelX = sliceCol * gridSize + voxelCoord[0];
    const texelY = sliceRow * gridSize + voxelCoord[1];

    let texture;
    if (level === 0) {
      texture = system.aggregatorKernel.outA0;
    } else {
      texture = system.pyramidKernels[level - 1].outA0;
    }
    if (!texture) return NaN;

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const pixelData = new Float32Array(4);
    gl.readPixels(texelX, texelY, 1, 1, gl.RGBA, gl.FLOAT, pixelData);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return pixelData[3]; // Mass is in the 'w' component
  };

  // Detailed diagnostic: mass of each particle's voxel at each aggregation level
  const particleLevelMasses = (() => {
    let report = '\nParticle Voxel Masses per Level:\n';
    for (let level = 0; level < system.numLevels; level++) {
      const p0_mass = getMassAtLevel(initial.p0.position, level);
      const p1_mass = getMassAtLevel(initial.p1.position, level);
      report += `  Level ${level} (gridSize=${system.levelConfigs[level].gridSize}): P0 Mass=${p0_mass.toFixed(3)}, P1 Mass=${p1_mass.toFixed(3)}\n`;
    }
    return report;
  })();

  system.dispose();
  canvas.remove();

  const posChanged = Math.abs(final.p0.position[0] - initial.p0.position[0]) > 1e-6;
  const velChanged = Math.abs(final.p0.velocity[0] - initial.p0.velocity[0]) > 1e-6;

  /** @type {(vec: number[]) => string} */
  const formatVec = (vec) => `[${vec.map((v) => v.toFixed(3)).join(',')}]`;

  // Enhanced diagnostic: show texture dimensions and level configs
  const levelConfigDiag = (() => {
    let diag = '\n  Level Configuration and Mass Propagation:\n';
    for (let i = 0; i < system.numLevels; i++) {
      const config = system.levelConfigs[i];
      diag += `    Level ${i}: gridSize=${config.gridSize}, slicesPerRow=${config.slicesPerRow}, ` +
              `textureSize=${config.gridSize * config.slicesPerRow}×${config.gridSize * Math.ceil(config.gridSize / config.slicesPerRow)}\n`;
    }
    return diag;
  })();

  const massPerLevelDiag = (() => {
    let diag = '\n  Mass Propagation by Level:\n';
    for (let level = 0; level < system.numLevels; level++) {
      const p0_mass = getMassAtLevel(initial.p0.position, level);
      const p1_mass = getMassAtLevel(initial.p1.position, level);
      diag += `    Level ${level}: P0=${p0_mass.toFixed(3)}, P1=${p1_mass.toFixed(3)}`;
      
      if (level > 0 && p0_mass === 0 && getMassAtLevel(initial.p0.position, level - 1) > 0) {
        diag += ` ← MASS LOST HERE (was present at Level ${level - 1})`;
      }
      diag += '\n';
    }
    return diag;
  })();

  const report = `\n\nInitial State:\n` +
    `  P0 (mass ${p0_mass.toFixed(1)}): pos=${formatVec(initial.p0.position)}, vel=${formatVec(initial.p0.velocity)}, voxel=[${initialVoxels.p0.join(',')}]\n` +
    `  P1 (mass ${p1_mass.toFixed(1)}): pos=${formatVec(initial.p1.position)}, vel=${formatVec(initial.p1.velocity)}, voxel=[${initialVoxels.p1.join(',')}]\n` +
    `\nFinal State:\n` +
    `  P0 (mass ${p0_mass.toFixed(1)}): pos=${formatVec(final.p0.position)}, vel=${formatVec(final.p0.velocity)}\n` +
    `  P1 (mass ${p1_mass.toFixed(1)}): pos=${formatVec(final.p1.position)}, vel=${formatVec(final.p1.velocity)}\n` +
    levelConfigDiag +
    massPerLevelDiag;

  assert.ok(posChanged || velChanged, `Physics not working. ${report}`);
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
  
  // Create cluster at position [-3, 0, 0] + test particle at [3, 0, 0] 
  // This places them far enough apart that they won't be in the same near-field neighborhood
  for (let i = 0; i < particleCount - 1; i++) {
    const theta = random() * 2 * Math.PI;
    const phi = Math.acos(2 * random() - 1);
    const r = random() * 0.3;  // Smaller cluster radius
    
    // Cluster centered at [-3, 0, 0]
    positions[i * 4 + 0] = -3.0 + r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }
  
  // Test particle at [3, 0, 0] - far from cluster
  // Distance: 6 units = ~27 L0 voxels, well outside 3x3x3 near-field neighborhood
  const testIdx = particleCount - 1;
  positions[testIdx * 4 + 0] = 3.0;
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
  // theta=0.9 (coarse, fast): accepts distant approximations, less accurate
  // theta=0.2 (fine, slow): only accepts very close/small voxels, more accurate
  const diff_high_mid = Math.abs(testParticleFinalX[1] - testParticleFinalX[0]);
  const diff_mid_low = Math.abs(testParticleFinalX[2] - testParticleFinalX[1]);
  
  // First check if simulation is running at all
  // Particle should move toward cluster (leftward, toward -3)
  const particleMoved = Math.abs(testParticleFinalX[0] - 3.0) > 0.01;
  
  if (!particleMoved) {
    assert.fail(`Simulation not working: test particle did not move from initial position 3.0. Results: ${testParticleFinalX.map(x => x.toFixed(4)).join(', ')}`);
  }
  
  // At least one difference should be measurable
  // Coarser theta should allow faster convergence or different approximation quality
  const maxDiff = Math.max(diff_high_mid, diff_mid_low);
  
  assert.ok(maxDiff > 0.01, 
    `Theta should affect results: theta=0.9→${testParticleFinalX[0].toFixed(4)}, 0.5→${testParticleFinalX[1].toFixed(4)}, 0.2→${testParticleFinalX[2].toFixed(4)}`);
  
  // All should show particle moved toward cluster (leftward)
  for (let i = 0; i < 3; i++) {
    assert.ok(testParticleFinalX[i] < 3.0, 
      `Particle should move toward cluster at -3 (theta=${thetaValues[i]}): ${testParticleFinalX[i].toFixed(3)} < 3.0`);
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
  
  // First check if simulation is running at all
  const particlesAccelerated = maxSpeeds.some(s => s > 0.2);
  
  if (!particlesAccelerated) {
    assert.fail(`Simulation not working: particles did not accelerate. Max speeds: ${maxSpeeds.map(s => s.toFixed(3)).join(', ')}`);
  }
  
  // Higher softening should result in lower peak velocities (less singular force)
  assert.ok(maxSpeeds[2] < maxSpeeds[0] || maxSpeeds[2] === maxSpeeds[0], 
    `Higher softening should reduce peak velocity: soft=0.01→${maxSpeeds[0].toFixed(3)}, 0.1→${maxSpeeds[1].toFixed(3)}, 0.5→${maxSpeeds[2].toFixed(3)}`);
  
  // All should have some acceleration
  for (let i = 0; i < 3; i++) {
    assert.ok(maxSpeeds[i] > 0.2, 
      `Particles should accelerate (softening=${softeningValues[i]}): max speed=${maxSpeeds[i].toFixed(3)} > 0.2`);
  }
});
