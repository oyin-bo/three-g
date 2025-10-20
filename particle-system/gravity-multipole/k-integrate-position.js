// @ts-check

/**
 * IntegratePositionKernel - Updates particle positions from velocities
 * 
 * Performs position += velocity * dt (drift step).
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';
import posIntegrateFrag from './shaders/pos_integrate.frag.js';

export class KIntegratePosition {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inVelocity?: WebGLTexture|null,
   *   outPosition?: WebGLTexture|null,
   *   width?: number,
   *   height?: number,
   *   dt?: number
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots - follow kernel contract
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;
    this.inVelocity = options.inVelocity !== undefined ? options.inVelocity : null;
    this.outPosition = options.outPosition !== undefined ? options.outPosition : null;
    
    // Texture dimensions
    this.width = options.width || 0;
    this.height = options.height || 0;
    
    // Physics parameters
    this.dt = options.dt !== undefined ? options.dt : (1 / 60);
    
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
    this.gl.shaderSource(frag, posIntegrateFrag);
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
    
    // Create an internal framebuffer (configured per-run). Keep a small
    // shadow of attachments so run() can rebind only when they change.
    this.outFramebuffer = this.gl.createFramebuffer();
    /** @type {{ a0: WebGLTexture } | null} */
    this._fboShadow = null;
  }
  
  /**
   * @param {string} vertSrc
   * @param {string} fragSrc
   * @returns {WebGLProgram}
   */
  // shader compile and VAO created inline in constructor; helper methods removed
  
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
    
    if (!this.inPosition || !this.inVelocity || !this.outPosition) {
      throw new Error('KIntegratePosition: missing required textures');
    }
    
    gl.useProgram(this.program);
    
    // Ensure framebuffer attachments match our current output
    if (this._fboShadow?.a0 !== this.outPosition) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outPosition, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error(`Framebuffer incomplete: ${status}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._fboShadow = { a0: this.outPosition };
    }

    // Bind output framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.viewport(0, 0, this.width, this.height);
    
    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    
    // Bind input textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_positions'), 0);
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.inVelocity);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_velocity'), 1);
    
    // Set uniforms
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_texSize'), this.width, this.height);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_dt'), this.dt);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particleCount'), this.width * this.height);
    
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
    if (this.inVelocity) gl.deleteTexture(this.inVelocity);
    if (this.outPosition) gl.deleteTexture(this.outPosition);

    this._fboShadow = null;
  }
}
