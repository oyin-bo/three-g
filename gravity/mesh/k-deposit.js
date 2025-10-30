// @ts-check

/**
 * KDeposit - Deposits particle mass onto mesh grid
 * 
 * Aggregates particles into 3D grid using NGP or CIC mass assignment.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import depositVertSrc from './shaders/deposit.vert.js';
import depositFragSrc from './shaders/deposit.frag.js';
import { readLinear, readGrid3D, formatNumber } from '../diag.js';

const CIC_OFFSETS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1]
];

export class KDeposit {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   outGrid?: WebGLTexture|null,
   *   particleCount?: number,
   *   particleTextureWidth?: number,
   *   particleTextureHeight?: number,
   *   gridSize?: number | [number, number, number],
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   textureWidth?: number,
   *   textureHeight?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   assignment?: 'ngp' | 'cic',
   *   disableFloatBlend?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Particle configuration
    this.particleCount = options.particleCount || 0;
    this.particleTextureWidth = options.particleTextureWidth || 0;
    this.particleTextureHeight = options.particleTextureHeight || 0;

    // Resource slots
    this.inPosition = (options.inPosition || options.inPosition === null) ? options.inPosition : createTextureRGBA32F(this.gl, this.particleTextureWidth || 1, this.particleTextureHeight || 1);
    
    // Grid configuration (process gridSize early for texture creation)
    const rawGridSize = options.gridSize || 64;
    this.gridSize = Array.isArray(rawGridSize) 
      ? rawGridSize 
      : [rawGridSize, rawGridSize, rawGridSize];
    const [Nx, Ny, Nz] = this.gridSize;
    this.slicesPerRow = options.slicesPerRow || Math.ceil(Math.sqrt(Nz));
    this.textureWidth = options.textureWidth || options.textureSize || (Nx * this.slicesPerRow);
    this.textureHeight = options.textureHeight || options.textureSize || (Ny * Math.ceil(Nz / this.slicesPerRow));
    this.textureSize = /** @deprecated */ (typeof options.textureSize === 'number' ? options.textureSize : this.textureWidth);
    
    this.outGrid = (options.outGrid || options.outGrid === null) ? options.outGrid : createGridTexture(this.gl, this.textureWidth, this.textureHeight);

    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-4, -4, -4],
      max: [4, 4, 4]
    };

    // Assignment method
    this.assignment = options.assignment || 'ngp';

    // Float blend flag
    this.disableFloatBlend = options.disableFloatBlend || false;

    // Compile and link shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, depositVertSrc);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, depositFragSrc);
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
    if (!buffer) throw new Error('Failed to create buffer');
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(this.particleCount), this.gl.STATIC_DRAW);
    this.gl.bindVertexArray(null);
    this.particleVAO = particleVAO;

    // Create FBO for output
    this.framebuffer = this.gl.createFramebuffer();
    if (!this.framebuffer) throw new Error('Failed to create framebuffer');
  }

  _createGridTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create texture');

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.textureWidth, this.textureHeight, 0, gl.RED, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    return texture;
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
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      grid: this.outGrid && readGrid3D({
        gl: this.gl, texture: this.outGrid, width: this.textureWidth,
        height: this.textureHeight, gridSize: this.gridSize[0],
        channels: ['density'], pixels, format: this.gl.R32F
      }),
      particleCount: this.particleCount,
      particleTextureWidth: this.particleTextureWidth,
      particleTextureHeight: this.particleTextureHeight,
      gridSize: [...this.gridSize],
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      worldBounds: { min: [...this.worldBounds.min], max: [...this.worldBounds.max] },
      assignment: this.assignment,
      disableFloatBlend: this.disableFloatBlend,
      renderCount: this.renderCount
    };

  const g = /** @type {any} */ (value.grid);
  const [Nx, Ny, Nz] = this.gridSize;
  const totalMass = g?.density?.mean ? g.density.mean * Nx * Ny * Nz : 0;

    value.toString = () =>
  `KDeposit(${this.particleCount} particles→${this.gridSize[0]}×${this.gridSize[1]}×${this.gridSize[2]} grid) assignment=${this.assignment} texture=${this.textureWidth}×${this.textureHeight} #${this.renderCount} bounds=[${this.worldBounds.min}]to[${this.worldBounds.max}]

position: ${value.position}

→ grid: ${value.grid ? `totalMass=${formatNumber(totalMass)} ` : ''}${value.grid}`;

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

    if (!this.inPosition) {
      throw new Error('KDeposit: inPosition texture not set');
    }
    if (!this.outGrid) {
      throw new Error('KDeposit: outGrid texture not set');
    }

    // Save GL state
    const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVP = gl.getParameter(gl.VIEWPORT);
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const prevBlend = gl.getParameter(gl.BLEND);
    const prevDepthTest = gl.getParameter(gl.DEPTH_TEST);

    // Bind FBO and attach output texture
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outGrid, 0);

    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`KDeposit: Framebuffer incomplete: ${fbStatus}`);
    }

  gl.viewport(0, 0, this.textureWidth, this.textureHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);

    gl.useProgram(this.program);

    // Bind input texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_positionTexture'), 0);

    // Set uniforms
  // Particle texture size for vertex fetch
  gl.uniform2f(gl.getUniformLocation(this.program, 'u_particleTextureSize'), this.particleTextureWidth, this.particleTextureHeight);
  // Packed grid texture size (width, height)
  gl.uniform2f(gl.getUniformLocation(this.program, 'u_textureSize'), this.textureWidth, this.textureHeight);
    gl.uniform3i(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize[0], this.gridSize[1], this.gridSize[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'), this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'), this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_particleSize'), 1.0);

    const assignmentValue = this.assignment === 'cic' ? 1 : 0;
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_assignment'), assignmentValue);

    const offsetLoc = gl.getUniformLocation(this.program, 'u_offset');
    const offsets = assignmentValue === 1 ? CIC_OFFSETS : [[0, 0, 0]];

    gl.bindVertexArray(this.particleVAO);
    for (const offset of offsets) {
      gl.uniform3f(offsetLoc, offset[0], offset[1], offset[2]);
      gl.drawArrays(gl.POINTS, 0, this.particleCount);
    }
    gl.bindVertexArray(null);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Restore GL state
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
    gl.useProgram(prevProg);
    gl.bindVertexArray(prevVAO);
    if (!prevBlend) gl.disable(gl.BLEND);
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);

    this.renderCount = (this.renderCount || 0) + 1;

    
  }

  dispose() {
    const gl = this.gl;

    if (this.program) {
      gl.deleteProgram(this.program);
    }

    if (this.particleVAO) {
      gl.deleteVertexArray(this.particleVAO);
    }

    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer);
    }

    if (this.outGrid) {
      gl.deleteTexture(this.outGrid);
    }
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
 * Helper: Create a grid texture (R32F for mass/counts)
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} [height]
 */
function createGridTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const w = width;
  const h = (height === undefined) ? width : height;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
