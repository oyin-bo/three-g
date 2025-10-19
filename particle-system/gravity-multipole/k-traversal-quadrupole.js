// @ts-check

/**
 * TraversalQuadrupoleKernel - Quadrupole Barnes-Hut tree traversal
 * 
 * Traverses the octree hierarchy to compute gravitational forces using quadrupole approximation.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';
import generateTraversalQuadrupoleShader from '../shaders/traversal-quadrupole.frag.js';

export class KTraversalQuadrupole {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inLevelA0?: WebGLTexture[],
   *   inLevelA1?: WebGLTexture[],
   *   inLevelA2?: WebGLTexture[],
   *   outForce?: WebGLTexture|null,
   *   particleTexWidth?: number,
   *   particleTexHeight?: number,
   *   numLevels?: number,
   *   levelConfigs?: Array<{size: number, gridSize: number, slicesPerRow: number}>,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   theta?: number,
   *   gravityStrength?: number,
   *   softening?: number,
   *   enableQuadrupoles?: boolean,
   *   useOccupancyMasks?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;
    this.inLevelA0 = options.inLevelA0 || [];
    this.inLevelA1 = options.inLevelA1 || [];
    this.inLevelA2 = options.inLevelA2 || [];
    this.outForce = options.outForce !== undefined ? options.outForce : null;
    
    // Particle texture dimensions
    this.particleTexWidth = options.particleTexWidth || 0;
    this.particleTexHeight = options.particleTexHeight || 0;
    
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
    this.enableQuadrupoles = options.enableQuadrupoles !== undefined ? options.enableQuadrupoles : true;
    this.useOccupancyMasks = options.useOccupancyMasks !== undefined ? options.useOccupancyMasks : false;
    
    // Create shader program with quadrupole shader
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
    const fragSource = generateTraversalQuadrupoleShader(this.useOccupancyMasks);
    this.gl.shaderSource(frag, fragSource);
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
    
    // Create an internal framebuffer (configured per-run)
    this.outFramebuffer = this.gl.createFramebuffer();
    /** @type {{ a0: WebGLTexture } | null} */
    this._fboShadow = null;
  }
  
  /**
   * Run the kernel (synchronous)
   */
  run() {
    const gl = this.gl;
    
    if (!this.inPosition || !this.outForce) {
      throw new Error('KTraversalQuadrupole: missing required textures');
    }
    
    if (this.inLevelA0.length < this.numLevels) {
      throw new Error(`KTraversalQuadrupole: expected ${this.numLevels} level A0 textures, got ${this.inLevelA0.length}`);
    }
    
    if (this.enableQuadrupoles) {
      if (this.inLevelA1.length < this.numLevels) {
        throw new Error(`KTraversalQuadrupole: expected ${this.numLevels} level A1 textures, got ${this.inLevelA1.length}`);
      }
      if (this.inLevelA2.length < this.numLevels) {
        throw new Error(`KTraversalQuadrupole: expected ${this.numLevels} level A2 textures, got ${this.inLevelA2.length}`);
      }
    }
    
    gl.useProgram(this.program);

    // Ensure framebuffer attachments match our output
    if (!this._fboShadow?.a0 !== this.outForce) {
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
    
    // Bind all octree level textures (A0, A1, A2 for quadrupole)
    // For compatibility with the shader that uses texture arrays, we need to bind each level
    // The shader expects sampler2DArray, but we're providing individual textures
    // We'll need to adapt this based on the actual shader implementation
    for (let i = 0; i < this.numLevels; i++) {
      // A0 textures
      const unitA0 = gl.TEXTURE1 + i * 3;
      gl.activeTexture(unitA0);
      gl.bindTexture(gl.TEXTURE_2D, this.inLevelA0[i]);
      gl.uniform1i(gl.getUniformLocation(this.program, `u_levelA0_${i}`), 1 + i * 3);
      
      if (this.enableQuadrupoles) {
        // A1 textures
        const unitA1 = gl.TEXTURE1 + i * 3 + 1;
        gl.activeTexture(unitA1);
        gl.bindTexture(gl.TEXTURE_2D, this.inLevelA1[i]);
        gl.uniform1i(gl.getUniformLocation(this.program, `u_levelA1_${i}`), 1 + i * 3 + 1);
        
        // A2 textures
        const unitA2 = gl.TEXTURE1 + i * 3 + 2;
        gl.activeTexture(unitA2);
        gl.bindTexture(gl.TEXTURE_2D, this.inLevelA2[i]);
        gl.uniform1i(gl.getUniformLocation(this.program, `u_levelA2_${i}`), 1 + i * 3 + 2);
      }
    }
    
    // Set level configuration uniforms
    const cellSizes = new Float32Array(this.numLevels);
    const gridSizes = new Float32Array(this.numLevels);
    const slicesPerRow = new Float32Array(this.numLevels);
    
    // Calculate cell sizes from world bounds and grid sizes
    const worldSize = [
      this.worldBounds.max[0] - this.worldBounds.min[0],
      this.worldBounds.max[1] - this.worldBounds.min[1],
      this.worldBounds.max[2] - this.worldBounds.min[2]
    ];
    const maxWorldSize = Math.max(...worldSize);
    
    for (let i = 0; i < this.numLevels; i++) {
      const config = this.levelConfigs[i];
      gridSizes[i] = config.gridSize;
      slicesPerRow[i] = config.slicesPerRow;
      cellSizes[i] = maxWorldSize / config.gridSize;
    }
    
    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_cellSizes'), cellSizes);
    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_gridSizes'), gridSizes);
    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_slicesPerRow'), slicesPerRow);
    
    // Set physics parameters
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_texSize'),
      this.particleTexWidth, this.particleTexHeight);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particleCount'),
      this.particleTexWidth * this.particleTexHeight);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'),
      this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'),
      this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_theta'), this.theta);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_G'), this.gravityStrength);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_softening'), this.softening);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_numLevels'), this.numLevels);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_enableQuadrupoles'), this.enableQuadrupoles ? 1 : 0);
    
    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    
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
