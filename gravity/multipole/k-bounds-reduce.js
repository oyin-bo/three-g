// @ts-check


import { fsQuadVert } from '../core-shaders.js';
import { formatNumber, readLinear } from '../diag.js';

/**
 * BoundsReduceKernel2 - GPU-resident hierarchical bounds reduction (8×8 tiles)
 * 
 * Reduces N particle positions to a single bounding box (min, max) using 
 * 8×8 tile reduction passes. Output is a 2×1 texture containing
 * (minX, minY, minZ, _) and (maxX, maxY, maxZ, _).
 * 
 * Uses at most 2 intermediate textures, reusing them via ping-pong.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */
export class KBoundsReduce {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   outBounds?: WebGLTexture|null,
   *   particleTextureWidth: number,
   *   particleTextureHeight: number,
   *   particleCount?: number
   * }} options
   */
  constructor({ gl, inPosition, outBounds, particleTextureWidth, particleTextureHeight, particleCount }) {
    this.gl = gl;

    // Resource slots - follow kernel contract
    this.inPosition = (inPosition || inPosition === null) ? inPosition : createPositionTexture(this.gl, particleTextureWidth, particleTextureHeight);
    this.outBounds = (outBounds || outBounds === null) ? outBounds : createBoundsTexture(this.gl);

    // Texture dimensions
    this.particleTextureWidth = particleTextureWidth;
    this.particleTextureHeight = particleTextureHeight;
    this.particleCount = particleCount || 0;

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

    // Calculate how many reduction passes we need (8× reduction per pass)
    let width = this.particleTextureWidth;
    let height = this.particleTextureHeight;
    const sizes = [];
    
    while (width > 8 || height > 8) {
      width = Math.max(1, Math.ceil(width / 8));
      height = Math.max(1, Math.ceil(height / 8));
      sizes.push({ width, height });
    }

    // Allocate intermediate textures based on number of passes needed
    // 0 passes: input → output (no intermediates)
    // 1 pass: input → small → output (1 intermediate)
    // 2+ passes: input → small → smaller → small → smaller... → output (2 intermediates, ping-pong)
    
    this.smallTexture = null;
    this.smallerTexture = null;
    this.smallFBO = null;
    this.smallerFBO = null;
    
    if (sizes.length >= 1) {
      const firstSize = sizes[0];
      this.smallTexture = createReductionTexture(this.gl, firstSize.width, firstSize.height);
      this.smallFBO = this.gl.createFramebuffer();
    }
    
    if (sizes.length >= 2) {
      const secondSize = sizes[1];
      this.smallerTexture = createReductionTexture(this.gl, secondSize.width, secondSize.height);
      this.smallerFBO = this.gl.createFramebuffer();
    }

    // Store reduction sizes for run()
    this.reductionSizes = sizes;

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
        gl: this.gl, texture: this.inPosition, width: this.particleTextureWidth,
        height: this.particleTextureHeight, count: this.particleCount,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      bounds: this.outBounds && readLinear({
        gl: this.gl, texture: this.outBounds, width: 2, height: 1, count: 2,
        channels: ['x', 'y', 'z', 'w'], pixels
      }),
      particleTextureWidth: this.particleTextureWidth,
      particleTextureHeight: this.particleTextureHeight,
      particleCount: this.particleCount,
      reductionPasses: this.reductionSizes.length,
      renderCount: this.renderCount
    };

    // Extract actual bounds if available
    const boundsMin = value.bounds?.pixels?.[0] ?
      [value.bounds.pixels[0].x, value.bounds.pixels[0].y, value.bounds.pixels[0].z] : null;
    const boundsMax = value.bounds?.pixels?.[1] ?
      [value.bounds.pixels[1].x, value.bounds.pixels[1].y, value.bounds.pixels[1].z] : null;

    value.toString = () =>
      `KBoundsReduce2(${this.particleCount} particles) ${this.particleTextureWidth}×${this.particleTextureHeight} passes=${this.reductionSizes.length} #${this.renderCount}

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
      throw new Error('KBoundsReduce2: missing required textures');
    }

    gl.useProgram(this.program);

    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);

    let inputTex = this.inPosition;
    let inputWidth = this.particleTextureWidth;
    let inputHeight = this.particleTextureHeight;

    // Execute reduction passes
    for (let i = 0; i < this.reductionSizes.length; i++) {
      const size = this.reductionSizes[i];
      
      // Determine output texture and FBO for this pass
      let outputTex, outputFBO;
      if (i === 0) {
        // First pass always goes to smallTexture
        outputTex = this.smallTexture;
        outputFBO = this.smallFBO;
      } else if (i === 1) {
        // Second pass goes to smallerTexture
        outputTex = this.smallerTexture;
        outputFBO = this.smallerFBO;
      } else {
        // Subsequent passes ping-pong between small and smaller
        // If previous was smaller, output to small; if previous was small, output to smaller
        if (i % 2 === 0) {
          outputTex = this.smallTexture;
          outputFBO = this.smallFBO;
        } else {
          outputTex = this.smallerTexture;
          outputFBO = this.smallerFBO;
        }
      }

      gl.bindFramebuffer(gl.FRAMEBUFFER, outputFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTex, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      gl.viewport(0, 0, size.width, size.height);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inputTex);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_inputTex'), 0);
      gl.uniform2f(gl.getUniformLocation(this.program, 'u_inputSize'), inputWidth, inputHeight);

      gl.bindVertexArray(this.quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);

      // Next iteration uses this pass's output as input
      inputTex = /** @type {WebGLTexture} */ (outputTex);
      inputWidth = size.width;
      inputHeight = size.height;
    }

    // Final pass: reduce to 2×1 output
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outBounds, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, 2, 1);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, inputTex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_inputTex'), 0);
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_inputSize'), inputWidth, inputHeight);

    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    if (this.program) this.gl.deleteProgram(this.program);
    if (this.quadVAO) this.gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebuffer) this.gl.deleteFramebuffer(this.outFramebuffer);

    if (this.smallTexture) this.gl.deleteTexture(this.smallTexture);
    if (this.smallerTexture) this.gl.deleteTexture(this.smallerTexture);
    if (this.smallFBO) this.gl.deleteFramebuffer(this.smallFBO);
    if (this.smallerFBO) this.gl.deleteFramebuffer(this.smallerFBO);

    if (this.inPosition) this.gl.deleteTexture(this.inPosition);
    if (this.outBounds) this.gl.deleteTexture(this.outBounds);
  }
}

/**
 * Bounds reduction shader - 8×8 tile reduction
 * 
 * Each output pixel samples an 8×8 region from the input texture.
 * Output format: pixel at x=0 contains min, pixel at x=1 contains max.
 */
function boundsReduceShader() {
  return `#version 300 es
precision highp float;

uniform sampler2D u_inputTex;
uniform vec2 u_inputSize;

out vec4 fragColor;

void main() {
  ivec2 outCoord = ivec2(gl_FragCoord.xy);
  
  vec3 minBound = vec3(1e20);
  vec3 maxBound = vec3(-1e20);
  bool hasValidData = false;
  
  // Calculate base input coordinate for this output pixel's 8×8 tile
  ivec2 baseCoord = outCoord * 8;
  
  // Sample 8×8 region
  for (int dy = 0; dy < 8; dy++) {
    for (int dx = 0; dx < 8; dx++) {
      ivec2 coord = baseCoord + ivec2(dx, dy);
      
      // Bounds check - skip if outside input texture
      if (coord.x >= int(u_inputSize.x) || coord.y >= int(u_inputSize.y)) {
        continue;
      }
      
      vec4 texel = texelFetch(u_inputTex, coord, 0);
      vec3 pos = texel.xyz;
      float mass = texel.w;
      
      // Skip particles with NaN coordinates, NaN mass, or non-positive mass
      if (isnan(pos.x) || isnan(pos.y) || isnan(pos.z) || isnan(mass) || mass <= 0.0) {
        continue;
      }
      
      minBound = min(minBound, pos);
      maxBound = max(maxBound, pos);
      hasValidData = true;
    }
  }
  
  // Output based on pixel coordinate
  if (outCoord.x == 0) {
    // Pixel 0: output minBounds
    fragColor = vec4(minBound, hasValidData ? 1.0 : 0.0);
  } else {
    // Pixel 1: output maxBounds
    fragColor = vec4(maxBound, hasValidData ? 1.0 : 0.0);
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

/**
 * Create position texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createPositionTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create position texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
