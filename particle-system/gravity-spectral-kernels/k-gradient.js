// @ts-check

/**
 * KGradient - Computes force field from gravitational potential
 * 
 * Computes gradient: F = -∇φ → F(k) = -i·k·φ(k)
 * Generates three force spectrum textures (Fx, Fy, Fz)
 * Follows the WebGL2 Kernel contract.
 */

import gradientFrag from './shaders/gradient.frag.js';
import fsQuadVert from '../shaders/fullscreen.vert.js';

export class KGradient {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPotentialSpectrum?: WebGLTexture|null,
   *   outForceSpectrumX?: WebGLTexture|null,
   *   outForceSpectrumY?: WebGLTexture|null,
   *   outForceSpectrumZ?: WebGLTexture|null,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   worldSize?: [number, number, number]
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inPotentialSpectrum = options.inPotentialSpectrum !== undefined ? options.inPotentialSpectrum : null;
    this.outForceSpectrumX = options.outForceSpectrumX !== undefined ? options.outForceSpectrumX : null;
    this.outForceSpectrumY = options.outForceSpectrumY !== undefined ? options.outForceSpectrumY : null;
    this.outForceSpectrumZ = options.outForceSpectrumZ !== undefined ? options.outForceSpectrumZ : null;
    
    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;
    this.textureSize = options.textureSize || (this.gridSize * this.slicesPerRow);
    
    // World size
    this.worldSize = options.worldSize || [100.0, 100.0, 100.0];
    
    // Compile and link shader program
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
    this.gl.shaderSource(frag, gradientFrag);
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
    const quadVertices = new Float32Array([
      -1, -1,  1, -1,  -1, 1,  1, 1
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

    gl.viewport(0, 0, this.textureSize, this.textureSize);
    
    // Setup GL state
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
    
    // Bind input potential spectrum
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPotentialSpectrum);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_potentialSpectrum'), 0);
    
    // Set common uniforms
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
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
  }
  
  /**
   * Dispose all resources
   */
  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebufferX) gl.deleteFramebuffer(this.outFramebufferX);
    if (this.outFramebufferY) gl.deleteFramebuffer(this.outFramebufferY);
    if (this.outFramebufferZ) gl.deleteFramebuffer(this.outFramebufferZ);

    // Note: Do not delete input/output textures as they are owned by external code
    this._fboShadow = null;
  }
}
