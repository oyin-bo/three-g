// @ts-check

/**
 * TraversalKernel - Monopole Barnes-Hut tree traversal
 * 
 * Traverses the octree hierarchy to compute gravitational forces using monopole approximation.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import { fsQuadVert } from '../core-shaders.js';
import { formatNumber, readLinear } from '../diag.js';
import traversalFrag from './shaders/traversal.frag.js';

export class KTraversal {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inLevelA0?: WebGLTexture[],
   *   outForce?: WebGLTexture|null,
   *   particleTexWidth?: number,
   *   particleTexHeight?: number,
   *   numLevels?: number,
   *   levelConfigs?: Array<{size: number, gridSize: number, slicesPerRow: number}>,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   theta?: number,
   *   gravityStrength?: number,
   *   softening?: number
   * }} params
   */
  constructor({
    gl,
    inPosition,
    inLevelA0,
    outForce,
    particleTexWidth = 0,
    particleTexHeight = 0,
    numLevels = 7,
    levelConfigs = [],
    worldBounds = { min: [-4, -4, 0], max: [4, 4, 2] },
    theta = 0.5,
    gravityStrength = 0.0003,
    softening = 0.2
  }) {
    this.gl = gl;

    // Particle texture dimensions
    this.particleTexWidth = particleTexWidth;
    this.particleTexHeight = particleTexHeight;

    // Resource slots - follow kernel contract: (truthy || === null) ? use : create
    this.inPosition = (inPosition || inPosition === null)
      ? inPosition
      : createTextureRGBA32F(this.gl, this.particleTexWidth, this.particleTexHeight);

    this.inLevelA0 = (inLevelA0 || inLevelA0 === null)
      ? inLevelA0
      : [];

    // Allocate outForce if not provided (truthy) or explicitly null
    this.outForce = (outForce || outForce === null)
      ? outForce
      : createTextureRGBA32F(this.gl, this.particleTexWidth, this.particleTexHeight);

    // Octree configuration
    this.numLevels = numLevels;
    this.levelConfigs = levelConfigs;

    // World bounds
    this.worldBounds = worldBounds;

    // Physics parameters
    this.theta = theta;
    this.gravityStrength = gravityStrength;
    this.softening = softening;

    // Create shader program
    // Compile and link shader program (inline, like KPyramidBuild)
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
    this.gl.shaderSource(frag, traversalFrag);
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

    // Create quad VAO
    const quadVAO = this.gl.createVertexArray();
    if (!quadVAO) throw new Error('Failed to create VAO');
    this.gl.bindVertexArray(quadVAO);
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const quadVertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, quadVertices, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    this.quadVAO = quadVAO;

    // Create an internal framebuffer (configured per-run). Keep a shadow
    // of attachments so run() can rebind only when they change.
    this.outFramebuffer = this.gl.createFramebuffer();
    /** @type {{ a0: WebGLTexture } | null} */
    this._fboShadow = null;
  }

  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      position: this.inPosition && readLinear({
        gl: this.gl, texture: this.inPosition, width: this.particleTexWidth,
        height: this.particleTexHeight, count: this.particleTexWidth * this.particleTexHeight,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      force: this.outForce && readLinear({
        gl: this.gl, texture: this.outForce, width: this.particleTexWidth,
        height: this.particleTexHeight, count: this.particleTexWidth * this.particleTexHeight,
        channels: ['fx', 'fy', 'fz', 'w'], pixels: true
      }),
      levels: this.inLevelA0 && this.inLevelA0.map((tex, i) => tex && (() => {
        const { gridSize = 1, slicesPerRow = 1, size = 0 } = this.levelConfigs[i] || {};
        return {
          level: i,
          ...readLinear({
            gl: this.gl,
            texture: tex,
            width: gridSize * slicesPerRow,
            height: Math.ceil(gridSize / slicesPerRow) * gridSize,
            count: size,
            channels: ['cx', 'cy', 'cz', 'mass'],
            pixels
          })
        };
      })()).filter(Boolean),
      particleTexWidth: this.particleTexWidth,
      particleTexHeight: this.particleTexHeight,
      numLevels: this.numLevels,
      theta: this.theta,
      gravityStrength: this.gravityStrength,
      softening: this.softening,
      worldBounds: { min: [...this.worldBounds.min], max: [...this.worldBounds.max] },
      totalForce: 0,
      renderCount: this.renderCount
    };

    // Calculate total force as sum of individual particle force magnitudes
    if (value.force?.pixels && value.force.pixels.length > 0) {
      let totalMag = 0;
      for (const pixel of value.force.pixels) {
        const mag = Math.sqrt(pixel.fx ** 2 + pixel.fy ** 2 + pixel.fz ** 2);
        totalMag += mag;
      }
      value.totalForce = totalMag;
    } else {
      value.totalForce = 0;
    }

    value.toString = () =>
      `KTraversal(${this.particleTexWidth}×${this.particleTexHeight}) theta=${this.theta} G=${this.gravityStrength} soft=${this.softening} levels=${this.numLevels} #${this.renderCount} bounds=[${this.worldBounds.min}]to[${this.worldBounds.max}]

position: ${value.position}

force: ${value.force ? `totalForceMag=${formatNumber(value.totalForce)} ` : ''}${value.force}

${!value.levels ? 'L:none' : value.levels.map(l => `L${l.level}:\n${l.toString()}\n`).join('\n')}`;

    return value;
  }

  /**
   * Get human-readable string representation of kernel state
   * @returns {string} Markdown-formatted summary
   */
  toString() {
    return this.valueOf().toString();
  }

  /**
   * Run the kernel (synchronous)
   */
  run() {
    if (!this.inPosition || !this.outForce) throw new Error('KTraversal: missing required textures');

    if (this.inLevelA0.length < this.numLevels) throw new Error(`KTraversal: expected ${this.numLevels} level textures, got ${this.inLevelA0.length}`);

    this.gl.useProgram(this.program);

    // Ensure framebuffer attachments match our output
    if (this._fboShadow?.a0 !== this.outForce) {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.outFramebuffer);
      this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.outForce, 0);
      this.gl.drawBuffers([this.gl.COLOR_ATTACHMENT0]);
      const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
      if (status !== this.gl.FRAMEBUFFER_COMPLETE) {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        throw new Error(`Framebuffer incomplete: ${status}`);
      }
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

      this._fboShadow = { a0: this.outForce };
    }

    // Bind output framebuffer
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.outFramebuffer);
    this.gl.viewport(0, 0, this.particleTexWidth, this.particleTexHeight);

    // Setup GL state
    this.gl.disable(this.gl.DEPTH_TEST);
    this.gl.disable(this.gl.BLEND);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.colorMask(true, true, true, true);

    // Bind position texture
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.inPosition);
    this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_particlePositions'), 0);

    // Set particle count
    const particleCount = this.particleTexWidth * this.particleTexHeight;
    this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_particleCount'), particleCount);

    // Bind all octree level textures (A0 only for monopole)
    for (let i = 0; i < this.numLevels; i++) {
      const unit = this.gl.TEXTURE1 + i;
      this.gl.activeTexture(unit);
      // Only bind if texture exists, otherwise bind null
      const texture = this.inLevelA0[i] || null;
      this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
      this.gl.uniform1i(this.gl.getUniformLocation(this.program, `u_quadtreeLevel${i}`), i + 1);
    }

    // Set level configuration uniforms
    const levelSizes = new Float32Array(this.numLevels);
    const levelGridSizes = new Float32Array(this.numLevels);
    const levelSlicesPerRow = new Float32Array(this.numLevels);

    const worldExtent = Math.max(
      this.worldBounds.max[0] - this.worldBounds.min[0],
      this.worldBounds.max[1] - this.worldBounds.min[1],
      this.worldBounds.max[2] - this.worldBounds.min[2]
    );

    for (let i = 0; i < this.numLevels; i++) {
      const config = this.levelConfigs[i];
      levelSizes[i] = worldExtent / config.gridSize;  // World-space cell size
      levelGridSizes[i] = config.gridSize;
      levelSlicesPerRow[i] = config.slicesPerRow;
    }

    this.gl.uniform1fv(this.gl.getUniformLocation(this.program, 'u_cellSizes'), levelSizes);
    this.gl.uniform1fv(this.gl.getUniformLocation(this.program, 'u_gridSizes'), levelGridSizes);
    this.gl.uniform1fv(this.gl.getUniformLocation(this.program, 'u_slicesPerRow'), levelSlicesPerRow);

    // Set physics parameters
    this.gl.uniform2f(this.gl.getUniformLocation(this.program, 'u_texSize'),
      this.particleTexWidth, this.particleTexHeight);
    this.gl.uniform3f(this.gl.getUniformLocation(this.program, 'u_worldMin'),
      this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    this.gl.uniform3f(this.gl.getUniformLocation(this.program, 'u_worldMax'),
      this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_theta'), this.theta);
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_G'), this.gravityStrength);
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_softening'), this.softening);
    this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_numLevels'), this.numLevels);

    // Draw
    this.gl.bindVertexArray(this.quadVAO);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);

    // DEBUG: Check for GL errors
    const err = this.gl.getError();
    if (err !== this.gl.NO_ERROR) console.error('[KTraversal] WebGL error after drawArrays:', err);

    this.gl.bindVertexArray(null);

    for (let i = 0; i < this.numLevels; i++) {
      const unit = this.gl.TEXTURE1 + i;
      this.gl.activeTexture(unit);
      this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    }
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.gl.useProgram(null);

    // Unbind
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

    this.renderCount = (this.renderCount || 0) + 1;


  }

  dispose() {
    if (this.program) this.gl.deleteProgram(this.program);
    if (this.quadVAO) this.gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebuffer) this.gl.deleteFramebuffer(this.outFramebuffer);

    if (this.inPosition) this.gl.deleteTexture(this.inPosition);
    if (this.outForce) this.gl.deleteTexture(this.outForce);

    this._fboShadow = null;
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

