// @ts-check

/**
 * LaplacianForceModuleKernels - kernelized Laplacian spring force module.
 *
 * Reimplements the legacy LaplacianForceModule using WebGL2 kernels located in
 * graph-laplacian-kernels/. The orchestrator builds CSR data on the CPU,
 * uploads textures, and wires kernel passes to accumulate spring forces.
 */

import { KLaplacianPartials } from './k-laplacian-partials.js';
import { KLaplacianReduceBlend } from './k-laplacian-reduce-blend.js';
import { KLaplacianFinish } from './k-laplacian-finish.js';

/**
 * @typedef {{from: number, to: number, strength: number}} LaplacianEdge
 */

export class GraphLaplacian {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   edges: Iterable<LaplacianEdge>,
   *   particleCount: number,
   *   textureWidth: number,
   *   textureHeight: number,
   *   k?: number,
   *   shardSize?: number,
   *   normalized?: boolean,
   *   disableFloatBlend?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    this.particleCount = options.particleCount;
    this.textureWidth = options.textureWidth;
    this.textureHeight = options.textureHeight;
    this.disableFloatBlend = !!options.disableFloatBlend;

    this.options = {
      k: options.k ?? 0.01,
      shardSize: options.shardSize ?? 64,
      normalized: options.normalized ?? false
    };

    this.edges = Array.from(options.edges);

    const N = this.particleCount;
    /** @type {{to: number, weight: number}[][]} */
    const adjacency = Array.from({ length: N }, () => []);
    const degreeCount = new Float32Array(N);

    for (const edge of this.edges) {
      const { from, to, strength } = edge;
      if (from < 0 || from >= N || to < 0 || to >= N) {
        console.warn(`LaplacianForceModuleKernels: edge out of bounds ${from} -> ${to}`);
        continue;
      }

      adjacency[from].push({ to, weight: strength });
      degreeCount[from] += strength;
    }

    const totalEntries = adjacency.reduce((sum, list) => sum + list.length, 0);
    this.rowPtr = new Float32Array(N + 1);
    this.colIdx = new Float32Array(totalEntries);
    this.weight = new Float32Array(totalEntries);
    this.deg = degreeCount;

    let csrOffset = 0;
    for (let i = 0; i < N; i++) {
      this.rowPtr[i] = csrOffset;
      /** @type {{to: number, weight: number}[]} */
      const neighbors = adjacency[i];
      for (let j = 0; j < neighbors.length; j++) {
        const nbr = neighbors[j];
        this.colIdx[csrOffset] = nbr.to;
        this.weight[csrOffset] = nbr.weight;
        csrOffset++;
      }
    }
    this.rowPtr[N] = csrOffset;

    if (this.options.normalized) {
      this.degInv = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        this.degInv[i] = this.deg[i] > 0 ? 1 / this.deg[i] : 0;
      }
    }

    /** @type {{nodeId: number, start: number, len: number}[]} */
    const shards = [];
    const shardSize = this.options.shardSize;

    for (let nodeId = 0; nodeId < this.particleCount; nodeId++) {
      const start = this.rowPtr ? this.rowPtr[nodeId] : 0;
      const end = this.rowPtr ? this.rowPtr[nodeId + 1] : start;
      const degree = end - start;
      if (degree <= 0) continue;

      for (let offset = 0; offset < degree; offset += shardSize) {
        const len = Math.min(shardSize, degree - offset);
        shards.push({ nodeId, start: start + offset, len });
      }
    }

    this.shards = shards;

    const colSize = this._calculateTextureSize(this.colIdx ? this.colIdx.length : 0);
    const weightSize = this._calculateTextureSize(this.weight ? this.weight.length : 0);
    const shardSizeInfo = this._calculateTextureSize(this.shards ? this.shards.length : 0);
    const degSize = this._calculateTextureSize(this.particleCount);

    this.colIdxTex = createDataTexture(this.gl, colSize.width, colSize.height, this.gl.R32F, this.gl.RED, this.gl.FLOAT);
    this.weightTex = createDataTexture(this.gl, weightSize.width, weightSize.height, this.gl.R32F, this.gl.RED, this.gl.FLOAT);
    this.shardsTex = createDataTexture(this.gl, shardSizeInfo.width, shardSizeInfo.height, this.gl.RGBA32F, this.gl.RGBA, this.gl.FLOAT);
    this.degTex = createDataTexture(this.gl, degSize.width, degSize.height, this.gl.R32F, this.gl.RED, this.gl.FLOAT);
    if (this.degInv) {
      this.degInvTex = createDataTexture(this.gl, degSize.width, degSize.height, this.gl.R32F, this.gl.RED, this.gl.FLOAT);
    }

    if (this.colIdx && this.colIdxTex) {
      const padded = new Float32Array(colSize.width * colSize.height);
      padded.set(this.colIdx);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.colIdxTex);
      this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, colSize.width, colSize.height, this.gl.RED, this.gl.FLOAT, padded);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }

    if (this.weight && this.weightTex) {
      const padded = new Float32Array(weightSize.width * weightSize.height);
      padded.set(this.weight);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.weightTex);
      this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, weightSize.width, weightSize.height, this.gl.RED, this.gl.FLOAT, padded);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }

    if (this.shards && this.shardsTex) {
      const packed = new Float32Array(shardSizeInfo.width * shardSizeInfo.height * 4);
      for (let i = 0; i < this.shards.length; i++) {
        const shard = this.shards[i];
        packed[i * 4 + 0] = shard.nodeId;
        packed[i * 4 + 1] = shard.start;
        packed[i * 4 + 2] = shard.len;
        packed[i * 4 + 3] = 0;
      }
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.shardsTex);
      this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, shardSizeInfo.width, shardSizeInfo.height, this.gl.RGBA, this.gl.FLOAT, packed);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }

    if (this.deg && this.degTex) {
      const paddedDeg = new Float32Array(degSize.width * degSize.height);
      paddedDeg.set(this.deg);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.degTex);
      this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, degSize.width, degSize.height, this.gl.RED, this.gl.FLOAT, paddedDeg);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }

    if (this.degInv && this.degInvTex) {
      const paddedInv = new Float32Array(degSize.width * degSize.height);
      paddedInv.set(this.degInv);
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.degInvTex);
      this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, degSize.width, degSize.height, this.gl.RED, this.gl.FLOAT, paddedInv);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }


    if (!this.colIdxTex || !this.weightTex || !this.shardsTex || !this.degTex)
      throw new Error('LaplacianForceModuleKernels: textures missing');

    const degSizeInfo = degSize;

    this.partialsKernel = new KLaplacianPartials({
      gl: this.gl,
      inShards: this.shardsTex,
      inColIdx: this.colIdxTex,
      inWeight: this.weightTex,
      inPosition: null,
      partialsWidth: shardSizeInfo.width,
      partialsHeight: shardSizeInfo.height,
      shardTextureWidth: shardSizeInfo.width,
      shardTextureHeight: shardSizeInfo.height,
      colTextureWidth: colSize.width,
      colTextureHeight: colSize.height,
      positionTextureWidth: this.textureWidth,
      positionTextureHeight: this.textureHeight,
      shardBlockSize: this.options.shardSize
    });

    this.reduceKernel = new KLaplacianReduceBlend({
      gl: this.gl,
      inPartials: this.partialsKernel.outPartials || null,
      inShards: this.shardsTex,
      axWidth: degSizeInfo.width,
      axHeight: degSizeInfo.height,
      shardTextureWidth: shardSizeInfo.width,
      shardTextureHeight: shardSizeInfo.height,
      shardCount: this.shards ? this.shards.length : 0
    });

    if (this.disableFloatBlend)
      console.warn('[LaplacianForceModuleKernels] EXT_float_blend unavailable: Laplacian accumulation may be inaccurate.');

    this.finishKernel = new KLaplacianFinish({
      gl: this.gl,
      inAx: this.reduceKernel.outAx || null,
      inDeg: this.options.normalized && this.degInvTex ? this.degInvTex : this.degTex,
      inPosition: null,
      outForce: null,
      outForceFramebuffer: null,
      forceWidth: this.textureWidth,
      forceHeight: this.textureHeight,
      axWidth: degSizeInfo.width,
      axHeight: degSizeInfo.height,
      degWidth: degSizeInfo.width,
      degHeight: degSizeInfo.height,
      positionWidth: this.textureWidth,
      positionHeight: this.textureHeight,
      springK: this.options.k,
      enableBlend: !this.disableFloatBlend
    });
  }

  /**
   * Accumulate Laplacian forces into the provided target.
   *
   * @param {{
   *   positionTexture: WebGLTexture,
   *   targetForceTexture: WebGLTexture,
   *   targetForceFramebuffer: WebGLFramebuffer,
   *   dt?: number
   * }} ctx
   */
  accumulate(ctx) {
    if (!this.partialsKernel || !this.reduceKernel || !this.finishKernel)
      throw new Error('LaplacianForceModuleKernels: kernels not initialized');

    if (!ctx.targetForceTexture)
      throw new Error('LaplacianForceModuleKernels: targetForceTexture missing');

    if (!ctx.targetForceFramebuffer)
      throw new Error('LaplacianForceModuleKernels: targetForceFramebuffer missing');

    if (this.disableFloatBlend) {
      console.warn('[LaplacianForceModuleKernels] Skipping accumulation: EXT_float_blend unavailable');
      return;
    }

    const positionTex = ctx.positionTexture;

    this.partialsKernel.inPosition = positionTex;
    this.partialsKernel.run();

    if (!this.partialsKernel.outPartials)
      throw new Error('LaplacianForceModuleKernels: partials output missing');

    this.reduceKernel.inPartials = this.partialsKernel.outPartials;
    this.reduceKernel.inShards = this.shardsTex;
    this.reduceKernel.run();

    if (!this.reduceKernel.outAx)
      throw new Error('LaplacianForceModuleKernels: Ax output missing');

    this.finishKernel.inAx = this.reduceKernel.outAx;
    this.finishKernel.inPosition = positionTex;
    this.finishKernel.inDeg = this.options.normalized && this.degInvTex
      ? this.degInvTex
      : this.degTex;
    this.finishKernel.outForce = ctx.targetForceTexture;
    this.finishKernel.outForceFramebuffer = ctx.targetForceFramebuffer;
    this.finishKernel.run();

    // Clean references so dispose() can skip deleting external textures
    this.partialsKernel.inPosition = null;
    this.reduceKernel.inPartials = null;
    this.reduceKernel.inShards = null;
    this.finishKernel.outForce = null;
    this.finishKernel.outForceFramebuffer = null;
    this.finishKernel.inPosition = null;
    this.finishKernel.inAx = null;
    this.finishKernel.inDeg = null;
  }

  dispose() {
    const gl = this.gl;

    this.partialsKernel.dispose();
    this.reduceKernel.dispose();
    this.finishKernel.dispose();

    // TODO: should this be deleted or left to the kernels to delete?
    if (this.colIdxTex) gl.deleteTexture(this.colIdxTex);
    if (this.weightTex) gl.deleteTexture(this.weightTex);
    if (this.shardsTex) gl.deleteTexture(this.shardsTex);
    if (this.degTex) gl.deleteTexture(this.degTex);
    if (this.degInvTex) gl.deleteTexture(this.degInvTex);
  }

  /**
   * @param {number} length
   */
  _calculateTextureSize(length) {
    const gl = this.gl;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (length <= 0) return { width: 1, height: 1 };
    const width = Math.min(maxSize, Math.ceil(Math.sqrt(length)));
    const height = Math.ceil(length / width);
    if (height > maxSize)
      throw new Error(`Texture size limit exceeded for length=${length}`);
    return { width, height };
  }
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @param {number} internalFormat
 * @param {number} format
 * @param {number} type
 */
function createDataTexture(gl, width, height, internalFormat, format, type) {
  const tex = gl.createTexture();
  if (!tex) throw new Error('createDataTexture: allocation failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return tex;
}
