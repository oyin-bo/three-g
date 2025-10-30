// @ts-check

import { readLinear } from '../diag.js';

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

    // Require float color attachments for first-pass render-to-float
    // WebGL2 needs EXT_color_buffer_float to render to RGBA16F/RGBA32F
    this._extColorBufferFloat = this.gl.getExtension('EXT_color_buffer_float');
    if (!this._extColorBufferFloat) throw new Error('KBoundsReduce: EXT_color_buffer_float not available; first pass cannot render to float textures');

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
    // Use a fullscreen triangle to avoid VBO/attribute dependency for passes
    this.gl.shaderSource(vert, fsQuadVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    // Create first pass shader (particle positions → min/max pairs)
    const fragFirst = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!fragFirst) throw new Error('Failed to create first pass fragment shader');
    this.gl.shaderSource(fragFirst, firstPassShader());
    this.gl.compileShader(fragFirst);
    if (!this.gl.getShaderParameter(fragFirst, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(fragFirst);
      this.gl.deleteShader(fragFirst);
      throw new Error(`First pass shader compile failed: ${info}`);
    }

    this.programFirst = this.gl.createProgram();
    if (!this.programFirst) throw new Error('Failed to create first pass program');
    this.gl.attachShader(this.programFirst, vert);
    this.gl.attachShader(this.programFirst, fragFirst);
    this.gl.linkProgram(this.programFirst);
    if (!this.gl.getProgramParameter(this.programFirst, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.programFirst);
      this.gl.deleteProgram(this.programFirst);
      throw new Error(`First pass program link failed: ${info}`);
    }
    this.gl.deleteShader(fragFirst);

    // Create reduction pass shader (min/max pairs → min/max pairs)
    const fragReduce = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!fragReduce) throw new Error('Failed to create reduction fragment shader');
    this.gl.shaderSource(fragReduce, reductionPassShader());
    this.gl.compileShader(fragReduce);
    if (!this.gl.getShaderParameter(fragReduce, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(fragReduce);
      this.gl.deleteShader(fragReduce);
      throw new Error(`Reduction pass shader compile failed: ${info}`);
    }

    this.programReduce = this.gl.createProgram();
    if (!this.programReduce) throw new Error('Failed to create reduction pass program');
    this.gl.attachShader(this.programReduce, vert);
    this.gl.attachShader(this.programReduce, fragReduce);
    this.gl.linkProgram(this.programReduce);
    if (!this.gl.getProgramParameter(this.programReduce, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.programReduce);
      this.gl.deleteProgram(this.programReduce);
      throw new Error(`Reduction pass program link failed: ${info}`);
    }

    this.gl.deleteShader(vert);
    this.gl.deleteShader(fragReduce);

    // Create a dedicated empty VAO for fullscreen triangle draws (no attributes needed)
    const triVAO = this.gl.createVertexArray();
    if (!triVAO) throw new Error('Failed to create VAO');
    // Also create a legacy quad VAO/VBO (kept for potential future use) but not used in draws
    const quadVAO = this.gl.createVertexArray();
    if (!quadVAO) throw new Error('Failed to create VAO');
    this.gl.bindVertexArray(quadVAO);
    const buffer = this.gl.createBuffer();
    if (!buffer) throw new Error('Failed to create quad VBO');
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const quadVertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, quadVertices, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    // Keep strong references so GC doesn't collect GPU resources
    this.fullscreenTriVAO = triVAO;
    this.quadVBO = buffer;
    this.quadVAO = quadVAO;

    // Calculate how many reduction passes we need (8× reduction per pass)
    let width = this.particleTextureWidth;
    let height = this.particleTextureHeight;
    const sizes = [];

    while (width > 8 || height > 8) {
      width = Math.max(1, Math.ceil(width / 8));
      height = Math.max(1, Math.ceil(height / 8));
      // Intermediate textures are 2× wider to store min (even x) and max (odd x)
      sizes.push({ width: width * 2, height });
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
      smallTexture: this.smallTexture && readLinear({
        gl: this.gl, texture: this.smallTexture,
        width: this.reductionSizes[0]?.width || 0,
        height: this.reductionSizes[0]?.height || 0,
        count: (this.reductionSizes[0]?.width || 0) * (this.reductionSizes[0]?.height || 0),
        channels: ['x', 'y', 'z', 'w'], pixels
      }),
      smallerTexture: this.smallerTexture && readLinear({
        gl: this.gl, texture: this.smallerTexture,
        width: this.reductionSizes[1]?.width || 0,
        height: this.reductionSizes[1]?.height || 0,
        count: (this.reductionSizes[1]?.width || 0) * (this.reductionSizes[1]?.height || 0),
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

    if (!this.inPosition || !this.outBounds) {
      throw new Error('KBoundsReduce2: missing required textures');
    }

    // Setup GL state
    this.gl.disable(this.gl.DEPTH_TEST);
    this.gl.disable(this.gl.BLEND);
    this.gl.disable(this.gl.SCISSOR_TEST);
    this.gl.disable(this.gl.CULL_FACE);
    // Ensure fragments are generated (some kernels may enable this)
    this.gl.disable(this.gl.RASTERIZER_DISCARD);
    this.gl.colorMask(true, true, true, true);

    let inputTex = this.inPosition;
    let inputWidth = this.particleTextureWidth;
    let inputHeight = this.particleTextureHeight;

    // Execute reduction passes
    for (let i = 0; i < this.reductionSizes.length; i++) {
      const size = this.reductionSizes[i];
      const isFirstPass = (i === 0);
      const program = isFirstPass ? this.programFirst : this.programReduce;

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
        if (i % 2 === 0) {
          outputTex = this.smallTexture;
          outputFBO = this.smallFBO;
        } else {
          outputTex = this.smallerTexture;
          outputFBO = this.smallerFBO;
        }
      }

      this.gl.useProgram(program);
      this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, outputFBO);
      this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, outputTex, 0);
      this.gl.drawBuffers([this.gl.COLOR_ATTACHMENT0]);
      this.gl.viewport(0, 0, size.width, size.height);

      // Validate FBO before drawing (especially important for first pass)
      const status = this.gl.checkFramebufferStatus(this.gl.FRAMEBUFFER);
      if (status !== this.gl.FRAMEBUFFER_COMPLETE) {
        const hex = '0x' + status.toString(16);
        throw new Error(`KBoundsReduce: framebuffer incomplete for ${isFirstPass ? 'first' : 'reduction'} pass (${hex})`);
      }

      this.gl.activeTexture(this.gl.TEXTURE0);
      this.gl.bindTexture(this.gl.TEXTURE_2D, inputTex);
      this.gl.uniform1i(this.gl.getUniformLocation(program, 'u_inputTex'), 0);
      this.gl.uniform2f(this.gl.getUniformLocation(program, 'u_inputSize'), inputWidth, inputHeight);

      this.gl.bindVertexArray(this.fullscreenTriVAO);
      this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
      this.gl.bindVertexArray(null);

      // Next iteration uses this pass's output as input
      inputTex = /** @type {WebGLTexture} */ (outputTex);
      inputWidth = size.width;
      inputHeight = size.height;
    }


    // Final pass: reduce to 2×1 output (uses reduction shader)
    this.gl.useProgram(this.programReduce);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.outFramebuffer);
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.outBounds, 0);
    this.gl.drawBuffers([this.gl.COLOR_ATTACHMENT0]);
    this.gl.viewport(0, 0, 2, 1);


    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, inputTex);
    this.gl.uniform1i(this.gl.getUniformLocation(this.programReduce, 'u_inputTex'), 0);
    this.gl.uniform2f(this.gl.getUniformLocation(this.programReduce, 'u_inputSize'), inputWidth, inputHeight);

    this.gl.bindVertexArray(this.fullscreenTriVAO);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
    this.gl.bindVertexArray(null);

    this.gl.activeTexture(this.gl.TEXTURE0);
    this.gl.bindTexture(this.gl.TEXTURE_2D, null);
    this.gl.useProgram(null);
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    if (this.programFirst) this.gl.deleteProgram(this.programFirst);
    if (this.programReduce) this.gl.deleteProgram(this.programReduce);
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
 * First pass shader: particle positions → min/max pairs
 * Reads raw particle data, outputs 2× wide texture with even=min, odd=max
 */
function firstPassShader() {
  return `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_inputTex;
uniform vec2 u_inputSize;

layout(location = 0) out vec4 fragColor;

void main() {
  ivec2 outCoord = ivec2(floor(gl_FragCoord.xy));
  
  // Calculate base input coordinate for this output pixel's 8×8 tile
  // Output is 2× wider, so divide x by 2 to get tile index
  ivec2 baseCoord = ivec2(outCoord.x / 2, outCoord.y) * 8;
  
  vec3 minBound = vec3(1e20);
  vec3 maxBound = vec3(-1e20);
  bool hasValidData = false;
  
  // Sample 8×8 region of particle positions
  for (int dy = 0; dy < 8; dy++) {
    for (int dx = 0; dx < 8; dx++) {
      ivec2 coord = baseCoord + ivec2(dx, dy);
      
      // Bounds check
      if (coord.x >= int(u_inputSize.x) || coord.y >= int(u_inputSize.y)) {
        continue;
      }
      
      vec4 texel = texelFetch(u_inputTex, coord, 0);
      vec3 pos = texel.xyz;
      float mass = texel.w;
      
      // Skip invalid particles
      if (isnan(pos.x) || isnan(pos.y) || isnan(pos.z) || isnan(mass) || mass <= 0.0) {
        continue;
      }
      
      minBound = min(minBound, pos);
      maxBound = max(maxBound, pos);
      hasValidData = true;
    }
  }
  
  // Output: even x = min, odd x = max
  if (outCoord.x % 2 == 0) {
    fragColor = vec4(minBound, hasValidData ? 1.0 : 0.0);
  } else {
    fragColor = vec4(maxBound, hasValidData ? 1.0 : 0.0);
  }
}
`;
}

/**
 * Reduction pass shader: min/max pairs → min/max pairs
 * Reads previous reduction output (even=min, odd=max), outputs same format
 */
function reductionPassShader() {
  return `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_inputTex;
uniform vec2 u_inputSize;

out vec4 fragColor;

void main() {
  ivec2 outCoord = ivec2(floor(gl_FragCoord.xy));
  
  // Calculate base tile coordinate
  // Output is 2× wider, so divide x by 2 to get tile index
  ivec2 baseTile = ivec2(outCoord.x / 2, outCoord.y) * 8;
  
  vec3 minBound = vec3(1e20);
  vec3 maxBound = vec3(-1e20);
  bool hasValidData = false;
  
  // Sample 8×8 region of min/max pairs
  for (int dy = 0; dy < 8; dy++) {
    for (int dx = 0; dx < 8; dx++) {
      ivec2 tileCoord = baseTile + ivec2(dx, dy);
      
      // Each tile position has two pixels: even=min, odd=max
      ivec2 minCoord = ivec2(tileCoord.x * 2, tileCoord.y);
      ivec2 maxCoord = ivec2(tileCoord.x * 2 + 1, tileCoord.y);
      
      // Bounds check
      if (minCoord.x >= int(u_inputSize.x) || minCoord.y >= int(u_inputSize.y)) {
        continue;
      }
      
      vec4 minTexel = texelFetch(u_inputTex, minCoord, 0);
      vec4 maxTexel = texelFetch(u_inputTex, maxCoord, 0);
      
      vec3 tileMin = minTexel.xyz;
      vec3 tileMax = maxTexel.xyz;
      
      // Skip invalid data
      if (isnan(tileMin.x) || isnan(tileMax.x)) {
        continue;
      }
      
      minBound = min(minBound, tileMin);
      maxBound = max(maxBound, tileMax);
      hasValidData = true;
    }
  }
  
  // Output: even x = min, odd x = max
  if (outCoord.x % 2 == 0) {
    fragColor = vec4(minBound, hasValidData ? 1.0 : 0.0);
  } else {
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

// Fullscreen triangle vertex shader (no attributes required)
const fsQuadVert =/* glsl */`#version 300 es
precision highp float;

const vec2 POS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

void main() {
  gl_Position = vec4(POS[gl_VertexID], 0.0, 1.0);
}`;

function formatNumber(n) {
  return n.toFixed(3);
}
