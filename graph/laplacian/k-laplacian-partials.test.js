// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';

import { assertAllFinite, assertClose, createTestTexture, getGL, readTexture, resetGL } from '../../gravity/test-utils.js';
import { KLaplacianPartials } from './k-laplacian-partials.js';

/**
 * Helper: create a 1×1 shard texture entry.
 * @param {WebGL2RenderingContext} gl
 * @param {number} nodeId
 * @param {number} start
 * @param {number} len
 */
function createShardTexture(gl, nodeId, start, len) {
  const data = new Float32Array([nodeId, start, len, 0]);
  return createTestTexture(gl, 1, 1, data);
}

/**
 * Helper: create a 1D texture with given scalar values in the R channel.
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
 * Helper: create a position texture (RGBA32F) from vec3 list.
 * @param {WebGL2RenderingContext} gl
 * @param {Array<[number, number, number]>} positions
 */
function createPositionTexture(gl, positions) {
  const width = Math.max(1, Math.ceil(Math.sqrt(positions.length)));
  const height = Math.max(1, Math.ceil(positions.length / width));
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < positions.length; i++) {
    const [x, y, z] = positions[i];
    const idx = i * 4;
    data[idx] = x;
    data[idx + 1] = y;
    data[idx + 2] = z;
    data[idx + 3] = 1;
  }
  const texture = createTestTexture(gl, width, height, data);
  return { texture, width, height };
}

/**
 * Test 1: kernel allocates output texture when not provided.
 */
test('KLaplacianPartials: creates outPartials when not provided', async () => {
  const gl = getGL();

  const shardsTex = createShardTexture(gl, 0, 0, 1);
  const colIdxTex = createScalarTexture(gl, [0]);
  const weightTex = createScalarTexture(gl, [1]);
  const { texture: positionsTex, width: posW, height: posH } = createPositionTexture(gl, [[0, 0, 0]]);

  const kernel = new KLaplacianPartials({
    gl,
    inShards: shardsTex,
    inColIdx: colIdxTex,
    inWeight: weightTex,
    inPosition: positionsTex,
    partialsWidth: 1,
    partialsHeight: 1,
    shardTextureWidth: 1,
    shardTextureHeight: 1,
    colTextureWidth: 1,
    colTextureHeight: 1,
    positionTextureWidth: posW,
    positionTextureHeight: posH,
    shardBlockSize: 4
  });

  assert.ok(kernel.outPartials, 'Kernel should allocate outPartials texture');

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: false });
  assert.ok(snapshot.partials,
    `Out partials should be finite\n\n${kernel.toString()}`);

  kernel.dispose();
  resetGL();
});

/**
 * Test 2: partials accumulate weighted neighbor positions.
 */
test('KLaplacianPartials: accumulates weighted neighbor positions', async () => {
  const gl = getGL();

  const shardsTex = createShardTexture(gl, 0, 0, 2);
  const colIdxTex = createScalarTexture(gl, [1, 2]);
  const weightTex = createScalarTexture(gl, [2, 3]);
  const { texture: positionsTex, width: posW, height: posH } = createPositionTexture(gl, [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0]
  ]);

  const kernel = new KLaplacianPartials({
    gl,
    inShards: shardsTex,
    inColIdx: colIdxTex,
    inWeight: weightTex,
    inPosition: positionsTex,
    partialsWidth: 1,
    partialsHeight: 1,
    shardTextureWidth: 1,
    shardTextureHeight: 1,
    colTextureWidth: 2,
    colTextureHeight: 1,
    positionTextureWidth: posW,
    positionTextureHeight: posH,
    shardBlockSize: 4
  });

  kernel.run();

  const snapshot = kernel.valueOf({ pixels: true });

  assertClose(snapshot.partials.pixels[0].sumx, 2 * 1 + 3 * 0, 1e-5,
    `sumx should match expected\n\n${kernel.toString()}`);
  assertClose(snapshot.partials.pixels[0].sumy, 2 * 0 + 3 * 1, 1e-5,
    `sumy should match expected\n\n${kernel.toString()}`);
  assertClose(snapshot.partials.pixels[0].sumz, 0, 1e-5,
    `sumz should match expected\n\n${kernel.toString()}`);
  assertClose(snapshot.partials.pixels[0].w, 5, 1e-5,
    `weight sum should match expected\n\n${kernel.toString()}`);

  kernel.dispose();
  resetGL();
});

/**
 * Test 3: missing inputs trigger an error.
 */
test('KLaplacianPartials: run throws if required inputs missing', async () => {
  const gl = getGL();

  const shardsTex = createShardTexture(gl, 0, 0, 1);
  const colIdxTex = createScalarTexture(gl, [0]);
  const weightTex = createScalarTexture(gl, [1]);
  const { texture: positionsTex, width: posW, height: posH } = createPositionTexture(gl, [[0, 0, 0]]);

  const kernel = new KLaplacianPartials({
    gl,
    inShards: shardsTex,
    inColIdx: colIdxTex,
    inWeight: weightTex,
    inPosition: positionsTex,
    partialsWidth: 1,
    partialsHeight: 1,
    shardTextureWidth: 1,
    shardTextureHeight: 1,
    colTextureWidth: 1,
    colTextureHeight: 1,
    positionTextureWidth: posW,
    positionTextureHeight: posH,
    shardBlockSize: 4
  });

  kernel.inPosition = null;
  assert.throws(() => kernel.run(), /required input textures/, 'run() should throw when inputs are missing');

  kernel.dispose();
  resetGL();
});

