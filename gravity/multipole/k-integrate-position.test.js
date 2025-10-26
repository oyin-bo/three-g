// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';

import { assertAllFinite, assertClose, createTestTexture, disposeKernel, getGL, readTexture, resetGL } from '../test-utils.js';
import { KIntegratePosition } from './k-integrate-position.js';

/**
 * Test 1: Zero velocity - position should not change
 */
test('KIntegratePosition: zero velocity', async () => {
  const gl = getGL();

  const width = 2;
  const height = 2;

  const posData = new Float32Array([
    1.0, 2.0, 3.0, 1.0,
    4.0, 5.0, 6.0, 1.0,
    7.0, 8.0, 9.0, 1.0,
    10.0, 11.0, 12.0, 1.0
  ]);

  const velData = new Float32Array([
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0,
    0.0, 0.0, 0.0, 0.0
  ]);

  const posTex = createTestTexture(gl, width, height, posData);
  const velTex = createTestTexture(gl, width, height, velData);
  const outTex = createTestTexture(gl, width, height, null);

  const kernel = new KIntegratePosition({
    gl,
    inPosition: posTex,
    inVelocity: velTex,
    outPosition: outTex,
    width,
    height,
    dt: 1.0
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // Position should remain unchanged (displacement should be zero)
  assertClose(snapshot.outPosition.x.mean, snapshot.position.x.mean, 1e-5,
    `Position should not change with zero velocity\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Constant velocity - position += velocity * dt
 */
test('KIntegratePosition: constant velocity', async () => {
  const gl = getGL();

  const width = 1;
  const height = 1;

  const posData = new Float32Array([1.0, 2.0, 3.0, 1.0]);
  const velData = new Float32Array([0.5, 0.5, 0.5, 0.0]);

  const posTex = createTestTexture(gl, width, height, posData);
  const velTex = createTestTexture(gl, width, height, velData);
  const outTex = createTestTexture(gl, width, height, null);

  const dt = 0.1;

  const kernel = new KIntegratePosition({
    gl,
    inPosition: posTex,
    inVelocity: velTex,
    outPosition: outTex,
    width,
    height,
    dt
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });

  // position += velocity * dt
  // (1.0, 2.0, 3.0) + (0.5, 0.5, 0.5) * 0.1 = (1.05, 2.05, 3.05)
  assertClose(snapshot.outPosition.x.mean, 1.05, 1e-5,
    `Position x should be 1.05\n\n${kernel.toString()}`);
  assertClose(snapshot.outPosition.y.mean, 2.05, 1e-5,
    `Position y should be 2.05\n\n${kernel.toString()}`);
  assertClose(snapshot.outPosition.z.mean, 3.05, 1e-5,
    `Position z should be 3.05\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Varying velocities across particles
 */
test('KIntegratePosition: varying velocities', async () => {
  const gl = getGL();

  const width = 2;
  const height = 2;

  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    1.0, 1.0, 1.0, 2.0,
    -1.0, -1.0, -1.0, 1.5,
    5.0, 5.0, 5.0, 3.0
  ]);

  const velData = new Float32Array([
    1.0, 0.0, 0.0, 0.0,  // velocity in +x
    0.0, 2.0, 0.0, 0.0,  // velocity in +y
    0.0, 0.0, 3.0, 0.0,  // velocity in +z
    -1.0, -1.0, -1.0, 0.0 // velocity in -x,-y,-z
  ]);

  const posTex = createTestTexture(gl, width, height, posData);
  const velTex = createTestTexture(gl, width, height, velData);
  const outTex = createTestTexture(gl, width, height, null);

  const dt = 1.0;

  const kernel = new KIntegratePosition({
    gl,
    inPosition: posTex,
    inVelocity: velTex,
    outPosition: outTex,
    width,
    height,
    dt
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: true });

  // Particle 0: (0,0,0) + (1,0,0)*1 = (1,0,0)
  assertClose(snapshot.outPosition.pixels[0].x, 1.0, 1e-5,
    `Particle 0 x\n\n${kernel.toString()}`);

  // Particle 1: (1,1,1) + (0,2,0)*1 = (1,3,1)
  assertClose(snapshot.outPosition.pixels[1].y, 3.0, 1e-5,
    `Particle 1 y\n\n${kernel.toString()}`);

  // Particle 2: (-1,-1,-1) + (0,0,3)*1 = (-1,-1,2)
  assertClose(snapshot.outPosition.pixels[2].z, 2.0, 1e-5,
    `Particle 2 z\n\n${kernel.toString()}`);

  // Particle 3: (5,5,5) + (-1,-1,-1)*1 = (4,4,4)
  assertClose(snapshot.outPosition.pixels[3].x, 4.0, 1e-5,
    `Particle 3 x\n\n${kernel.toString()}`);
  assertClose(snapshot.outPosition.pixels[3].y, 4.0, 1e-5,
    `Particle 3 y\n\n${kernel.toString()}`);
  assertClose(snapshot.outPosition.pixels[3].z, 4.0, 1e-5,
    `Particle 3 z\n\n${kernel.toString()}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 4: dt scaling - larger dt means more motion
 */
test('KIntegratePosition: dt scaling', async () => {
  const gl = getGL();

  const width = 1;
  const height = 1;

  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const velData = new Float32Array([1.0, 1.0, 1.0, 0.0]);

  const posTex = createTestTexture(gl, width, height, posData);
  const velTex = createTestTexture(gl, width, height, velData);
  const outTex1 = createTestTexture(gl, width, height, null);
  const outTex2 = createTestTexture(gl, width, height, null);

  // Small dt
  const kernel1 = new KIntegratePosition({
    gl,
    inPosition: posTex,
    inVelocity: velTex,
    outPosition: outTex1,
    width,
    height,
    dt: 0.1
  });

  kernel1.run();
  const result1 = readTexture(gl, outTex1, width, height);

  // Large dt (10x)
  const kernel2 = new KIntegratePosition({
    gl,
    inPosition: posTex,
    inVelocity: velTex,
    outPosition: outTex2,
    width,
    height,
    dt: 1.0
  });

  kernel2.run();
  const result2 = readTexture(gl, outTex2, width, height);

  // Small dt: (0,0,0) + (1,1,1)*0.1 = (0.1,0.1,0.1)
  assertClose(result1[0], 0.1, 1e-5, 'Small dt x');
  assertClose(result1[1], 0.1, 1e-5, 'Small dt y');
  assertClose(result1[2], 0.1, 1e-5, 'Small dt z');

  // Large dt: (0,0,0) + (1,1,1)*1.0 = (1,1,1)
  assertClose(result2[0], 1.0, 1e-5, 'Large dt x');
  assertClose(result2[1], 1.0, 1e-5, 'Large dt y');
  assertClose(result2[2], 1.0, 1e-5, 'Large dt z');

  // Result2 should be 10x larger than result1
  assertClose(result2[0] / result1[0], 10.0, 1e-4, 'Ratio x');
  assertClose(result2[1] / result1[1], 10.0, 1e-4, 'Ratio y');
  assertClose(result2[2] / result1[2], 10.0, 1e-4, 'Ratio z');

  disposeKernel(kernel1);
  disposeKernel(kernel2);
  resetGL();
});

/**
 * Test 5: Negative velocities - particles can move backward
 */
test('KIntegratePosition: negative velocities', async () => {
  const gl = getGL();

  const width = 2;
  const height = 1;

  const posData = new Float32Array([
    10.0, 10.0, 10.0, 1.0,
    5.0, 5.0, 5.0, 1.0
  ]);

  const velData = new Float32Array([
    -5.0, -5.0, -5.0, 0.0,
    -2.5, -2.5, -2.5, 0.0
  ]);

  const posTex = createTestTexture(gl, width, height, posData);
  const velTex = createTestTexture(gl, width, height, velData);
  const outTex = createTestTexture(gl, width, height, null);

  const dt = 1.0;

  const kernel = new KIntegratePosition({
    gl,
    inPosition: posTex,
    inVelocity: velTex,
    outPosition: outTex,
    width,
    height,
    dt
  });

  kernel.run();

  const result = readTexture(gl, outTex, width, height);

  // Particle 0: (10,10,10) + (-5,-5,-5)*1 = (5,5,5)
  assertClose(result[0], 5.0, 1e-5, 'Particle 0 x');
  assertClose(result[1], 5.0, 1e-5, 'Particle 0 y');
  assertClose(result[2], 5.0, 1e-5, 'Particle 0 z');

  // Particle 1: (5,5,5) + (-2.5,-2.5,-2.5)*1 = (2.5,2.5,2.5)
  assertClose(result[4], 2.5, 1e-5, 'Particle 1 x');
  assertClose(result[5], 2.5, 1e-5, 'Particle 1 y');
  assertClose(result[6], 2.5, 1e-5, 'Particle 1 z');

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 6: Large particle count
 */
test('KIntegratePosition: large particle count', async () => {
  const gl = getGL();

  const width = 32;
  const height = 32;
  const particleCount = width * height;

  const posData = new Float32Array(particleCount * 4);
  const velData = new Float32Array(particleCount * 4);

  // Initialize particles in a grid
  for (let i = 0; i < particleCount; i++) {
    posData[i * 4 + 0] = (i % width) / width;
    posData[i * 4 + 1] = Math.floor(i / width) / height;
    posData[i * 4 + 2] = 0.0;
    posData[i * 4 + 3] = 1.0;

    velData[i * 4 + 0] = 0.01;
    velData[i * 4 + 1] = 0.01;
    velData[i * 4 + 2] = 0.01;
    velData[i * 4 + 3] = 0.0;
  }

  const posTex = createTestTexture(gl, width, height, posData);
  const velTex = createTestTexture(gl, width, height, velData);
  const outTex = createTestTexture(gl, width, height, null);

  const dt = 1.0;

  const kernel = new KIntegratePosition({
    gl,
    inPosition: posTex,
    inVelocity: velTex,
    outPosition: outTex,
    width,
    height,
    dt
  });

  kernel.run();

  const result = readTexture(gl, outTex, width, height);

  assertAllFinite(result, 'Result must be finite');

  // Check first particle: (0,0,0) + (0.01,0.01,0.01)*1 = (0.01,0.01,0.01)
  assertClose(result[0], 0.01, 1e-5, 'First particle x');
  assertClose(result[1], 0.01, 1e-5, 'First particle y');
  assertClose(result[2], 0.01, 1e-5, 'First particle z');

  // Check last particle
  const lastIdx = (particleCount - 1) * 4;
  const expectedX = (particleCount - 1) % width / width + 0.01;
  const expectedY = Math.floor((particleCount - 1) / width) / height + 0.01;
  assertClose(result[lastIdx + 0], expectedX, 1e-4, 'Last particle x');
  assertClose(result[lastIdx + 1], expectedY, 1e-4, 'Last particle y');
  assertClose(result[lastIdx + 2], 0.01, 1e-5, 'Last particle z');

  // Verify all masses unchanged
  for (let i = 0; i < particleCount; i++) {
    assertClose(result[i * 4 + 3], 1.0, 1e-5, `Particle ${i} mass`);
  }

  disposeKernel(kernel);
  resetGL();
});
