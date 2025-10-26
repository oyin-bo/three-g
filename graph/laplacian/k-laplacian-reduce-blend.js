// @ts-check

/**
 * KLaplacianReduceBlend - accumulate shard partials into per-particle totals.
 *
 * Issues one POINTS draw where each vertex corresponds to a shard. Uses
 * additive blending into the outAx texture. Implements the kernel contract
 * from docs/8-webgl-kernels.md.
 */

import { readLinear, formatNumber } from '../diag.js';

export class KLaplacianReduceBlend {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPartials?: WebGLTexture|null,
   *   inShards?: WebGLTexture|null,
   *   outAx?: WebGLTexture|null,
   *   axWidth?: number,
   *   axHeight?: number,
   *   shardTextureWidth?: number,
   *   shardTextureHeight?: number,
   *   shardCount?: number
   * }} options
   */
  constructor(options) {
    /** @type {WebGL2RenderingContext} */
    this.gl = options.gl;

    /** @type {WebGLTexture|null} */
    this.inPartials = options.inPartials !== undefined ? options.inPartials : null;
    /** @type {WebGLTexture|null} */
    this.inShards = options.inShards !== undefined ? options.inShards : null;

    this.axWidth = options.axWidth || 1;
    this.axHeight = options.axHeight || 1;
    this.shardTextureWidth = options.shardTextureWidth || 1;
    this.shardTextureHeight = options.shardTextureHeight || 1;
    this.shardCount = options.shardCount || (this.shardTextureWidth * this.shardTextureHeight);

    const outProvided = options.outAx || options.outAx === null;
    /** @type {WebGLTexture|null} */
    this.outAx = outProvided
      ? options.outAx || null
      : createRenderTexture(this.gl, this.axWidth, this.axHeight);

    /** @type {WebGLFramebuffer|null} */
    this.framebuffer = /** @type {WebGLFramebuffer|null} */ (this.gl.createFramebuffer());
    if (!this.framebuffer) throw new Error('KLaplacianReduceBlend: failed to create framebuffer');
    if (this.outAx) {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.framebuffer);
      this.gl.framebufferTexture2D(
        this.gl.FRAMEBUFFER,
        this.gl.COLOR_ATTACHMENT0,
        this.gl.TEXTURE_2D,
        this.outAx,
        0
      );
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
    }

    /** @type {WebGLProgram|null} */
    this.program = createProgram(this.gl, pointVS, reduceBlendFS);

    /** @type {WebGLVertexArrayObject|null} */
    this.vao = /** @type {WebGLVertexArrayObject|null} */ (this.gl.createVertexArray());
    if (!this.vao) throw new Error('KLaplacianReduceBlend: failed to create VAO');
    this.gl.bindVertexArray(this.vao);

    const buffer = /** @type {WebGLBuffer|null} */ (this.gl.createBuffer());
    if (!buffer) throw new Error('KLaplacianReduceBlend: failed to create buffer');
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const ids = new Float32Array(this.shardCount);
    for (let i = 0; i < this.shardCount; i++) ids[i] = i;
    this.gl.bufferData(this.gl.ARRAY_BUFFER, ids, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 1, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    /** @type {WebGLBuffer|null} */
    this.buffer = buffer;

    this.uniforms = {
      /** @type {WebGLUniformLocation|null} */ uPartials: this.gl.getUniformLocation(this.program, 'uPartials'),
      /** @type {WebGLUniformLocation|null} */ uShards: this.gl.getUniformLocation(this.program, 'uShards'),
      /** @type {WebGLUniformLocation|null} */ uPartialsSize: this.gl.getUniformLocation(this.program, 'uPartialsSize'),
      /** @type {WebGLUniformLocation|null} */ uShardSize: this.gl.getUniformLocation(this.program, 'uShardSize'),
      /** @type {WebGLUniformLocation|null} */ uAxSize: this.gl.getUniformLocation(this.program, 'uAxSize')
    };
  }
  
  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      partials: this.inPartials && readLinear({
        gl: this.gl, texture: this.inPartials, width: this.shardTextureWidth,
        height: this.shardTextureHeight, count: this.shardCount,
        channels: ['wx', 'wy', 'wz', 'wSum'], pixels
      }),
      shards: this.inShards && readLinear({
        gl: this.gl, texture: this.inShards, width: this.shardTextureWidth,
        height: this.shardTextureHeight, count: this.shardCount,
        channels: ['start', 'end', 'reserved1', 'reserved2'], pixels
      }),
      ax: this.outAx && readLinear({
        gl: this.gl, texture: this.outAx, width: this.axWidth,
        height: this.axHeight, count: this.axWidth * this.axHeight,
        channels: ['ax', 'ay', 'az', 'wSum'], pixels
      }),
      axWidth: this.axWidth,
      axHeight: this.axHeight,
      shardCount: this.shardCount,
      renderCount: this.renderCount
    };
    
    value.toString = () =>
`KLaplacianReduceBlend(${this.axWidth}×${this.axHeight}) shards=${this.shardCount} #${this.renderCount}

partials: ${value.partials}

shards: ${value.shards}

→ ax: ${value.ax}`;
    
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

    if (!this.outAx) throw new Error('KLaplacianReduceBlend: outAx missing');
    if (!this.inPartials || !this.inShards)
      throw new Error('KLaplacianReduceBlend: inputs missing');

    if (!this.program) throw new Error('KLaplacianReduceBlend: program missing');
    gl.useProgram(this.program);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.axWidth, this.axHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPartials);
    if (this.uniforms.uPartials) gl.uniform1i(this.uniforms.uPartials, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.inShards);
    if (this.uniforms.uShards) gl.uniform1i(this.uniforms.uShards, 1);

    if (this.uniforms.uPartialsSize)
      gl.uniform2i(this.uniforms.uPartialsSize, this.shardTextureWidth, this.shardTextureHeight);
    if (this.uniforms.uShardSize)
      gl.uniform2i(this.uniforms.uShardSize, this.shardTextureWidth, this.shardTextureHeight);
    if (this.uniforms.uAxSize)
      gl.uniform2i(this.uniforms.uAxSize, this.axWidth, this.axHeight);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, this.shardCount);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.framebuffer) gl.deleteFramebuffer(this.framebuffer);

    if (this.inPartials) gl.deleteTexture(this.inPartials);
    if (this.inShards) gl.deleteTexture(this.inShards);
    if (this.outAx) gl.deleteTexture(this.outAx);

    this.program = null;
    this.vao = null;
    this.buffer = null;
    this.framebuffer = null;
    this.inPartials = null;
    this.inShards = null;
    this.outAx = null;
  }
}

const pointVS = `#version 300 es
precision highp float;
layout(location = 0) in float aIndex;

uniform sampler2D uShards;
uniform ivec2 uShardSize;
uniform ivec2 uAxSize;

out vec2 vUV;
flat out int vShardId;

vec4 fetch1D(sampler2D tex, ivec2 size, int idx) {
  ivec2 uv = ivec2(idx % size.x, idx / size.x);
  return texelFetch(tex, uv, 0);
}

void main() {
  int sid = int(aIndex + 0.5);
  vec4 shard = fetch1D(uShards, uShardSize, sid);
  int nodeId = int(shard.x + 0.5);
  ivec2 nodePixel = ivec2(nodeId % uAxSize.x, nodeId / uAxSize.x);
  vec2 nodeUV = (vec2(nodePixel) + 0.5) / vec2(uAxSize);
  vUV = nodeUV;
  vShardId = sid;
  gl_Position = vec4(nodeUV * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

const reduceBlendFS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPartials;
uniform ivec2 uPartialsSize;

in vec2 vUV;
flat in int vShardId;
out vec4 outColor;

vec4 fetch1D(sampler2D tex, ivec2 size, int idx) {
  ivec2 uv = ivec2(idx % size.x, idx / size.x);
  return texelFetch(tex, uv, 0);
}

void main() {
  vec4 partial = fetch1D(uPartials, uPartialsSize, vShardId);
  outColor = partial;
}`;

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 */
function createProgram(gl, vertSrc, fragSrc) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  if (!vs) throw new Error('KLaplacianReduceBlend: vertex shader allocation failed');
  gl.shaderSource(vs, vertSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(vs) || 'unknown';
    gl.deleteShader(vs);
    throw new Error(`KLaplacianReduceBlend vertex shader compile failed: ${info}`);
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!fs) throw new Error('KLaplacianReduceBlend: fragment shader allocation failed');
  gl.shaderSource(fs, fragSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(fs) || 'unknown';
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`KLaplacianReduceBlend fragment shader compile failed: ${info}`);
  }

  const program = gl.createProgram();
  if (!program) throw new Error('KLaplacianReduceBlend: program allocation failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || 'unknown';
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(program);
    throw new Error(`KLaplacianReduceBlend program link failed: ${info}`);
  }

  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createRenderTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('KLaplacianReduceBlend: render texture allocation failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
