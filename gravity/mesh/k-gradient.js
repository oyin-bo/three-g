// @ts-check

/**
 * KGradient - Computes force spectra from potential spectrum
 * 
 * Calculates gradient in Fourier space to obtain force components (Fx, Fy, Fz).
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import { fsQuadVert } from '../core-shaders.js';
// Reuse the spectral gradient shader that supports non-square packed textures
import gradientFrag from '../spectral/shaders/gradient.frag.js';
import { readLinear, readGrid3D, formatNumber } from '../diag.js';

export class KGradient {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPotentialSpectrum?: WebGLTexture|null,
   *   outForceSpectrumX?: WebGLTexture|null,
   *   outForceSpectrumY?: WebGLTexture|null,
   *   outForceSpectrumZ?: WebGLTexture|null,
   *   quadVAO?: WebGLVertexArrayObject|null,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   textureWidth?: number,
   *   textureHeight?: number,
   *   worldSize?: [number,number,number]
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inPotentialSpectrum = (options.inPotentialSpectrum || options.inPotentialSpectrum === null) ? options.inPotentialSpectrum : createComplexTexture(this.gl, options.textureWidth || options.textureSize || ((options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64)))), options.textureHeight || options.textureSize || ((options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64)))));
    this.outForceSpectrumX = (options.outForceSpectrumX || options.outForceSpectrumX === null) ? options.outForceSpectrumX : createComplexTexture(this.gl, options.textureWidth || options.textureSize || ((options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64)))), options.textureHeight || options.textureSize || ((options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64)))));
    this.outForceSpectrumY = (options.outForceSpectrumY || options.outForceSpectrumY === null) ? options.outForceSpectrumY : createComplexTexture(this.gl, options.textureWidth || options.textureSize || ((options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64)))), options.textureHeight || options.textureSize || ((options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64)))));
    this.outForceSpectrumZ = (options.outForceSpectrumZ || options.outForceSpectrumZ === null) ? options.outForceSpectrumZ : createComplexTexture(this.gl, options.textureWidth || options.textureSize || ((options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64)))), options.textureHeight || options.textureSize || ((options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64)))));
    this.quadVAO = (options.quadVAO || options.quadVAO === null) ? options.quadVAO : createQuadVAO(this.gl);
    
    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || Math.ceil(Math.sqrt(this.gridSize));
  // Non-square packed 3D texture dimensions (fallback to square textureSize)
  this.textureWidth = options.textureWidth || options.textureSize || (this.gridSize * this.slicesPerRow);
  this.textureHeight = options.textureHeight || options.textureSize || (this.gridSize * Math.ceil(this.gridSize / this.slicesPerRow));
  // Legacy alias kept for backward-compat reads
  this.textureSize = /** @deprecated */ (typeof options.textureSize === 'number' ? options.textureSize : this.textureWidth);
    
    // Physics parameters
    this.worldSize = options.worldSize || [8, 8, 8];
    
    // Compile and link shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, fsQuadVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, gradientFrag);
    this.gl.compileShader(frag);
    if (!this.gl.getShaderParameter(frag, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(frag);
      this.gl.deleteShader(frag);
      throw new Error(`Fragment shader compile failed: ${info}`);
    }

    this.program = this.gl.createProgram();
    if (!this.program) throw new Error('Failed to create program');
    this.gl.attachShader(this.program, vert);
    this.gl.attachShader(this.program, frag);
    this.gl.linkProgram(this.program);
    if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.program);
      this.gl.deleteProgram(this.program);
      throw new Error(`Program link failed: ${info}`);
    }

    this.gl.deleteShader(vert);
    this.gl.deleteShader(frag);

    // Create FBOs for three output textures
    this.framebufferX = this.gl.createFramebuffer();
    this.framebufferY = this.gl.createFramebuffer();
    this.framebufferZ = this.gl.createFramebuffer();
    if (!this.framebufferX || !this.framebufferY || !this.framebufferZ) {
      throw new Error('Failed to create framebuffers');
    }
  }

  _createSpectrumTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create texture');
    
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.textureWidth, this.textureHeight, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    
    return texture;
  }

  _createQuadVAO() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Failed to create buffer');
    
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const quadData = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    
    return vao;
  }
  
  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      potentialSpectrum: this.inPotentialSpectrum && readLinear({
        gl: this.gl, texture: this.inPotentialSpectrum, width: this.textureWidth,
        height: this.textureHeight, count: this.textureWidth * this.textureHeight,
        channels: ['real', 'imag'], pixels, format: this.gl.RG32F
      }),
      forceSpectrumX: this.outForceSpectrumX && readLinear({
        gl: this.gl, texture: this.outForceSpectrumX, width: this.textureWidth,
        height: this.textureHeight, count: this.textureWidth * this.textureHeight,
        channels: ['real', 'imag'], pixels, format: this.gl.RG32F
      }),
      forceSpectrumY: this.outForceSpectrumY && readLinear({
        gl: this.gl, texture: this.outForceSpectrumY, width: this.textureWidth,
        height: this.textureHeight, count: this.textureWidth * this.textureHeight,
        channels: ['real', 'imag'], pixels, format: this.gl.RG32F
      }),
      forceSpectrumZ: this.outForceSpectrumZ && readLinear({
        gl: this.gl, texture: this.outForceSpectrumZ, width: this.textureWidth,
        height: this.textureHeight, count: this.textureWidth * this.textureHeight,
        channels: ['real', 'imag'], pixels, format: this.gl.RG32F
      }),
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      textureWidth: this.textureWidth,
      textureHeight: this.textureHeight,
      worldSize: [...this.worldSize],
      renderCount: this.renderCount
    };
    
    value.toString = () =>
`KGradient(${this.gridSize}³ grid) texture=${this.textureWidth}×${this.textureHeight} worldSize=[${this.worldSize}] #${this.renderCount}

potentialSpectrum: ${value.potentialSpectrum}

→ forceSpectrumX: ${value.forceSpectrumX}

→ forceSpectrumY: ${value.forceSpectrumY}

→ forceSpectrumZ: ${value.forceSpectrumZ}`;
    
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
    
    if (!this.inPotentialSpectrum) {
      throw new Error('KGradient: inPotentialSpectrum texture not set');
    }
    if (!this.outForceSpectrumX || !this.outForceSpectrumY || !this.outForceSpectrumZ) {
      throw new Error('KGradient: output force spectrum textures not set');
    }
    
    // Save GL state
    const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVP = gl.getParameter(gl.VIEWPORT);
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const prevBlend = gl.getParameter(gl.BLEND);
    const prevDepthTest = gl.getParameter(gl.DEPTH_TEST);
    
    gl.viewport(0, 0, this.textureWidth, this.textureHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    
    gl.useProgram(this.program);
    
    // Bind input texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPotentialSpectrum);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_potentialSpectrum'), 0);
    
    // Set uniforms
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    // Provide packed texture dimensions for non-square support
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_textureSize'), this.textureWidth, this.textureHeight);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldSize'), this.worldSize[0], this.worldSize[1], this.worldSize[2]);
    
    gl.bindVertexArray(this.quadVAO);
    
    // Render to X component
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebufferX);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceSpectrumX, 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_axis'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    // Render to Y component
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebufferY);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceSpectrumY, 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_axis'), 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    // Render to Z component
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebufferZ);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceSpectrumZ, 0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_axis'), 2);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    gl.bindVertexArray(null);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    
    // Restore GL state
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
    gl.useProgram(prevProg);
    gl.bindVertexArray(prevVAO);
    if (prevBlend) gl.enable(gl.BLEND);
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
    
    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    const gl = this.gl;
    
    if (this.program) {
      gl.deleteProgram(this.program);
    }
    
    if (this.framebufferX) gl.deleteFramebuffer(this.framebufferX);
    if (this.framebufferY) gl.deleteFramebuffer(this.framebufferY);
    if (this.framebufferZ) gl.deleteFramebuffer(this.framebufferZ);
    
    if (this.outForceSpectrumX) gl.deleteTexture(this.outForceSpectrumX);
    if (this.outForceSpectrumY) gl.deleteTexture(this.outForceSpectrumY);
    if (this.outForceSpectrumZ) gl.deleteTexture(this.outForceSpectrumZ);
    
    if (this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
    }
  }
}

/**
 * Helper: Create an RG32F complex texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} [height]
 */
function createComplexTexture(gl, width, height) {
  const w = width;
  const h = (height === undefined) ? width : height;
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, w, h, 0, gl.RG, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/**
 * Helper: Create a fullscreen quad VAO
 * @param {WebGL2RenderingContext} gl
 */
function createQuadVAO(gl) {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Failed to create VAO');
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('Failed to create buffer');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const quadVertices = new Float32Array([
    -1, -1,  1, -1,  -1, 1,  1, 1
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
