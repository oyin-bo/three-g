// @ts-check

/**
 * KNearField - Computes near-field corrections
 * 
 * Computes real-space near-field forces to correct mesh approximation errors.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';
import nearFieldFrag from '../shaders/near-field.frag.js';

export class KNearField {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inMassGrid?: WebGLTexture|null,
   *   outForceX?: WebGLTexture|null,
   *   outForceY?: WebGLTexture|null,
   *   outForceZ?: WebGLTexture|null,
   *   quadVAO?: WebGLVertexArrayObject|null,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   softening?: number,
   *   gravityStrength?: number,
   *   nearFieldRadius?: number
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inMassGrid = options.inMassGrid !== undefined ? options.inMassGrid : null;
    this.outForceX = options.outForceX !== undefined ? options.outForceX : null;
    this.outForceY = options.outForceY !== undefined ? options.outForceY : null;
    this.outForceZ = options.outForceZ !== undefined ? options.outForceZ : null;
    this.quadVAO = options.quadVAO !== undefined ? options.quadVAO : null;
    
    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || Math.ceil(Math.sqrt(this.gridSize));
    this.textureSize = options.textureSize || (this.gridSize * this.slicesPerRow);
    
    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-4, -4, -4],
      max: [4, 4, 4]
    };
    
    // Physics parameters
    this.softening = options.softening || 0.15;
    this.gravityStrength = options.gravityStrength || 0.0003;
    this.nearFieldRadius = options.nearFieldRadius || 2;
    
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
    this.gl.shaderSource(frag, nearFieldFrag);
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

    // Create FBOs for three output textures
    this.framebufferX = this.gl.createFramebuffer();
    this.framebufferY = this.gl.createFramebuffer();
    this.framebufferZ = this.gl.createFramebuffer();
    if (!this.framebufferX || !this.framebufferY || !this.framebufferZ) {
      throw new Error('Failed to create framebuffers');
    }
    
    // If no output textures provided, create them
    if (!this.outForceX || !this.outForceY || !this.outForceZ) {
      this.outForceX = this._createForceTexture();
      this.outForceY = this._createForceTexture();
      this.outForceZ = this._createForceTexture();
      this.ownsOutTextures = true;
    } else {
      this.ownsOutTextures = false;
    }
    
    // Create quad VAO if not provided
    if (!this.quadVAO) {
      this.quadVAO = this._createQuadVAO();
      this.ownsQuadVAO = true;
    } else {
      this.ownsQuadVAO = false;
    }
  }

  _createForceTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create texture');
    
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.textureSize, this.textureSize, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    
    if (!this.inMassGrid) {
      throw new Error('KNearField: inMassGrid texture not set');
    }
    if (!this.outForceX || !this.outForceY || !this.outForceZ) {
      throw new Error('KNearField: output force textures not set');
    }
    
    // Save GL state
    const prevFB = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    const prevVP = gl.getParameter(gl.VIEWPORT);
    const prevProg = gl.getParameter(gl.CURRENT_PROGRAM);
    const prevVAO = gl.getParameter(gl.VERTEX_ARRAY_BINDING);
    const prevBlend = gl.getParameter(gl.BLEND);
    const prevDepthTest = gl.getParameter(gl.DEPTH_TEST);
    
    gl.viewport(0, 0, this.textureSize, this.textureSize);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    
    gl.useProgram(this.program);
    
    // Bind input texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inMassGrid);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_massGrid'), 0);
    
    // Set uniforms
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'), this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'), this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_softening'), this.softening);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gravityStrength'), this.gravityStrength);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_nearFieldRadius'), this.nearFieldRadius);
    
    gl.bindVertexArray(this.quadVAO);
    
    // Render to X component
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebufferX);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceX, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_component'), 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    // Render to Y component
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebufferY);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceY, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_component'), 1);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    
    // Render to Z component
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebufferZ);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForceZ, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_component'), 2);
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
    
    if (this.framebufferX) gl.deleteFramebuffer(this.framebufferX);
    if (this.framebufferY) gl.deleteFramebuffer(this.framebufferY);
    if (this.framebufferZ) gl.deleteFramebuffer(this.framebufferZ);
    this.framebufferX = null;
    this.framebufferY = null;
    this.framebufferZ = null;
    
    if (this.ownsOutTextures) {
      if (this.outForceX) gl.deleteTexture(this.outForceX);
      if (this.outForceY) gl.deleteTexture(this.outForceY);
      if (this.outForceZ) gl.deleteTexture(this.outForceZ);
      this.outForceX = null;
      this.outForceY = null;
      this.outForceZ = null;
    }
    
    if (this.ownsQuadVAO && this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
      this.quadVAO = null;
    }
  }
}
