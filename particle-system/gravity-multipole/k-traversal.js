// @ts-check

/**
 * TraversalKernel - Monopole Barnes-Hut tree traversal
 * 
 * Traverses the octree hierarchy to compute gravitational forces using monopole approximation.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';
import traversalFrag from '../shaders/traversal.frag.js';

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
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Particle texture dimensions
    this.particleTexWidth = options.particleTexWidth || 0;
    this.particleTexHeight = options.particleTexHeight || 0;
    
    // Resource slots - follow kernel contract: (truthy || === null) ? use : create
    this.inPosition = (options.inPosition || options.inPosition === null)
      ? options.inPosition
      : createTextureRGBA32F(this.gl, this.particleTexWidth, this.particleTexHeight);
    
    this.inLevelA0 = (options.inLevelA0 || options.inLevelA0 === null)
      ? options.inLevelA0
      : [];
    
    // Allocate outForce if not provided (truthy) or explicitly null
    this.outForce = (options.outForce || options.outForce === null) 
      ? options.outForce 
      : createTextureRGBA32F(this.gl, this.particleTexWidth, this.particleTexHeight);
    
    // Octree configuration
    this.numLevels = options.numLevels || 7;
    this.levelConfigs = options.levelConfigs || [];
    
    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-4, -4, 0],
      max: [4, 4, 2]
    };
    
    // Physics parameters
    this.theta = options.theta !== undefined ? options.theta : 0.5;
    this.gravityStrength = options.gravityStrength !== undefined ? options.gravityStrength : 0.0003;
    this.softening = options.softening !== undefined ? options.softening : 0.2;
    
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
   * @param {string} vertSrc
   * @param {string} fragSrc
   * @returns {WebGLProgram}
   */
  // shader program and VAO created inline in constructor; helper methods removed
  
  /**
   * @param {WebGLTexture} texture
   * @returns {WebGLFramebuffer}
   */
  _createFramebuffer(texture) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('Failed to create framebuffer');
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`Framebuffer incomplete: ${status}`);
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }
  
  /**
   * Run the kernel (synchronous)
   */
  run() {
    const gl = this.gl;
    
    // console.log(`[KTraversal.run] START: texW=${this.particleTexWidth}, texH=${this.particleTexHeight}, numLevels=${this.numLevels}`);
    
    if (!this.inPosition || !this.outForce) {
      throw new Error('KTraversal: missing required textures');
    }
    
    if (this.inLevelA0.length < this.numLevels) {
      throw new Error(`KTraversal: expected ${this.numLevels} level textures, got ${this.inLevelA0.length}`);
    }
    
    gl.useProgram(this.program);

    // Ensure framebuffer attachments match our output
    if (this._fboShadow?.a0 !== this.outForce) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForce, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error(`Framebuffer incomplete: ${status}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._fboShadow = { a0: this.outForce };
    }

    // Bind output framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.viewport(0, 0, this.particleTexWidth, this.particleTexHeight);
    
    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    
    // Bind position texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particlePositions'), 0);
    
    // Set particle count
    const particleCount = this.particleTexWidth * this.particleTexHeight;
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particleCount'), particleCount);
    
    // Bind all octree level textures (A0 only for monopole)
    // console.log(`[KTraversal] Binding ${this.numLevels} level textures. inLevelA0 length: ${this.inLevelA0.length}`);
    for (let i = 0; i < this.numLevels; i++) {
      const unit = gl.TEXTURE1 + i;
      gl.activeTexture(unit);
      // Only bind if texture exists, otherwise bind null
      const texture = this.inLevelA0[i] || null;
      const hasTexture = !!texture;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform1i(gl.getUniformLocation(this.program, `u_quadtreeLevel${i}`), i + 1);
      if (i < 3 || i === this.numLevels - 1) {
        // console.log(`  Level ${i}: u_quadtreeLevel${i} -> TEXTURE${i+1}, texture=${hasTexture}, gridSize=${this.levelConfigs[i].gridSize}`);
      }
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
    
    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_cellSizes'), levelSizes);
    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_gridSizes'), levelGridSizes);
    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_slicesPerRow'), levelSlicesPerRow);
    
    // Set physics parameters
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_texSize'),
      this.particleTexWidth, this.particleTexHeight);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'),
      this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'),
      this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_theta'), this.theta);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_G'), this.gravityStrength);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_softening'), this.softening);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_numLevels'), this.numLevels);
    
    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    // DEBUG: Check for GL errors
    const err = gl.getError();
    if (err !== gl.NO_ERROR) {
      console.error('[KTraversal] WebGL error after drawArrays:', err);
    }
    
    gl.bindVertexArray(null);

    for (let i = 0; i < this.numLevels; i++) {
      const unit = gl.TEXTURE1 + i;
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);

    // Unbind
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  /**
   * Dispose all resources
   */
  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebuffer) gl.deleteFramebuffer(this.outFramebuffer);

    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.outForce) gl.deleteTexture(this.outForce);

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

