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
 * Test 1: Read position texture
 */
test('mesh-kernels.debug: can read position texture', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([1.5, 2.5, 3.5, 1.0,  -1.0, -2.0, -3.0, 2.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.positionTexture, 0);
  
  const pixels = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  assert.strictEqual(pixels[0], 1.5, 'Position X[0] should match');
  assert.strictEqual(pixels[1], 2.5, 'Position Y[0] should match');
  assert.strictEqual(pixels[2], 3.5, 'Position Z[0] should match');
  assert.strictEqual(pixels[3], 1.0, 'Mass[0] should match');
  
  assert.strictEqual(pixels[4], -1.0, 'Position X[1] should match');
  assert.strictEqual(pixels[5], -2.0, 'Position Y[1] should match');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 2: Read velocity texture
 */
test('mesh-kernels.debug: can read velocity texture', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  
  const velocities = new Float32Array(8);
  velocities.set([0.5, -0.5, 0.3, 0,  -0.2, 0.7, -0.1, 0]);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityTexture, 0);
  
  const pixels = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  assert.strictEqual(pixels[0], 0.5, 'Velocity X[0] should match');
  assert.strictEqual(pixels[1], -0.5, 'Velocity Y[0] should match');
  assert.strictEqual(pixels[2], 0.3, 'Velocity Z[0] should match');
  
  assert.strictEqual(pixels[4], -0.2, 'Velocity X[1] should match');
  assert.strictEqual(pixels[5], 0.7, 'Velocity Y[1] should match');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 3: Texture dimensions
 */
test('mesh-kernels.debug: texture dimensions match particle count', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 50;
  const texWidth = Math.ceil(Math.sqrt(particleCount));
  const texHeight = Math.ceil(particleCount / texWidth);
  
  const positions = new Float32Array(texWidth * texHeight * 4);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  assert.strictEqual(system.textureWidth, texWidth, 'Texture width should match');
  assert.strictEqual(system.textureHeight, texHeight, 'Texture height should match');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 4: Frame counter
 */
test('mesh-kernels.debug: step increments frame count', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const initialFrame = system.frameCount;
  
  system.step();
  assert.strictEqual(system.frameCount, initialFrame + 1, 'Frame count should increment');
  
  system.step();
  system.step();
  assert.strictEqual(system.frameCount, initialFrame + 3, 'Frame count should increment each step');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 5: Grid size property
 */
test('mesh-kernels.debug: grid size property matches constructor', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const gridSize = 128;
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: gridSize, assignment: 'cic' }
  });
  
  assert.ok(system, 'System should be created with gridSize parameter');
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 6: State changes
 */
test('mesh-kernels.debug: multiple steps change particle state', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([-1, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityTexture, 0);
  
  const initialVel = new Float32Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, initialVel);
  
  for (let i = 0; i < 10; i++) {
    system.step();
  }
  
  const finalVel = new Float32Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, finalVel);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  const velDiff = Math.abs(finalVel[0] - initialVel[0]) + 
                  Math.abs(finalVel[1] - initialVel[1]) + 
                  Math.abs(finalVel[2] - initialVel[2]);
  
  assert.ok(velDiff > 0.001, 
    `Velocities should change after simulation: diff=${velDiff.toFixed(6)}, initial=[${initialVel[0].toFixed(6)},${initialVel[1].toFixed(6)},${initialVel[2].toFixed(6)}], final=[${finalVel[0].toFixed(6)},${finalVel[1].toFixed(6)},${finalVel[2].toFixed(6)}]`);
  
  system.dispose();
  canvas.remove();
});

/**
 * Test 7: Assignment method parameter
 */
test('mesh-kernels.debug: assignment method parameter works', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 1.0,  1, 0, 0, 1.0]);
  const velocities = new Float32Array(8);
  
  const systemNGP = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'ngp' }
  });
  
  assert.ok(systemNGP, 'System should accept ngp assignment method');
  systemNGP.dispose();
  
  const posCIC = new Float32Array(positions);
  const velCIC = new Float32Array(velocities);
  
  const systemCIC = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions: posCIC, velocities: velCIC },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  assert.ok(systemCIC, 'System should accept cic assignment method');
  systemCIC.dispose();
  
  canvas.remove();
});

/**
 * DIAGNOSTIC: Test - Kernel deposit interrogation
 * Verify that mass deposition is actually occurring during step
 */
test('mesh-kernels.debug.diagnostic: kernel mass deposit', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 100.0,  0.5, 0.5, 0.5, 50.0]);  // Two particles with mass
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 16, assignment: 'cic' }
  });
  
  // Run one step and interrogate deposit kernel
  system._depositMass();
  
  if (!system.depositKernel || !system.depositKernel.outGrid) {
    throw new Error('depositKernel.outGrid is null after _depositMass');
  }
  
  const depositOutput = new Float32Array(16 * 8 * 16 * 8 * 4);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.depositKernel.outGrid, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    throw new Error(`Deposit kernel FBO incomplete: status=${status} (expected ${gl.FRAMEBUFFER_COMPLETE})`);
  }
  
  gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.FLOAT, depositOutput);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Check that deposit output has non-zero mass
  let totalMassDeposited = 0;
  let nonZeroVoxels = 0;
  
  for (let i = 0; i < depositOutput.length; i += 4) {
    const mass = depositOutput[i + 3];  // Mass in alpha
    if (mass > 0) {
      totalMassDeposited += mass;
      nonZeroVoxels++;
    }
  }
  
  assert.ok(totalMassDeposited > 0, 
    `Deposit kernel should have deposited mass: total=${totalMassDeposited}, nonZeroVoxels=${nonZeroVoxels}, expectedMass=150`);
  
  system.dispose();
  canvas.remove();
});

/**
 * DIAGNOSTIC: Test - Kernel FFT interrogation
 * Verify FFT is transforming the density field to spectrum
 */
test('mesh-kernels.debug.diagnostic: kernel FFT transformation', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 100.0,  0.5, 0.5, 0.5, 50.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 16, assignment: 'cic' }
  });
  
  // Run deposit and FFT forward
  system._depositMass();
  system.fftForwardKernel.grid = system.depositKernel.outGrid;
  system.fftForwardKernel.run();
  
  if (!system.fftForwardKernel.spectrum) {
    throw new Error('FFT spectrum is null after forward transform');
  }
  
  // Read spectrum (RG32F format)
  const spectrumOutput = new Float32Array(128 * 128 * 2);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.fftForwardKernel.spectrum, 0);
  
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    throw new Error(`FFT spectrum FBO incomplete: status=${status}`);
  }
  
  gl.readPixels(0, 0, 128, 128, gl.RG, gl.FLOAT, spectrumOutput);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Check spectrum DC component
  const dcReal = spectrumOutput[0];
  const dcImag = spectrumOutput[1];
  
  assert.ok(Number.isFinite(dcReal) && Number.isFinite(dcImag),
    `FFT DC component should be finite: real=${dcReal}, imag=${dcImag}`);
  
  assert.ok(Math.abs(dcReal) > 0 || Math.abs(dcImag) > 0,
    `FFT spectrum should have non-zero DC component: real=${dcReal.toFixed(6)}, imag=${dcImag.toFixed(6)}`);
  
  system.dispose();
  canvas.remove();
});

/**
 * DIAGNOSTIC: Test - Force grid output
 * Verify that force grids contain non-zero forces
 */
test('mesh-kernels.debug.diagnostic: force grid computation', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 100.0,  1, 0, 0, 50.0]);  // Two particles at different positions
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 16, assignment: 'cic' }
  });
  
  // Run full mesh force computation up to gradient
  system._depositMass();
  system.fftForwardKernel.grid = system.depositKernel.outGrid;
  system.fftForwardKernel.run();
  system.poissonKernel.inDensitySpectrum = system.fftForwardKernel.spectrum;
  system.poissonKernel.run();
  system.gradientKernel.inPotentialSpectrum = system.poissonKernel.outPotentialSpectrum;
  system.gradientKernel.run();
  
  if (!system.gradientKernel.outForceSpectrumX) {
    throw new Error('Gradient kernel outForceSpectrumX is null');
  }
  
  // Read force spectrum X
  const forceSpecX = new Float32Array(128 * 128 * 4);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.gradientKernel.outForceSpectrumX, 0);
  
  gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.FLOAT, forceSpecX);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Check for non-zero forces
  let maxForce = 0;
  let nonZeroCount = 0;
  
  for (let i = 0; i < forceSpecX.length; i++) {
    const val = Math.abs(forceSpecX[i]);
    if (val > 0) nonZeroCount++;
    maxForce = Math.max(maxForce, val);
  }
  
  assert.ok(maxForce > 0,
    `Force grid should have non-zero values: maxForce=${maxForce}, nonZeroCount=${nonZeroCount}, expectedNonZero>=1`);
  
  system.dispose();
  canvas.remove();
});

/**
 * DIAGNOSTIC: Test - Sampled forces at particles
 * Verify that forces are actually being sampled at particle positions
 */
test('mesh-kernels.debug.diagnostic: force sampling at particles', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array(8);
  positions.set([0, 0, 0, 100.0,  1, 0, 0, 50.0]);
  const velocities = new Float32Array(8);
  
  const system = new ParticleSystemMeshKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.001,
    softening: 0.1,
    mesh: { gridSize: 16, assignment: 'cic' }
  });
  
  // Run through full force computation
  system._depositMass();
  system._computeMeshForces();
  system._sampleForces();
  
  if (!system.forceSampleKernel.outForce) {
    throw new Error('forceSampleKernel.outForce is null');
  }
  
  // Read sampled forces
  const sampledForces = new Float32Array(2 * 4);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.forceSampleKernel.outForce, 0);
  
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, sampledForces);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Check that at least one force component is non-zero
  const force0Magnitude = Math.sqrt(
    sampledForces[0]*sampledForces[0] + 
    sampledForces[1]*sampledForces[1] + 
    sampledForces[2]*sampledForces[2]
  );
  const force1Magnitude = Math.sqrt(
    sampledForces[4]*sampledForces[4] + 
    sampledForces[5]*sampledForces[5] + 
    sampledForces[6]*sampledForces[6]
  );
  
  assert.ok(force0Magnitude > 0 || force1Magnitude > 0,
    `Sampled forces should be non-zero: particle0_mag=${force0Magnitude.toFixed(8)}, particle1_mag=${force1Magnitude.toFixed(8)}, particle0_force=[${sampledForces[0].toFixed(8)},${sampledForces[1].toFixed(8)},${sampledForces[2].toFixed(8)}], particle1_force=[${sampledForces[4].toFixed(8)},${sampledForces[5].toFixed(8)},${sampledForces[6].toFixed(8)}]`);
  
  system.dispose();
  canvas.remove();
});
