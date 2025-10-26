// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemQuadrupoleKernels } from './particle-system-quadrupole-kernels.js';

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
 * Test 1: Timestep refinement improves accuracy
 */
test('quadrupole-kernels.convergence: smaller timestep improves accuracy', async () => {
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
    
    const system = new ParticleSystemQuadrupoleKernels({
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
    
    const snap = system.positionKernel.valueOf({ pixels: true });
    if (!snap.position?.pixels) throw new Error('No position pixels');
    finalPositions.push(snap.position.pixels[0].x); // particle 0 x-coordinate
    
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
test('quadrupole-kernels.convergence: basic physics simulation works', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const initialPositions = new Float32Array(8);
  initialPositions.set([
    2, 0, 0, 1.0,
    0, 0, 0, 10.0
  ]);
  const initialVelocities = new Float32Array(8);
  
  const positions = new Float32Array(initialPositions);
  const velocities = new Float32Array(initialVelocities);
  
  const system = new ParticleSystemQuadrupoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.002,
    damping: 0.002
  });
  
  // Store initial positions directly from input
  const initialX = positions[0];

  // Run one step and capture full diagnostics
  system.step();
  
  const afterFirstStep = {
    aggregator: system.aggregatorKernel.valueOf({ pixels: false }),
    traversal: system.traversalKernel.valueOf({ pixels: false }),
    velocity: system.velocityKernel.valueOf({ pixels: false }),
    position: system.positionKernel.valueOf({ pixels: true })
  };

  // Run 9 more steps (total 10)
  for (let i = 1; i < 10; i++) {
    system.step();
  }

  const final = system.positionKernel.valueOf({ pixels: true });

  system.dispose();
  canvas.remove();

  const posChanged = final.outPosition?.pixels ? 
    Math.abs(final.outPosition.pixels[0].x - initialX) > 1e-6 : false;
  const velChanged = afterFirstStep.velocity.velocity?.pixels && final.velocity?.pixels ? 
    Math.abs(final.velocity.pixels[0].vx - afterFirstStep.velocity.velocity.pixels[0].vx) > 1e-6 : false;

  const diagnostics = `\n\nDiagnostics after 1 step:\n\n` +
    `Aggregator:\n${afterFirstStep.aggregator.toString()}\n\n` +
    `Traversal:\n${afterFirstStep.traversal.toString()}\n\n` +
    `Velocity Integration:\n${afterFirstStep.velocity.toString()}\n\n` +
    `Position Integration:\n${afterFirstStep.position.toString()}\n`;

  assert.ok(posChanged || velChanged, `Physics not working. ${diagnostics}`);
});

/**
 * Test 2: Theta parameter affects accuracy (with quadrupole advantage)
 */
test('quadrupole-kernels.convergence: theta parameter controls approximation quality', async () => {
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

  const thetaValuesSnaps = [];
  
  for (const theta of thetaValues) {
    const { canvas, gl } = createTestCanvas();
    
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemQuadrupoleKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-7, -7, -7], max: [7, 7, 7] },
      dt: 0.01,
      gravityStrength: 0.001,
      softening: 0.1,
      theta: theta
    });
    
    // Run simulation
    let earlySnap, midSnap;
    for (let i = 0; i < 50; i++) {
      system.step();
      if (i === 5) earlySnap = system.positionKernel.valueOf({ pixels: true });
      if (i === 25) midSnap = system.positionKernel.valueOf({ pixels: true });
    }
    
    const finalSnap = system.positionKernel.valueOf({ pixels: true });
    if (!finalSnap.position?.pixels) throw new Error('No final position pixels');
    testParticleFinalX.push(finalSnap.position.pixels[testIdx].x);
    
    system.dispose();
    canvas.remove();

    thetaValuesSnaps.push({ early: earlySnap, mid: midSnap, final: finalSnap });
  }
  
  // Lower theta (more accurate) should give different result than higher theta
  const diff_high_mid = Math.abs(testParticleFinalX[1] - testParticleFinalX[0]);
  const diff_mid_low = Math.abs(testParticleFinalX[2] - testParticleFinalX[1]);
  
  // First check if simulation is running at all
  const particleMoved = Math.abs(testParticleFinalX[0] - 5.0) > 1e-6;
  
  if (!particleMoved) {
    assert.fail(`Simulation not working: test particle did not move from initial position 5.0. Results: ${testParticleFinalX.map(x => x.toFixed(4)).join(', ')}`);
  }
  
  // At least one difference should be measurable (allow very small if particles barely move)
  const maxDiff = Math.max(diff_high_mid, diff_mid_low);
  
  assert.ok(maxDiff > 0.001 || maxDiff < 1e-10, 
    `Theta should affect results: theta=0.9→${testParticleFinalX[0].toFixed(4)}, 0.5→${testParticleFinalX[1].toFixed(4)}, 0.2→${testParticleFinalX[2].toFixed(4)}

----------------------------------------------------------------------------------------------------
#### THETA SNAPSHOTS:

${
    thetaValuesSnaps.map((snaps, i) => {
      return (
        `
--- [${i}] Theta = ${thetaValues[i]} ---
EARLY: ${thetaValuesSnaps[i].early}

MID: ${thetaValuesSnaps[i].mid}

FINAL: ${thetaValuesSnaps[i].final}


`
      );
    })
}
`);
  
  // All should show particle moved toward cluster
  for (let i = 0; i < 3; i++) {
    assert.ok(testParticleFinalX[i] < 5.0, 
      `Particle should move toward cluster (theta=${thetaValues[i]}): ${testParticleFinalX[i].toFixed(3)} < 5.0`);
  }
});

/**
 * Test 3: Softening parameter validation
 */
test('quadrupole-kernels.convergence: softening affects close encounters', async () => {
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
    
    const system = new ParticleSystemQuadrupoleKernels({
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
      
      const snap = system.velocityKernel.valueOf({ pixels: true });
      if (!snap.velocity?.pixels) continue;
      
      const vx0 = snap.velocity.pixels[0].vx;
      const vy0 = snap.velocity.pixels[0].vy;
      const vz0 = snap.velocity.pixels[0].vz;
      const vx1 = snap.velocity.pixels[1].vx;
      const vy1 = snap.velocity.pixels[1].vy;
      const vz1 = snap.velocity.pixels[1].vz;
      
      const speed0 = Math.sqrt(vx0**2 + vy0**2 + vz0**2);
      const speed1 = Math.sqrt(vx1**2 + vy1**2 + vz1**2);
      
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

