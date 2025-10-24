// @ts-check

/**
 * KFFT - 3D FFT Transform Kernel
 * 
 * Implements forward and inverse 3D FFT for PM method.
 * Follows the WebGL2 Kernel contract, adapted for complex FFT operations.
 * 
 * NORMALIZATION CONVENTION:
 * - Forward: F̂(k) = Σ f(x)·exp(-2πikx)           [unnormalized]
 * - Inverse: f(x) = (1/N³)·Σ F̂(k)·exp(2πikx)    [normalized by 1/N³]
 */

import fftFrag from './shaders/fft.frag.js';
import fsQuadVert from '../shaders/fullscreen.vert.js';

export class KFFT {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inReal?: WebGLTexture|null,
   *   inComplex?: WebGLTexture|null,
   *   outComplex?: WebGLTexture|null,
   *   outReal?: WebGLTexture|null,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   inverse?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Resource slots
    this.inReal = (options.inReal || options.inReal === null) ? options.inReal : createTextureRGBA32F(this.gl, options.gridSize || 64, options.gridSize || 64);
    this.inComplex = (options.inComplex || options.inComplex === null) ? options.inComplex : createComplexTexture(this.gl, options.textureSize || (options.gridSize || 64) * (options.slicesPerRow || 8));
    this.outComplex = (options.outComplex || options.outComplex === null) ? options.outComplex : createComplexTexture(this.gl, options.textureSize || (options.gridSize || 64) * (options.slicesPerRow || 8));
    this.outReal = (options.outReal || options.outReal === null) ? options.outReal : createTextureRGBA32F(this.gl, options.gridSize || 64, options.gridSize || 64);

    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;
    this.textureSize = options.textureSize || (this.gridSize * this.slicesPerRow);

    // FFT direction
    this.inverse = options.inverse || false;

    // Compile FFT shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, fsQuadVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info || 'no error log'}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, fftFrag);
    this.gl.compileShader(frag);
    if (!this.gl.getShaderParameter(frag, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(frag);
      this.gl.deleteShader(frag);
      throw new Error(`Fragment shader compile failed: ${info}`);
    }

    this.fftProgram = this.gl.createProgram();
    if (!this.fftProgram) throw new Error('Failed to create program');
    this.gl.attachShader(this.fftProgram, vert);
    this.gl.attachShader(this.fftProgram, frag);
    this.gl.linkProgram(this.fftProgram);
    if (!this.gl.getProgramParameter(this.fftProgram, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.fftProgram);
      this.gl.deleteProgram(this.fftProgram);
      throw new Error(`Program link failed: ${info}`);
    }

    this.gl.deleteShader(vert);
    this.gl.deleteShader(frag);

    // Create real-to-complex conversion program (simple shader)
    const realToComplexFragSrc = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 outColor;
      uniform sampler2D u_massGrid;
      void main() {
        float mass = texture(u_massGrid, v_uv).r;
        outColor = vec4(mass, 0.0, 0.0, 0.0);
      }
    `;

    const vert2 = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert2) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert2, fsQuadVert);
    this.gl.compileShader(vert2);
    if (!this.gl.getShaderParameter(vert2, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert2);
      this.gl.deleteShader(vert2);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag2 = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag2) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag2, realToComplexFragSrc);
    this.gl.compileShader(frag2);
    if (!this.gl.getShaderParameter(frag2, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(frag2);
      this.gl.deleteShader(frag2);
      throw new Error(`Fragment shader compile failed: ${info}`);
    }

    this.realToComplexProgram = this.gl.createProgram();
    if (!this.realToComplexProgram) throw new Error('Failed to create program');
    this.gl.attachShader(this.realToComplexProgram, vert2);
    this.gl.attachShader(this.realToComplexProgram, frag2);
    this.gl.linkProgram(this.realToComplexProgram);
    if (!this.gl.getProgramParameter(this.realToComplexProgram, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.realToComplexProgram);
      this.gl.deleteProgram(this.realToComplexProgram);
      throw new Error(`Program link failed: ${info}`);
    }

    this.gl.deleteShader(vert2);
    this.gl.deleteShader(frag2);

    // Create complex-to-real extraction program
    const complexToRealFragSrc = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 outColor;
      uniform sampler2D u_complexTexture;
      void main() {
        vec2 complex = texture(u_complexTexture, v_uv).rg;
        float realPart = complex.r;
        outColor = vec4(realPart, 0.0, 0.0, 0.0);
      }
    `;

    const vert3 = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert3) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert3, fsQuadVert);
    this.gl.compileShader(vert3);
    if (!this.gl.getShaderParameter(vert3, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert3);
      this.gl.deleteShader(vert3);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag3 = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag3) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag3, complexToRealFragSrc);
    this.gl.compileShader(frag3);
    if (!this.gl.getShaderParameter(frag3, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(frag3);
      this.gl.deleteShader(frag3);
      throw new Error(`Fragment shader compile failed: ${info}`);
    }

    this.complexToRealProgram = this.gl.createProgram();
    if (!this.complexToRealProgram) throw new Error('Failed to create program');
    this.gl.attachShader(this.complexToRealProgram, vert3);
    this.gl.attachShader(this.complexToRealProgram, frag3);
    this.gl.linkProgram(this.complexToRealProgram);
    if (!this.gl.getProgramParameter(this.complexToRealProgram, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.complexToRealProgram);
      this.gl.deleteProgram(this.complexToRealProgram);
      throw new Error(`Program link failed: ${info}`);
    }

    this.gl.deleteShader(vert3);
    this.gl.deleteShader(frag3);

    // Create quad VAO
    const quadVAO = this.gl.createVertexArray();
    if (!quadVAO) throw new Error('Failed to create VAO');
    this.gl.bindVertexArray(quadVAO);
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const quadVertices = new Float32Array([
      -1, -1, 1, -1, -1, 1, 1, 1
    ]);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, quadVertices, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    this.quadVAO = quadVAO;

    // Create internal ping-pong textures for FFT stages
    this.workingTexture = this._createComplexTexture();
    this.pingPongTexture = this._createComplexTexture();
    this.workingFramebuffer = this.gl.createFramebuffer();
    this.pingPongFramebuffer = this.gl.createFramebuffer();
  }

  /**
   * Create an RG32F complex texture
   * @private
   */
  _createComplexTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, this.textureSize, this.textureSize, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /**
   * Run the kernel (synchronous)
   * 
   * Forward FFT: inReal → outComplex
   * Inverse FFT: inComplex → outReal
   */
  run() {
    const gl = this.gl;

    if (this.inverse) {
      this._runInverse();
    } else {
      this._runForward();
    }
  }

  /**
   * Forward FFT: real → complex spectrum
   * @private
   */
  _runForward() {
    const gl = this.gl;

    if (!this.inReal || !this.outComplex) {
      throw new Error('KFFT forward: missing inReal or outComplex');
    }

    // Step 1: Convert real to complex
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.workingFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.workingTexture, 0);
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.realToComplexProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inReal);
    gl.uniform1i(gl.getUniformLocation(this.realToComplexProgram, 'u_massGrid'), 0);
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // Step 2: Perform 3D FFT
    this._perform3DFFT(false);

    // Step 3: Copy result to output
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.workingFramebuffer);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.workingTexture, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.pingPongFramebuffer);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outComplex, 0);
    gl.blitFramebuffer(0, 0, this.textureSize, this.textureSize,
      0, 0, this.textureSize, this.textureSize,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  }

  /**
   * Inverse FFT: complex spectrum → real
   * @private
   */
  _runInverse() {
    const gl = this.gl;

    if (!this.inComplex || !this.outReal) {
      throw new Error('KFFT inverse: missing inComplex or outReal');
    }

    // Step 1: Copy input to working texture
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.pingPongFramebuffer);
    gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.inComplex, 0);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.workingFramebuffer);
    gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.workingTexture, 0);
    gl.blitFramebuffer(0, 0, this.textureSize, this.textureSize,
      0, 0, this.textureSize, this.textureSize,
      gl.COLOR_BUFFER_BIT, gl.NEAREST);

    // Step 2: Perform inverse 3D FFT
    this._perform3DFFT(true);

    // Step 3: Extract real part and write to output
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.pingPongFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outReal, 0);
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.complexToRealProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.workingTexture);
    gl.uniform1i(gl.getUniformLocation(this.complexToRealProgram, 'u_complexTexture'), 0);
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Perform separable 3D FFT using butterfly stages
   * @private
   * @param {boolean} inverse
   */
  _perform3DFFT(inverse) {
    const gl = this.gl;
    const numStages = Math.log2(this.gridSize);

    gl.useProgram(this.fftProgram);
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // Set common uniforms
    gl.uniform1f(gl.getUniformLocation(this.fftProgram, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.fftProgram, 'u_slicesPerRow'), this.slicesPerRow);
    gl.uniform1i(gl.getUniformLocation(this.fftProgram, 'u_inverse'), inverse ? 1 : 0);

    // Perform FFT along each axis (X, Y, Z)
    for (let axis = 0; axis < 3; axis++) {
      gl.uniform1i(gl.getUniformLocation(this.fftProgram, 'u_axis'), axis);

      for (let stage = 0; stage < numStages; stage++) {
        gl.uniform1i(gl.getUniformLocation(this.fftProgram, 'u_stage'), stage);

        // Ping-pong between working and pingPong textures
        const isEven = stage % 2 === 0;
        const srcTex = isEven ? this.workingTexture : this.pingPongTexture;
        const dstTex = isEven ? this.pingPongTexture : this.workingTexture;
        const dstFBO = isEven ? this.pingPongFramebuffer : this.workingFramebuffer;

        gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.uniform1i(gl.getUniformLocation(this.fftProgram, 'u_spectrum'), 0);

        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
      }

      // After each axis, ensure result is in workingTexture for next axis
      const finalIsInPingPong = (numStages % 2) !== 0;
      if (finalIsInPingPong) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.pingPongFramebuffer);
        gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.pingPongTexture, 0);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.workingFramebuffer);
        gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.workingTexture, 0);
        gl.blitFramebuffer(0, 0, this.textureSize, this.textureSize,
          0, 0, this.textureSize, this.textureSize,
          gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
    }

    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Dispose all resources
   */
  dispose() {
    const gl = this.gl;

    if (this.fftProgram) gl.deleteProgram(this.fftProgram);
    if (this.realToComplexProgram) gl.deleteProgram(this.realToComplexProgram);
    if (this.complexToRealProgram) gl.deleteProgram(this.complexToRealProgram);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.workingTexture) gl.deleteTexture(this.workingTexture);
    if (this.pingPongTexture) gl.deleteTexture(this.pingPongTexture);
    if (this.workingFramebuffer) gl.deleteFramebuffer(this.workingFramebuffer);
    if (this.pingPongFramebuffer) gl.deleteFramebuffer(this.pingPongFramebuffer);

    // Note: Do not delete inReal, inComplex, outComplex, outReal as they are
    // owned by external code (ParticleSystemSpectralKernels)
  }
}

/**
 * Helper: Create a RGBA32F texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createTextureRGBA32F(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
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
