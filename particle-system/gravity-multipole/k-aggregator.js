// @ts-check

/**
 * AggregatorKernel - Aggregates particles into L0 octree level
 * 
 * Deposits particle moments into the finest octree level using additive blending.
 * Outputs three MRT attachments: A0 (monopole), A1 (quadrupole xx,yy,zz,xy), A2 (quadrupole xz,yz).
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import aggregationVert from '../shaders/aggregation.vert.js';
import aggregationFrag from '../shaders/aggregation.frag.js';


export class KAggregator {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   outA0?: WebGLTexture|null,
   *   outA1?: WebGLTexture|null,
   *   outA2?: WebGLTexture|null,
   *   particleCount?: number,
   *   particleTexWidth?: number,
   *   particleTexHeight?: number,
   *   octreeSize?: number,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   disableFloatBlend?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Particle configuration
    this.particleCount = options.particleCount || 0;
    this.particleTexWidth = options.particleTexWidth || 0;
    this.particleTexHeight = options.particleTexHeight || 0;
    
    // Octree configuration
    this.octreeSize = options.octreeSize || 512;
    
    // Resource slots - create textures if not provided per kernel contract
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;
    const { outA0, outA1, outA2 } = options;
    this.outA0 = (outA0 || outA0 === null) ? outA0 : createTextureRGBA32F(this.gl, this.octreeSize, this.octreeSize);
    this.outA1 = (outA1 || outA1 === null) ? outA1 : createTextureRGBA32F(this.gl, this.octreeSize, this.octreeSize);
    this.outA2 = (outA2 || outA2 === null) ? outA2 : createTextureRGBA32F(this.gl, this.octreeSize, this.octreeSize);
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || 8;
    
    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-4, -4, 0],
      max: [4, 4, 2]
    };
    
    // Float blend flag
    this.disableFloatBlend = options.disableFloatBlend || false;
    
    // Compile and link shader program (inline, like KPyramidBuild)
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, aggregationVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, aggregationFrag);
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
    
    // Create an internal framebuffer (will be configured per-run). We keep
    // a small shadow of attachments so run() can rebind only when they change.
    this.outFramebuffer = this.gl.createFramebuffer();
    /** @type {{ a0: WebGLTexture, a1: WebGLTexture, a2: WebGLTexture } | null} */
    this._fboShadow = null;
  }
  
  /**
   * @param {string} vertSrc
   * @param {string} fragSrc
   * @returns {WebGLProgram}
   */
  // removed helper methods; shader compile and VAO created inline in constructor
  
  /**
   * Run the kernel (synchronous)
   */
  run() {
    const gl = this.gl;
    
    if (!this.inPosition || !this.outA0 || !this.outA1 || !this.outA2) {
      throw new Error('KAggregator: missing required textures');
    }
    
    gl.useProgram(this.program);
    
    // Ensure framebuffer attachments match our outputs. Reconfigure when
    // attachments differ from the shadow to avoid redundant GL calls.
    if (this._fboShadow?.a0 !== this.outA0 ||
      this._fboShadow?.a1 !== this.outA1 ||
      this._fboShadow?.a2 !== this.outA2) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
      if (this.outA0) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outA0, 0);
      if (this.outA1) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.outA1, 0);
      if (this.outA2) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, this.outA2, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error(`MRT framebuffer incomplete: ${status}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._fboShadow = { a0: this.outA0, a1: this.outA1, a2: this.outA2 };
    }

    // Bind output framebuffer (MRT)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    // Reassert draw buffers on the bound FBO (robust across context changes)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.viewport(0, 0, this.octreeSize, this.octreeSize);
    
    // Clear outputs
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    
    // Setup GL state for additive blending
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    
    if (!this.disableFloatBlend) {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }
    
    // Bind position texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_positions'), 0);
    
    // Set uniforms
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_texSize'), 
      this.particleTexWidth, this.particleTexHeight);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'),
      this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'),
      this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    
    // Draw particles as points
    gl.bindVertexArray(this.particleVAO);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.bindVertexArray(null);
    
    // Disable blend
    gl.disable(gl.BLEND);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    
    // Unbind
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

    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.outA0) gl.deleteTexture(this.outA0);
    if (this.outA1) gl.deleteTexture(this.outA1);
    if (this.outA2) gl.deleteTexture(this.outA2);

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
}
