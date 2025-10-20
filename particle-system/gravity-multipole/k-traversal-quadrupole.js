// @ts-check

/**
 * TraversalQuadrupoleKernel - Quadrupole Barnes-Hut tree traversal
 * 
 * Traverses the octree hierarchy to compute gravitational forces using quadrupole approximation.
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';

// Simple quadrupole shader using individual textures (not arrays)
// This matches the monopole pattern for consistency in the kernel approach
const traversalQuadrupoleShader = `#version 300 es
precision highp float;

// Quadrupole traversal using individual textures per level
uniform sampler2D u_particlePositions;

// A0 monopole moments per level
uniform sampler2D u_levelA0_0;
uniform sampler2D u_levelA0_1;
uniform sampler2D u_levelA0_2;
uniform sampler2D u_levelA0_3;
uniform sampler2D u_levelA0_4;
uniform sampler2D u_levelA0_5;
uniform sampler2D u_levelA0_6;

// A1 quadrupole moments per level [m*x², m*y², m*z², m*xy]
uniform sampler2D u_levelA1_0;
uniform sampler2D u_levelA1_1;
uniform sampler2D u_levelA1_2;
uniform sampler2D u_levelA1_3;
uniform sampler2D u_levelA1_4;
uniform sampler2D u_levelA1_5;
uniform sampler2D u_levelA1_6;

// A2 quadrupole moments per level [m*xz, m*yz, 0, 0]
uniform sampler2D u_levelA2_0;
uniform sampler2D u_levelA2_1;
uniform sampler2D u_levelA2_2;
uniform sampler2D u_levelA2_3;
uniform sampler2D u_levelA2_4;
uniform sampler2D u_levelA2_5;
uniform sampler2D u_levelA2_6;

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
uniform bool u_enableQuadrupoles;

out vec4 fragColor;

// Sample A0 from specific level
vec4 sampleLevelA0(int level, ivec2 coord) {
  if (level == 0) return texelFetch(u_levelA0_0, coord, 0);
  else if (level == 1) return texelFetch(u_levelA0_1, coord, 0);
  else if (level == 2) return texelFetch(u_levelA0_2, coord, 0);
  else if (level == 3) return texelFetch(u_levelA0_3, coord, 0);
  else if (level == 4) return texelFetch(u_levelA0_4, coord, 0);
  else if (level == 5) return texelFetch(u_levelA0_5, coord, 0);
  else if (level == 6) return texelFetch(u_levelA0_6, coord, 0);
  return vec4(0.0);
}

// Sample A1 from specific level
vec4 sampleLevelA1(int level, ivec2 coord) {
  if (level == 0) return texelFetch(u_levelA1_0, coord, 0);
  else if (level == 1) return texelFetch(u_levelA1_1, coord, 0);
  else if (level == 2) return texelFetch(u_levelA1_2, coord, 0);
  else if (level == 3) return texelFetch(u_levelA1_3, coord, 0);
  else if (level == 4) return texelFetch(u_levelA1_4, coord, 0);
  else if (level == 5) return texelFetch(u_levelA1_5, coord, 0);
  else if (level == 6) return texelFetch(u_levelA1_6, coord, 0);
  return vec4(0.0);
}

// Sample A2 from specific level
vec4 sampleLevelA2(int level, ivec2 coord) {
  if (level == 0) return texelFetch(u_levelA2_0, coord, 0);
  else if (level == 1) return texelFetch(u_levelA2_1, coord, 0);
  else if (level == 2) return texelFetch(u_levelA2_2, coord, 0);
  else if (level == 3) return texelFetch(u_levelA2_3, coord, 0);
  else if (level == 4) return texelFetch(u_levelA2_4, coord, 0);
  else if (level == 5) return texelFetch(u_levelA2_5, coord, 0);
  else if (level == 6) return texelFetch(u_levelA2_6, coord, 0);
  return vec4(0.0);
}

// Convert 3D voxel coordinate to 2D texture coordinate
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

  vec3 worldExtent = u_worldMax - u_worldMin;
  float eps = max(u_softening, 1e-6);

  // Traverse octree levels from coarsest to finest
  for (int level = min(u_numLevels - 1, 7); level >= 0; level--) {
    float gridSize = u_gridSizes[level];
    float slicesPerRow = u_slicesPerRow[level];
    float cellSize = u_cellSizes[level];

    // Find which voxel contains particle
    vec3 relPos = (myPos - u_worldMin) / worldExtent;
    ivec3 voxelCoord = ivec3(clamp(relPos * gridSize, vec3(0.0), vec3(gridSize - 0.01)));
    
    // Traverse all voxels at this level
    for (int vz = 0; vz < int(gridSize); vz++) {
      for (int vy = 0; vy < int(gridSize); vy++) {
        for (int vx = 0; vx < int(gridSize); vx++) {
          ivec3 testVoxel = ivec3(vx, vy, vz);
          ivec2 texCoord = voxelToTexel(testVoxel, gridSize, slicesPerRow);
          
          // Sample monopole moments
          vec4 a0 = sampleLevelA0(level, texCoord);
          float mass = a0.w;
          
          if (mass < 1e-10) continue;
          
          // Center of mass
          vec3 com = a0.xyz / mass;
          vec3 r = myPos - com;
          float dist = length(r);
          
          // MAC criterion
          bool useCell = (cellSize / (dist + eps)) < u_theta || testVoxel == voxelCoord;
          
          if (useCell) {
            if (testVoxel == voxelCoord) {
              // Self-voxel: skip or use direct summation
              continue;
            }
            
            // Monopole force
            float distSq = dist * dist + eps * eps;
            float distCubed = distSq * sqrt(distSq);
            vec3 monopoleForce = -u_G * mass * r / distCubed;
            
            totalForce += monopoleForce;
            
            // Add quadrupole correction if enabled
            if (u_enableQuadrupoles && level > 0) {
              vec4 a1 = sampleLevelA1(level, texCoord);
              vec4 a2 = sampleLevelA2(level, texCoord);
              
              // Quadrupole moments: Q_xx, Q_yy, Q_zz, Q_xy, Q_xz, Q_yz
              float qxx = a1.r - com.x * com.x * mass;
              float qyy = a1.g - com.y * com.y * mass;
              float qzz = a1.b - com.z * com.z * mass;
              float qxy = a1.a - com.x * com.y * mass;
              float qxz = a2.r - com.x * com.z * mass;
              float qyz = a2.g - com.y * com.z * mass;
              
              // Quadrupole force correction (simplified)
              float dist5 = distSq * distSq * sqrt(distSq);
              vec3 quadForce = vec3(0.0);
              
              // Trace term
              float trace = qxx + qyy + qzz;
              quadForce += 1.5 * u_G * trace * r / dist5;
              
              // Diagonal terms
              quadForce.x += u_G * (qxx * r.x + qxy * r.y + qxz * r.z) / dist5;
              quadForce.y += u_G * (qxy * r.x + qyy * r.y + qyz * r.z) / dist5;
              quadForce.z += u_G * (qxz * r.x + qyz * r.y + qzz * r.z) / dist5;
              
              totalForce += quadForce * 2.5; // Tuning factor
            }
          }
        }
      }
    }
  }

  fragColor = vec4(totalForce, 0.0);
}
`;

export class KTraversalQuadrupole {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inLevelA0?: WebGLTexture[],
   *   inLevelA1?: WebGLTexture[],
   *   inLevelA2?: WebGLTexture[],
   *   outForce?: WebGLTexture|null,
   *   particleTexWidth?: number,
   *   particleTexHeight?: number,
   *   numLevels?: number,
   *   levelConfigs?: Array<{size: number, gridSize: number, slicesPerRow: number}>,
   *   worldBounds?: {min: [number,number,number], max: [number,number,number]},
   *   theta?: number,
   *   gravityStrength?: number,
   *   softening?: number,
   *   enableQuadrupoles?: boolean,
   *   useOccupancyMasks?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;
    
    // Resource slots
    this.inPosition = options.inPosition !== undefined ? options.inPosition : null;
    this.inLevelA0 = options.inLevelA0 || [];
    this.inLevelA1 = options.inLevelA1 || [];
    this.inLevelA2 = options.inLevelA2 || [];
    this.outForce = options.outForce !== undefined ? options.outForce : null;
    
    // Particle texture dimensions
    this.particleTexWidth = options.particleTexWidth || 0;
    this.particleTexHeight = options.particleTexHeight || 0;
    
    // Octree configuration
    this.numLevels = options.numLevels || 7;
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
    this.enableQuadrupoles = options.enableQuadrupoles !== undefined ? options.enableQuadrupoles : true;
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
    this.gl.shaderSource(frag, traversalQuadrupoleShader);
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
   * Run the kernel (synchronous)
   */
  run() {
    const gl = this.gl;
    
    if (!this.inPosition || !this.outForce) {
      throw new Error('KTraversalQuadrupole: missing required textures');
    }
    
    if (this.inLevelA0.length < this.numLevels) {
      throw new Error(`KTraversalQuadrupole: expected ${this.numLevels} level A0 textures, got ${this.inLevelA0.length}`);
    }
    
    if (this.enableQuadrupoles) {
      if (this.inLevelA1.length < this.numLevels) {
        throw new Error(`KTraversalQuadrupole: expected ${this.numLevels} level A1 textures, got ${this.inLevelA1.length}`);
      }
      if (this.inLevelA2.length < this.numLevels) {
        throw new Error(`KTraversalQuadrupole: expected ${this.numLevels} level A2 textures, got ${this.inLevelA2.length}`);
      }
    }
    
    gl.useProgram(this.program);

    // Ensure framebuffer attachments match our output
    if (!this._fboShadow?.a0 !== this.outForce) {
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
    gl.viewport(0, 0, this.particleTexWidth, this.particleTexHeight);
    
    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    
    // Bind position texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particlePositions'), 0);
    
    // Bind all octree level textures (A0, A1, A2 for quadrupole)
    // Use individual textures matching the shader uniforms
    const maxLevels = Math.min(this.numLevels, 7);
    
    // Bind A0 textures
    for (let i = 0; i < maxLevels; i++) {
      gl.activeTexture(gl.TEXTURE1 + i);
      gl.bindTexture(gl.TEXTURE_2D, this.inLevelA0[i]);
      gl.uniform1i(gl.getUniformLocation(this.program, `u_levelA0_${i}`), 1 + i);
    }
    
    // Bind A1 textures if quadrupoles enabled
    if (this.enableQuadrupoles) {
      for (let i = 0; i < maxLevels; i++) {
        gl.activeTexture(gl.TEXTURE8 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.inLevelA1[i]);
        gl.uniform1i(gl.getUniformLocation(this.program, `u_levelA1_${i}`), 8 + i);
      }
      
      // Bind A2 textures
      for (let i = 0; i < maxLevels; i++) {
        gl.activeTexture(gl.TEXTURE16 + i);
        gl.bindTexture(gl.TEXTURE_2D, this.inLevelA2[i]);
        gl.uniform1i(gl.getUniformLocation(this.program, `u_levelA2_${i}`), 16 + i);
      }
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
      this.particleTexWidth, this.particleTexHeight);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_particleCount'),
      this.particleTexWidth * this.particleTexHeight);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMin'),
      this.worldBounds.min[0], this.worldBounds.min[1], this.worldBounds.min[2]);
    gl.uniform3f(gl.getUniformLocation(this.program, 'u_worldMax'),
      this.worldBounds.max[0], this.worldBounds.max[1], this.worldBounds.max[2]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_theta'), this.theta);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_G'), this.gravityStrength);
    gl.uniform1f(gl.getUniformLocation(this.program, 'u_softening'), this.softening);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_numLevels'), this.numLevels);
    gl.uniform1i(gl.getUniformLocation(this.program, 'u_enableQuadrupoles'), this.enableQuadrupoles ? 1 : 0);
    
    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
    
    // Unbind
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  
  /**
   * Dispose all resources
   */
  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebuffer) gl.deleteFramebuffer(this.outFramebuffer);

    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.outForce) gl.deleteTexture(this.outForce);

    this._fboShadow = null;
  }
}
