// @ts-check

/**
 * KNearField - Computes near-field corrections
 * 
 * Computes real-space near-field forces to correct mesh approximation errors.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import { fsQuadVert } from '../core-shaders.js';
import { formatNumber, readGrid3D, readLinear } from '../diag.js';

export class KNearField {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inMassGrid?: WebGLTexture|null,
   *   outForceX?: WebGLTexture|null,
   *   outForceY?: WebGLTexture|null,
   *   outForceZ?: WebGLTexture|null,
   *   quadVAO?: WebGLVertexArrayObject|null,
   *   gridSize?: number | [number, number, number],
   *   slicesPerRow?: number,
   *   textureSize?: number,
   *   textureWidth?: number,
   *   textureHeight?: number,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   softening?: number,
   *   gravityStrength?: number,
   *   nearFieldRadius?: number
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Grid configuration (process gridSize early for texture creation)
    const rawGridSize = options.gridSize || 64;
    this.gridSize = Array.isArray(rawGridSize) 
      ? rawGridSize 
      : [rawGridSize, rawGridSize, rawGridSize];
    const [Nx, Ny, Nz] = this.gridSize;
    this.slicesPerRow = options.slicesPerRow || Math.ceil(Math.sqrt(Nz));
    this.textureWidth = options.textureWidth || options.textureSize || (Nx * this.slicesPerRow);
    this.textureHeight = options.textureHeight || options.textureSize || (Ny * Math.ceil(Nz / this.slicesPerRow));
    this.textureSize = /** @deprecated */ (typeof options.textureSize === 'number' ? options.textureSize : this.textureWidth);

    // Resource slots
    this.inMassGrid = (options.inMassGrid || options.inMassGrid === null) ? options.inMassGrid : createGridTexture(this.gl, this.textureWidth, this.textureHeight);
    this.outForceX = (options.outForceX || options.outForceX === null) ? options.outForceX : createGridTexture(this.gl, this.textureWidth, this.textureHeight);
    this.outForceY = (options.outForceY || options.outForceY === null) ? options.outForceY : createGridTexture(this.gl, this.textureWidth, this.textureHeight);
    this.outForceZ = (options.outForceZ || options.outForceZ === null) ? options.outForceZ : createGridTexture(this.gl, this.textureWidth, this.textureHeight);
    this.quadVAO = (options.quadVAO || options.quadVAO === null) ? options.quadVAO : createQuadVAO(this.gl);

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
  }

  _createForceTexture() {
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) throw new Error('Failed to create texture');

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, this.textureSize, this.textureSize, 0, gl.RED, gl.FLOAT, null);
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

  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      massGrid: this.inMassGrid && readGrid3D({
        gl: this.gl, texture: this.inMassGrid, width: this.textureWidth,
        height: this.textureHeight, gridSize: this.gridSize[0],
        channels: ['mass'], pixels, format: this.gl.R32F
      }),
      forceX: this.outForceX && readGrid3D({
        gl: this.gl, texture: this.outForceX, width: this.textureWidth,
        height: this.textureHeight, gridSize: this.gridSize[0],
        channels: ['fx'], pixels, format: this.gl.R32F
      }),
      forceY: this.outForceY && readGrid3D({
        gl: this.gl, texture: this.outForceY, width: this.textureWidth,
        height: this.textureHeight, gridSize: this.gridSize[0],
        channels: ['fy'], pixels, format: this.gl.R32F
      }),
      forceZ: this.outForceZ && readGrid3D({
        gl: this.gl, texture: this.outForceZ, width: this.textureWidth,
        height: this.textureHeight, gridSize: this.gridSize[0],
        channels: ['fz'], pixels, format: this.gl.R32F
      }),
      gridSize: [...this.gridSize],
      slicesPerRow: this.slicesPerRow,
      textureWidth: this.textureWidth,
      textureHeight: this.textureHeight,
      worldBounds: { min: [...this.worldBounds.min], max: [...this.worldBounds.max] },
      softening: this.softening,
      gravityStrength: this.gravityStrength,
      nearFieldRadius: this.nearFieldRadius,
      renderCount: this.renderCount
    };

    value.toString = () =>
      `KNearField(grid=${this.gridSize[0]}×${this.gridSize[1]}×${this.gridSize[2]}) texture=${this.textureWidth}×${this.textureHeight} soft=${formatNumber(this.softening)} G=${formatNumber(this.gravityStrength)} r=${this.nearFieldRadius} #${this.renderCount} bounds=[${this.worldBounds.min}]to[${this.worldBounds.max}]

massGrid: ${value.massGrid}

→ forceX: ${value.forceX}
→ forceY: ${value.forceY}
→ forceZ: ${value.forceZ}`;

    return value;
  }

  /**
   * Get human-readable string representation of kernel state
   * @returns {string} Compact summary
   */
  toString() {
    return this.valueOf().toString();
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

  gl.viewport(0, 0, this.textureWidth, this.textureHeight);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);

    gl.useProgram(this.program);

    // Bind input texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inMassGrid);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_massGrid'), 0);

    // Set uniforms
    gl.uniform3i(gl.getUniformLocation(this.program, 'u_gridSize'), this.gridSize[0], this.gridSize[1], this.gridSize[2]);
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

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Restore GL state
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFB);
    gl.viewport(prevVP[0], prevVP[1], prevVP[2], prevVP[3]);
    gl.useProgram(prevProg);
    gl.bindVertexArray(prevVAO);
    if (prevBlend) gl.enable(gl.BLEND);
    if (prevDepthTest) gl.enable(gl.DEPTH_TEST);

    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    const gl = this.gl;

    if (this.program) {
      gl.deleteProgram(this.program);
    }

    if (this.framebufferX) gl.deleteFramebuffer(this.framebufferX);
    if (this.framebufferY) gl.deleteFramebuffer(this.framebufferY);
    if (this.framebufferZ) gl.deleteFramebuffer(this.framebufferZ);
  // Avoid assigning nulls for @ts-check compatibility

    if (this.outForceX) gl.deleteTexture(this.outForceX);
    if (this.outForceY) gl.deleteTexture(this.outForceY);
    if (this.outForceZ) gl.deleteTexture(this.outForceZ);
    this.outForceX = null;
    this.outForceY = null;
    this.outForceZ = null;

    if (this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
      this.quadVAO = null;
    }
  }
}

/**
 * Helper: Create a grid texture (R32F for mass/force)
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} [height]
 */
function createGridTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  const w = width;
  const h = (height === undefined) ? width : height;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

/**
 * Helper: Create a fullscreen quad VAO
 * @param {WebGL2RenderingContext} gl
 */
function createQuadVAO(gl) {
  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Failed to create VAO');
  gl.bindVertexArray(vao);
  const buffer = gl.createBuffer();
  if (!buffer) throw new Error('Failed to create buffer');
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  const quadVertices = new Float32Array([
    -1, -1, 1, -1, -1, 1, 1, 1
  ]);
  gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return vao;
}

const nearFieldFrag = /* glsl */`#version 300 es
precision highp float;
precision highp int;

out vec4 outColor;

uniform sampler2D u_massGrid;
uniform ivec3 u_gridSize;
uniform float u_slicesPerRow;
uniform vec3 u_worldMin;
uniform vec3 u_worldMax;
uniform float u_softening;
uniform float u_gravityStrength;
uniform int u_nearFieldRadius;
uniform int u_component;

const int MAX_RADIUS = 4;

int wrapIndexInt(int value, int size) {
  int m = value % size;
  return m < 0 ? m + size : m;
}

vec3 minimumImage(vec3 delta, vec3 extent) {
  return delta - extent * floor(delta / extent + 0.5);
}

ivec2 voxelToTexel(ivec3 voxel, ivec3 gridSize, int slicesPerRow) {
  int sliceRow = voxel.z / slicesPerRow;
  int sliceCol = voxel.z - sliceRow * slicesPerRow;
  int texX = sliceCol * gridSize.x + voxel.x;
  int texY = sliceRow * gridSize.y + voxel.y;
  return ivec2(texX, texY);
}

vec3 voxelCenterWorld(ivec3 voxel, vec3 worldMin, vec3 worldMax, ivec3 gridSize) {
  vec3 extent = max(worldMax - worldMin, vec3(1e-6));
  return worldMin + (vec3(voxel) + vec3(0.5)) / vec3(gridSize) * extent;
}

void main() {
  ivec3 N = u_gridSize;
  int slicesPerRow = int(u_slicesPerRow + 0.5);

  if (N.x <= 0 || N.y <= 0 || N.z <= 0 || slicesPerRow <= 0) {
    outColor = vec4(0.0);
    return;
  }

  int radius = u_nearFieldRadius;
  if (radius <= 0) {
    outColor = vec4(0.0);
    return;
  }
  if (radius > MAX_RADIUS) {
    radius = MAX_RADIUS;
  }

  ivec2 texel = ivec2(floor(gl_FragCoord.xy - vec2(0.5)));

  if (texel.x < 0 || texel.y < 0) {
    outColor = vec4(0.0);
    return;
  }

  int sliceCol = texel.x / N.x;
  int sliceRow = texel.y / N.y;
  int iz = sliceRow * slicesPerRow + sliceCol;
  if (iz < 0 || iz >= N.z) {
    outColor = vec4(0.0);
    return;
  }

  int ix = texel.x - sliceCol * N.x;
  int iy = texel.y - sliceRow * N.y;
  if (ix < 0 || ix >= N.x || iy < 0 || iy >= N.y) {
    outColor = vec4(0.0);
    return;
  }

  ivec3 baseVoxel = ivec3(ix, iy, iz);

  ivec2 baseTexel = voxelToTexel(baseVoxel, N, slicesPerRow);
  vec4 baseCell = texelFetch(u_massGrid, baseTexel, 0);
  float baseMass = baseCell.a;
  vec3 baseCOM = baseMass > 0.0 ? baseCell.rgb / baseMass : voxelCenterWorld(baseVoxel, u_worldMin, u_worldMax, N);

  vec3 extent = max(u_worldMax - u_worldMin, vec3(1e-6));
  vec3 total = vec3(0.0);

  for (int dz = -MAX_RADIUS; dz <= MAX_RADIUS; ++dz) {
    if (abs(dz) > radius) continue;
    for (int dy = -MAX_RADIUS; dy <= MAX_RADIUS; ++dy) {
      if (abs(dy) > radius) continue;
      for (int dx = -MAX_RADIUS; dx <= MAX_RADIUS; ++dx) {
        if (abs(dx) > radius) continue;

        ivec3 neighbor = baseVoxel + ivec3(dx, dy, dz);
        neighbor.x = wrapIndexInt(neighbor.x, N.x);
        neighbor.y = wrapIndexInt(neighbor.y, N.y);
        neighbor.z = wrapIndexInt(neighbor.z, N.z);

        ivec2 neighborTexel = voxelToTexel(neighbor, N, slicesPerRow);
        vec4 cell = texelFetch(u_massGrid, neighborTexel, 0);
        float mass = cell.a;
        if (mass <= 0.0) {
          continue;
        }

        vec3 neighborCOM = cell.rgb / mass;
        vec3 delta = minimumImage(neighborCOM - baseCOM, extent);
        float dist2 = dot(delta, delta);
        if (dist2 <= 1e-12) {
          continue;
        }

        float softened = dist2 + u_softening * u_softening;
        float invDist = inversesqrt(softened);
        float invDist3 = invDist * invDist * invDist;
        vec3 accel = -u_gravityStrength * mass * delta * invDist3;
        total += accel;
      }
    }
  }

  float componentValue = 0.0;
  if (u_component == 0) {
    componentValue = total.x;
  } else if (u_component == 1) {
    componentValue = total.y;
  } else {
    componentValue = total.z;
  }

  outColor = vec4(componentValue, 0.0, 0.0, 0.0);
}
`;
