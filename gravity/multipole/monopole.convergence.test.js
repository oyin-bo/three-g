// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';
import { GravityMonopole } from './gravity-monopole.js';

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
 * @param {GravityMonopole} system
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

    const system = new GravityMonopole({
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

  const system = new GravityMonopole({
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

  system.dispose();
  canvas.remove();

  const posChanged = Math.abs(final.p0.position[0] - initial.p0.position[0]) > 1e-6;
  const velChanged = Math.abs(final.p0.velocity[0] - initial.p0.velocity[0]) > 1e-6;

  /** @type {(vec: number[]) => string} */
  const formatVec = (vec) => `[${vec.map((v) => v.toFixed(3)).join(',')}]`;

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
 * Test 2a: Theta parameter with stronger gravity
 */
test('monopole-kernels.convergence: theta parameter affects results (strong gravity)', async () => {
  // Test with clustered particles where theta affects force calculation
  // Use stronger gravity to get measurable differences
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
  for (let i = 0; i < particleCount - 1; i++) {
    const theta = random() * 2 * Math.PI;
    const phi = Math.acos(2 * random() - 1);
    const r = random() * 0.3;

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

  // Test particle at [3, 0, 0]
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
  const diagnostics = {
    initialTestParticle: /** @type {{pos: number[], vel: number[]} | null} */ (null),
    clusterBounds: { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] },
    stepData: /** @type {Array<{step: number, pos: number[], vel: number[], speed: number}>} */ ([]),
    systemDt: 0
  };

  for (let thetaIdx = 0; thetaIdx < thetaValues.length; thetaIdx++) {
    const theta = thetaValues[thetaIdx];
    const { canvas, gl } = createTestCanvas();

    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);

    // Capture initial state
    if (thetaIdx === 0) {
      diagnostics.initialTestParticle = {
        pos: [pos[testIdx * 4], pos[testIdx * 4 + 1], pos[testIdx * 4 + 2]],
        vel: [vel[testIdx * 4], vel[testIdx * 4 + 1], vel[testIdx * 4 + 2]]
      };
      for (let i = 0; i < particleCount - 1; i++) {
        for (let d = 0; d < 3; d++) {
          diagnostics.clusterBounds.min[d] = Math.min(diagnostics.clusterBounds.min[d], pos[i * 4 + d]);
          diagnostics.clusterBounds.max[d] = Math.max(diagnostics.clusterBounds.max[d], pos[i * 4 + d]);
        }
      }
    }

    const system = new GravityMonopole({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-7, -7, -7], max: [7, 7, 7] },
      dt: 0.01,
      gravityStrength: 0.1,  // 100x stronger than weak version
      softening: 0.1,
      theta: theta
    });

    if (thetaIdx === 0) {
      diagnostics.systemDt = system.options.dt;
    }

    // Run simulation (50 steps = 0.5s)
    for (let step = 0; step < 50; step++) {
      system.step();

      if (thetaIdx === 0) { // Only capture for first theta
        const stepData = readParticleData(system, testIdx);
        if (step < 5 || step % 10 === 9 || step === 49) { // First 5, then every 10, plus last
          diagnostics.stepData.push({
            step: step + 1,
            pos: [stepData.position[0], stepData.position[1], stepData.position[2]],
            vel: [stepData.velocity[0], stepData.velocity[1], stepData.velocity[2]],
            speed: Math.sqrt(stepData.velocity[0] ** 2 + stepData.velocity[1] ** 2 + stepData.velocity[2] ** 2)
          });
        }
      }
    }

    const finalData = readParticleData(system, testIdx);
    testParticleFinalX.push(finalData.position[0]);

    system.dispose();
    canvas.remove();
  }

  // Lower theta (more accurate) should give different result than higher theta
  const diff_high_mid = Math.abs(testParticleFinalX[1] - testParticleFinalX[0]);
  const diff_mid_low = Math.abs(testParticleFinalX[2] - testParticleFinalX[1]);
  const maxDiff = Math.max(diff_high_mid, diff_mid_low);

  // With strong gravity, particle should move measurably
  const particleMoved = Math.abs(testParticleFinalX[0] - 3.0) > 0.01;

  if (!particleMoved) {
    const stepDataStr = diagnostics.stepData.map(d =>
      `Step ${d.step}: pos=[${d.pos.map(v => v.toFixed(6)).join(',')}] vel=[${d.vel.map(v => v.toFixed(6)).join(',')}] speed=${d.speed.toFixed(6)}`
    ).join('\n    ');

    const failMsg = [
      'STRONG_GRAVITY_TEST_FAILURE',
      `cluster_bounds: x=[${diagnostics.clusterBounds.min[0].toFixed(2)}, ${diagnostics.clusterBounds.max[0].toFixed(2)}]`,
      `initial_test_particle: pos=[${diagnostics.initialTestParticle?.pos.map(v => v.toFixed(2)).join(',')}]`,
      `final_positions: theta=0.9→${testParticleFinalX[0].toFixed(6)}, theta=0.5→${testParticleFinalX[1].toFixed(6)}, theta=0.2→${testParticleFinalX[2].toFixed(6)}`,
      `displacement: theta=0.9→${(testParticleFinalX[0] - 3.0).toFixed(6)}`,
      `step_by_step_data_theta=0.9:`,
      stepDataStr
    ].join('\n');

    assert.fail(failMsg);
  }

  // Theta should cause at least 0.1% difference in final position
  assert.ok(maxDiff > 0.001,
    `Theta should affect results: theta=0.9→${testParticleFinalX[0].toFixed(6)}, 0.5→${testParticleFinalX[1].toFixed(6)}, 0.2→${testParticleFinalX[2].toFixed(6)}, diff=${maxDiff.toFixed(6)}`);
});

/**
 * Test 2b: Theta parameter with more simulation steps
 */
test('monopole-kernels.convergence: theta parameter affects results (long simulation)', async () => {
  // Test with clustered particles over extended time
  // More steps allow subtle differences to accumulate
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
  for (let i = 0; i < particleCount - 1; i++) {
    const theta = random() * 2 * Math.PI;
    const phi = Math.acos(2 * random() - 1);
    const r = random() * 0.3;

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

  // Test particle at [3, 0, 0]
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

    const system = new GravityMonopole({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-7, -7, -7], max: [7, 7, 7] },
      dt: 0.01,
      gravityStrength: 0.001,
      softening: 0.1,
      theta: theta
    });

    // Run simulation much longer (500 steps = 5s)
    for (let i = 0; i < 500; i++) {
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
  const maxDiff = Math.max(diff_high_mid, diff_mid_low);

  // With 10x more steps, particle should move more
  const particleMoved = Math.abs(testParticleFinalX[0] - 3.0) > 0.001;
  assert.ok(particleMoved, `Particle should move over 500 steps: ${testParticleFinalX[0].toFixed(6)} vs 3.0`);

  // Theta differences should accumulate over time
  assert.ok(maxDiff > 0.0001,
    `Theta should affect results over long simulation: theta=0.9→${testParticleFinalX[0].toFixed(6)}, 0.5→${testParticleFinalX[1].toFixed(6)}, 0.2→${testParticleFinalX[2].toFixed(6)}, diff=${maxDiff.toFixed(6)}`);
});

/**
 * Test 2c: Original weak gravity test (commented - kept for reference)


/**
 * Test 3: Softening parameter validation
 */
test('monopole-kernels.convergence: softening affects close encounters', async () => {
  // Two particles with close approach
  const positions = new Float32Array(8);  // 2x2 texture = 8 floats
  positions.set([-0.5, 0, 0, 1.0, 0.5, 0, 0, 1.0]);

  const velocities = new Float32Array(8);
  velocities.set([0.2, 0, 0, 0, -0.2, 0, 0, 0]);

  const G = 0.001;
  const softeningValues = [0.01, 0.1, 0.5];
  const maxSpeeds = [];

  for (const softening of softeningValues) {
    const { canvas, gl } = createTestCanvas();

    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);

    const system = new GravityMonopole({
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

      const speed0 = Math.sqrt(p0.velocity[0] ** 2 + p0.velocity[1] ** 2 + p0.velocity[2] ** 2);
      const speed1 = Math.sqrt(p1.velocity[0] ** 2 + p1.velocity[1] ** 2 + p1.velocity[2] ** 2);

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
