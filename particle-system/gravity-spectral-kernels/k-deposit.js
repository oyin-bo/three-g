// @ts-check

/**
 * KDeposit - Deposits particles to PM grid
 * 
 * Deposits particle masses onto 3D grid using additive blending.
 * Follows the WebGL2 Kernel contract similar to KAggregator.
 */

import pmDepositVertSrc from './shaders/pm-deposit.vert.js';
import pmDepositFragSrc from './shaders/pm-deposit.frag.js';

export class KDeposit {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   outMassGrid?: WebGLTexture|null,
   *   particleCount?: number,
   *   particleTexWidth?: number,
   *   particleTexHeight?: number,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   assignment?: 'NGP'|'CIC',
   *   disableFloatBlend?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;
    this.outMassGrid = options.outMassGrid !== undefined ? options.outMassGrid : null;
    
    // Particle configuration
    this.particleCount = options.particleCount || 0;
    this.particleTexWidth = options.particleTexWidth || 0;
    this.particleTexHeight = options.particleTexHeight || 0;
    
    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;
    this.textureSize = options.textureSize || (this.gridSize * this.slicesPerRow);
    
    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-2, -2, -2],
      max: [2, 2, 2]
    };
    
    // Assignment method: NGP (0) or CIC (1)
    this.assignment = options.assignment || 'CIC';
    
    // Float blend flag
    this.disableFloatBlend = options.disableFloatBlend || false;
    
    // Compile and link shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, pmDepositVertSrc);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
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
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    
    // Clear grid
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    
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
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_textureSize'),
      this.particleTexWidth, this.particleTexHeight);
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
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  /**
   * Dispose all resources
   */
  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.particleVAO) gl.deleteVertexArray(this.particleVAO);
    if (this.outFramebuffer) gl.deleteFramebuffer(this.outFramebuffer);

    // Note: Do not delete inPosition, outMassGrid as they are owned by external code
    this._fboShadow = null;
  }
}
