// @ts-check

/**
 * KPoisson - Solves Poisson equation in Fourier space
 * 
 * Converts density spectrum to gravitational potential spectrum.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';
import poissonFrag from '../gravity-spectral/shaders/poisson.frag.js';

export class KPoisson {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inDensitySpectrum?: WebGLTexture|null,
   *   outPotentialSpectrum?: WebGLTexture|null,
   *   quadVAO?: WebGLVertexArrayObject|null,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   worldSize?: [number,number,number],
   *   gravityStrength?: number,
   *   splitMode?: 0|1|2,
   *   kCut?: number,
   *   gaussianSigma?: number,
   *   deconvolveOrder?: 0|1|2|3,
   *   useDiscrete?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inDensitySpectrum = options.inDensitySpectrum !== undefined ? options.inDensitySpectrum : null;
    this.outPotentialSpectrum = options.outPotentialSpectrum !== undefined ? options.outPotentialSpectrum : null;
    this.quadVAO = options.quadVAO !== undefined ? options.quadVAO : null;
    
    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || Math.ceil(Math.sqrt(this.gridSize));
    this.textureSize = options.textureSize || (this.gridSize * this.slicesPerRow);
    
    // Physics parameters
    this.worldSize = options.worldSize || [8, 8, 8];
    this.fourPiG = 4.0 * Math.PI * (options.gravityStrength || 0.0003);
    this.splitMode = options.splitMode || 0;
    this.kCut = options.kCut || 0;
    this.gaussianSigma = options.gaussianSigma || 0;
    this.deconvolveOrder = options.deconvolveOrder || 1;
    this.useDiscrete = options.useDiscrete !== undefined ? options.useDiscrete : true;
    
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

    // Create FBO for output
    this.framebuffer = this.gl.createFramebuffer();
    if (!this.framebuffer) throw new Error('Failed to create framebuffer');
    
    // If no output texture provided, create one
    if (!this.outPotentialSpectrum) {
      this.outPotentialSpectrum = this._createSpectrumTexture();
      this.ownsOutTexture = true;
    } else {
      this.ownsOutTexture = false;
    }
    
    // Create quad VAO if not provided
    if (!this.quadVAO) {
      this.quadVAO = this._createQuadVAO();
      this.ownsQuadVAO = true;
    } else {
      this.ownsQuadVAO = false;
    }
  }

  _createSpectrumTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create texture');
    
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.textureSize, this.textureSize, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    
    return texture;
  }

  _createQuadVAO() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Failed to create buffer');
    
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const quadData = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    
    return vao;
  }

  run() {
    const gl = this.gl;
    
    if (!this.inDensitySpectrum) {
      throw new Error('KPoisson: inDensitySpectrum texture not set');
    }
    if (!this.outPotentialSpectrum) {
      throw new Error('KPoisson: outPotentialSpectrum texture not set');
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
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outPotentialSpectrum, 0);
    
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`KPoisson: Framebuffer incomplete: ${fbStatus}`);
    }
    
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    
    gl.useProgram(this.program);
    
    // Bind input texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inDensitySpectrum);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_densitySpectrum'), 0);
    
    // Set uniforms
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gravitationalConstant'), this.fourPiG);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldSize'), this.worldSize[0], this.worldSize[1], this.worldSize[2]);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_splitMode'), this.splitMode);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_kCut'), this.kCut);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gaussianSigma'), this.gaussianSigma);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_deconvolveOrder'), this.deconvolveOrder);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_useDiscrete'), this.useDiscrete ? 1 : 0);
    
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    
    // Restore GL state
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
    gl.useProgram(prevProg);
    gl.bindVertexArray(prevVAO);
    if (prevBlend) gl.enable(gl.BLEND);
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
  }

  dispose() {
    const gl = this.gl;
    
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    
    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer);
      this.framebuffer = null;
    }
    
    if (this.ownsOutTexture && this.outPotentialSpectrum) {
      gl.deleteTexture(this.outPotentialSpectrum);
      this.outPotentialSpectrum = null;
    }
    
    if (this.ownsQuadVAO && this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
      this.quadVAO = null;
    }
  }
}
