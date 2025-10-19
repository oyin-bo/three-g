// @ts-check

/**
 * Unit tests for KIntegrateVelocity kernel.
 * Tests physics calculations: velocity update from forces, clamping, damping.
 */

import { test } from 'node:test';
import assert from 'node:assert';

import { 
  getGL, 
  createTestTexture, 
  readTexture, 
  assertClose, 
  assertAllFinite,
  disposeKernel,
  resetGL
} from '../test-utils.js';

import { KIntegrateVelocity } from './k-integrate-velocity.js';

/**
 * Helper: Create a texture filled with known values.
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @param {number} value - scalar value for all 4 components
 * @returns {WebGLTexture}
 */
function fillTexture(gl, width, height, value) {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    data[i] = value;
  }
  return createTestTexture(gl, width, height, data);
}

/**
 * Test 1: Zero force produces zero velocity change
 * With zero force, velocity should remain unchanged (no acceleration).
 */
test('KIntegrateVelocity: zero force', async () => {
  const gl = getGL();
  const width = 2, height = 2;
  
  // Initial velocity: (0.5, 0.2, 0.1, 0.0)
  const velData = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    velData[i * 4 + 0] = 0.5;     // vx
    velData[i * 4 + 1] = 0.2;     // vy
    velData[i * 4 + 2] = 0.1;     // vz
    velData[i * 4 + 3] = 0.0;     // unused
  }
  const velTex = createTestTexture(gl, width, height, velData);
  
  // Force: all zeros
  const forceTex = fillTexture(gl, width, height, 0.0);
  
  // Position: dummy (not used in this calculation, but required)
  const posTex = fillTexture(gl, width, height, 0.0);
  
  // Create output texture
  const outVelTex = createTestTexture(gl, width, height, null);
  
  // Create and run kernel
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt: 0.1,
    damping: 0.0,
    maxSpeed: 10.0,
    maxAccel: 10.0
  });
  
  kernel.run();
  
  // Read result
  const result = readTexture(gl, outVelTex, width, height);
  
  // Verify: velocity should be unchanged with zero force and no damping
  assertAllFinite(result, 'Result must be finite');
  for (let i = 0; i < width * height; i++) {
    assertClose(result[i * 4 + 0], 0.5, 1e-5, `Pixel ${i} vx`);
    assertClose(result[i * 4 + 1], 0.2, 1e-5, `Pixel ${i} vy`);
    assertClose(result[i * 4 + 2], 0.1, 1e-5, `Pixel ${i} vz`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Constant force produces linear velocity update
 * With constant force F and dt, velocity should increase by F*dt.
 * Expected: v_new = v_old + a*dt where a = F (unit mass)
 */
test('KIntegrateVelocity: constant force acceleration', async () => {
  const gl = getGL();
  const width = 2, height = 2;
  
  // Initial velocity: all zeros
  const velTex = fillTexture(gl, width, height, 0.0);
  
  // Force: constant (1.0, 2.0, 3.0) in all pixels
  const forceData = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    forceData[i * 4 + 0] = 1.0;    // fx
    forceData[i * 4 + 1] = 2.0;    // fy
    forceData[i * 4 + 2] = 3.0;    // fz
    forceData[i * 4 + 3] = 0.0;    // unused
  }
  const forceTex = createTestTexture(gl, width, height, forceData);
  
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  const dt = 0.1;
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt,
    damping: 0.0,
    maxSpeed: 10.0,
    maxAccel: 10.0
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Expected: v = f * dt = (0.1, 0.2, 0.3)
  const expectedVx = 1.0 * dt;
  const expectedVy = 2.0 * dt;
  const expectedVz = 3.0 * dt;
  
  assertAllFinite(result, 'Result must be finite');
  for (let i = 0; i < width * height; i++) {
    assertClose(result[i * 4 + 0], expectedVx, 1e-5, `Pixel ${i} vx`);
    assertClose(result[i * 4 + 1], expectedVy, 1e-5, `Pixel ${i} vy`);
    assertClose(result[i * 4 + 2], expectedVz, 1e-5, `Pixel ${i} vz`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Max acceleration clamping
 * Forces exceeding maxAccel should be clamped before integration.
 * A force of (10, 0, 0) with maxAccel=5 should be clamped to (5, 0, 0).
 */
test('KIntegrateVelocity: max acceleration clamping', async () => {
  const gl = getGL();
  const width = 1, height = 1;
  
  const velTex = fillTexture(gl, width, height, 0.0);
  
  // Force: (10, 0, 0) - magnitude 10, will be clamped to maxAccel=5
  const forceData = new Float32Array(4);
  forceData[0] = 10.0;
  forceData[1] = 0.0;
  forceData[2] = 0.0;
  forceData[3] = 0.0;
  const forceTex = createTestTexture(gl, width, height, forceData);
  
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  const dt = 0.1;
  const maxAccel = 5.0;
  
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt,
    damping: 0.0,
    maxSpeed: 10.0,
    maxAccel
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Expected: force clamped to 5.0, then v = 5.0 * dt = 0.5
  const expectedV = maxAccel * dt;
  
  assertAllFinite(result, 'Result must be finite');
  assertClose(result[0], expectedV, 1e-5, 'vx should be clamped');
  assertClose(result[1], 0.0, 1e-5, 'vy should be zero');
  assertClose(result[2], 0.0, 1e-5, 'vz should be zero');
});

/**
 * Test 4: Max speed clamping
 * Velocities exceeding maxSpeed should be clamped after integration.
 * v = (3, 4, 0) has magnitude 5, clamped to maxSpeed=4 gives (2.4, 3.2, 0).
 */
test('KIntegrateVelocity: max speed clamping', async () => {
  const gl = getGL();
  const width = 1, height = 1;
  
  // Initial velocity: (3, 4, 0) - magnitude 5
  const velData = new Float32Array(4);
  velData[0] = 3.0;
  velData[1] = 4.0;
  velData[2] = 0.0;
  velData[3] = 0.0;
  const velTex = createTestTexture(gl, width, height, velData);
  
  const forceTex = fillTexture(gl, width, height, 0.0);
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  const maxSpeed = 4.0;
  
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt: 0.1,
    damping: 0.0,
    maxSpeed,
    maxAccel: 10.0
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Expected: (3,4,0) normalized to magnitude 4 = (2.4, 3.2, 0)
  const scale = maxSpeed / 5.0;
  const expectedVx = 3.0 * scale;
  const expectedVy = 4.0 * scale;
  
  assertAllFinite(result, 'Result must be finite');
  assertClose(result[0], expectedVx, 1e-5, 'vx clamped');
  assertClose(result[1], expectedVy, 1e-5, 'vy clamped');
  assertClose(result[2], 0.0, 1e-5, 'vz should be zero');
  
  // Verify final magnitude doesn't exceed maxSpeed
  const finalMag = Math.sqrt(result[0]*result[0] + result[1]*result[1] + result[2]*result[2]);
  assertClose(finalMag, maxSpeed, 1e-5, 'Final speed should equal maxSpeed');
});

/**
 * Test 5: Damping reduces velocity
 * Velocity should be multiplied by (1 - damping) each frame.
 * v_new = (v_old + f*dt) * (1 - damping)
 */
test('KIntegrateVelocity: damping', async () => {
  const gl = getGL();
  const width = 1, height = 1;
  
  // Initial velocity: (1.0, 1.0, 1.0)
  const velData = new Float32Array(4);
  velData[0] = 1.0;
  velData[1] = 1.0;
  velData[2] = 1.0;
  velData[3] = 0.0;
  const velTex = createTestTexture(gl, width, height, velData);
  
  const forceTex = fillTexture(gl, width, height, 0.0);
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  const damping = 0.2;  // 20% energy loss
  
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt: 0.1,
    damping,
    maxSpeed: 10.0,
    maxAccel: 10.0
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Expected: v * (1 - damping) = 1.0 * 0.8 = 0.8
  const expectedV = 1.0 * (1.0 - damping);
  
  assertAllFinite(result, 'Result must be finite');
  assertClose(result[0], expectedV, 1e-5, 'vx damped');
  assertClose(result[1], expectedV, 1e-5, 'vy damped');
  assertClose(result[2], expectedV, 1e-5, 'vz damped');
});

/**
 * Test 6: Combined force, damping, and clamping
 * Realistic scenario: apply force, apply damping, then clamp speed.
 */
test('KIntegrateVelocity: combined physics', async () => {
  const gl = getGL();
  const width = 1, height = 1;
  
  // Initial velocity: (0.5, 0.5, 0.5)
  const velData = new Float32Array(4);
  velData[0] = 0.5;
  velData[1] = 0.5;
  velData[2] = 0.5;
  velData[3] = 0.0;
  const velTex = createTestTexture(gl, width, height, velData);
  
  // Force: (10, 10, 10) - will be clamped to maxAccel=5
  const forceData = new Float32Array(4);
  forceData[0] = 10.0;
  forceData[1] = 10.0;
  forceData[2] = 10.0;
  forceData[3] = 0.0;
  const forceTex = createTestTexture(gl, width, height, forceData);
  
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  const dt = 0.1;
  const damping = 0.1;
  const maxAccel = 5.0;
  const maxSpeed = 2.0;
  
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt,
    damping,
    maxSpeed,
    maxAccel
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Step 1: Clamp force magnitude to maxAccel: ||(10,10,10)|| ≈ 17.32 > 5
  //         Clamped force = (10,10,10) / 17.32 * 5 ≈ (2.887, 2.887, 2.887)
  // Step 2: Apply dt: v = (0.5, 0.5, 0.5) + (2.887, 2.887, 2.887) * 0.1 ≈ (0.7887, 0.7887, 0.7887)
  // Step 3: Apply damping: v = (0.7887, 0.7887, 0.7887) * (1 - 0.1) ≈ (0.7098, 0.7098, 0.7098)
  // Step 4: Check speed: mag ≈ 1.229 < maxSpeed=2.0, so no speed clamping needed
  
  const expectedV = 10.0 / Math.sqrt(300) * 5.0 * 0.1 * 0.9 + 0.5 * 0.9;  // ≈ 0.7098
  
  assertAllFinite(result, 'Result must be finite');
  assertClose(result[0], expectedV, 1e-5, 'vx');
  assertClose(result[1], expectedV, 1e-5, 'vy');
  assertClose(result[2], expectedV, 1e-5, 'vz');
  
  const finalMag = Math.sqrt(result[0]*result[0] + result[1]*result[1] + result[2]*result[2]);
  assert.ok(finalMag <= maxSpeed * 1.01, 'Final speed should not exceed maxSpeed (with small tolerance)');
});

/**
 * Test 7: Multi-pixel consistency
 * Verify that different pixels are processed independently and correctly.
 */
test('KIntegrateVelocity: multi-pixel consistency', async () => {
  const gl = getGL();
  const width = 3, height = 2;
  
  // Create velocity texture with different values per pixel
  const velData = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    velData[i * 4 + 0] = i * 0.1;     // vx: 0, 0.1, 0.2, 0.3, 0.4, 0.5
    velData[i * 4 + 1] = 0.0;
    velData[i * 4 + 2] = 0.0;
    velData[i * 4 + 3] = 0.0;
  }
  const velTex = createTestTexture(gl, width, height, velData);
  
  // Force: uniform across all pixels
  const forceData = new Float32Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    forceData[i * 4 + 0] = 1.0;
    forceData[i * 4 + 1] = 0.0;
    forceData[i * 4 + 2] = 0.0;
    forceData[i * 4 + 3] = 0.0;
  }
  const forceTex = createTestTexture(gl, width, height, forceData);
  
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  const dt = 0.1;
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt,
    damping: 0.0,
    maxSpeed: 10.0,
    maxAccel: 10.0
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Verify each pixel: vx_new = vx_old + 1.0 * dt = vx_old + 0.1
  for (let i = 0; i < width * height; i++) {
    const expectedVx = i * 0.1 + 1.0 * dt;
    assertClose(result[i * 4 + 0], expectedVx, 1e-5, `Pixel ${i} vx`);
    assertClose(result[i * 4 + 1], 0.0, 1e-5, `Pixel ${i} vy`);
    assertClose(result[i * 4 + 2], 0.0, 1e-5, `Pixel ${i} vz`);
  }
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 8: Large timestep stability
 * Verify that large force magnitudes don't cause NaN or Inf.
 */
test('KIntegrateVelocity: large force stability', async () => {
  const gl = getGL();
  const width = 1, height = 1;
  
  const velTex = fillTexture(gl, width, height, 0.0);
  
  // Huge force
  const forceData = new Float32Array(4);
  forceData[0] = 1e6;
  forceData[1] = 1e6;
  forceData[2] = 1e6;
  forceData[3] = 0.0;
  const forceTex = createTestTexture(gl, width, height, forceData);
  
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  const maxAccel = 100.0;
  const maxSpeed = 50.0;
  
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt: 0.1,
    damping: 0.0,
    maxSpeed,
    maxAccel
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Verify all components are finite
  assertAllFinite(result, 'Result must be finite with large forces');
  
  // Verify speed doesn't exceed maxSpeed
  const finalMag = Math.sqrt(result[0]*result[0] + result[1]*result[1] + result[2]*result[2]);
  assert.ok(finalMag <= maxSpeed * 1.01, 'Speed should be clamped even with huge forces');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 9: Damping with various coefficients
 * Test that damping coefficient scales velocity correctly.
 */
test('KIntegrateVelocity: variable damping', async () => {
  const gl = getGL();
  const width = 1, height = 1;
  
  const initialVel = 5.0;
  const velData = new Float32Array(4);
  velData[0] = initialVel;
  velData[1] = initialVel;
  velData[2] = initialVel;
  velData[3] = 0.0;
  const velTex = createTestTexture(gl, width, height, velData);
  
  const forceTex = fillTexture(gl, width, height, 0.0);
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  // Test with 50% damping
  const damping = 0.5;
  
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt: 0.1,
    damping,
    maxSpeed: 10.0,
    maxAccel: 10.0
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Expected: v * (1 - 0.5) = v * 0.5 = 2.5
  const expectedV = initialVel * (1.0 - damping);
  
  assertAllFinite(result, 'Result must be finite');
  assertClose(result[0], expectedV, 1e-5, 'vx with 50% damping');
  assertClose(result[1], expectedV, 1e-5, 'vy with 50% damping');
  assertClose(result[2], expectedV, 1e-5, 'vz with 50% damping');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 10: Force clamping direction preservation
 * Ensure that clamped forces maintain their direction.
 */
test('KIntegrateVelocity: force clamping preserves direction', async () => {
  const gl = getGL();
  const width = 1, height = 1;
  
  const velTex = fillTexture(gl, width, height, 0.0);
  
  // Force: (3, 4, 0) - magnitude 5
  const forceData = new Float32Array(4);
  forceData[0] = 3.0;
  forceData[1] = 4.0;
  forceData[2] = 0.0;
  forceData[3] = 0.0;
  const forceTex = createTestTexture(gl, width, height, forceData);
  
  const posTex = fillTexture(gl, width, height, 0.0);
  const outVelTex = createTestTexture(gl, width, height, null);
  
  const dt = 0.1;
  const maxAccel = 2.5;  // Clamp to half the magnitude
  
  const kernel = new KIntegrateVelocity({
    gl,
    inVelocity: velTex,
    inForce: forceTex,
    inPosition: posTex,
    outVelocity: outVelTex,
    width,
    height,
    dt,
    damping: 0.0,
    maxSpeed: 10.0,
    maxAccel
  });
  
  kernel.run();
  
  const result = readTexture(gl, outVelTex, width, height);
  
  // Force should be clamped to (1.5, 2.0, 0) - maintains direction
  // velocity = clamped_force * dt = (0.15, 0.2, 0)
  const expectedVx = 1.5 * dt;
  const expectedVy = 2.0 * dt;
  
  assertAllFinite(result, 'Result must be finite');
  assertClose(result[0], expectedVx, 1e-5, 'vx - clamped force direction preserved');
  assertClose(result[1], expectedVy, 1e-5, 'vy - clamped force direction preserved');
  assertClose(result[2], 0.0, 1e-5, 'vz should be zero');
  
  // Verify direction is preserved: ratio should be 3:4
  const ratio = result[0] / result[1];
  assertClose(ratio, 0.75, 1e-5, 'Velocity ratio should be 3:4 (direction preserved)');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Export function for running all tests (for REPL runner)
 * @param {WebGL2RenderingContext} glContext
 * @returns {Promise<object>}
 */
export async function runTests(glContext) {
  // Note: When run from browser REPL via daebug, the daebug test runner
  // will handle execution. This function is for programmatic access if needed.
  return { status: 'tests loaded' };
}