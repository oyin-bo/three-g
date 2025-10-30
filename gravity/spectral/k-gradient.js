// @ts-check

import { fsQuadVert } from '../core-shaders.js';
import { readLinear } from '../diag.js';
import gradientFrag from './shaders/gradient.frag.js';

/**
 * KGradient - Computes force field from gravitational potential
 * 
 * Computes gradient: F = -∇φ → F(k) = -i·k·φ(k)
 * Generates three force spectrum textures (Fx, Fy, Fz)
 * Follows the WebGL2 Kernel contract.
 */
export class KGradient {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPotentialSpectrum?: WebGLTexture|null,
   *   outForceSpectrumX?: WebGLTexture|null,
   *   outForceSpectrumY?: WebGLTexture|null,
   *   outForceSpectrumZ?: WebGLTexture|null,
   *   gridSize?: number | [number, number, number],
   *   slicesPerRow?: number,
   *   textureWidth?: number,
   *   textureHeight?: number,
   *   worldSize?: [number, number, number]
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Grid configuration
    this.gridSize = Array.isArray(options.gridSize) ? options.gridSize : [options.gridSize || 64, options.gridSize || 64, options.gridSize || 64];
    this.slicesPerRow = options.slicesPerRow || 8;
    const [Nx, Ny, Nz] = this.gridSize;
    this.textureWidth = options.textureWidth || (Nx * this.slicesPerRow);
    this.textureHeight = options.textureHeight || (Ny * Math.ceil(Nz / this.slicesPerRow));

    // Resource slots
    this.inPotentialSpectrum = (options.inPotentialSpectrum || options.inPotentialSpectrum === null) ? options.inPotentialSpectrum : createComplexTexture(this.gl, this.textureWidth, this.textureHeight);
    this.outForceSpectrumX = (options.outForceSpectrumX || options.outForceSpectrumX === null) ? options.outForceSpectrumX : createComplexTexture(this.gl, this.textureWidth, this.textureHeight);
    this.outForceSpectrumY = (options.outForceSpectrumY || options.outForceSpectrumY === null) ? options.outForceSpectrumY : createComplexTexture(this.gl, this.textureWidth, this.textureHeight);
    this.outForceSpectrumZ = (options.outForceSpectrumZ || options.outForceSpectrumZ === null) ? options.outForceSpectrumZ : createComplexTexture(this.gl, this.textureWidth, this.textureHeight);

    // World size
    this.worldSize = options.worldSize || [4, 4, 4];

    // Compile shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, fsQuadVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info || 'no error log'}`);
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

    const program = this.gl.createProgram();
    if (!program) throw new Error('Failed to create program');
    this.gl.attachShader(program, vert);
    this.gl.attachShader(program, frag);
    this.gl.linkProgram(program);
    if (!this.gl.getProgramParameter(program, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(program);
      this.gl.deleteProgram(program);
      throw new Error(`Program link failed: ${info}`);
    }

    this.gl.deleteShader(vert);
    this.gl.deleteShader(frag);
    this.program = program;

    // Create quad VAO
    const quadVAO = this.gl.createVertexArray();
    if (!quadVAO) throw new Error('Failed to create VAO');
    this.gl.bindVertexArray(quadVAO);
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const quadVertices = new Float32Array([
      -1, -1, 1, -1, -1, 1, 1, 1
    ]);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, quadVertices, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    this.quadVAO = quadVAO;

    // Create framebuffers (one per axis)
    this.outFramebufferX = this.gl.createFramebuffer();
    this.outFramebufferY = this.gl.createFramebuffer();
    this.outFramebufferZ = this.gl.createFramebuffer();

    /** @type {{ x: WebGLTexture, y: WebGLTexture, z: WebGLTexture } | null} */
    this._fboShadow = null;
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
      textureWidth: this.textureWidth,
      textureHeight: this.textureHeight,
      worldSize: [...this.worldSize],
      renderCount: this.renderCount
    };

    value.toString = () =>
      `KGradient(${this.gridSize.join('x')} grid) texture=${this.textureWidth}×${this.textureHeight} worldSize=[${this.worldSize}] #${this.renderCount}

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

  /**
   * Run the kernel (synchronous)
   */
  run() {
    const gl = this.gl;

    if (!this.inPotentialSpectrum || !this.outForceSpectrumX || !this.outForceSpectrumY || !this.outForceSpectrumZ) {
      throw new Error('KGradient: missing required textures');
    }

    gl.useProgram(this.program);

    // Configure framebuffers if needed
    if (!this._fboShadow ||
      this._fboShadow.x !== this.outForceSpectrumX ||
      this._fboShadow.y !== this.outForceSpectrumY ||
      this._fboShadow.z !== this.outForceSpectrumZ) {

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebufferX);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceSpectrumX, 0);
      let status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer X incomplete: ${status}`);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebufferY);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceSpectrumY, 0);
      status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer Y incomplete: ${status}`);

      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebufferZ);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceSpectrumZ, 0);
      status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`Framebuffer Z incomplete: ${status}`);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._fboShadow = {
        x: this.outForceSpectrumX,
        y: this.outForceSpectrumY,
        z: this.outForceSpectrumZ
      };
    }

    gl.viewport(0, 0, this.textureWidth, this.textureHeight);

    // Setup GL state
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);

    // Bind input potential spectrum
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPotentialSpectrum);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_potentialSpectrum'), 0);

    // Set common uniforms
    gl.uniform3iv(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    // Provide packed 3D texture dims
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_textureSize'), this.textureWidth, this.textureHeight);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldSize'),
      this.worldSize[0], this.worldSize[1], this.worldSize[2]);

    // Compute gradient for each axis
    const axes = [
      { index: 0, framebuffer: this.outFramebufferX },
      { index: 1, framebuffer: this.outFramebufferY },
      { index: 2, framebuffer: this.outFramebufferZ }
    ];

    for (const axis of axes) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, axis.framebuffer);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_axis'), axis.index);
      gl.bindVertexArray(this.quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    }

    // Cleanup
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);


    this.renderCount = (this.renderCount || 0) + 1;

  }

  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebufferX) gl.deleteFramebuffer(this.outFramebufferX);
    if (this.outFramebufferY) gl.deleteFramebuffer(this.outFramebufferY);
    if (this.outFramebufferZ) gl.deleteFramebuffer(this.outFramebufferZ);

    if (this.inPotentialSpectrum) {
      gl.deleteTexture(this.inPotentialSpectrum);
      this.inPotentialSpectrum = null;
    }
    if (this.outForceSpectrumX) {
      gl.deleteTexture(this.outForceSpectrumX);
      this.outForceSpectrumX = null;
    }
    if (this.outForceSpectrumY) {
      gl.deleteTexture(this.outForceSpectrumY);
      this.outForceSpectrumY = null;
    }
    if (this.outForceSpectrumZ) {
      gl.deleteTexture(this.outForceSpectrumZ);
      this.outForceSpectrumZ = null;
    }
    this._fboShadow = null;
  }
}

/**
 * Helper: Create an RG32F complex texture
 * Accepts either (gl, size) for square textures or (gl, width, height)
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
