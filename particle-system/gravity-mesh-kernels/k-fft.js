// @ts-check

/**
 * KFFT - 3D Fast Fourier Transform kernel
 * 
 * Performs forward or inverse 3D FFT using Stockham algorithm.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';
import fftFrag from './shaders/fft.frag.js';

export class KFFT {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   grid?: WebGLTexture|null,
   *   spectrum?: WebGLTexture|null,
   *   quadVAO?: WebGLVertexArrayObject|null,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   inverse?: boolean,
   *   cellVolume?: number
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.grid = (options.grid || options.grid === null) ? options.grid : createGridTexture(this.gl, (options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64))));
    this.spectrum = (options.spectrum || options.spectrum === null) ? options.spectrum : createComplexTexture(this.gl, (options.gridSize || 64) * (options.slicesPerRow || Math.ceil(Math.sqrt(options.gridSize || 64))));
    this.quadVAO = (options.quadVAO || options.quadVAO === null) ? options.quadVAO : createQuadVAO(this.gl);
    
    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || Math.ceil(Math.sqrt(this.gridSize));
    this.textureSize = options.textureSize || (this.gridSize * this.slicesPerRow);
    
    // Transform direction
    this.inverse = options.inverse !== undefined ? options.inverse : false;
    
    // Cell volume for density conversion
    this.cellVolume = options.cellVolume || 1.0;
    
    // Compile FFT program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, fsQuadVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`FFT vertex shader compile failed: ${info}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, fftFrag);
    this.gl.compileShader(frag);
    if (!this.gl.getShaderParameter(frag, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(frag);
      this.gl.deleteShader(frag);
      throw new Error(`FFT fragment shader compile failed: ${info}`);
    }

    this.fftProgram = this.gl.createProgram();
    if (!this.fftProgram) throw new Error('Failed to create FFT program');
    this.gl.attachShader(this.fftProgram, vert);
    this.gl.attachShader(this.fftProgram, frag);
    this.gl.linkProgram(this.fftProgram);
    if (!this.gl.getProgramParameter(this.fftProgram, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.fftProgram);
      this.gl.deleteProgram(this.fftProgram);
      throw new Error(`FFT program link failed: ${info}`);
    }

    this.gl.deleteShader(vert);
    this.gl.deleteShader(frag);

    // Create real-to-complex conversion program
    this._createRealToComplexProgram();
    
    // Create complex-to-real extraction program
    this._createComplexToRealProgram();
    
    // Create ping-pong texture for FFT stages
    this.pingPongTexture = this._createSpectrumTexture();
    
    // Create framebuffers
    this.framebuffer = this.gl.createFramebuffer();
    this.pingPongFBO = this.gl.createFramebuffer();
    if (!this.framebuffer || !this.pingPongFBO) {
      throw new Error('Failed to create framebuffers');
    }
  }

  _createRealToComplexProgram() {
    const frag = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 outColor;
      uniform sampler2D u_massGrid;
      uniform float u_cellVolume;

      void main() {
        float mass = texture(u_massGrid, v_uv).a;
        float density = mass / u_cellVolume;
        outColor = vec4(density, 0.0, 0.0, 0.0);
      }
    `;
    
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, fsQuadVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`RealToComplex vertex shader failed: ${info}`);
    }

    const fragShader = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!fragShader) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(fragShader, frag);
    this.gl.compileShader(fragShader);
    if (!this.gl.getShaderParameter(fragShader, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(fragShader);
      this.gl.deleteShader(fragShader);
      throw new Error(`RealToComplex fragment shader failed: ${info}`);
    }

    this.realToComplexProgram = this.gl.createProgram();
    if (!this.realToComplexProgram) throw new Error('Failed to create program');
    this.gl.attachShader(this.realToComplexProgram, vert);
    this.gl.attachShader(this.realToComplexProgram, fragShader);
    this.gl.linkProgram(this.realToComplexProgram);
    if (!this.gl.getProgramParameter(this.realToComplexProgram, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.realToComplexProgram);
      this.gl.deleteProgram(this.realToComplexProgram);
      throw new Error(`RealToComplex program link failed: ${info}`);
    }

    this.gl.deleteShader(vert);
    this.gl.deleteShader(fragShader);
  }

  _createComplexToRealProgram() {
    const frag = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 outColor;
      uniform sampler2D u_complexTexture;

      void main() {
        vec2 complexValue = texture(u_complexTexture, v_uv).rg;
        float realPart = complexValue.r;
        outColor = vec4(realPart, 0.0, 0.0, realPart);
      }
    `;
    
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, fsQuadVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`ComplexToReal vertex shader failed: ${info}`);
    }

    const fragShader = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!fragShader) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(fragShader, frag);
    this.gl.compileShader(fragShader);
    if (!this.gl.getShaderParameter(fragShader, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(fragShader);
      this.gl.deleteShader(fragShader);
      throw new Error(`ComplexToReal fragment shader failed: ${info}`);
    }

    this.complexToRealProgram = this.gl.createProgram();
    if (!this.complexToRealProgram) throw new Error('Failed to create program');
    this.gl.attachShader(this.complexToRealProgram, vert);
    this.gl.attachShader(this.complexToRealProgram, fragShader);
    this.gl.linkProgram(this.complexToRealProgram);
    if (!this.gl.getProgramParameter(this.complexToRealProgram, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.complexToRealProgram);
      this.gl.deleteProgram(this.complexToRealProgram);
      throw new Error(`ComplexToReal program link failed: ${info}`);
    }

    this.gl.deleteShader(vert);
    this.gl.deleteShader(fragShader);
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

  _convertRealToComplex() {
    const gl = this.gl;
    
    if (!this.grid) {
      throw new Error('KFFT: grid not set for real-to-complex conversion');
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.spectrum, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.useProgram(this.realToComplexProgram);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.grid);
    gl.uniform1i(gl.getUniformLocation(this.realToComplexProgram, 'u_massGrid'), 0);
    gl.uniform1f(gl.getUniformLocation(this.realToComplexProgram, 'u_cellVolume'), this.cellVolume);
    
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _perform3DFFT() {
    const gl = this.gl;
    const numStages = Math.log2(this.gridSize) | 0;
    
    gl.useProgram(this.fftProgram);
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    
    const uGridSize = gl.getUniformLocation(this.fftProgram, 'u_gridSize');
    const uSlicesPerRow = gl.getUniformLocation(this.fftProgram, 'u_slicesPerRow');
    const uInverse = gl.getUniformLocation(this.fftProgram, 'u_inverse');
    const uNumStages = gl.getUniformLocation(this.fftProgram, 'u_numStages');
    const uAxis = gl.getUniformLocation(this.fftProgram, 'u_axis');
    const uStage = gl.getUniformLocation(this.fftProgram, 'u_stage');
    const uInputTex = gl.getUniformLocation(this.fftProgram, 'u_inputTexture');
    
    gl.uniform1f(uGridSize, this.gridSize);
    gl.uniform1f(uSlicesPerRow, this.slicesPerRow);
    gl.uniform1i(uInverse, this.inverse ? 1 : 0);
    gl.uniform1i(uNumStages, numStages);
    
    for (let axis = 0; axis < 3; axis++) {
      gl.uniform1i(uAxis, axis);
      
      for (let stage = 0; stage < numStages; stage++) {
        gl.uniform1i(uStage, stage);
        
        const readFromPrimary = (stage % 2 === 0);
        const readTex = readFromPrimary ? this.spectrum : this.pingPongTexture;
        const writeTex = readFromPrimary ? this.pingPongTexture : this.spectrum;
        const writeFBO = readFromPrimary ? this.pingPongFBO : this.framebuffer;
        
        gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, writeTex, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, readTex);
        gl.uniform1i(uInputTex, 0);
        
        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
      }
      
      // If odd number of stages, result is in ping-pong, copy to primary
      if (numStages % 2 === 1) {
        this._copyTexture(this.pingPongTexture, this.spectrum);
      }
    }
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _extractRealPart(outputTexture) {
    const gl = this.gl;
    
    const tempFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, tempFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);
    // Make sure we render to COLOR_ATTACHMENT0 on this FBO
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    
    gl.useProgram(this.complexToRealProgram);
    
    // Avoid sampling from the same texture that is currently bound as the draw target
    // If outputTexture === spectrum, copy spectrum into pingPongTexture and sample from it
    let sourceTex = this.spectrum;
    if (outputTexture === this.spectrum) {
      this._copyTexture(this.spectrum, this.pingPongTexture);
      sourceTex = this.pingPongTexture;
    }
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.uniform1i(gl.getUniformLocation(this.complexToRealProgram, 'u_complexTexture'), 0);
    
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(tempFBO);
  }

  _copyTexture(src, dst) {
    const gl = this.gl;
    
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0);
    
    gl.bindTexture(gl.TEXTURE_2D, dst);
    gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, this.textureSize, this.textureSize);
    
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
  }

  run() {
    const gl = this.gl;
    
    if (!this.grid && !this.inverse) {
      throw new Error('KFFT: grid texture not set for forward transform');
    }
    if (!this.spectrum) {
      throw new Error('KFFT: spectrum texture not set');
    }
    
    // Save GL state
    const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVP = gl.getParameter(gl.VIEWPORT);
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const prevBlend = gl.getParameter(gl.BLEND);
    const prevDepthTest = gl.getParameter(gl.DEPTH_TEST);
    
    if (!this.inverse) {
      // Forward FFT: real grid -> complex spectrum
      this._convertRealToComplex();
    }
    
    this._perform3DFFT();
    
    if (this.inverse) {
      // Inverse FFT: extract real part from spectrum back to grid
      this._extractRealPart(this.grid);
    }
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    
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
    
    if (this.fftProgram) {
      gl.deleteProgram(this.fftProgram);
      this.fftProgram = null;
    }
    
    if (this.realToComplexProgram) {
      gl.deleteProgram(this.realToComplexProgram);
      this.realToComplexProgram = null;
    }
    
    if (this.complexToRealProgram) {
      gl.deleteProgram(this.complexToRealProgram);
      this.complexToRealProgram = null;
    }
    
    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer);
      this.framebuffer = null;
    }
    
    if (this.pingPongFBO) {
      gl.deleteFramebuffer(this.pingPongFBO);
      this.pingPongFBO = null;
    }
    
    if (this.pingPongTexture) {
      gl.deleteTexture(this.pingPongTexture);
      this.pingPongTexture = null;
    }
    
    if (this.spectrum) {
      gl.deleteTexture(this.spectrum);
      this.spectrum = null;
    }
    
    if (this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
      this.quadVAO = null;
    }
  }
}

/**
 * Helper: Create a grid texture (RGBA32F for density)
 * @param {WebGL2RenderingContext} gl
 * @param {number} size
 */
function createGridTexture(gl, size) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
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

/**
 * Helper: Create a fullscreen quad VAO
 * @param {WebGL2RenderingContext} gl
 */
function createQuadVAO(gl) {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Failed to create VAO');
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('Failed to create buffer');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const quadVertices = new Float32Array([
    -1, -1,  1, -1,  -1, 1,  1, 1
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}
