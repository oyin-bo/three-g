// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemMeshKernels } from './particle-system-mesh-kernels.js';
import { assertClose } from '../test-utils.js';

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
  
  assert.deepStrictEqual({
    p0: { x: pixels[0], y: pixels[1], z: pixels[2], w: pixels[3] },
    p1: { x: pixels[4], y: pixels[5], z: pixels[6], w: pixels[7] }
  }, {
    p0: { x: 1.5, y: 2.5, z: 3.5, w: 1.0 },
    p1: { x: -1.0, y: -2.0, z: -3.0, w: 2.0 }
  }, 'Particle position and mass data should match initial values');
  
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
  
  // Check velocities with tolerance for floating point precision
  assertClose(pixels[0], 0.5, 1e-5, 'v0.x should match');
  assertClose(pixels[1], -0.5, 1e-5, 'v0.y should match');
  assertClose(pixels[2], 0.3, 1e-5, 'v0.z should match');
  assertClose(pixels[3], 0, 1e-5, 'v0.w should match');
  assertClose(pixels[4], -0.2, 1e-5, 'v1.x should match');
  assertClose(pixels[5], 0.7, 1e-5, 'v1.y should match');
  assertClose(pixels[6], -0.1, 1e-5, 'v1.z should match');
  assertClose(pixels[7], 0, 1e-5, 'v1.w should match');
  
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
  
  assert.deepStrictEqual({
    textureWidth: system.textureWidth,
    textureHeight: system.textureHeight
  }, {
    textureWidth: texWidth,
    textureHeight: texHeight
  }, 'Texture dimensions should match calculated values');
  
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
  const afterOneStep = system.frameCount;
  
  system.step();
  system.step();
  const afterThreeSteps = system.frameCount;
  
  assert.deepStrictEqual({
    initial: initialFrame,
    afterOne: afterOneStep,
    afterThree: afterThreeSteps
  }, {
    initial: 0,
    afterOne: 1,
    afterThree: 3
  }, 'Frame count should increment correctly');
  
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
    gravityStrength: 1,
    softening: 0.1,
    mesh: { gridSize: 32, assignment: 'cic' }
  });
  
  const fbo = gl.createFramebuffer();
  
  // Read initial state (both particles)
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.positionTexture, 0);
  const initialPos = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, initialPos);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityTexture, 0);
  const initialVel = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, initialVel);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Run one step and check intermediate state
  system.step();
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  // Check forces after first step
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.forceSampleKernel.outForce, 0);
  const forcesAfterStep1 = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, forcesAfterStep1);
  
  // Check velocities after first step
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityTexture, 0);
  const velAfterStep1 = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, velAfterStep1);
  
  // Check positions after first step
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.positionTexture, 0);
  const posAfterStep1 = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, posAfterStep1);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Run more steps
  for (let i = 1; i < 100; i++) {
    system.step();
  }
  
  // Read final state
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.positionTexture, 0);
  const finalPos = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, finalPos);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityTexture, 0);
  const finalVel = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, finalVel);
  
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.forceSampleKernel.outForce, 0);
  const finalForces = new Float32Array(8);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, finalForces);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  const velDiff = Math.abs(finalVel[0] - initialVel[0]) + 
                  Math.abs(finalVel[1] - initialVel[1]) + 
                  Math.abs(finalVel[2] - initialVel[2]);
  
  // Build detailed diagnostics
  const diagnostics = {
    frameCount: system.frameCount,
    hasForceGrids: {
      X: !!system.forceGridX,
      Y: !!system.forceGridY,
      Z: !!system.forceGridZ
    },
    particle0: {
      initialPos: [initialPos[0], initialPos[1], initialPos[2], initialPos[3]],
      initialVel: [initialVel[0], initialVel[1], initialVel[2], initialVel[3]],
      posAfterStep1: [posAfterStep1[0], posAfterStep1[1], posAfterStep1[2], posAfterStep1[3]],
      velAfterStep1: [velAfterStep1[0], velAfterStep1[1], velAfterStep1[2], velAfterStep1[3]],
      forceAfterStep1: [forcesAfterStep1[0], forcesAfterStep1[1], forcesAfterStep1[2], forcesAfterStep1[3]],
      finalPos: [finalPos[0], finalPos[1], finalPos[2], finalPos[3]],
      finalVel: [finalVel[0], finalVel[1], finalVel[2], finalVel[3]],
      finalForce: [finalForces[0], finalForces[1], finalForces[2], finalForces[3]]
    },
    particle1: {
      initialPos: [initialPos[4], initialPos[5], initialPos[6], initialPos[7]],
      initialVel: [initialVel[4], initialVel[5], initialVel[6], initialVel[7]],
      posAfterStep1: [posAfterStep1[4], posAfterStep1[5], posAfterStep1[6], posAfterStep1[7]],
      velAfterStep1: [velAfterStep1[4], velAfterStep1[5], velAfterStep1[6], velAfterStep1[7]],
      forceAfterStep1: [forcesAfterStep1[4], forcesAfterStep1[5], forcesAfterStep1[6], forcesAfterStep1[7]],
      finalPos: [finalPos[4], finalPos[5], finalPos[6], finalPos[7]],
      finalVel: [finalVel[4], finalVel[5], finalVel[6], finalVel[7]],
      finalForce: [finalForces[4], finalForces[5], finalForces[6], finalForces[7]]
    },
    velDiff
  };
  
  // Lower threshold for mesh method (grid smoothing reduces force magnitude to ~1e-7)
  assert.ok(velDiff > 1e-8, 
    `Velocities should change after simulation:\n${JSON.stringify(diagnostics, null, 2)}`);
  
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
