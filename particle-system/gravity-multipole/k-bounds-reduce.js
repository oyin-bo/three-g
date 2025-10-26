// @ts-check

/**
 * BoundsReduceKernel - GPU-resident hierarchical bounds reduction
 * 
 * Reduces N particle positions to a single bounding box (min, max) using 
 * recursive min/max reduction passes. Output is a 2×1 texture containing
 * (minX, minY, minZ, _) and (maxX, maxY, maxZ, _).
 * 
 * This eliminates CPU readback and enables dynamic world bounds updates.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';
import { readLinear, formatNumber } from '../diag.js';

export class KBoundsReduce {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   outBounds?: WebGLTexture|null,
   *   particleTexWidth?: number,
   *   particleTexHeight?: number,
   *   particleCount?: number
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots - follow kernel contract
    this.inPosition = (options.inPosition || options.inPosition === null)
      ? options.inPosition
      : null;
    
    this.outBounds = (options.outBounds || options.outBounds === null)
      ? options.outBounds
      : createBoundsTexture(this.gl);
    
    // Texture dimensions
    this.particleTexWidth = options.particleTexWidth || 0;
    this.particleTexHeight = options.particleTexHeight || 0;
    this.particleCount = options.particleCount || 0;
    
    // Create shader program
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
    this.gl.shaderSource(frag, boundsReduceShader());
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
    const quadVertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, quadVertices, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    this.quadVAO = quadVAO;
    
    // Allocate intermediate reduction textures (pyramid of reductions)
    // Each level reduces by 16× (4×4 samples per output texel)
    this.reductionLevels = [];
    let currentWidth = this.particleTexWidth;
    let currentHeight = this.particleTexHeight;
    
    while (currentWidth > 1 || currentHeight > 1) {
      currentWidth = Math.max(1, Math.ceil(currentWidth / 4));
      currentHeight = Math.max(1, Math.ceil(currentHeight / 4));
      
      // Each level stores min in R,G,B and max in A (packed)
      // Actually, we need 2 texels per level: one for min, one for max
      // So make width = max(2, currentWidth)
      const levelWidth = Math.max(2, currentWidth);
      const tex = createReductionTexture(this.gl, levelWidth, currentHeight);
      const fbo = this.gl.createFramebuffer();
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, fbo);
      this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, tex, 0);
      this.gl.drawBuffers([this.gl.COLOR_ATTACHMENT0]);
      const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
      if (status !== this.gl.FRAMEBUFFER_COMPLETE) {
        throw new Error(`Reduction framebuffer incomplete: ${status}`);
      }
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);
      
      this.reductionLevels.push({ texture: tex, framebuffer: fbo, width: levelWidth, height: currentHeight });
    }
    
    // Create final framebuffer for outBounds
    this.outFramebuffer = this.gl.createFramebuffer();
  }
  
  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      position: this.inPosition && readLinear({
        gl: this.gl, texture: this.inPosition, width: this.particleTexWidth,
        height: this.particleTexHeight, count: this.particleCount,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      bounds: this.outBounds && readLinear({
        gl: this.gl, texture: this.outBounds, width: 2, height: 1, count: 2,
        channels: ['x', 'y', 'z', 'w'], pixels
      }),
      particleTexWidth: this.particleTexWidth,
      particleTexHeight: this.particleTexHeight,
      particleCount: this.particleCount,
      reductionLevels: this.reductionLevels.length,
      renderCount: this.renderCount
    };
    
    // Extract actual bounds if available
    const boundsMin = value.bounds?.pixels?.[0] ? 
      [value.bounds.pixels[0].x, value.bounds.pixels[0].y, value.bounds.pixels[0].z] : null;
    const boundsMax = value.bounds?.pixels?.[1] ? 
      [value.bounds.pixels[1].x, value.bounds.pixels[1].y, value.bounds.pixels[1].z] : null;
    
    value.toString = () =>
`KBoundsReduce(${this.particleCount} particles) ${this.particleTexWidth}×${this.particleTexHeight} levels=${this.reductionLevels.length} #${this.renderCount}

position: ${value.position}

bounds: ${value.bounds}${boundsMin && boundsMax ? `
  computed: [${boundsMin.map(formatNumber).join(',')}] to [${boundsMax.map(formatNumber).join(',')}]` : ''}`;
    
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
   */
  run() {
    const gl = this.gl;
    
    if (!this.inPosition || !this.outBounds) {
      throw new Error('KBoundsReduce: missing required textures');
    }
    
    gl.useProgram(this.program);
    
    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    
    // First pass: reduce particle positions → first level
    let inputTex = this.inPosition;
    let inputWidth = this.particleTexWidth;
    let inputHeight = this.particleTexHeight;
    
    for (let i = 0; i < this.reductionLevels.length; i++) {
      const level = this.reductionLevels[i];
      
      gl.bindFramebuffer(gl.FRAMEBUFFER, level.framebuffer);
      gl.viewport(0, 0, level.width, level.height);
      
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTex);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_inputTex'), 0);
      
      gl.uniform2f(gl.getUniformLocation(this.program, 'u_inputSize'), inputWidth, inputHeight);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_particleCount'), 
        i === 0 ? this.particleCount : (inputWidth * inputHeight));
      
      gl.bindVertexArray(this.quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      
      // Next iteration uses this level's output as input
      inputTex = level.texture;
      inputWidth = level.width;
      inputHeight = level.height;
    }
    
    // Final pass: reduce last level → 2×1 output
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outBounds, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, 2, 1);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_inputTex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_inputSize'), inputWidth, inputHeight);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particleCount'), inputWidth * inputHeight);
    
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    this.renderCount = (this.renderCount || 0) + 1;
  }
  
  /**
   * Dispose all resources
   */
  dispose() {
    const gl = this.gl;
    
    if (this.program) gl.deleteProgram(this.program);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebuffer) gl.deleteFramebuffer(this.outFramebuffer);
    
    for (const level of this.reductionLevels) {
      if (level.texture) gl.deleteTexture(level.texture);
      if (level.framebuffer) gl.deleteFramebuffer(level.framebuffer);
    }
    
    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.outBounds) gl.deleteTexture(this.outBounds);
  }
}

/**
 * Bounds reduction shader - hierarchical min/max
 */
function boundsReduceShader() {
  return `#version 300 es
precision highp float;

uniform sampler2D u_inputTex;
uniform vec2 u_inputSize;
uniform int u_particleCount;

out vec4 fragColor;

void main() {
  ivec2 outCoord = ivec2(gl_FragCoord.xy);
  
  // Each output texel samples a 4×4 region of input
  ivec2 baseCoord = outCoord * 4;
  
  // Initialize to extreme values
  vec3 minBound = vec3(1e20);
  vec3 maxBound = vec3(-1e20);
  
  // Sample 4×4 region (16 samples)
  for (int dy = 0; dy < 4; dy++) {
    for (int dx = 0; dx < 4; dx++) {
      ivec2 sampleCoord = baseCoord + ivec2(dx, dy);
      
      // Bounds check
      if (sampleCoord.x >= int(u_inputSize.x) || sampleCoord.y >= int(u_inputSize.y)) {
        continue;
      }
      
      vec4 texel = texelFetch(u_inputTex, sampleCoord, 0);
      vec3 pos = texel.xyz;
      float mass = texel.w;
      
      // Only include particles with positive mass
      if (mass > 0.0) {
        minBound = min(minBound, pos);
        maxBound = max(maxBound, pos);
      }
    }
  }
  
  // Output format: texel 0 = min, texel 1 = max
  if (outCoord.x == 0 && outCoord.y == 0) {
    fragColor = vec4(minBound, 1.0);
  } else if (outCoord.x == 1 && outCoord.y == 0) {
    fragColor = vec4(maxBound, 1.0);
  } else {
    // Intermediate levels: pack min/max into RGBA
    // Store both for next reduction pass
    fragColor = vec4(minBound.xy, maxBound.xy);
  }
}
`;
}

/**
 * Create 2×1 texture for bounds (minXYZ, maxXYZ)
 * @param {WebGL2RenderingContext} gl
 */
function createBoundsTexture(gl) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create bounds texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 2, 1, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/**
 * Create intermediate reduction texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createReductionTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create reduction texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

