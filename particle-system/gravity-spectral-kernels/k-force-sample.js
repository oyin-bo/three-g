// @ts-check

/**
 * KForceSample - Samples force field at particle positions
 * 
 * Samples forces from PM grids at particle positions using trilinear interpolation.
 * Follows the WebGL2 Kernel contract.
 */

import forceSampleFrag from './shaders/force-sample.frag.js';
import forceSampleVert from './shaders/force-sample.vert.js';
import { readLinear, readGrid3D, formatNumber } from '../diag.js';

export class KForceSample {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inForceGridX?: WebGLTexture|null,
   *   inForceGridY?: WebGLTexture|null,
   *   inForceGridZ?: WebGLTexture|null,
   *   outForce?: WebGLTexture|null,
   *   particleCount?: number,
   *   particleTexWidth?: number,
   *   particleTexHeight?: number,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   accumulate?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Resource slots
    this.inPosition = (options.inPosition || options.inPosition === null) ? options.inPosition : createTextureRGBA32F(this.gl, options.particleTexWidth || 1, options.particleTexHeight || 1);
    this.inForceGridX = (options.inForceGridX || options.inForceGridX === null) ? options.inForceGridX : createComplexTexture(this.gl, options.gridSize || 64);
    this.inForceGridY = (options.inForceGridY || options.inForceGridY === null) ? options.inForceGridY : createComplexTexture(this.gl, options.gridSize || 64);
    this.inForceGridZ = (options.inForceGridZ || options.inForceGridZ === null) ? options.inForceGridZ : createComplexTexture(this.gl, options.gridSize || 64);
    this.outForce = (options.outForce || options.outForce === null) ? options.outForce : createTextureRGBA32F(this.gl, options.particleTexWidth || 1, options.particleTexHeight || 1);

    // Particle configuration
    this.particleCount = options.particleCount || 0;
    this.particleTexWidth = options.particleTexWidth || 0;
    this.particleTexHeight = options.particleTexHeight || 0;

    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;

    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-2, -2, -2],
      max: [2, 2, 2]
    };

    // Accumulate flag
    this.accumulate = options.accumulate || false;

    // Compile and link shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, forceSampleVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, forceSampleFrag);
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
    const textureSize = this.gridSize * this.slicesPerRow;
    const value = {
      position: this.inPosition && readLinear({
        gl: this.gl, texture: this.inPosition, width: this.particleTexWidth,
        height: this.particleTexHeight, count: this.particleCount,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      forceGridX: this.inForceGridX && readGrid3D({
        gl: this.gl, texture: this.inForceGridX, width: textureSize,
        height: textureSize, gridSize: this.gridSize,
        channels: ['fx'], pixels, format: this.gl.R32F
      }),
      forceGridY: this.inForceGridY && readGrid3D({
        gl: this.gl, texture: this.inForceGridY, width: textureSize,
        height: textureSize, gridSize: this.gridSize,
        channels: ['fy'], pixels, format: this.gl.R32F
      }),
      forceGridZ: this.inForceGridZ && readGrid3D({
        gl: this.gl, texture: this.inForceGridZ, width: textureSize,
        height: textureSize, gridSize: this.gridSize,
        channels: ['fz'], pixels, format: this.gl.R32F
      }),
      force: this.outForce && readLinear({
        gl: this.gl, texture: this.outForce, width: this.particleTexWidth,
        height: this.particleTexHeight, count: this.particleCount,
        channels: ['fx', 'fy', 'fz', 'unused'], pixels
      }),
      particleCount: this.particleCount,
      particleTexWidth: this.particleTexWidth,
      particleTexHeight: this.particleTexHeight,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      worldBounds: { min: [...this.worldBounds.min], max: [...this.worldBounds.max] },
      accumulate: this.accumulate,
      renderCount: this.renderCount
    };

    const totalForce = value.force?.fx ? Math.sqrt(value.force.fx.mean ** 2 + value.force.fy.mean ** 2 + value.force.fz.mean ** 2) : 0;

    value.toString = () =>
      `KForceSample(${this.particleCount} particles from ${this.gridSize}³ grid) accumulate=${this.accumulate} #${this.renderCount} bounds=[${this.worldBounds.min}]to[${this.worldBounds.max}]

position: ${value.position}

forceGridX: ${value.forceGridX}
forceGridY: ${value.forceGridY}
forceGridZ: ${value.forceGridZ}

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


  /**
   * Run the kernel (synchronous)
   */
  run() {
    const gl = this.gl;

    if (!this.inPosition || !this.inForceGridX || !this.inForceGridY || !this.inForceGridZ || !this.outForce) {
      throw new Error('KForceSample: missing required textures');
    }

    gl.useProgram(this.program);

    // Configure framebuffer if needed
    if (this._fboShadow !== this.outForce) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForce, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error(`Framebuffer incomplete: ${status}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._fboShadow = this.outForce;
    }

    // Bind output framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.viewport(0, 0, this.particleTexWidth, this.particleTexHeight);

    // Setup GL state
    if (this.accumulate) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.blendEquation(gl.FUNC_ADD);
    } else {
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);

    // Bind position texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_positionTexture'), 0);

    // Bind force grid textures
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.inForceGridX);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_forceGridX'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.inForceGridY);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_forceGridY'), 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.inForceGridZ);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_forceGridZ'), 3);

    // Set uniforms
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_textureSize'),
      this.particleTexWidth, this.particleTexHeight);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'),
      this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'),
      this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);

    // Draw particles
    gl.bindVertexArray(this.particleVAO);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.bindVertexArray(null);

    // Cleanup
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
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
    if (this.inForceGridX) gl.deleteTexture(this.inForceGridX);
    if (this.inForceGridY) gl.deleteTexture(this.inForceGridY);
    if (this.inForceGridZ) gl.deleteTexture(this.inForceGridZ);
    if (this.outForce) gl.deleteTexture(this.outForce);

    this.inPosition = null;
    this.inForceGridX = null;
    this.inForceGridY = null;
    this.inForceGridZ = null;
    this.outForce = null;
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
 * Helper: Create an RG32F complex texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} size
 */
function createComplexTexture(gl, size) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, size, size, 0, gl.RG, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
