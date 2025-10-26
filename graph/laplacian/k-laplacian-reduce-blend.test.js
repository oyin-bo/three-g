// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';

import { KLaplacianReduceBlend } from './k-laplacian-reduce-blend.js';
import { getGL, createTestTexture, resetGL } from '../../gravity/test-utils.js';

/**
 * Helper: create shard metadata texture (RGBA32F) with entries [{nodeId, start, len, pad}, ...].
 * @param {WebGL2RenderingContext} gl
 * @param {Array<[number, number, number, number]>} rows
 */
function createShardTexture(gl, rows) {
  const width = rows.length;
  const data = new Float32Array(width * 4);
  for (let i = 0; i < rows.length; i++) {
    const [nodeId, start, len, pad] = rows[i];
    const base = i * 4;
    data[base] = nodeId;
    data[base + 1] = start;
    data[base + 2] = len;
    data[base + 3] = pad;
  }
  return createTestTexture(gl, width, 1, data);
}

/**
 * Helper: create partials texture (RGBA payload) for shards.
 * @param {WebGL2RenderingContext} gl
 * @param {Array<[number, number, number, number]>} values
 */
function createPartialsTexture(gl, values) {
  const width = values.length;
  const data = new Float32Array(width * 4);
  for (let i = 0; i < values.length; i++) {
    const [x, y, z, w] = values[i];
    const base = i * 4;
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = z;
    data[base + 3] = w;
  }
  return createTestTexture(gl, width, 1, data);
}

/**
 * Test 1: kernel allocates outAx when not provided.
 */
test('KLaplacianReduceBlend: creates outAx when not provided', async () => {
  const gl = getGL();

  const shardsTex = createShardTexture(gl, [[0, 0, 1, 0]]);
  const partialsTex = createPartialsTexture(gl, [[1, 2, 3, 4]]);

  const kernel = new KLaplacianReduceBlend({
    gl,
    inPartials: partialsTex,
    inShards: shardsTex,
    axWidth: 1,
    axHeight: 1,
    shardTextureWidth: 1,
    shardTextureHeight: 1,
    shardCount: 1
  });

  assert.ok(kernel.outAx, 'Kernel should allocate outAx texture');

  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: false });
  assert.ok(snapshot.ax, 
    `Reduced texture should be finite\n\n${kernel.toString()}`);

  kernel.dispose();
  resetGL();
});

/**
 * Test 2: additive blending accumulates shard contributions per node.
 */
test('KLaplacianReduceBlend: accumulates shards into node Ax', async () => {
  const gl = getGL();

  // Two shards targeting the same node (id 0)
  const shardsTex = createShardTexture(gl, [
    [0, 0, 1, 0],
    [0, 1, 1, 0]
  ]);
  const partialsTex = createPartialsTexture(gl, [
    [1, 0, 0, 2],
    [3, 4, 0, 5]
  ]);

  const kernel = new KLaplacianReduceBlend({
    gl,
    inPartials: partialsTex,
    inShards: shardsTex,
    axWidth: 1,
    axHeight: 1,
    shardTextureWidth: 2,
    shardTextureHeight: 1,
    shardCount: 2
  });

  kernel.run();
  
  const snapshot = kernel.valueOf({ pixels: true });

  assert.strictEqual(snapshot.ax.pixels[0].ax, 4, 
    `Sum X should match (1 + 3)\n\n${kernel.toString()}`);
  assert.strictEqual(snapshot.ax.pixels[0].ay, 4, 
    `Sum Y should match (0 + 4)\n\n${kernel.toString()}`);
  assert.strictEqual(snapshot.ax.pixels[0].az, 0, 
    `Sum Z should match (0 + 0)\n\n${kernel.toString()}`);
  assert.strictEqual(snapshot.ax.pixels[0].w, 7, 
    `Sum weights should match (2 + 5)\n\n${kernel.toString()}`);

  kernel.dispose();
  resetGL();
});

/**
 * Test 3: run throws when required inputs missing.
 */
test('KLaplacianReduceBlend: run throws if inputs missing', async () => {
  const gl = getGL();

  const shardsTex = createShardTexture(gl, [[0, 0, 1, 0]]);
  const partialsTex = createPartialsTexture(gl, [[1, 0, 0, 1]]);

  const kernel = new KLaplacianReduceBlend({
    gl,
    inPartials: partialsTex,
    inShards: shardsTex,
    axWidth: 1,
    axHeight: 1,
    shardTextureWidth: 1,
    shardTextureHeight: 1,
    shardCount: 1
  });

  kernel.inPartials = null;
  assert.throws(() => kernel.run(), /inputs missing/, 'run() should throw when inputs are missing');

  kernel.dispose();
  resetGL();
});
