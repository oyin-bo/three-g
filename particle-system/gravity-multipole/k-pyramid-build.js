// @ts-check

import fsQuadVert from '../shaders/fullscreen.vert.js';
import reductionFrag from '../shaders/reduction.frag.js';

/**
 * Builds octree pyramid via 2x2x2 reduction
 * 
 * Reduces one octree level to the next coarser level by sampling 8 child cells.
 * Outputs three MRT attachments: A0 (monopole), A1 (quadrupole), A2 (quadrupole).
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */
export class KPyramidBuild {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   outSize: number,
   *   outGridSize: number,
   *   outSlicesPerRow: number,
   *   inA0?: WebGLTexture|null,
   *   inA1?: WebGLTexture|null,
   *   inA2?: WebGLTexture|null,
   *   outA0?: WebGLTexture|null,
   *   outA1?: WebGLTexture|null,
   *   outA2?: WebGLTexture|null
   * }} options
   */
  constructor({
    gl,
    outSize,
    outGridSize,
    outSlicesPerRow,
    inA0, inA1, inA2,
    outA0, outA1, outA2
  }) {
    this.gl = gl;

    this.outSize = outSize;
    this.outGridSize = outGridSize;
    this.outSlicesPerRow = outSlicesPerRow;

    // Input textures are 2x larger because pyramid reduction is 2×2×2 → 1
    const inSize = this.outSize * 2;
    this.inA0 = (inA0 || inA0 === null) ? inA0 : createTextureRGBA32F(this.gl, inSize, inSize);
    this.inA1 = (inA1 || inA1 === null) ? inA1 : createTextureRGBA32F(this.gl, inSize, inSize);
    this.inA2 = (inA2 || inA2 === null) ? inA2 : createTextureRGBA32F(this.gl, inSize, inSize);

    this.outA0 = (outA0 || outA0 === null) ? outA0 : createTextureRGBA32F(this.gl, this.outSize || 1, this.outSize || 1);
    this.outA1 = (outA1 || outA1 === null) ? outA1 : createTextureRGBA32F(this.gl, this.outSize || 1, this.outSize || 1);
    this.outA2 = (outA2 || outA2 === null) ? outA2 : createTextureRGBA32F(this.gl, this.outSize || 1, this.outSize || 1);

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
    this.gl.shaderSource(frag, reductionFrag);
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

    // Create framebuffer (internal) and attach initial outputs. We keep a
    // small shadow of the currently-attached textures so run() can rebind
    // only when attachments change. Create the FBO now and then configure it.
    this.outFramebuffer = this.gl.createFramebuffer();

    // Shadow state of attachments starts as detached (null). The framebuffer
    // will be (re)configured inside run() when attachments are present or change.
    /** @type {{ a0: WebGLTexture, a1: WebGLTexture, a2: WebGLTexture } | null} */
    this._fboShadow = null;
  }

  run() {
    this.gl.useProgram(this.program);

    // Ensure the framebuffer attachments match our current outputs. We
    // only reconfigure when attachments differ from the shadow to avoid
    // redundant GL calls.
    if (!this._fboShadow?.a0 !== this.outA0 ||
      this._fboShadow?.a1 !== this.outA1 ||
      this._fboShadow?.a2 !== this.outA2) {
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.outFramebuffer);

      // Attach or detach attachments explicitly
      this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.outA0, 0);
      this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT1, this.gl.TEXTURE_2D, this.outA1, 0);
      this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT2, this.gl.TEXTURE_2D, this.outA2, 0);

      this.gl.drawBuffers([
        this.gl.COLOR_ATTACHMENT0,
        this.gl.COLOR_ATTACHMENT1,
        this.gl.COLOR_ATTACHMENT2
      ]);

      const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
      if (status !== this.gl.FRAMEBUFFER_COMPLETE) {
        this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
        throw new Error(`MRT framebuffer incomplete: ${status}`);
      }

      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

      // Shadow state of attachments (references or null)
      this._fboShadow = {
        a0: /** @type {WebGLTexture} */ (this.outA0),
        a1: /** @type {WebGLTexture} */ (this.outA1),
        a2: /** @type {WebGLTexture} */ (this.outA2)
      };
    }

    // Bind output framebuffer (MRT)
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.outFramebuffer);
    this.gl.viewport(0, 0, this.outSize, this.outSize);

    // Setup GL state
    this.gl.disable(this.gl.DEPTH_TEST);
    this.gl.disable(this.gl.BLEND);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.colorMask(true, true, true, true);

    // Bind input textures
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.inA0);
    this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_previousLevelA0'), 0);

    this.gl.activeTexture(this.gl.TEXTURE1);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.inA1);
    this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_previousLevelA1'), 1);

    this.gl.activeTexture(this.gl.TEXTURE2);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.inA2);
    this.gl.uniform1i(this.gl.getUniformLocation(this.program, 'u_previousLevelA2'), 2);

    // Set uniforms
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_gridSize'), this.outGridSize);
    this.gl.uniform1f(this.gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.outSlicesPerRow);

    // Draw
    this.gl.bindVertexArray(this.quadVAO);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
    this.gl.bindVertexArray(null);

    this.gl.activeTexture(this.gl.TEXTURE2);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.gl.activeTexture(this.gl.TEXTURE1);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.gl.useProgram(null);

    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
  }

  dispose() {
    if (this.program) this.gl.deleteProgram(this.program);

    if (this.quadVAO) this.gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebuffer) this.gl.deleteFramebuffer(this.outFramebuffer);

    if (this.inA0) this.gl.deleteTexture(this.inA0);
    if (this.inA1) this.gl.deleteTexture(this.inA1);
    if (this.inA2) this.gl.deleteTexture(this.inA2);
    if (this.outA0) this.gl.deleteTexture(this.outA0);
    if (this.outA1) this.gl.deleteTexture(this.outA1);
    if (this.outA2) this.gl.deleteTexture(this.outA2);

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
};