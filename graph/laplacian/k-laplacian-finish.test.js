// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';

import { assertClose, createTestTexture, getGL, resetGL } from '../../gravity/test-utils.js';
import { KLaplacianFinish } from './k-laplacian-finish.js';

/**
 * Helper: create scalar data texture in R channel.
 * @param {WebGL2RenderingContext} gl
 * @param {number[]} values
 */
function createScalarTexture(gl, values) {
  const width = values.length;
  const data = new Float32Array(width * 4);
  for (let i = 0; i < values.length; i++) {
    data[i * 4] = values[i];
  }
  return createTestTexture(gl, width, 1, data);
}

/**
 * Helper: create vector3 texture (xyz stored, w=1).
 * @param {WebGL2RenderingContext} gl
 * @param {Array<[number, number, number]>} values
 */
function createVec3Texture(gl, values) {
  const width = values.length;
  const data = new Float32Array(width * 4);
  for (let i = 0; i < values.length; i++) {
    const [x, y, z] = values[i];
    const base = i * 4;
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = z;
    data[base + 3] = 1;
  }
  return createTestTexture(gl, width, 1, data);
}

/**
 * Test 1: kernel allocates outForce framebuffer/texture when not provided.
 */
test('KLaplacianFinish: allocates outForce when not provided', async () => {
  const gl = getGL();

  const axTex = createVec3Texture(gl, [[1, 2, 3]]);
  const degTex = createScalarTexture(gl, [2]);
  const posTex = createVec3Texture(gl, [[4, 5, 6]]);

  const kernel = new KLaplacianFinish({
    gl,
    inAx: axTex,
    inDeg: degTex,
    inPosition: posTex,
    forceWidth: 1,
    forceHeight: 1,
    axWidth: 1,
    axHeight: 1,
    degWidth: 1,
    degHeight: 1,
    positionWidth: 1,
    positionHeight: 1,
    springK: 0.5,
    enableBlend: false
  });

  assert.ok(kernel.outForce, 'Kernel should allocate outForce texture');
  assert.ok(kernel.outForceFramebuffer, 'Kernel should allocate framebuffer');

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });
  assert.ok(snapshot.force,
    `Force texture should be finite\n\n${kernel.toString()}`);

  kernel.dispose();
  resetGL();
});

/**
 * Test 2: computes F = k*(Ax - deg*x) with blending disabled.
 */
test('KLaplacianFinish: computes Laplacian force contribution', async () => {
  const gl = getGL();

  const axTex = createVec3Texture(gl, [[2, 4, 6]]);
  const degTex = createScalarTexture(gl, [2]);
  const posTex = createVec3Texture(gl, [[1, 1, 1]]);
  const outTex = createVec3Texture(gl, [[0, 0, 0]]);

  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('Failed to create framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const kernel = new KLaplacianFinish({
    gl,
    inAx: axTex,
    inDeg: degTex,
    inPosition: posTex,
    outForce: outTex,
    outForceFramebuffer: fbo,
    forceWidth: 1,
    forceHeight: 1,
    axWidth: 1,
    axHeight: 1,
    degWidth: 1,
    degHeight: 1,
    positionWidth: 1,
    positionHeight: 1,
    springK: 1,
    enableBlend: false
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: true });

  assertClose(snapshot.force.pixels[0].fx, 0, 1e-5,
    `Force X should be computed correctly\n\n${kernel.toString()}`);
  assertClose(snapshot.force.pixels[0].fy, 2, 1e-5,
    `Force Y should be computed correctly\n\n${kernel.toString()}`);
  assertClose(snapshot.force.pixels[0].fz, 4, 1e-5,
    `Force Z should be computed correctly\n\n${kernel.toString()}`);

  kernel.dispose();
  gl.deleteFramebuffer(fbo);
  resetGL();
});

/**
 * Test 3: run throws when required inputs missing.
 */
test('KLaplacianFinish: run throws if inputs missing', async () => {
  const gl = getGL();

  const axTex = createVec3Texture(gl, [[1, 0, 0]]);
  const degTex = createScalarTexture(gl, [1]);
  const posTex = createVec3Texture(gl, [[0, 0, 0]]);

  const kernel = new KLaplacianFinish({
    gl,
    inAx: axTex,
    inDeg: degTex,
    inPosition: posTex,
    forceWidth: 1,
    forceHeight: 1,
    axWidth: 1,
    axHeight: 1,
    degWidth: 1,
    degHeight: 1,
    positionWidth: 1,
    positionHeight: 1,
    springK: 0.1,
    enableBlend: false
  });

  kernel.inDeg = null;
  assert.throws(() => kernel.run(), /required inputs/, 'run() should throw when inputs missing');

  kernel.dispose();
  resetGL();
});
