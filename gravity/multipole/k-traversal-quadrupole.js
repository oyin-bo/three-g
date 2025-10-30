// @ts-check

/**
 * TraversalQuadrupoleKernel - Quadrupole Barnes-Hut tree traversal
 * 
 * Traverses the octree hierarchy to compute gravitational forces using quadrupole approximation.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import { fsQuadVert } from '../core-shaders.js';
import { formatNumber, readLinear } from '../diag.js';

export class KTraversalQuadrupole {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inBounds?: WebGLTexture|null,
   *   inLevelsA0?: WebGLTexture|null,
   *   inLevelsA1?: WebGLTexture|null,
   *   inLevelsA2?: WebGLTexture|null,
   *   inOccupancy?: WebGLTexture|null,
   *   outForce?: WebGLTexture|null,
   *   particleTextureWidth?: number,
   *   particleTextureHeight?: number,
   *   numLevels?: number,
   *   levelConfigs?: Array<{size: number, gridSize: number, slicesPerRow: number}>,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   theta?: number,
   *   gravityStrength?: number,
   *   softening?: number,
   *   useOccupancyMasks?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Resource slots - follow kernel contract: (truthy || === null) ? use : create
    this.inPosition = (options.inPosition || options.inPosition === null)
      ? options.inPosition
      : createTextureRGBA32F(this.gl, options.particleTextureWidth || 0, options.particleTextureHeight || 0);

    this.inBounds = (options.inBounds || options.inBounds === null)
      ? options.inBounds
      : null;

    // Accept texture arrays for all levels (TEXTURE_2D_ARRAY)
    this.inLevelsA0 = (options.inLevelsA0 || options.inLevelsA0 === null) ? options.inLevelsA0 : null;
    this.inLevelsA1 = (options.inLevelsA1 || options.inLevelsA1 === null) ? options.inLevelsA1 : null;
    this.inLevelsA2 = (options.inLevelsA2 || options.inLevelsA2 === null) ? options.inLevelsA2 : null;

    this.inOccupancy = (options.inOccupancy || options.inOccupancy === null)
      ? options.inOccupancy
      : null;

    this.outForce = (options.outForce || options.outForce === null)
      ? options.outForce
      : createTextureRGBA32F(this.gl, options.particleTextureWidth || 0, options.particleTextureHeight || 0);

    // Particle texture dimensions
    this.particleTextureWidth = options.particleTextureWidth || 0;
    this.particleTextureHeight = options.particleTextureHeight || 0;

    // Octree configuration
    this.numLevels = options.numLevels || 4;
    if (this.numLevels > 4) throw new Error('KTraversalQuadrupole: numLevels cannot exceed 4 due to texture unit limits');
    this.levelConfigs = options.levelConfigs || [];

    // World bounds
    this.worldBounds = options.worldBounds || {
      min: [-4, -4, 0],
      max: [4, 4, 2]
    };

    // Physics parameters
    this.theta = options.theta !== undefined ? options.theta : 0.5;
    this.gravityStrength = options.gravityStrength !== undefined ? options.gravityStrength : 0.0003;
    this.softening = options.softening !== undefined ? options.softening : 0.2;
    this.useOccupancyMasks = options.useOccupancyMasks !== undefined ? options.useOccupancyMasks : false;

    // Create shader program with quadrupole shader
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
    this.gl.shaderSource(frag, buildTraversalQuadrupoleShader(this.numLevels, this.useOccupancyMasks));
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

    // Create an internal framebuffer (configured per-run)
    this.outFramebuffer = this.gl.createFramebuffer();
    /** @type {{ a0: WebGLTexture } | null} */
    this._fboShadow = null;
  }

  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const gl = this.gl;

    // Helper: Read a single layer from a texture array
    /**
     * @param {WebGLTexture|null} textureArray
     * @param {number} layer
     * @param {number} size
     */
    const readTextureArrayLayer = (textureArray, layer, size) => {
      if (!textureArray) return null;
      // Derive the correct 2D layout for this level
      const config = this.levelConfigs[layer];
      const gridSize = config?.gridSize || size;
      const slicesPerRow = config?.slicesPerRow || 1;
      const width = gridSize * slicesPerRow;
      const sliceRows = Math.ceil(gridSize / Math.max(1, slicesPerRow));
      const height = gridSize * sliceRows;

      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, textureArray, 0, layer);

      const buffer = new Float32Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, buffer);

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);

      // Compute statistics
      let nonZeroCount = 0;
      let maxMass = 0;
      let totalMass = 0;
      const masses = [];

      for (let i = 0; i < buffer.length; i += 4) {
        const mass = buffer[i + 3];
        if (mass > 1e-10) {
          nonZeroCount++;
          maxMass = Math.max(maxMass, mass);
          totalMass += mass;
          masses.push(mass);
        }
      }

      return {
        size,
        layer,
        nonZeroCount,
        maxMass,
        totalMass,
        avgMass: nonZeroCount > 0 ? totalMass / nonZeroCount : 0,
        voxelCount: gridSize * gridSize * gridSize,
        toString: () => `Layer${layer} ${gridSize}³: ${nonZeroCount}/${gridSize * gridSize * gridSize} occupied, mass=[${maxMass.toFixed(3)}max ${(totalMass / nonZeroCount || 0).toFixed(3)}avg]`
      };
    };

    // Read all levels from texture arrays
    /** @type {Array<ReturnType<typeof readTextureArrayLayer>>} */
    const levelTextureArrayA0 = [];
    /** @type {Array<ReturnType<typeof readTextureArrayLayer>>} */
    const levelTextureArrayA1 = [];
    /** @type {Array<ReturnType<typeof readTextureArrayLayer>>} */
    const levelTextureArrayA2 = [];

    for (let i = 0; i < this.numLevels; i++) {
      const config = this.levelConfigs[i];
      if (!config) continue;

      levelTextureArrayA0[i] = readTextureArrayLayer(this.inLevelsA0, i, config.size);
      levelTextureArrayA1[i] = readTextureArrayLayer(this.inLevelsA1, i, config.size);
      levelTextureArrayA2[i] = readTextureArrayLayer(this.inLevelsA2, i, config.size);
    }

    const value = {
      position: this.inPosition && readLinear({
        gl: this.gl, texture: this.inPosition, width: this.particleTextureWidth,
        height: this.particleTextureHeight, count: this.particleTextureWidth * this.particleTextureHeight,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      force: this.outForce && readLinear({
        gl: this.gl, texture: this.outForce, width: this.particleTextureWidth,
        height: this.particleTextureHeight, count: this.particleTextureWidth * this.particleTextureHeight,
        channels: ['fx', 'fy', 'fz', 'w'], pixels
      }),
      bounds: this.inBounds && readLinear({
        gl: this.gl, texture: this.inBounds, width: 2, height: 1, count: 2,
        channels: ['x', 'y', 'z', 'w'], pixels
      }),
      levelTextureArrayA0,
      levelTextureArrayA1,
      levelTextureArrayA2,
      particleTextureWidth: this.particleTextureWidth,
      particleTextureHeight: this.particleTextureHeight,
      numLevels: this.numLevels,
      theta: this.theta,
      gravityStrength: this.gravityStrength,
      softening: this.softening,
      worldBounds: { min: [...this.worldBounds.min], max: [...this.worldBounds.max] },
      useOccupancyMasks: this.useOccupancyMasks,
      renderCount: this.renderCount
    };

    // Compute total force magnitude
    // @ts-ignore - dynamic properties from readLinear
    const totalForce = value.force?.fx ?
      // @ts-ignore
      Math.sqrt(value.force.fx.mean ** 2 + value.force.fy.mean ** 2 + value.force.fz.mean ** 2) : 0;

    // Format texture array layer summaries
    /** @param {Array<ReturnType<typeof readTextureArrayLayer>>} arr */
    const formatLevels = (arr) => arr.map(l => l ? l.toString() : 'null').join('\n  ');

    value.toString = () =>
      `KTraversalQuadrupole(${this.particleTextureWidth}×${this.particleTextureHeight}) theta=${this.theta} G=${this.gravityStrength} soft=${this.softening} levels=${this.numLevels} occupancy=${this.useOccupancyMasks} #${this.renderCount} bounds=[${this.worldBounds.min}]to[${this.worldBounds.max}]

position: ${value.position}

bounds: ${value.bounds}

force: ${value.force ? `totalForceMag=${formatNumber(totalForce)} ` : ''}${value.force}

levelTextureArrayA0 (monopole):
  ${formatLevels(levelTextureArrayA0)}

levelTextureArrayA1 (quadrupole xx,yy,zz,xy):
  ${formatLevels(levelTextureArrayA1)}

levelTextureArrayA2 (quadrupole xz,yz):
  ${formatLevels(levelTextureArrayA2)}`;

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

    if (!this.inPosition || !this.outForce) {
      throw new Error('KTraversalQuadrupole: missing required textures');
    }

    if (!this.inLevelsA0 || !this.inLevelsA1 || !this.inLevelsA2) {
      throw new Error('KTraversalQuadrupole: missing texture arrays for levels');
    }

    gl.useProgram(this.program);

    // Ensure framebuffer attachments match our output
    if (this._fboShadow?.a0 !== this.outForce) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outForce, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error(`Framebuffer incomplete: ${status}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._fboShadow = { a0: this.outForce };
    }

    // Bind output framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.viewport(0, 0, this.particleTextureWidth, this.particleTextureHeight);

    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);

    // Bind position texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particlePositions'), 0);

    // Bind texture arrays for all levels (3 arrays instead of 12+ individual textures)
    // This is the key optimization that prevents texture unit exhaustion

    // Bind A0 array (texture unit 1)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.inLevelsA0);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_levelsA0'), 1);

    // Bind A1 array (texture unit 2)
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.inLevelsA1);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_levelsA1'), 2);

    // Bind A2 array (texture unit 3)
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.inLevelsA2);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_levelsA2'), 3);

    // Bind occupancy texture if enabled (texture unit 22)
    if (this.useOccupancyMasks && this.inOccupancy) {
      gl.activeTexture(gl.TEXTURE22);
      gl.bindTexture(gl.TEXTURE_2D, this.inOccupancy);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_occupancy'), 22);
    }

    // Bind bounds texture if available (texture unit 23)
    if (this.inBounds) {
      gl.activeTexture(gl.TEXTURE23);
      gl.bindTexture(gl.TEXTURE_2D, this.inBounds);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_bounds'), 23);
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_useBoundsTexture'), 1);
    } else {
      // Fallback to uniform bounds (initial frames before first bounds update)
      gl.uniform1i(gl.getUniformLocation(this.program, 'u_useBoundsTexture'), 0);
    }

    // Set level configuration uniforms
    const cellSizes = new Float32Array(this.numLevels);
    const gridSizes = new Float32Array(this.numLevels);
    const slicesPerRow = new Float32Array(this.numLevels);

    // Calculate cell sizes from world bounds and grid sizes
    const worldSize = [
      this.worldBounds.max[0] - this.worldBounds.min[0],
      this.worldBounds.max[1] - this.worldBounds.min[1],
      this.worldBounds.max[2] - this.worldBounds.min[2]
    ];
    const maxWorldSize = Math.max(...worldSize);

    for (let i = 0; i < this.numLevels; i++) {
      const config = this.levelConfigs[i];
      gridSizes[i] = config.gridSize;
      slicesPerRow[i] = config.slicesPerRow;
      cellSizes[i] = maxWorldSize / config.gridSize;
    }

    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_cellSizes'), cellSizes);
    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_gridSizes'), gridSizes);
    gl.uniform1fv(gl.getUniformLocation(this.program, 'u_slicesPerRow'), slicesPerRow);

    // Set physics parameters
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_texSize'),
      this.particleTextureWidth, this.particleTextureHeight);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particleCount'),
      this.particleTextureWidth * this.particleTextureHeight);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'),
      this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'),
      this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_theta'), this.theta);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_G'), this.gravityStrength);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_softening'), this.softening);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_numLevels'), this.numLevels);

    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // Unbind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    if (this.useOccupancyMasks) {
      gl.activeTexture(gl.TEXTURE22);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    if (this.inBounds) {
      gl.activeTexture(gl.TEXTURE23);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.useProgram(null);

    // Unbind
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebuffer) gl.deleteFramebuffer(this.outFramebuffer);

    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.inOccupancy) gl.deleteTexture(this.inOccupancy);
    if (this.outForce) gl.deleteTexture(this.outForce);

    this._fboShadow = null;
  }
}

/**
 * @param {number} levelCount
 * @param {boolean} useOccupancy
 */
function buildTraversalQuadrupoleShader(levelCount, useOccupancy = false) {
  const maxL = Math.max(1, Math.min(levelCount | 0, 4));

  const occupancyDecl = useOccupancy ? 'uniform sampler2D u_occupancy;' : '';

  const samplerDecl = `#version 300 es
precision highp float;
precision highp sampler2DArray;  // Required for texture arrays in WebGL2

uniform sampler2D u_particlePositions;
uniform sampler2DArray u_levelsA0;  // Texture array for all A0 levels
uniform sampler2DArray u_levelsA1;  // Texture array for all A1 levels
uniform sampler2DArray u_levelsA2;  // Texture array for all A2 levels
${occupancyDecl}
uniform sampler2D u_bounds;       // 2×1 texture: texel 0 = min bounds, texel 1 = max bounds
uniform bool u_useBoundsTexture; // true if bounds texture available

uniform float u_theta;
uniform int u_numLevels;
uniform float u_cellSizes[8];
uniform float u_gridSizes[8];
uniform float u_slicesPerRow[8];
uniform vec2 u_texSize;
uniform int u_particleCount;
uniform vec3 u_worldMin;
uniform vec3 u_worldMax;
uniform float u_softening;
uniform float u_G;

out vec4 fragColor;`;

  const occupancyCheckCode = useOccupancy ? `
          // Check occupancy before processing cell (70-90% skip rate)
          vec4 occupancy = texelFetch(u_occupancy, texCoord, 0);
          if (occupancy.r < 0.5) continue;  // Empty cell - skip
` : '';

  const body = `
ivec2 voxelToTexel(ivec3 voxelCoord, float gridSize, float slicesPerRow) {
  int vx = voxelCoord.x;
  int vy = voxelCoord.y;
  int vz = voxelCoord.z;
  int sliceIndex = vz;
  int sliceRow = sliceIndex / int(slicesPerRow);
  int sliceCol = sliceIndex - sliceRow * int(slicesPerRow);
  int texelX = sliceCol * int(gridSize) + vx;
  int texelY = sliceRow * int(gridSize) + vy;
  return ivec2(texelX, texelY);
}

// Sample from texture arrays using layer index
vec4 sampleLevelA0(int level, ivec2 coord) {
  return texelFetch(u_levelsA0, ivec3(coord, level), 0);
}

vec4 sampleLevelA1(int level, ivec2 coord) {
  return texelFetch(u_levelsA1, ivec3(coord, level), 0);
}

vec4 sampleLevelA2(int level, ivec2 coord) {
  return texelFetch(u_levelsA2, ivec3(coord, level), 0);
}

// Compute distance from point to nearest point on voxel
float distToNearestPoint(vec3 point, ivec3 voxel, vec3 worldMin, float cellSize) {
  vec3 voxelMin = worldMin + vec3(voxel) * cellSize;
  vec3 voxelMax = voxelMin + vec3(cellSize);
  vec3 nearest = clamp(point, voxelMin, voxelMax);
  return length(point - nearest);
}

// Compute distance from point to farthest point on voxel
float distToFarthestPoint(vec3 point, ivec3 voxel, vec3 worldMin, float cellSize) {
  vec3 voxelMin = worldMin + vec3(voxel) * cellSize;
  vec3 voxelMax = voxelMin + vec3(cellSize);
  
  // Farthest corner is the one where each coordinate is maximally far
  vec3 farthest;
  farthest.x = (point.x < (voxelMin.x + voxelMax.x) * 0.5) ? voxelMax.x : voxelMin.x;
  farthest.y = (point.y < (voxelMin.y + voxelMax.y) * 0.5) ? voxelMax.y : voxelMin.y;
  farthest.z = (point.z < (voxelMin.z + voxelMax.z) * 0.5) ? voxelMax.z : voxelMin.z;
  
  return length(point - farthest);
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int myIndex = coord.y * int(u_texSize.x) + coord.x;
  if (myIndex >= u_particleCount) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 myUV = (vec2(coord) + 0.5) / u_texSize;
  vec3 myPos = texture(u_particlePositions, myUV).xyz;
  vec3 totalForce = vec3(0.0);

  // Get world bounds from texture or uniforms
  vec3 worldMin, worldMax;
  if (u_useBoundsTexture) {
    // Sample bounds texture: texel 0 = min, texel 1 = max
    vec4 minBounds = texelFetch(u_bounds, ivec2(0, 0), 0);
    vec4 maxBounds = texelFetch(u_bounds, ivec2(1, 0), 0);
    worldMin = minBounds.xyz - vec3(0.1); // Add small margin to prevent edge clamping
    worldMax = maxBounds.xyz + vec3(0.1);
  } else {
    // Fallback to uniform bounds (initial frames)
    worldMin = u_worldMin;
    worldMax = u_worldMax;
  }

  vec3 worldExtent = worldMax - worldMin;
  float eps = max(u_softening, 1e-6);

  // Barnes-Hut hierarchical traversal: coarsest to finest
  // Performance: scan all voxels at the coarsest level; at finer levels, scan
  // a theta-driven neighborhood to ensure all cells that could fail MAC are covered.
  // This guarantees refinement works correctly without scanning the entire grid.
  for (int level = min(u_numLevels - 1, ${maxL - 1}); level >= 0; level--) {
    float gridSize = u_gridSizes[level];
    float slicesPerRow = u_slicesPerRow[level];
    float cellSize = u_cellSizes[level];

    // Find particle's voxel at this level
    vec3 relPos = (myPos - worldMin) / worldExtent;
    relPos = clamp(relPos, vec3(0.0), vec3(1.0 - (1.0 / gridSize)));
    ivec3 myVoxel = ivec3(floor(relPos * gridSize));
    
    // Compute theta-driven neighborhood radius for correct refinement coverage.
    // MAC fails when cellSize/dist >= theta, i.e., dist <= cellSize/theta.
    // In voxel units (dist ~ nb*cellSize), this means nb >= 1/theta.
    // Use ceil(1/theta) + 1 for safety margin to ensure all refinement candidates covered. (see todo)
    bool isCoarsestLevel = (level == u_numLevels - 1);
    int nb = isCoarsestLevel ? int(gridSize) : int(ceil(1.0 / u_theta)) + 1; // TODO: this +1 costs a lot of performance! Review and re-adjust later
    int startX = max(0, myVoxel.x - nb);
    int startY = max(0, myVoxel.y - nb);
    int startZ = max(0, myVoxel.z - nb);
    int endX = min(int(gridSize) - 1, myVoxel.x + nb);
    int endY = min(int(gridSize) - 1, myVoxel.y + nb);
    int endZ = min(int(gridSize) - 1, myVoxel.z + nb);
    
    for (int vz = startZ; vz <= endZ; vz++) {
      for (int vy = startY; vy <= endY; vy++) {
        for (int vx = startX; vx <= endX; vx++) {
          ivec3 testVoxel = ivec3(vx, vy, vz);
          ivec2 texCoord = voxelToTexel(testVoxel, gridSize, slicesPerRow);
          ${occupancyCheckCode}
          vec4 a0 = sampleLevelA0(level, texCoord);
          float mass = a0.w;
          if (mass < 1e-10) continue;
          
          // Skip own voxel
          bool isMyVoxel = (testVoxel.x == myVoxel.x && testVoxel.y == myVoxel.y && testVoxel.z == myVoxel.z);
          if (isMyVoxel) continue;
          
          // Compute geometric distances to voxel
          float distNear = distToNearestPoint(myPos, testVoxel, worldMin, cellSize);
          float distFar = distToFarthestPoint(myPos, testVoxel, worldMin, cellSize);
          
          // Three-case geometric classification
          bool entirelyFarEnough = (distFar * u_theta < cellSize);
          bool entirelyTooClose = (distNear * u_theta >= cellSize);
          bool straddlesBoundary = !entirelyFarEnough && !entirelyTooClose;
          
          bool isFinestLevel = (level == 0);
          
          // Case 2: Entirely too close - skip unless finest level
          if (entirelyTooClose && !isFinestLevel) {
            continue; // Children will handle at finer level
          }
          
          // Determine mass/moments to use
          vec3 com = a0.xyz / mass;
          vec4 a1 = vec4(0.0);
          vec4 a2 = vec4(0.0);
          
          // Case 3: Straddles boundary - compute residual mass
          if (straddlesBoundary && !isFinestLevel) {
            vec4 sumChildrenA0 = vec4(0.0);
            vec4 sumChildrenA1 = vec4(0.0);
            vec4 sumChildrenA2 = vec4(0.0);
            
            float finerGridSize = u_gridSizes[level - 1];
            float finerSlicesPerRow = u_slicesPerRow[level - 1];
            
            // Compute child voxel bounds: children are at testVoxel*2 + {0,1} per axis
            // Clamp offsets to valid range before loop to avoid runtime branching
            int minCx = (testVoxel.x * 2 < 0) ? (0 - testVoxel.x * 2) : 0;
            int maxCx = (testVoxel.x * 2 + 1 >= int(finerGridSize)) ? (int(finerGridSize) - testVoxel.x * 2 - 1) : 1;
            int minCy = (testVoxel.y * 2 < 0) ? (0 - testVoxel.y * 2) : 0;
            int maxCy = (testVoxel.y * 2 + 1 >= int(finerGridSize)) ? (int(finerGridSize) - testVoxel.y * 2 - 1) : 1;
            int minCz = (testVoxel.z * 2 < 0) ? (0 - testVoxel.z * 2) : 0;
            int maxCz = (testVoxel.z * 2 + 1 >= int(finerGridSize)) ? (int(finerGridSize) - testVoxel.z * 2 - 1) : 1;
            
            for (int cz = minCz; cz <= maxCz; cz++) {
              for (int cy = minCy; cy <= maxCy; cy++) {
                for (int cx = minCx; cx <= maxCx; cx++) {
                  ivec3 childVoxel = testVoxel * 2 + ivec3(cx, cy, cz);
                  
                  ivec2 childTexCoord = voxelToTexel(childVoxel, finerGridSize, finerSlicesPerRow);
                  vec4 childA0 = sampleLevelA0(level - 1, childTexCoord);
                  
                  if (childA0.w > 1e-10) {
                    sumChildrenA0 += childA0;
                    if (level > 0) {
                      sumChildrenA1 += sampleLevelA1(level - 1, childTexCoord);
                      sumChildrenA2 += sampleLevelA2(level - 1, childTexCoord);
                    }
                  }
                }
              }
            }
            
            // Use residual
            vec4 residualA0 = a0 - sumChildrenA0;
            mass = residualA0.w;
            if (mass < 1e-10) continue; // No residual
            
            com = residualA0.xyz / mass;
            if (level > 0) {
              a1 = sampleLevelA1(level, texCoord) - sumChildrenA1;
              a2 = sampleLevelA2(level, texCoord) - sumChildrenA2;
            }
          } else {
            // Case 1: Entirely far enough, or finest level - use full mass
            if (level > 0) {
              a1 = sampleLevelA1(level, texCoord);
              a2 = sampleLevelA2(level, texCoord);
            }
          }
          
          // Apply force
          vec3 r = myPos - com;
          float dist = length(r);
          float distSq = dist * dist + eps * eps;
          float distCubed = distSq * sqrt(distSq);
          vec3 monopoleForce = -u_G * mass * r / distCubed;
          totalForce += monopoleForce;
          
          // Add quadrupole correction (except at finest level where it's negligible)
          if (level > 0) {
            float qxx = a1.r - com.x * com.x * mass;
            float qyy = a1.g - com.y * com.y * mass;
            float qzz = a1.b - com.z * com.z * mass;
            float qxy = a1.a - com.x * com.y * mass;
            float qxz = a2.r - com.x * com.z * mass;
            float qyz = a2.g - com.y * com.z * mass;
            float dist5 = distSq * distSq * sqrt(distSq);
            vec3 quadForce = vec3(0.0);
            float trace = qxx + qyy + qzz;
            quadForce += 1.5 * u_G * trace * r / dist5;
            quadForce.x += u_G * (qxx * r.x + qxy * r.y + qxz * r.z) / dist5;
            quadForce.y += u_G * (qxy * r.x + qyy * r.y + qyz * r.z) / dist5;
            quadForce.z += u_G * (qxz * r.x + qyz * r.y + qzz * r.z) / dist5;
            totalForce += quadForce * 2.5;
          }
        }
      }
    }
  }
  fragColor = vec4(totalForce, 0.0);
}`;

  return samplerDecl + '\n' + body;
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