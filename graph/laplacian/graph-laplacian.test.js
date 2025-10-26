// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { GraphLaplacian } from './graph-laplacian.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, resetGL } from '../gravity/test-utils.js';

/**
 * Helper: create RGBA32F texture storing vec3 data + w channel.
 * @param {WebGL2RenderingContext} gl
 * @param {Array<[number, number, number, number]>} values
 */
function createVecTexture(gl, values) {
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
 * Build simple two-node graph with symmetric edge.
 */
function createTestEdges(strength = 1) {
  return [
    { from: 0, to: 1, strength },
    { from: 1, to: 0, strength }
  ];
}

/**
 * @param {number} count
 * @returns {{width: number, height: number}}
 */
function layoutTexture(count) {
  const width = Math.ceil(Math.sqrt(count));
  const height = Math.ceil(count / width);
  return { width, height };
}

/**
 * @param {Array<[number, number, number]>} positions
 * @param {number} width
 * @param {number} height
 */
function makePositionData(positions, width, height) {
  const data = new Float32Array(width * height * 4);
  for (let i = 0; i < positions.length; i++) {
    const base = i * 4;
    const [x, y, z] = positions[i];
    data[base + 0] = x;
    data[base + 1] = y;
    data[base + 2] = z;
    data[base + 3] = 1;
  }
  return data;
}

/**
 * @param {Float32Array} pixels
 * @param {number} count
 * @returns {Array<[number, number, number]>}
 */
function extractForces(pixels, count) {
  /** @type {Array<[number, number, number]>} */
  const forces = [];
  for (let i = 0; i < count; i++) {
    const base = i * 4;
    forces.push([pixels[base], pixels[base + 1], pixels[base + 2]]);
  }
  return forces;
}

/**
 * @param {{
 *   positions: Array<[number, number, number]>,
 *   edges: Array<{from: number, to: number, strength?: number}>,
 *   k?: number,
 *   normalized?: boolean
 * }} payload
 * @returns {Array<[number, number, number]>}
 */
function computeCpuForces({ positions, edges, k = 1, normalized = false }) {
  const count = positions.length;
  const Ax = Array.from({ length: count }, () => [0, 0, 0]);
  const deg = new Array(count).fill(0);

  for (const edge of edges) {
    const { from, to, strength = 1 } = edge;
    if (from < 0 || from >= count || to < 0 || to >= count) continue;
    const posTo = positions[to];
    Ax[from][0] += strength * posTo[0];
    Ax[from][1] += strength * posTo[1];
    Ax[from][2] += strength * posTo[2];
    deg[from] += strength;
  }

  /** @type {Array<[number, number, number]>} */
  const forces = Array.from({ length: count }, () => [0, 0, 0]);
  for (let i = 0; i < count; i++) {
    const mult = normalized ? (deg[i] > 0 ? 1 / deg[i] : 0) : deg[i];
    const xi = positions[i];
    forces[i][0] = k * (Ax[i][0] - mult * xi[0]);
    forces[i][1] = k * (Ax[i][1] - mult * xi[1]);
    forces[i][2] = k * (Ax[i][2] - mult * xi[2]);
  }
  return forces;
}

/**
 * @param {[number, number, number]} actual
 * @param {[number, number, number]} expected
 * @param {number} eps
 * @param {string} label
 */
function assertForce(actual, expected, eps, label) {
  assertClose(actual[0], expected[0], eps, `${label} Fx`);
  assertClose(actual[1], expected[1], eps, `${label} Fy`);
  assertClose(actual[2], expected[2], eps, `${label} Fz`);
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {{
 *   edges: Array<{from: number, to: number, strength?: number}>,
 *   positions: Array<[number, number, number]>,
 *   k?: number,
 *   shardSize?: number,
 *   normalized?: boolean,
 *   disableFloatBlend?: boolean
 * }} options
 */
function createLaplacianHarness(gl, {
  edges,
  positions,
  k = 1,
  shardSize = 64,
  normalized = false,
  disableFloatBlend = false
}) {
  const nodeCount = positions.length;
  const { width, height } = layoutTexture(nodeCount);
  const positionTex = createTestTexture(gl, width, height, makePositionData(positions, width, height));
  const targetTex = createTestTexture(gl, width, height, new Float32Array(width * height * 4));
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('Failed to create framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  const laplacianEdges = edges.map((edge) => ({
    from: edge.from,
    to: edge.to,
    strength: edge.strength ?? 1
  }));

  const module = new GraphLaplacian({
    gl,
    edges: laplacianEdges,
    particleCount: nodeCount,
    textureWidth: width,
    textureHeight: height,
    k,
    shardSize,
    normalized,
    disableFloatBlend
  });

  function clearTarget() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * @param {{ clearFirst?: boolean }=} options
   */
  function accumulateAndRead(options) {
    const clearFirst = options?.clearFirst ?? true;
    if (clearFirst) clearTarget();
    module.accumulate({
      positionTexture: positionTex,
      targetForceTexture: targetTex,
      targetForceFramebuffer: fbo
    });
    const pixels = readTexture(gl, targetTex, width, height);
    assertAllFinite(pixels, 'Force texture must contain finite values');
    return extractForces(pixels, nodeCount);
  }

  function dispose() {
    module.dispose();
    gl.deleteTexture(positionTex);
    gl.deleteTexture(targetTex);
    gl.deleteFramebuffer(fbo);
  }

  return {
    module,
    accumulateAndRead,
    dispose,
    edges: laplacianEdges,
    positions,
    k,
    normalized,
    targetTex,
    framebuffer: fbo,
    textureWidth: width,
    textureHeight: height,
    positionTexture: positionTex
  };
}

/**
 * @param {Array<[number, number, number]>} forces
 * @returns {[number, number, number]}
 */
function sumForces(forces) {
  return forces.reduce(
    (acc, f) => {
      acc[0] += f[0];
      acc[1] += f[1];
      acc[2] += f[2];
      return acc;
    },
    [0, 0, 0]
  );
}

const EPS = 1e-5;

/**
 * @param {ReturnType<typeof createLaplacianHarness>} harness
 * @param {number} [eps]
 */
function compareHarnessToCpu(harness, eps = EPS) {
  const gpu = harness.accumulateAndRead();
  const cpu = computeCpuForces({
    positions: harness.positions,
    edges: harness.edges,
    k: harness.k,
    normalized: harness.normalized
  });

  for (let i = 0; i < cpu.length; i++) {
    assertForce(gpu[i], cpu[i], eps, `node ${i}`);
  }

  return { gpu, cpu };
}

test('two nodes, single directed edge', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: [{ from: 0, to: 1, strength: 2 }],
    positions: [
      [0, 0, 0],
      [1, 0, 0]
    ],
    k: 0.5,
    shardSize: 8
  });

  const { gpu } = compareHarnessToCpu(harness);
  assertForce(gpu[1], [0, 0, 0], EPS, 'node 1 static');
  harness.dispose();
  resetGL();
});

test('three-node chain symmetric layout', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: [
      { from: 0, to: 1, strength: 1 },
      { from: 1, to: 0, strength: 1 },
      { from: 1, to: 2, strength: 1 },
      { from: 2, to: 1, strength: 1 }
    ],
    positions: [
      [-1, 0, 0],
      [0, 0, 0],
      [1, 0, 0]
    ],
    k: 1,
    shardSize: 8
  });

  compareHarnessToCpu(harness);
  harness.dispose();
  resetGL();
});

test('triangle loop at rest length', async () => {
  const gl = getGL();
  const s = Math.sqrt(3) / 3;
  const harness = createLaplacianHarness(gl, {
    edges: [
      { from: 0, to: 1, strength: 1 },
      { from: 1, to: 2, strength: 1 },
      { from: 2, to: 0, strength: 1 },
      { from: 1, to: 0, strength: 1 },
      { from: 2, to: 1, strength: 1 },
      { from: 0, to: 2, strength: 1 }
    ],
    positions: [
      [0, 0, 0],
      [1, 0, 0],
      [0.5, s * 2, 0]
    ],
    k: 0.75,
    shardSize: 8
  });

  const { gpu } = compareHarnessToCpu(harness);
  const total = sumForces(gpu);
  assertClose(total[0], 0, EPS, 'triangle sum Fx');
  assertClose(total[1], 0, EPS, 'triangle sum Fy');
  assertClose(total[2], 0, EPS, 'triangle sum Fz');
  harness.dispose();
  resetGL();
});

test('isolated node stays zero', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: [
      { from: 0, to: 1, strength: 1 },
      { from: 1, to: 0, strength: 1 }
    ],
    positions: [
      [0, 0, 0],
      [1, 0, 0],
      [5, 5, 0]
    ],
    k: 0.25,
    shardSize: 8
  });

  const { gpu } = compareHarnessToCpu(harness);
  assertForce(gpu[2], [0, 0, 0], EPS, 'isolated node force');
  harness.dispose();
  resetGL();
});

test('weighted asymmetric edges', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: [
      { from: 0, to: 1, strength: 3 },
      { from: 1, to: 0, strength: 1 }
    ],
    positions: [
      [0, 0, 0],
      [2, 0, 0]
    ],
    k: 0.2,
    shardSize: 4
  });

  compareHarnessToCpu(harness);
  harness.dispose();
  resetGL();
});

test('normalized Laplacian matches CPU expectation', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: [
      { from: 0, to: 1, strength: 1 },
      { from: 1, to: 0, strength: 1 }
    ],
    positions: [
      [0, 0, 0],
      [2, 0, 0]
    ],
    k: 1,
    shardSize: 4,
    normalized: true
  });

  compareHarnessToCpu(harness, 1e-5);
  harness.dispose();
  resetGL();
});

test('shard boundary splitting still matches CPU', async () => {
  const gl = getGL();
  const neighborCount = 10;
  /** @type {Array<[number, number, number]>} */
  const positions = [[0, 0, 0]];
  const edges = [];
  for (let i = 0; i < neighborCount; i++) {
    const angle = (i / neighborCount) * Math.PI * 2;
    positions.push([Math.cos(angle), Math.sin(angle), 0]);
    edges.push({ from: 0, to: i + 1, strength: 1 });
    edges.push({ from: i + 1, to: 0, strength: 1 });
  }

  const harness = createLaplacianHarness(gl, {
    edges,
    positions,
    k: 0.3,
    shardSize: 4
  });

  compareHarnessToCpu(harness);
  harness.dispose();
  resetGL();
});

test('high-degree symmetric star keeps zero net force', async () => {
  const gl = getGL();
  const spokes = 12;
  /** @type {Array<[number, number, number]>} */
  const positions = [[0, 0, 0]];
  const edges = [];
  for (let i = 0; i < spokes; i++) {
    const angle = (i / spokes) * Math.PI * 2;
    positions.push([Math.cos(angle), Math.sin(angle), 0]);
    edges.push({ from: 0, to: i + 1, strength: 2 });
    edges.push({ from: i + 1, to: 0, strength: 2 });
  }

  const harness = createLaplacianHarness(gl, {
    edges,
    positions,
    k: 0.4,
    shardSize: 8
  });

  const { gpu } = compareHarnessToCpu(harness);
  const total = sumForces(gpu);
  assertClose(total[0], 0, EPS, 'star Fx sum');
  assertClose(total[1], 0, EPS, 'star Fy sum');
  assertClose(total[2], 0, EPS, 'star Fz sum');
  harness.dispose();
  resetGL();
});

test('ring lattice conserves momentum', async () => {
  const gl = getGL();
  const nodes = 8;
  /** @type {Array<[number, number, number]>} */
  const positions = [];
  const edges = [];
  for (let i = 0; i < nodes; i++) {
    const angle = (i / nodes) * Math.PI * 2;
    positions.push([Math.cos(angle) * 2, Math.sin(angle) * 2, 0]);
    const next = (i + 1) % nodes;
    edges.push({ from: i, to: next, strength: 1 });
    edges.push({ from: next, to: i, strength: 1 });
  }

  const harness = createLaplacianHarness(gl, {
    edges,
    positions,
    k: 0.6,
    shardSize: 8
  });

  const { gpu } = compareHarnessToCpu(harness);
  const total = sumForces(gpu);
  assertClose(total[0], 0, 5e-5, 'ring Fx sum');
  assertClose(total[1], 0, 5e-5, 'ring Fy sum');
  assertClose(total[2], 0, 5e-5, 'ring Fz sum');
  harness.dispose();
  resetGL();
});

test('zero-strength edges do not contribute', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: [
      { from: 0, to: 1, strength: 0 },
      { from: 1, to: 0, strength: 0 }
    ],
    positions: [
      [0, 0, 0],
      [1, 0, 0]
    ],
    k: 1,
    shardSize: 4
  });

  const gpu = harness.accumulateAndRead();
  assertForce(gpu[0], [0, 0, 0], EPS, 'node 0 zero edge');
  assertForce(gpu[1], [0, 0, 0], EPS, 'node 1 zero edge');
  harness.dispose();
  resetGL();
});

test('out-of-bounds edges are ignored safely', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: [
      { from: 0, to: 1, strength: 1 },
      { from: 5, to: 0, strength: 2 }
    ],
    positions: [
      [0, 0, 0],
      [1, 0, 0]
    ],
    k: 0.5,
    shardSize: 4
  });

  compareHarnessToCpu(harness);
  harness.dispose();
  resetGL();
});

test('module clears external handles after accumulate', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: createTestEdges(1),
    positions: [
      [0, 0, 0],
      [1, 0, 0]
    ],
    k: 0.3,
    shardSize: 4
  });

  harness.accumulateAndRead();
  const module = harness.module;
  assert.strictEqual(module.finishKernel?.outForce, null);
  assert.strictEqual(module.finishKernel?.outForceFramebuffer, null);
  assert.strictEqual(module.finishKernel?.inAx, null);
  assert.strictEqual(module.finishKernel?.inDeg, null);
  harness.dispose();
  resetGL();
});

test('accumulate skips when float blend disabled and retains target', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: createTestEdges(1),
    positions: [
      [0, 0, 0],
      [1, 0, 0]
    ],
    k: 1,
    shardSize: 4,
    disableFloatBlend: true
  });

  const zeroForces = harness.accumulateAndRead();
  assertForce(zeroForces[0], [0, 0, 0], EPS, 'node 0 float blend off zero');
  assertForce(zeroForces[1], [0, 0, 0], EPS, 'node 1 float blend off zero');

  // Fill target with sentinel values and ensure accumulate leaves them untouched
  const sentinel = new Float32Array(harness.textureWidth * harness.textureHeight * 4);
  sentinel.fill(0.1234);
  gl.bindTexture(gl.TEXTURE_2D, harness.targetTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, harness.textureWidth, harness.textureHeight, gl.RGBA, gl.FLOAT, sentinel);
  gl.bindTexture(gl.TEXTURE_2D, null);

  harness.accumulateAndRead({ clearFirst: false });
  const pixels = readTexture(gl, harness.targetTex, harness.textureWidth, harness.textureHeight);
  for (let i = 0; i < pixels.length; i++) {
    assertClose(pixels[i], 0.1234, 1e-6, 'sentinel preserved');
  }

  harness.dispose();
  resetGL();
});

test('coincident nodes remain stable', async () => {
  const gl = getGL();
  const harness = createLaplacianHarness(gl, {
    edges: createTestEdges(2),
    positions: [
      [1, 1, 1],
      [1, 1, 1]
    ],
    k: 0.5,
    shardSize: 4
  });

  const { gpu } = compareHarnessToCpu(harness);
  assertForce(gpu[0], [0, 0, 0], EPS, 'node 0 coincident');
  assertForce(gpu[1], [0, 0, 0], EPS, 'node 1 coincident');
  harness.dispose();
  resetGL();
});
