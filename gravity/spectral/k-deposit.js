// @ts-check

/**
 * KDeposit - Deposits particles to PM grid
 * 
 * Deposits particle masses onto 3D grid using additive blending.
 * Follows the WebGL2 Kernel contract similar to KAggregator.
 */

import { formatNumber, readGrid3D, readLinear } from '../diag.js';
import pmDepositFragSrc from './shaders/pm-deposit.frag.js';
import pmDepositVertSrc from './shaders/pm-deposit.vert.js';

export class KDeposit {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   outMassGrid?: WebGLTexture|null,
   *   particleCount?: number,
   *   particleTextureWidth?: number,
   *   particleTextureHeight?: number,
   *   gridSize?: number,
   *   slicesPerRow?: number,
  *   textureSize?: number,
  *   textureWidth?: number,
  *   textureHeight?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   assignment?: 'NGP'|'CIC',
   *   disableFloatBlend?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Resource slots - follow kernel contract: (truthy || === null) ? use : create
    this.inPosition = (options.inPosition || options.inPosition === null)
      ? options.inPosition
      : createTextureRGBA32F(this.gl, options.particleTextureWidth || 0, options.particleTextureHeight || 0);
    this.outMassGrid = (options.outMassGrid || options.outMassGrid === null)
      ? options.outMassGrid
      : createTextureR32F(this.gl, options.textureSize || 64, options.textureSize || 64);

    // Particle configuration
    this.particleCount = options.particleCount || 0;
    this.particleTextureWidth = options.particleTextureWidth || 0;
    this.particleTextureHeight = options.particleTextureHeight || 0;

    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;
    // 2D packed texture dimensions (may be non-square)
    this.textureWidth = options.textureWidth || options.textureSize || (this.gridSize * this.slicesPerRow);
    this.textureHeight = options.textureHeight || options.textureSize || (this.gridSize * Math.ceil(this.gridSize / this.slicesPerRow));
    this.textureSize = this.textureWidth; // legacy fallback

    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-2, -2, -2],
      max: [2, 2, 2]
    };

    // Assignment method: NGP (0) or CIC (1)
    this.assignment = options.assignment || 'CIC';

    // Float blend flag
    this.disableFloatBlend = options.disableFloatBlend || false;

    // Validate shader sources

    // Compile and link shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, pmDepositVertSrc);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info || 'no error log'}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, pmDepositFragSrc);
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

    // Create particle VAO (uses gl_VertexID)
    const particleVAO = this.gl.createVertexArray();
    if (!particleVAO) throw new Error('Failed to create VAO');
    this.gl.bindVertexArray(particleVAO);
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const particleIndices = new Float32Array(this.particleCount);
    for (let i = 0; i < this.particleCount; i++) particleIndices[i] = i;
    this.gl.bufferData(this.gl.ARRAY_BUFFER, particleIndices, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 1, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    this.particleVAO = particleVAO;

    // Create framebuffer
    this.outFramebuffer = this.gl.createFramebuffer();
    /** @type {WebGLTexture | null} */
    this._fboShadow = null;
  }

  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      position: this.inPosition && readLinear({
        gl: this.gl, texture: this.inPosition, width: this.particleTextureWidth,
        height: this.particleTextureHeight, count: this.particleCount,
        channels: ['x', 'y', 'z', 'mass'], pixels, format: this.gl.RGBA32F
      }),
      massGrid: this.outMassGrid && readGrid3D({
        gl: this.gl, texture: this.outMassGrid, width: this.textureSize,
        height: this.textureSize, gridSize: this.gridSize,
        channels: ['mass'], pixels, format: this.gl.R32F
      }),
      particleCount: this.particleCount,
      particleTextureWidth: this.particleTextureWidth,
      particleTextureHeight: this.particleTextureHeight,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      worldBounds: { min: [...this.worldBounds.min], max: [...this.worldBounds.max] },
      assignment: this.assignment,
      disableFloatBlend: this.disableFloatBlend,
      renderCount: this.renderCount
    };

    // Compute total mass deposited
    const totalMass = value.massGrid?.mass?.mean ?
      value.massGrid.mass.mean * this.gridSize * this.gridSize * this.gridSize : value.massGrid?.mass?.mean;

    value.toString = () =>
      `KDeposit(${this.particleCount} particles→${this.gridSize}³ grid) assignment=${this.assignment} texture=${this.textureSize}×${this.textureSize} #${this.renderCount} bounds=[${this.worldBounds.min}]to[${this.worldBounds.max}]

position: ${value.position}

massGrid: ${value.massGrid ? `totalMass=${formatNumber(totalMass)} ` : ''}${value.massGrid}\n\n`;

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

    if (!this.inPosition || !this.outMassGrid) {
      throw new Error('KDeposit: missing required textures');
    }

    gl.useProgram(this.program);

    // Configure framebuffer if needed
    if (this._fboShadow !== this.outMassGrid) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outMassGrid, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error(`Framebuffer incomplete: ${status}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._fboShadow = this.outMassGrid;
    }

    // Bind output framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.viewport(0, 0, this.textureWidth, this.textureHeight);

    // Clear grid
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, false, false, false); // only write R channel (R32F)

    // Enable additive blending for mass accumulation
    if (!this.disableFloatBlend) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.blendEquation(gl.FUNC_ADD);
    } else {
      gl.disable(gl.BLEND);
    }

    // Bind position texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_positionTexture'), 0);

    // Set uniforms
    // Particle position texture size (width, height)
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_particleTextureSize'),
      this.particleTextureWidth, this.particleTextureHeight);
    // Packed 3D grid texture size (width, height)
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_textureSize'), this.textureWidth, this.textureHeight);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'),
      this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'),
      this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_particleSize'), 1.0);

    const assignmentMode = this.assignment === 'NGP' ? 0 : 1;
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_assignment'), assignmentMode);

    // Draw particles
    gl.bindVertexArray(this.particleVAO);
    if (assignmentMode === 1) {
      // CIC: render 8 times with corner offsets
      const offsets = [
        [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
        [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]
      ];
      const offsetLoc = gl.getUniformLocation(this.program, 'u_cellOffset');
      for (const offset of offsets) {
        gl.uniform3f(offsetLoc, offset[0], offset[1], offset[2]);
        gl.drawArrays(gl.POINTS, 0, this.particleCount);
      }
    } else {
      // NGP: single pass
      gl.uniform3f(gl.getUniformLocation(this.program, 'u_cellOffset'), 0, 0, 0);
      gl.drawArrays(gl.POINTS, 0, this.particleCount);
    }
    gl.bindVertexArray(null);

    // Cleanup
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.renderCount = (this.renderCount || 0) + 1;


  }

  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.particleVAO) gl.deleteVertexArray(this.particleVAO);
    if (this.outFramebuffer) gl.deleteFramebuffer(this.outFramebuffer);

    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.outMassGrid) gl.deleteTexture(this.outMassGrid);

    this.inPosition = null;
    this.outMassGrid = null;
    this._fboShadow = null;
  }
}

/**
 * Helper: Create a RGBA32F texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createTextureRGBA32F(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/**
 * Helper: Create a R32F texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createTextureR32F(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
