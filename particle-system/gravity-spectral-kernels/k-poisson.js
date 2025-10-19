// @ts-check

/**
 * KPoisson - Poisson solver in Fourier space
 * 
 * Solves Poisson equation: ∇²φ = 4πGρ → φ(k) = -4πGρ(k) / k²
 * Follows the WebGL2 Kernel contract.
 */

import poissonFrag from './shaders/poisson.frag.js';
import fsQuadVert from '../shaders/fullscreen.vert.js';

export class KPoisson {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inDensitySpectrum?: WebGLTexture|null,
   *   outPotentialSpectrum?: WebGLTexture|null,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   gravitationalConstant?: number,
   *   worldSize?: [number, number, number],
   *   assignment?: 'NGP'|'CIC'|'TSC',
   *   poissonUseDiscrete?: boolean,
   *   treePMSigma?: number
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inDensitySpectrum = options.inDensitySpectrum !== undefined ? options.inDensitySpectrum : null;
    this.outPotentialSpectrum = options.outPotentialSpectrum !== undefined ? options.outPotentialSpectrum : null;
    
    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;
    this.textureSize = options.textureSize || (this.gridSize * this.slicesPerRow);
    
    // Physics parameters
    this.gravitationalConstant = options.gravitationalConstant !== undefined ? options.gravitationalConstant : (4.0 * Math.PI * 0.0003);
    this.worldSize = options.worldSize || [100.0, 100.0, 100.0];
    this.assignment = options.assignment || 'CIC';
    this.poissonUseDiscrete = options.poissonUseDiscrete !== undefined ? options.poissonUseDiscrete : true;
    this.treePMSigma = options.treePMSigma || 0.0;
    
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
    this.gl.shaderSource(frag, poissonFrag);
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
    
    if (!this.inDensitySpectrum || !this.outPotentialSpectrum) {
      throw new Error('KPoisson: missing required textures');
    }
    
    gl.useProgram(this.program);
    
    // Configure framebuffer if needed
    if (this._fboShadow !== this.outPotentialSpectrum) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outPotentialSpectrum, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error(`Framebuffer incomplete: ${status}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._fboShadow = this.outPotentialSpectrum;
    }

    // Bind output framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    
    // Setup GL state
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.colorMask(true, true, true, true);
    
    // Bind input density spectrum
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inDensitySpectrum);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_densitySpectrum'), 0);
    
    // Set uniforms
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gravitationalConstant'), this.gravitationalConstant);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldSize'),
      this.worldSize[0], this.worldSize[1], this.worldSize[2]);
    
    // Deconvolution order based on assignment
    let deconvolveOrder = 2; // CIC default
    if (this.assignment === 'TSC') deconvolveOrder = 3;
    if (this.assignment === 'NGP') deconvolveOrder = 1;
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_deconvolveOrder'), deconvolveOrder);
    
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_useDiscrete'), this.poissonUseDiscrete ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gaussianSigma'), this.treePMSigma);
    
    // Draw fullscreen quad
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    
    // Cleanup
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

    // Note: Do not delete inDensitySpectrum, outPotentialSpectrum as they are owned by external code
    this._fboShadow = null;
  }
}
