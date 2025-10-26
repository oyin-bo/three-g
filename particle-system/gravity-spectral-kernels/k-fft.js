// @ts-check

/**
 * KFFT - 3D FFT Transform Kernel
 * 
 * Implements forward and inverse 3D FFT for PM method.
 * Follows the WebGL2 Kernel contract, adapted for complex FFT operations.
 * 
 * LEAN ARCHITECTURE:
 * - Uses exactly 3 textures: real (R32F), complexFrom (RG32F), complexTo (RG32F)
 * - 3 shader program variants baked from single generator
 * - Texture swapping invariant: complexFrom holds input/result, complexTo holds intermediate
 * 
 * NORMALIZATION CONVENTION:
 * - Forward: F̂(k) = Σ f(x)·exp(-2πikx)           [unnormalized]
 * - Inverse: f(x) = (1/N³)·Σ F̂(k)·exp(2πikx)    [normalized by 1/N³]
 */

import fftFrag from './shaders/fft.frag.js';
import fsQuadVert from '../shaders/fullscreen.vert.js';
import { readLinear, readGrid3D, formatNumber } from '../diag.js';

export class KFFT {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   real?: WebGLTexture|null,
   *   complexFrom?: WebGLTexture|null,
   *   complexTo?: WebGLTexture|null,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   inverse?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;
    this.textureSize = options.textureSize || (this.gridSize * this.slicesPerRow);

    // Lean texture architecture: exactly 3 textures
    this.real = options.real || createTextureR32F(this.gl, this.textureSize, this.textureSize);
    this.ownsReal = !options.real;
    this.complexFrom = options.complexFrom || createComplexTexture(this.gl, this.textureSize, this.textureSize);
    this.ownsComplexFrom = !options.complexFrom;
    this.complexTo = options.complexTo || createComplexTexture(this.gl, this.textureSize, this.textureSize);
    this.ownsComplexTo = !options.complexTo;

    // FFT direction
    this.inverse = options.inverse || false;

    // Compile 3 shader program variants from single generator
    this.fftProgramRealToComplex = this._compileProgram(fftFrag({ collapsed: 'from' }));
    this.fftProgramComplexToReal = this._compileProgram(fftFrag({ collapsed: 'to' }));
    this.fftProgramComplexToComplex = this._compileProgram(fftFrag());

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

    // Create framebuffers for rendering
    this.framebufferFrom = this.gl.createFramebuffer();
    this.framebufferTo = this.gl.createFramebuffer();
    this.framebufferReal = this.gl.createFramebuffer();
  }

  /**
   * Compile a shader program from fragment shader source
   * @private
   * @param {string} fragSource
   */
  _compileProgram(fragSource) {
    const gl = this.gl;

    const vert = gl.createShader(gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    gl.shaderSource(vert, fsQuadVert);
    gl.compileShader(vert);
    if (!gl.getShaderParameter(vert, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(vert);
      gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info || 'no error log'}`);
    }

    const frag = gl.createShader(gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    gl.shaderSource(frag, fragSource);
    gl.compileShader(frag);
    if (!gl.getShaderParameter(frag, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(frag);
      gl.deleteShader(frag);
      throw new Error(`Fragment shader compile failed: ${info}`);
    }

    const program = gl.createProgram();
    if (!program) throw new Error('Failed to create program');
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Program link failed: ${info}`);
    }

    gl.deleteShader(vert);
    gl.deleteShader(frag);

    return program;
  }
  
  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      real: this.real && readGrid3D({
        gl: this.gl, texture: this.real, width: this.textureSize,
        height: this.textureSize, gridSize: this.gridSize,
        channels: ['real'], pixels, format: this.gl.R32F
      }),
      complexFrom: this.complexFrom && readLinear({
        gl: this.gl, texture: this.complexFrom, width: this.textureSize,
        height: this.textureSize, count: this.textureSize * this.textureSize,
        channels: ['real', 'imag'], pixels, format: this.gl.RG32F
      }),
      complexTo: this.complexTo && readLinear({
        gl: this.gl, texture: this.complexTo, width: this.textureSize,
        height: this.textureSize, count: this.textureSize * this.textureSize,
        channels: ['real', 'imag'], pixels, format: this.gl.RG32F
      }),
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: this.inverse,
      renderCount: this.renderCount
    };
    
    value.toString = () =>
`KFFT(${this.gridSize}³ grid) texture=${this.textureSize}×${this.textureSize} slices=${this.slicesPerRow} inverse=${this.inverse} #${this.renderCount}

real: ${value.real}

complexFrom: ${value.complexFrom}

→ complexTo: ${value.complexTo}`;
    
    return value;
  }
  
  /**
   * Get human-readable string representation of kernel state
   * @returns {string} Compact summary
   */
  toString() {
    return this.valueOf().toString();
  }

  /**
   * Run the kernel (synchronous)
   * 
   * Forward FFT: real → complexTo (result in complexTo)
   * Inverse FFT: complexFrom → real (result in real)
   */
  run() {
    if (this.inverse) {
      this._runInverse();
    } else {
      this._runForward();
    }
    
    this.renderCount = (this.renderCount || 0) + 1;
  }

  /**
   * Forward FFT: real → complex spectrum
   * Result ends up in complexTo
   * @private
   */
  _runForward() {
    const gl = this.gl;

    if (!this.real || !this.complexTo) {
      throw new Error('KFFT forward: missing real or complexTo');
    }

    // Perform 3D FFT with first stage using real-to-complex shader
    this._perform3DFFT(false);
  }

  /**
   * Inverse FFT: complex spectrum → real
   * Input from complexFrom, result ends up in real
   * @private
   */
  _runInverse() {
    const gl = this.gl;

    if (!this.complexFrom || !this.real) {
      throw new Error('KFFT inverse: missing complexFrom or real');
    }

    // Perform inverse 3D FFT with last stage using complex-to-real shader
    this._perform3DFFT(true);
  }

  /**
   * Perform separable 3D FFT using butterfly stages
   * @private
   * @param {boolean} inverse
   */
  _perform3DFFT(inverse) {
    const gl = this.gl;
    const numStages = Math.log2(this.gridSize);

    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    // Perform FFT along each axis (X, Y, Z)
    for (let axis = 0; axis < 3; axis++) {
      for (let stage = 0; stage < numStages; stage++) {
        const isFirstStage = (axis === 0 && stage === 0);
        const isLastStage = (axis === 2 && stage === numStages - 1);

        // Select shader program
        let program;
        if (!inverse && isFirstStage) {
          program = this.fftProgramRealToComplex;
        } else if (inverse && isLastStage) {
          program = this.fftProgramComplexToReal;
        } else {
          program = this.fftProgramComplexToComplex;
        }

        gl.useProgram(program);

        // Set common uniforms
        gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), this.gridSize);
        gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), this.slicesPerRow);
        gl.uniform1i(gl.getUniformLocation(program, 'u_inverse'), inverse ? 1 : 0);
        gl.uniform1i(gl.getUniformLocation(program, 'u_numStages'), numStages);
        gl.uniform1i(gl.getUniformLocation(program, 'u_axis'), axis);
        gl.uniform1i(gl.getUniformLocation(program, 'u_stage'), stage);
        gl.uniform1i(gl.getUniformLocation(program, 'u_debugMode'), 0);

        // Special handling for first/last stages
        if (!inverse && isFirstStage) {
          // First forward stage: read from real, write to complexTo
          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.real);
          gl.uniform1i(gl.getUniformLocation(program, 'u_realInput'), 0);

          gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebufferTo);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.complexTo, 0);
        } else if (inverse && isLastStage) {
          // Last inverse stage: read from complexFrom, write to real with normalization
          const normalizeInverse = 1.0 / (this.gridSize * this.gridSize * this.gridSize);
          gl.uniform1f(gl.getUniformLocation(program, 'u_normalizeInverse'), normalizeInverse);

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, this.complexFrom);
          gl.uniform1i(gl.getUniformLocation(program, 'u_spectrum'), 0);

          gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebufferReal);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.real, 0);
        } else {
          // Middle stages: ping-pong between complexFrom and complexTo
          // After first stage of axis 0 (forward) or before last stage of axis 2 (inverse),
          // we need to track which texture has the current data
          
          // Strategy: 
          // - Forward: first stage writes to complexTo, then ping-pong
          // - Inverse: start from complexFrom, ping-pong, last stage reads from complexFrom
          
          const stageIndex = axis * numStages + stage;
          let srcTex, dstTex, dstFBO;
          
          if (!inverse) {
            // Forward: first stage already wrote to complexTo
            // Subsequent stages ping-pong
            const isEvenStage = (stageIndex - 1) % 2 === 0;
            srcTex = isEvenStage ? this.complexTo : this.complexFrom;
            dstTex = isEvenStage ? this.complexFrom : this.complexTo;
            dstFBO = isEvenStage ? this.framebufferFrom : this.framebufferTo;
          } else {
            // Inverse: start from complexFrom, ping-pong until last stage
            const isEvenStage = stageIndex % 2 === 0;
            srcTex = isEvenStage ? this.complexFrom : this.complexTo;
            dstTex = isEvenStage ? this.complexTo : this.complexFrom;
            dstFBO = isEvenStage ? this.framebufferTo : this.framebufferFrom;
          }

          gl.activeTexture(gl.TEXTURE0);
          gl.bindTexture(gl.TEXTURE_2D, srcTex);
          gl.uniform1i(gl.getUniformLocation(program, 'u_spectrum'), 0);

          gl.bindFramebuffer(gl.FRAMEBUFFER, dstFBO);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTex, 0);
        }

        gl.bindVertexArray(this.quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
      }
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Dispose all resources
   */
  dispose() {
    const gl = this.gl;

    if (this.fftProgramRealToComplex) gl.deleteProgram(this.fftProgramRealToComplex);
    if (this.fftProgramComplexToReal) gl.deleteProgram(this.fftProgramComplexToReal);
    if (this.fftProgramComplexToComplex) gl.deleteProgram(this.fftProgramComplexToComplex);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.framebufferFrom) gl.deleteFramebuffer(this.framebufferFrom);
    if (this.framebufferTo) gl.deleteFramebuffer(this.framebufferTo);
    if (this.framebufferReal) gl.deleteFramebuffer(this.framebufferReal);

    if (this.real) {
      if (this.ownsReal) gl.deleteTexture(this.real);
      this.real = null;
    }
    if (this.complexFrom) {
      if (this.ownsComplexFrom) gl.deleteTexture(this.complexFrom);
      this.complexFrom = null;
    }
    if (this.complexTo) {
      if (this.ownsComplexTo) gl.deleteTexture(this.complexTo);
      this.complexTo = null;
    }
  }
}

/**
 * Helper: Create an R32F single-channel texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createTextureR32F(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null);
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
 * @param {number} width
 * @param {number} height
 */
function createComplexTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
