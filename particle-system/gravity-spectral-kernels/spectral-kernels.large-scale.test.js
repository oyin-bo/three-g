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
  canvas.width = 512;
  canvas.height = 512;
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
 * @param {ParticleSystemSpectralKernels} system
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
 * Dispose system and cleanup
 * @param {ParticleSystemSpectralKernels} system
 * @param {HTMLCanvasElement} canvas
 */
function disposeSystem(system, canvas) {
  system.dispose();
  canvas.remove();
}

/**
 * Test 1: 100 particles in random distribution
 */
test('spectral-kernels.large-scale: 100 particles evolve without errors', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 100;
  const texWidth = Math.ceil(Math.sqrt(particleCount));
  const texHeight = Math.ceil(particleCount / texWidth);
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  // Random positions in sphere
  for (let i = 0; i < particleCount; i++) {
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = Math.pow(Math.random(), 1/3) * 2.0; // Uniform in volume
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0;
  }
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.1,
    gridSize: 64
  });
  
  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  // Verify all particles have valid data
  const particles = readAllParticleData(system, particleCount);
  
  // Capture system state for diagnostics
  const diagFull = '\n\n' + system.toString();
  
  for (let i = 0; i < particleCount; i++) {
    const p = particles[i];
    
    const diag = `\n      Particle ${i} snapshot:\n` +
      `        position=[${p.position.slice(0, 3).map(v => v.toFixed(4)).join(', ')}]\n` +
      `        velocity=[${p.velocity.slice(0, 3).map(v => v.toFixed(4)).join(', ')}]`;

    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(p.position[j]), `Particle ${i} position[${j}] should be finite` + diag + diagFull);
      assert.ok(isFinite(p.velocity[j]), `Particle ${i} velocity[${j}] should be finite` + diag + diagFull);
    }
    
    // Check positions are reasonable
    const r = Math.sqrt(p.position[0]**2 + p.position[1]**2 + p.position[2]**2);
    assert.ok(r < 10, `Particle ${i} should stay in reasonable bounds: r=${r.toFixed(2)}` + diag + diagFull);
  }
  
  disposeSystem(system, canvas);
});

/**
 * Test 2: 256 particles - performance and stability
 */
test('spectral-kernels.large-scale: 256 particles perform efficiently', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 256;
  const texWidth = 16; // 16x16 = 256
  const texHeight = 16;
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  // Initialize in disk configuration
  for (let i = 0; i < particleCount; i++) {
    const r = Math.sqrt(Math.random()) * 2.5;
    const theta = Math.random() * 2 * Math.PI;
    const z = (Math.random() - 0.5) * 0.5;
    
    positions[i * 4 + 0] = r * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(theta);
    positions[i * 4 + 2] = z;
    positions[i * 4 + 3] = 1.0;
    
    // Circular velocity
    const v = Math.sqrt(0.0003 * 10 / r) * 0.5; // Rough estimate
    velocities[i * 4 + 0] = -v * Math.sin(theta);
    velocities[i * 4 + 1] = v * Math.cos(theta);
    velocities[i * 4 + 2] = 0;
  }
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.008,
    gravityStrength: 0.0003,
    softening: 0.15,
    gridSize: 64
  });
  
  // Measure performance
  const startTime = performance.now();
  const numSteps = 30;
  
  for (let i = 0; i < numSteps; i++) {
    system.step();
  }
  
  const elapsed = performance.now() - startTime;
  const msPerStep = elapsed / numSteps;
  
  // Spectral method should be efficient (O(N log N))
  const diagPerf = `\n  Performance diagnostics:\n` +
    `    Elapsed ms: ${elapsed.toFixed(2)}\n` +
    `    Steps: ${numSteps}\n` +
    `    ms per step: ${msPerStep.toFixed(2)}`;

  assert.ok(msPerStep < 50, 
    `Spectral method should be efficient: ${msPerStep.toFixed(2)}ms per step` + diagPerf);
  
  // Verify stability
  const particles = readAllParticleData(system, particleCount);
  let maxSpeed = 0;
  
  for (const p of particles) {
    const speed = Math.sqrt(p.velocity[0]**2 + p.velocity[1]**2 + p.velocity[2]**2);
    maxSpeed = Math.max(maxSpeed, speed);
    
    assert.ok(isFinite(speed), 'All velocities should be finite');
  }
  
  assert.ok(maxSpeed < 5.0, `Velocities should remain reasonable: max=${maxSpeed.toFixed(3)}` + diagPerf);
  
  disposeSystem(system, canvas);
});

/**
 * Test 3: 1000 particles - stress test
 */
test('spectral-kernels.large-scale: 1000 particles remain stable', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 1000;
  const texWidth = 32; // 32x32 = 1024
  const texHeight = 32;
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  // Plummer sphere distribution
  for (let i = 0; i < particleCount; i++) {
    const rPlummer = 1.0 / Math.sqrt(Math.pow(Math.random(), -2/3) - 1);
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    
    positions[i * 4 + 0] = rPlummer * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = rPlummer * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = rPlummer * Math.cos(phi);
    positions[i * 4 + 3] = 1.0;
    
    // Small random velocities
    velocities[i * 4 + 0] = (Math.random() - 0.5) * 0.1;
    velocities[i * 4 + 1] = (Math.random() - 0.5) * 0.1;
    velocities[i * 4 + 2] = (Math.random() - 0.5) * 0.1;
  }
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-8, -8, -8], max: [8, 8, 8] },
    dt: 0.005,
    gravityStrength: 0.0002,
    softening: 0.1,
    gridSize: 128 // Higher resolution for more particles
  });
  
  // Run fewer steps for large system
  for (let i = 0; i < 20; i++) {
    system.step();
  }
  
  // Sample check (don't read all 1000 particles)
  const sampleIndices = [0, 100, 250, 500, 750, 999];
  
  for (const idx of sampleIndices) {
    const texX = idx % texWidth;
    const texY = Math.floor(idx / texWidth);
    
    const posTex = system.positionTexture;
    const velTex = system.velocityTexture;
    
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
    const posData = new Float32Array(4);
    gl.readPixels(texX, texY, 1, 1, gl.RGBA, gl.FLOAT, posData);
    
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
    const velData = new Float32Array(4);
    gl.readPixels(texX, texY, 1, 1, gl.RGBA, gl.FLOAT, velData);
    
    gl.deleteFramebuffer(fbo);
    
    // Check finite values
    const posStr = Array.from(posData.subarray(0, 3)).map(v => v.toFixed(4)).join(', ');
    const velStr = Array.from(velData.subarray(0, 3)).map(v => v.toFixed(4)).join(', ');
    const diagSample = `\n    Particle ${idx} sample:\n` +
      `      position=[${posStr}]\n` +
      `      velocity=[${velStr}]`;

    for (let j = 0; j < 3; j++) {
      assert.ok(isFinite(posData[j]), `Particle ${idx} position[${j}] should be finite` + diagSample);
      assert.ok(isFinite(velData[j]), `Particle ${idx} velocity[${j}] should be finite` + diagSample);
    }
  }
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  disposeSystem(system, canvas);
});

/**
 * Test 4: Clustering behavior in large system
 */
test('spectral-kernels.large-scale: particles cluster over time', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 200;
  const texWidth = Math.ceil(Math.sqrt(particleCount));
  const texHeight = Math.ceil(particleCount / texWidth);
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  // Spread out initial distribution
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (Math.random() - 0.5) * 6;
    positions[i * 4 + 1] = (Math.random() - 0.5) * 6;
    positions[i * 4 + 2] = (Math.random() - 0.5) * 6;
    positions[i * 4 + 3] = 1.0;
  }
  
  const system = new ParticleSystemSpectralKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-8, -8, -8], max: [8, 8, 8] },
    dt: 0.01,
    gravityStrength: 0.0005,
    softening: 0.15,
    gridSize: 64
  });
  
  // Calculate initial spread
  function calculateSpread() {
    const particles = readAllParticleData(system, particleCount);
    let sumR2 = 0;
    for (const p of particles) {
      sumR2 += p.position[0]**2 + p.position[1]**2 + p.position[2]**2;
    }
    return Math.sqrt(sumR2 / particleCount);
  }
  
  const initialSpread = calculateSpread();
  
  // Run simulation
  for (let i = 0; i < 50; i++) {
    system.step();
  }
  
  const finalSpread = calculateSpread();
  
  // Capture system state for diagnostics
  const diagFull = '\n\n' + system.toString();
  
  // System should cluster (spread should decrease)
  const diagCluster = `\n  Clustering diagnostics:\n` +
    `    Initial spread: ${initialSpread.toFixed(3)}\n` +
    `    Final spread:   ${finalSpread.toFixed(3)}`;

  assert.ok(finalSpread < initialSpread * 0.85, 
    `System should cluster: spread ${initialSpread.toFixed(3)} -> ${finalSpread.toFixed(3)}` + diagCluster + diagFull);
  
  disposeSystem(system, canvas);
});

/**
 * Test 5: Grid resolution scaling for large systems
 */
test('spectral-kernels.large-scale: higher grid resolution handles more particles', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 400;
  const texWidth = 20;
  const texHeight = 20;
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  // Dense cluster
  for (let i = 0; i < particleCount; i++) {
    const r = Math.pow(Math.random(), 1/3) * 1.5;
    const theta = Math.random() * 2 * Math.PI;
    const phi = Math.acos(2 * Math.random() - 1);
    
    positions[i * 4 + 0] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 4 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 4 + 2] = r * Math.cos(phi);
    positions[i * 4 + 3] = 1.0;
  }
  
  // Test with different grid resolutions
  const gridSizes = [32, 64, 128];
  const maxSpeeds = [];
  
  for (const gridSize of gridSizes) {
    const pos = new Float32Array(positions);
    const vel = new Float32Array(velocities);
    
    const system = new ParticleSystemSpectralKernels({
      gl,
      particleData: { positions: pos, velocities: vel },
      worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
      dt: 0.01,
      gravityStrength: 0.0005,
      softening: 0.1,
      gridSize: gridSize
    });
    
    // Run simulation
    for (let i = 0; i < 20; i++) {
      system.step();
    }
    
    // Check maximum velocity
    const particles = readAllParticleData(system, particleCount);
    let maxSpeed = 0;
    for (const p of particles) {
      const speed = Math.sqrt(p.velocity[0]**2 + p.velocity[1]**2 + p.velocity[2]**2);
      maxSpeed = Math.max(maxSpeed, speed);
    }
    
    maxSpeeds.push(maxSpeed);
    system.dispose();
  }
  
  // All resolutions should produce stable results
  for (let i = 0; i < gridSizes.length; i++) {
    const diagGrid = `\n  Grid ${gridSizes[i]} diagnostics:\n` +
      `    Max velocity: ${maxSpeeds[i].toFixed(4)}\n` +
      `    Grid size: ${gridSizes[i]}`;

    assert.ok(isFinite(maxSpeeds[i]) && maxSpeeds[i] < 3.0, 
      `Grid ${gridSizes[i]} should be stable: maxSpeed=${maxSpeeds[i].toFixed(3)}` + diagGrid);
  }
  
  canvas.remove();
});
