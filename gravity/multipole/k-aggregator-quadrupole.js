// @ts-check

/**
 * AggregatorQuadrupoleKernel - Aggregates particles into L0 octree level with occupancy
 * 
 * Quadrupole-specific aggregator that deposits particle moments AND occupancy.
 * Outputs four MRT attachments: A0 (monopole), A1 (quadrupole xx,yy,zz,xy), A2 (quadrupole xz,yz), Occupancy.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import { readGrid3D, readLinear } from '../diag.js';
import aggregationQuadrupoleFrag from './shaders/aggregation-quadrupole.frag.js';
import aggregationQuadrupoleVert from './shaders/aggregation-quadrupole.vert.js';


export class KAggregatorQuadrupole {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inBounds?: WebGLTexture|null,
   *   outA0?: WebGLTexture|null,
   *   outA1?: WebGLTexture|null,
   *   outA2?: WebGLTexture|null,
   *   outOccupancy?: WebGLTexture|null,
   *   particleCount?: number,
   *   particleTextureWidth?: number,
   *   particleTextureHeight?: number,
   *   octreeSize?: number,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   disableFloatBlend?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Particle configuration
    this.particleCount = options.particleCount || 0;
    this.particleTextureWidth = options.particleTextureWidth || 0;
    this.particleTextureHeight = options.particleTextureHeight || 0;

    // Octree configuration
    this.octreeSize = options.octreeSize || 512;

    // Resource slots - create textures if not provided per kernel contract
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;
    this.inBounds = options.inBounds !== undefined ? options.inBounds : null;
    const { outA0, outA1, outA2, outOccupancy } = options;
    // Use RGBA32F for MRT - floating-point precision required for particle data
    this.outA0 = (outA0 || outA0 === null) ? outA0 : createTextureRGBA32F(this.gl, this.octreeSize, this.octreeSize);
    this.outA1 = (outA1 || outA1 === null) ? outA1 : createTextureRGBA32F(this.gl, this.octreeSize, this.octreeSize);
    this.outA2 = (outA2 || outA2 === null) ? outA2 : createTextureRGBA32F(this.gl, this.octreeSize, this.octreeSize);
    this.outOccupancy = (outOccupancy || outOccupancy === null) ? outOccupancy : createTextureRGBA32F(this.gl, this.octreeSize, this.octreeSize);

    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;

    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-4, -4, 0],
      max: [4, 4, 2]
    };

    // Float blend flag
    this.disableFloatBlend = options.disableFloatBlend || false;

    // Compile and link shader program (inline, like KPyramidBuild)
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, aggregationQuadrupoleVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, aggregationQuadrupoleFrag);
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

    // Create framebuffer with 4 MRT attachments (A0, A1, A2, Occupancy)
    this.outFramebuffer = this.gl.createFramebuffer();
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.outFramebuffer);
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.outA0, 0);
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT1, this.gl.TEXTURE_2D, this.outA1, 0);
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT2, this.gl.TEXTURE_2D, this.outA2, 0);
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT3, this.gl.TEXTURE_2D, this.outOccupancy, 0);
    this.gl.drawBuffers([this.gl.COLOR_ATTACHMENT0, this.gl.COLOR_ATTACHMENT1, this.gl.COLOR_ATTACHMENT2, this.gl.COLOR_ATTACHMENT3]);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
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
      bounds: this.inBounds && readLinear({
        gl: this.gl, texture: this.inBounds, width: 2, height: 1, count: 2,
        channels: ['x', 'y', 'z', 'w'], pixels
      }),
      a0: this.outA0 && readGrid3D({
        gl: this.gl, texture: this.outA0, width: this.octreeSize,
        height: this.octreeSize, gridSize: this.gridSize,
        channels: ['cx', 'cy', 'cz', 'mass'], pixels
      }),
      a1: this.outA1 && readGrid3D({
        gl: this.gl, texture: this.outA1, width: this.octreeSize,
        height: this.octreeSize, gridSize: this.gridSize,
        channels: ['xx', 'yy', 'zz', 'xy'], pixels
      }),
      a2: this.outA2 && readGrid3D({
        gl: this.gl, texture: this.outA2, width: this.octreeSize,
        height: this.octreeSize, gridSize: this.gridSize,
        channels: ['xz', 'yz', 'unused1', 'unused2'], pixels
      }),
      occupancy: this.outOccupancy && readGrid3D({
        gl: this.gl, texture: this.outOccupancy, width: this.octreeSize,
        height: this.octreeSize, gridSize: this.gridSize,
        channels: ['mask0', 'mask1', 'mask2', 'mask3'], pixels
      }),
      particleCount: this.particleCount,
      particleTextureWidth: this.particleTextureWidth,
      particleTextureHeight: this.particleTextureHeight,
      octreeSize: this.octreeSize,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      worldBounds: { min: [...this.worldBounds.min], max: [...this.worldBounds.max] },
      disableFloatBlend: this.disableFloatBlend,
      renderCount: this.renderCount
    };

    value.toString = () =>
      `KAggregatorQuadrupole(${this.particleCount} particles→${this.gridSize}³ grid) octree=${this.octreeSize}×${this.octreeSize} slices=${this.slicesPerRow} #${this.renderCount} bounds=[${this.worldBounds.min}]to[${this.worldBounds.max}]

position: ${value.position}

bounds: ${value.bounds}

A0 (monopole): ${value.a0}

A1 (quadrupole xx,yy,zz,xy): ${value.a1}

A2 (quadrupole xz,yz): ${value.a2}

Occupancy: ${value.occupancy}`;

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

    if (!this.inPosition || !this.outA0 || !this.outA1 || !this.outA2 || !this.outOccupancy) {
      throw new Error('KAggregatorQuadrupole: missing required textures');
    }

    // Clear any pending GL errors
    while (gl.getError() !== gl.NO_ERROR) { }

    gl.useProgram(this.program);

    // Unbind all texture units to avoid feedback
    for (let i = 0; i < 8; i++) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    // Bind framebuffer and set viewport with 4 MRT attachments
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2, gl.COLOR_ATTACHMENT3]);
    gl.viewport(0, 0, this.octreeSize, this.octreeSize);
    gl.disable(gl.SCISSOR_TEST);

    // Setup GL state for rendering (match monolithic exactly)
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.colorMask(true, true, true, true);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);

    // Clear output textures
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Enable additive blending for accumulation
    // Note: Even without EXT_float_blend, we must enable blending for accumulation to work.
    // Without the extension, precision may be reduced, but particles will still accumulate.
    // Disabling blending entirely would cause only the last particle to be visible.
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);

    // Bind position texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    const u_positions = gl.getUniformLocation(this.program, 'u_positions');
    gl.uniform1i(u_positions, 0);

    // Bind bounds texture if available (Phase 1: GPU-resident bounds)
    if (this.inBounds) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.inBounds);
      const u_bounds = gl.getUniformLocation(this.program, 'u_bounds');
      gl.uniform1i(u_bounds, 1);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_useBoundsTexture'), 1);
    } else {
      // Fallback to uniform bounds (initial frames before first bounds update)
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_useBoundsTexture'), 0);
      const u_worldMin = gl.getUniformLocation(this.program, 'u_worldMin');
      const u_worldMax = gl.getUniformLocation(this.program, 'u_worldMax');
      gl.uniform3f(u_worldMin,
        this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
      gl.uniform3f(u_worldMax,
        this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    }

    // Set other uniforms
    const u_texSize = gl.getUniformLocation(this.program, 'u_texSize');
    const u_gridSize = gl.getUniformLocation(this.program, 'u_gridSize');
    const u_slicesPerRow = gl.getUniformLocation(this.program, 'u_slicesPerRow');

    gl.uniform2f(u_texSize, this.particleTextureWidth, this.particleTextureHeight);
    gl.uniform1f(u_gridSize, this.gridSize);
    gl.uniform1f(u_slicesPerRow, this.slicesPerRow);

    // Draw particles as points
    gl.bindVertexArray(this.particleVAO);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.bindVertexArray(null);

    // Cleanup
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (this.inBounds) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }

    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.particleVAO) gl.deleteVertexArray(this.particleVAO);
    if (this.outFramebuffer) gl.deleteFramebuffer(this.outFramebuffer);

    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.outA0) gl.deleteTexture(this.outA0);
    if (this.outA1) gl.deleteTexture(this.outA1);
    if (this.outA2) gl.deleteTexture(this.outA2);
    if (this.outOccupancy) gl.deleteTexture(this.outOccupancy);
  }
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @returns {WebGLTexture}
 */
function createTextureRGBA32F(gl, width, height) {
  const fmt = gl.RGBA32F;
  const tp = gl.FLOAT;

  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt, width, height, 0, gl.RGBA, tp, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}


