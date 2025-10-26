// @ts-check

import { formatNumber, readLinear } from '../../gravity/diag.js';

/**
 * KLaplacianPartials - computes shard partial sums for Laplacian force assembly.
 *
 * Implements the WebGL2 Kernel contract described in docs/8-webgl-kernels.md.
 * Runs a fullscreen pass that gathers neighbor contributions for each shard
 * into an intermediate RGBA texture: RGB = weighted position sum, A = weight sum.
 */
export class KLaplacianPartials {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inShards?: WebGLTexture|null,
   *   inColIdx?: WebGLTexture|null,
   *   inWeight?: WebGLTexture|null,
   *   inPosition?: WebGLTexture|null,
   *   outPartials?: WebGLTexture|null,
   *   partialsWidth?: number,
   *   partialsHeight?: number,
   *   shardTextureWidth?: number,
   *   shardTextureHeight?: number,
   *   colTextureWidth?: number,
   *   colTextureHeight?: number,
   *   positionTextureWidth?: number,
   *   positionTextureHeight?: number,
   *   shardBlockSize?: number
   * }} options
   */
  constructor(options) {
    /** @type {WebGL2RenderingContext} */
    this.gl = options.gl;

    /** @type {WebGLTexture|null} */
    this.inShards = options.inShards !== undefined ? options.inShards : null;
    /** @type {WebGLTexture|null} */
    this.inColIdx = options.inColIdx !== undefined ? options.inColIdx : null;
    /** @type {WebGLTexture|null} */
    this.inWeight = options.inWeight !== undefined ? options.inWeight : null;
    /** @type {WebGLTexture|null} */
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;

    this.partialsWidth = options.partialsWidth || 1;
    this.partialsHeight = options.partialsHeight || 1;
    this.shardTextureWidth = options.shardTextureWidth || this.partialsWidth;
    this.shardTextureHeight = options.shardTextureHeight || this.partialsHeight;
    this.colTextureWidth = options.colTextureWidth || this.partialsWidth;
    this.colTextureHeight = options.colTextureHeight || this.partialsHeight;
    this.positionTextureWidth = options.positionTextureWidth || 1;
    this.positionTextureHeight = options.positionTextureHeight || 1;
    this.shardBlockSize = options.shardBlockSize || 64;

    const outProvided = options.outPartials || options.outPartials === null;
    /** @type {WebGLTexture|null} */
    this.outPartials = outProvided
      ? options.outPartials || null
      : createRenderTexture(this.gl, this.partialsWidth, this.partialsHeight);

    /** @type {WebGLFramebuffer|null} */
    this.framebuffer = /** @type {WebGLFramebuffer|null} */ (this.gl.createFramebuffer());
    if (!this.framebuffer) throw new Error('KLaplacianPartials: failed to create framebuffer');
    if (this.outPartials) {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
      this.gl.framebufferTexture2D(
        this.gl.FRAMEBUFFER,
        this.gl.COLOR_ATTACHMENT0,
        this.gl.TEXTURE_2D,
        this.outPartials,
        0
      );
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    /** @type {WebGLProgram|null} */
    this.program = createProgram(this.gl, fullscreenVS, partialsFS);
    /** @type {WebGLVertexArrayObject|null} */
    this.vao = createFullscreenQuadVAO(this.gl);

    this.uniforms = {
      /** @type {WebGLUniformLocation|null} */ uShards: this.gl.getUniformLocation(this.program, 'uShards'),
      /** @type {WebGLUniformLocation|null} */ uColIdx: this.gl.getUniformLocation(this.program, 'uColIdx'),
      /** @type {WebGLUniformLocation|null} */ uWeight: this.gl.getUniformLocation(this.program, 'uWeight'),
      /** @type {WebGLUniformLocation|null} */ uPos: this.gl.getUniformLocation(this.program, 'uPos'),
      /** @type {WebGLUniformLocation|null} */ uShardSize: this.gl.getUniformLocation(this.program, 'uShardSize'),
      /** @type {WebGLUniformLocation|null} */ uColIdxSize: this.gl.getUniformLocation(this.program, 'uColIdxSize'),
      /** @type {WebGLUniformLocation|null} */ uPosSize: this.gl.getUniformLocation(this.program, 'uPosSize'),
      /** @type {WebGLUniformLocation|null} */ uShardBlockSize: this.gl.getUniformLocation(this.program, 'uShardBlockSize')
    };
  }

  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      shards: this.inShards && readLinear({
        gl: this.gl, texture: this.inShards, width: this.shardTextureWidth,
        height: this.shardTextureHeight, count: this.shardTextureWidth * this.shardTextureHeight,
        channels: ['start', 'end', 'reserved1', 'reserved2'], pixels
      }),
      colIdx: this.inColIdx && readLinear({
        gl: this.gl, texture: this.inColIdx, width: this.colTextureWidth,
        height: this.colTextureHeight, count: this.colTextureWidth * this.colTextureHeight,
        channels: ['idx', 'unused1', 'unused2', 'unused3'], pixels
      }),
      weight: this.inWeight && readLinear({
        gl: this.gl, texture: this.inWeight, width: this.colTextureWidth,
        height: this.colTextureHeight, count: this.colTextureWidth * this.colTextureHeight,
        channels: ['weight', 'unused1', 'unused2', 'unused3'], pixels
      }),
      position: this.inPosition && readLinear({
        gl: this.gl, texture: this.inPosition, width: this.positionTextureWidth,
        height: this.positionTextureHeight, count: this.positionTextureWidth * this.positionTextureHeight,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      partials: this.outPartials && readLinear({
        gl: this.gl, texture: this.outPartials, width: this.partialsWidth,
        height: this.partialsHeight, count: this.partialsWidth * this.partialsHeight,
        channels: ['wx', 'wy', 'wz', 'wSum'], pixels
      }),
      partialsWidth: this.partialsWidth,
      partialsHeight: this.partialsHeight,
      shardBlockSize: this.shardBlockSize,
      renderCount: this.renderCount
    };

    value.toString = () =>
      `KLaplacianPartials(${this.partialsWidth}×${this.partialsHeight}) shardBlock=${this.shardBlockSize} #${this.renderCount}

shards: ${value.shards}

colIdx: ${value.colIdx}

weight: ${value.weight}

position: ${value.position}

→ partials: ${value.partials}`;

    return value;
  }

  /**
   * Get human-readable string representation of kernel state
   * @returns {string} Compact summary
   */
  toString() {
    return this.valueOf().toString();
  }

  run() {
    const gl = this.gl;

    if (!this.outPartials)
      throw new Error('KLaplacianPartials: outPartials texture missing');
    if (!this.inShards || !this.inColIdx || !this.inWeight || !this.inPosition)
      throw new Error('KLaplacianPartials: required input textures are missing');

    gl.useProgram(this.program);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.partialsWidth, this.partialsHeight);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inShards);
    if (this.uniforms.uShards) gl.uniform1i(this.uniforms.uShards, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.inColIdx);
    if (this.uniforms.uColIdx) gl.uniform1i(this.uniforms.uColIdx, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.inWeight);
    if (this.uniforms.uWeight) gl.uniform1i(this.uniforms.uWeight, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    if (this.uniforms.uPos) gl.uniform1i(this.uniforms.uPos, 3);

    if (this.uniforms.uShardSize)
      gl.uniform2i(
        this.uniforms.uShardSize,
        this.shardTextureWidth,
        this.shardTextureHeight
      );
    if (this.uniforms.uColIdxSize)
      gl.uniform2i(
        this.uniforms.uColIdxSize,
        this.colTextureWidth,
        this.colTextureHeight
      );
    if (this.uniforms.uPosSize)
      gl.uniform2i(
        this.uniforms.uPosSize,
        this.positionTextureWidth,
        this.positionTextureHeight
      );
    if (this.uniforms.uShardBlockSize)
      gl.uniform1i(this.uniforms.uShardBlockSize, this.shardBlockSize);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);

    if (this.inShards) gl.deleteTexture(this.inShards);
    if (this.inColIdx) gl.deleteTexture(this.inColIdx);
    if (this.inWeight) gl.deleteTexture(this.inWeight);
    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.outPartials) gl.deleteTexture(this.outPartials);

    this.program = null;
    this.vao = null;
    this.framebuffer = null;
    this.inShards = null;
    this.inColIdx = null;
    this.inWeight = null;
    this.inPosition = null;
    this.outPartials = null;
  }
}

const fullscreenVS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 position;
out vec2 vUV;
void main() {
  vUV = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const partialsFS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uShards;
uniform sampler2D uColIdx;
uniform sampler2D uWeight;
uniform sampler2D uPos;

uniform ivec2 uShardSize;
uniform ivec2 uColIdxSize;
uniform ivec2 uPosSize;
uniform int uShardBlockSize;

out vec4 outPartial;

vec4 fetch1D(sampler2D tex, ivec2 size, int idx) {
  ivec2 uv = ivec2(idx % size.x, idx / size.x);
  return texelFetch(tex, uv, 0);
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int sid = coord.y * uShardSize.x + coord.x;

  vec4 shardData = fetch1D(uShards, uShardSize, sid);
  int nodeId = int(shardData.x + 0.5);
  int start = int(shardData.y + 0.5);
  int len = int(shardData.z + 0.5);
  nodeId;

  vec3 sumx = vec3(0.0);
  float wsum = 0.0;

  for (int k = 0; k < 256; k++) {
    if (k >= len || k >= uShardBlockSize) break;
    int e = start + k;
    float nbrIdx = fetch1D(uColIdx, uColIdxSize, e).x;
    int nbr = int(nbrIdx + 0.5);
    float w = fetch1D(uWeight, uColIdxSize, e).x;
    vec3 xj = fetch1D(uPos, uPosSize, nbr).xyz;
    sumx += w * xj;
    wsum += w;
  }

  outPartial = vec4(sumx, wsum);
}`;

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 */
function createProgram(gl, vertSrc, fragSrc) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  if (!vs) throw new Error('KLaplacianPartials: failed to create vertex shader');
  gl.shaderSource(vs, vertSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(vs) || 'unknown';
    gl.deleteShader(vs);
    throw new Error(`KLaplacianPartials vertex shader compile failed: ${info}`);
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!fs) throw new Error('KLaplacianPartials: failed to create fragment shader');
  gl.shaderSource(fs, fragSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(fs) || 'unknown';
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`KLaplacianPartials fragment shader compile failed: ${info}`);
  }

  const program = gl.createProgram();
  if (!program) throw new Error('KLaplacianPartials: failed to create program');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || 'unknown';
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`KLaplacianPartials program link failed: ${info}`);
  }

  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

/**
 * @param {WebGL2RenderingContext} gl
 */
function createFullscreenQuadVAO(gl) {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('KLaplacianPartials: failed to create VAO');
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('KLaplacianPartials: failed to create buffer');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const verts = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createRenderTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('KLaplacianPartials: failed to create render texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
