// @ts-check

/**
 * KForceSample - Samples force grids at particle positions
 * 
 * Interpolates forces from 3D grid to particle positions.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import forceSampleVert from '../gravity-spectral/shaders/force-sample.vert.js';
import forceSampleFrag from '../gravity-spectral/shaders/force-sample.frag.js';

export class KForceSample {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inForceGridX?: WebGLTexture|null,
   *   inForceGridY?: WebGLTexture|null,
   *   inForceGridZ?: WebGLTexture|null,
   *   outForce?: WebGLTexture|null,
   *   particleCount?: number,
   *   particleTexWidth?: number,
   *   particleTexHeight?: number,
   *   gridSize?: number,
   *   slicesPerRow?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   accumulate?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;
    this.inForceGridX = options.inForceGridX !== undefined ? options.inForceGridX : null;
    this.inForceGridY = options.inForceGridY !== undefined ? options.inForceGridY : null;
    this.inForceGridZ = options.inForceGridZ !== undefined ? options.inForceGridZ : null;
    this.outForce = options.outForce !== undefined ? options.outForce : null;
    
    // Particle configuration
    this.particleCount = options.particleCount || 0;
    this.particleTexWidth = options.particleTexWidth || 0;
    this.particleTexHeight = options.particleTexHeight || 0;
    
    // Grid configuration
    this.gridSize = options.gridSize || 64;
    this.slicesPerRow = options.slicesPerRow || Math.ceil(Math.sqrt(this.gridSize));
    
    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-4, -4, -4],
      max: [4, 4, 4]
    };
    
    // Accumulate flag
    this.accumulate = options.accumulate !== undefined ? options.accumulate : false;
    
    // Compile and link shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, forceSampleVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, forceSampleFrag);
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
    if (!buffer) throw new Error('Failed to create buffer');
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(this.particleCount), this.gl.STATIC_DRAW);
    this.gl.bindVertexArray(null);
    this.particleVAO = particleVAO;

    // Create FBO for output
    this.framebuffer = this.gl.createFramebuffer();
    if (!this.framebuffer) throw new Error('Failed to create framebuffer');
    
    // If no output texture provided, create one
    if (!this.outForce) {
      this.outForce = this._createForceTexture();
      this.ownsOutForce = true;
    } else {
      this.ownsOutForce = false;
    }
  }

  _createForceTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create texture');
    
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.particleTexWidth, this.particleTexHeight, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    
    return texture;
  }

  run() {
    const gl = this.gl;
    
    if (!this.inPosition) {
      throw new Error('KForceSample: inPosition texture not set');
    }
    if (!this.inForceGridX || !this.inForceGridY || !this.inForceGridZ) {
      throw new Error('KForceSample: input force grid textures not set');
    }
    if (!this.outForce) {
      throw new Error('KForceSample: outForce texture not set');
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
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForce, 0);
    
    const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`KForceSample: Framebuffer incomplete: ${fbStatus}`);
    }
    
    gl.viewport(0, 0, this.particleTexWidth, this.particleTexHeight);
    
    if (this.accumulate) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.blendEquation(gl.FUNC_ADD);
    } else {
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.disable(gl.DEPTH_TEST);
    
    gl.useProgram(this.program);
    
    // Bind input textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_positionTexture'), 0);
    
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.inForceGridX);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_forceGridX'), 1);
    
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.inForceGridY);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_forceGridY'), 2);
    
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.inForceGridZ);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_forceGridZ'), 3);
    
    // Set uniforms
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_textureSize'), this.particleTexWidth, this.particleTexHeight);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_slicesPerRow'), this.slicesPerRow);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'), this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'), this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    
    gl.bindVertexArray(this.particleVAO);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);
    gl.bindVertexArray(null);
    
    // Restore GL state
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
    gl.useProgram(prevProg);
    gl.bindVertexArray(prevVAO);
    if (!prevBlend) gl.disable(gl.BLEND);
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);
  }

  dispose() {
    const gl = this.gl;
    
    if (this.program) {
      gl.deleteProgram(this.program);
      this.program = null;
    }
    
    if (this.particleVAO) {
      gl.deleteVertexArray(this.particleVAO);
      this.particleVAO = null;
    }
    
    if (this.framebuffer) {
      gl.deleteFramebuffer(this.framebuffer);
      this.framebuffer = null;
    }
    
    if (this.ownsOutForce && this.outForce) {
      gl.deleteTexture(this.outForce);
      this.outForce = null;
    }
  }
}
