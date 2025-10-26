// @ts-check

/**
 * KLaplacianFinish - final Laplacian force assembly pass.
 *
 * Computes F_attr = k * (Ax - deg * x) and writes the result into outForce.
 * Uses additive blending by default so multiple force contributors may
 * accumulate into the same render target.
 */

import { readLinear, formatNumber } from '../diag.js';

export class KLaplacianFinish {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inAx?: WebGLTexture|null,
   *   inDeg?: WebGLTexture|null,
   *   inPosition?: WebGLTexture|null,
   *   outForce?: WebGLTexture|null,
   *   outForceFramebuffer?: WebGLFramebuffer|null,
   *   forceWidth?: number,
   *   forceHeight?: number,
   *   axWidth?: number,
   *   axHeight?: number,
   *   degWidth?: number,
   *   degHeight?: number,
   *   positionWidth?: number,
   *   positionHeight?: number,
   *   springK?: number,
   *   enableBlend?: boolean
   * }} options
   */
  constructor(options) {
    /** @type {WebGL2RenderingContext} */
    this.gl = options.gl;

    /** @type {WebGLTexture|null} */
    this.inAx = options.inAx !== undefined ? options.inAx : null;
    /** @type {WebGLTexture|null} */
    this.inDeg = options.inDeg !== undefined ? options.inDeg : null;
    /** @type {WebGLTexture|null} */
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;

    this.axWidth = options.axWidth || 1;
    this.axHeight = options.axHeight || 1;
    this.degWidth = options.degWidth || 1;
    this.degHeight = options.degHeight || 1;
    this.positionWidth = options.positionWidth || 1;
    this.positionHeight = options.positionHeight || 1;
    this.forceWidth = options.forceWidth || this.positionWidth;
    this.forceHeight = options.forceHeight || this.positionHeight;

    const outForceProvided = options.outForce || options.outForce === null;
    /** @type {WebGLTexture|null} */
    this.outForce = outForceProvided
      ? options.outForce || null
      : createRenderTexture(this.gl, this.forceWidth, this.forceHeight);

    const framebufferProvided = options.outForceFramebuffer || options.outForceFramebuffer === null;
    /** @type {WebGLFramebuffer|null} */
    this.outForceFramebuffer = framebufferProvided
      ? options.outForceFramebuffer || null
      : (this.outForce ? createFramebuffer(this.gl, this.outForce) : null);

    this.springK = options.springK !== undefined ? options.springK : 0.01;
    this.enableBlend = options.enableBlend !== undefined ? options.enableBlend : true;

    /** @type {WebGLProgram|null} */
    this.program = createProgram(this.gl, fullscreenVS, finishFS);
    /** @type {WebGLVertexArrayObject|null} */
    this.vao = createFullscreenQuadVAO(this.gl);

    this.uniforms = {
      /** @type {WebGLUniformLocation|null} */ uAx: this.gl.getUniformLocation(this.program, 'uAx'),
      /** @type {WebGLUniformLocation|null} */ uDeg: this.gl.getUniformLocation(this.program, 'uDeg'),
      /** @type {WebGLUniformLocation|null} */ uPos: this.gl.getUniformLocation(this.program, 'uPos'),
      /** @type {WebGLUniformLocation|null} */ uAxSize: this.gl.getUniformLocation(this.program, 'uAxSize'),
      /** @type {WebGLUniformLocation|null} */ uDegSize: this.gl.getUniformLocation(this.program, 'uDegSize'),
      /** @type {WebGLUniformLocation|null} */ uPosSize: this.gl.getUniformLocation(this.program, 'uPosSize'),
      /** @type {WebGLUniformLocation|null} */ uK: this.gl.getUniformLocation(this.program, 'uK')
    };
  }
  
  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      ax: this.inAx && readLinear({
        gl: this.gl, texture: this.inAx, width: this.axWidth,
        height: this.axHeight, count: this.axWidth * this.axHeight,
        channels: ['ax', 'ay', 'az', 'wSum'], pixels
      }),
      deg: this.inDeg && readLinear({
        gl: this.gl, texture: this.inDeg, width: this.degWidth,
        height: this.degHeight, count: this.degWidth * this.degHeight,
        channels: ['degree', 'unused1', 'unused2', 'unused3'], pixels
      }),
      position: this.inPosition && readLinear({
        gl: this.gl, texture: this.inPosition, width: this.positionWidth,
        height: this.positionHeight, count: this.positionWidth * this.positionHeight,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      force: this.outForce && readLinear({
        gl: this.gl, texture: this.outForce, width: this.forceWidth,
        height: this.forceHeight, count: this.forceWidth * this.forceHeight,
        channels: ['fx', 'fy', 'fz', 'unused'], pixels
      }),
      forceWidth: this.forceWidth,
      forceHeight: this.forceHeight,
      springK: this.springK,
      enableBlend: this.enableBlend,
      renderCount: this.renderCount
    };
    
    // Compute total force magnitude
    const totalForce = value.force?.fx ? 
      Math.sqrt(value.force.fx.mean ** 2 + value.force.fy.mean ** 2 + value.force.fz.mean ** 2) : 0;
    
    value.toString = () =>
`KLaplacianFinish(${this.forceWidth}×${this.forceHeight}) springK=${formatNumber(this.springK)} blend=${this.enableBlend} #${this.renderCount}

ax: ${value.ax}

deg: ${value.deg}

position: ${value.position}

→ force: ${value.force ? `totalForceMag=${formatNumber(totalForce)} ` : ''}${value.force}`;
    
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

    if (!this.program) throw new Error('KLaplacianFinish: program missing');
    if (!this.outForceFramebuffer) throw new Error('KLaplacianFinish: framebuffer missing');
    if (!this.outForce) throw new Error('KLaplacianFinish: outForce texture missing');
    if (!this.inAx || !this.inDeg || !this.inPosition)
      throw new Error('KLaplacianFinish: required inputs missing');

    gl.useProgram(this.program);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outForceFramebuffer);
    gl.viewport(0, 0, this.forceWidth, this.forceHeight);

    if (this.enableBlend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inAx);
    if (this.uniforms.uAx) gl.uniform1i(this.uniforms.uAx, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.inDeg);
    if (this.uniforms.uDeg) gl.uniform1i(this.uniforms.uDeg, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    if (this.uniforms.uPos) gl.uniform1i(this.uniforms.uPos, 2);

    if (this.uniforms.uAxSize)
      gl.uniform2i(this.uniforms.uAxSize, this.axWidth, this.axHeight);
    if (this.uniforms.uDegSize)
      gl.uniform2i(this.uniforms.uDegSize, this.degWidth, this.degHeight);
    if (this.uniforms.uPosSize)
      gl.uniform2i(this.uniforms.uPosSize, this.positionWidth, this.positionHeight);
    if (this.uniforms.uK)
      gl.uniform1f(this.uniforms.uK, this.springK);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    
    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.outForceFramebuffer) gl.deleteFramebuffer(this.outForceFramebuffer);

    if (this.inAx) gl.deleteTexture(this.inAx);
    if (this.inDeg) gl.deleteTexture(this.inDeg);
    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.outForce) gl.deleteTexture(this.outForce);

    this.program = null;
    this.vao = null;
    this.outForceFramebuffer = null;
    this.inAx = null;
    this.inDeg = null;
    this.inPosition = null;
    this.outForce = null;
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

const finishFS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uAx;
uniform sampler2D uDeg;
uniform sampler2D uPos;

uniform ivec2 uAxSize;
uniform ivec2 uDegSize;
uniform ivec2 uPosSize;
uniform float uK;

out vec4 outForce;

vec4 fetch1D(sampler2D tex, ivec2 size, int idx) {
  ivec2 uv = ivec2(idx % size.x, idx / size.x);
  return texelFetch(tex, uv, 0);
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int i = coord.y * uPosSize.x + coord.x;

  vec3 Ax = fetch1D(uAx, uAxSize, i).xyz;
  float deg = fetch1D(uDeg, uDegSize, i).x;
  vec3 xi = fetch1D(uPos, uPosSize, i).xyz;

  vec3 F_attr = uK * (Ax - deg * xi);
  outForce = vec4(F_attr, 0.0);
}`;

/**
 * @param {WebGL2RenderingContext} gl
 * @param {string} vertSrc
 * @param {string} fragSrc
 */
function createProgram(gl, vertSrc, fragSrc) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  if (!vs) throw new Error('KLaplacianFinish: vertex shader allocation failed');
  gl.shaderSource(vs, vertSrc);
  gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(vs) || 'unknown';
    gl.deleteShader(vs);
    throw new Error(`KLaplacianFinish vertex shader compile failed: ${info}`);
  }

  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  if (!fs) throw new Error('KLaplacianFinish: fragment shader allocation failed');
  gl.shaderSource(fs, fragSrc);
  gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(fs) || 'unknown';
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`KLaplacianFinish fragment shader compile failed: ${info}`);
  }

  const program = gl.createProgram();
  if (!program) throw new Error('KLaplacianFinish: program allocation failed');
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program) || 'unknown';
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    gl.deleteProgram(program);
    throw new Error(`KLaplacianFinish program link failed: ${info}`);
  }

  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

/**
 * @param {WebGL2RenderingContext} gl
 */
function createFullscreenQuadVAO(gl) {
  const vao = /** @type {WebGLVertexArrayObject|null} */ (gl.createVertexArray());
  if (!vao) throw new Error('KLaplacianFinish: failed to create VAO');
  gl.bindVertexArray(vao);
  const buffer = /** @type {WebGLBuffer|null} */ (gl.createBuffer());
  if (!buffer) throw new Error('KLaplacianFinish: failed to create buffer');
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
 * @param {WebGLTexture} texture
 */
function createFramebuffer(gl, texture) {
  const fbo = /** @type {WebGLFramebuffer|null} */ (gl.createFramebuffer());
  if (!fbo) throw new Error('KLaplacianFinish: failed to create framebuffer');
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createRenderTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('KLaplacianFinish: render texture allocation failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
