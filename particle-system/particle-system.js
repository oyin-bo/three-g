/**
 * Plan M: "The Menace" — GPU-side Dynamic Octree
 * 
 * Implements a GPU-resident octree using WebGL2 fragment shaders for large-scale
 * particle simulation with O(N log N) complexity via Barnes-Hut algorithm.
 * Uses isotropic 3D treatment of X/Y/Z axes with Z-slice stacking for 2D texture mapping.
 */

// Shader sources
import fsQuadVert from './shaders/fullscreen.vert.js';
import reductionFrag from './shaders/reduction.frag.js';
import aggregationVert from './shaders/aggregation.vert.js';
import aggregationFrag from './shaders/aggregation.frag.js';
import traversalFrag from './shaders/traversal.frag.js';
import velIntegrateFrag from './shaders/vel_integrate.frag.js';
import posIntegrateFrag from './shaders/pos_integrate.frag.js';

// Pipeline utilities
import { unbindAllTextures as dbgUnbindAllTextures, checkGl as dbgCheckGl, checkFBO as dbgCheckFBO } from './utils/debug.js';
import { aggregateParticlesIntoL0 as aggregateL0 } from './pipeline/aggregator.js';
import { runReductionPass as pyramidReduce } from './pipeline/pyramid.js';
import { calculateForces as pipelineCalculateForces } from './pipeline/traversal.js';
import { integratePhysics as pipelineIntegratePhysics } from './pipeline/integrator.js';
import { updateWorldBoundsFromTexture as pipelineUpdateBounds } from './pipeline/bounds.js';

export class ParticleSystem {
  constructor(gl, options) {
    // ONLY dependency: WebGL2 context (reuses existing from THREE.WebGLRenderer)
    this.gl = gl;
    
    // Validate context (don't create!)
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystem requires WebGL2RenderingContext');
    }
    
    this.options = {
      particleCount: options.particleCount || 200000,
      worldBounds: options.worldBounds || {
        min: [-4, -4, 0],
        max: [4, 4, 2]
      },
      theta: options.theta || 0.5,
      dt: options.dt || 10 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.2,
      initialSpeed: options.initialSpeed || 0.05,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.0,
      debugSkipQuadtree: options.debugSkipQuadtree || false,
    };
    
    // Internal state
    this.isInitialized = false;
    this.frameCount = 0;
    
    // GPU resources
    this.levelTextures = [];
    this.levelFramebuffers = [];
    this.positionTextures = null;
    this.velocityTextures = null;
    this.forceTexture = null;
    this.colorTexture = null;
    this.programs = {};
    this.quadVAO = null;
    this.particleVAO = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.numLevels = 0;
    this.L0Size = 0;
    this._disableFloatBlend = false;
    this._quadtreeDisabled = false;
    this._lastBoundsUpdateFrame = -1;
  }

  // Debug helper: unbind all textures on commonly used units to avoid feedback loops
  unbindAllTextures() {
    dbgUnbindAllTextures(this.gl);
  }

  // Debug helper: log gl errors with a tag
  checkGl(tag) {
    return dbgCheckGl(this.gl, tag);
  }

  // Debug helper: check FBO completeness and tag
  checkFBO(tag) {
    dbgCheckFBO(this.gl, tag);
  }

  async init() {
    if (!this.gl) {
      throw new Error('WebGL2 context not available');
    }
    
    console.log('Initializing BarnesHutSystem...');
    
    try {
      this.checkWebGL2Support();
      this.calculateTextureDimensions();
      this.createShaderPrograms();
      this.createTextures();
      this.createGeometry();
      this.initializeParticles();
      
      // Restore GL state for THREE.js compatibility
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindVertexArray(null);
      // NOTE: Don't call gl.useProgram(null) - breaks THREE.js shaders!
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      
      this.isInitialized = true;
      console.log('BarnesHutSystem initialized successfully');
      
    } catch (error) {
      console.error('BarnesHutSystem initialization failed:', error);
      this.dispose();
      throw error;
    }
  }

  checkWebGL2Support() {
    const gl = this.gl;
    
    const colorBufferFloat = gl.getExtension('EXT_color_buffer_float');
    const floatBlend = gl.getExtension('EXT_float_blend');
    
    if (!colorBufferFloat) {
      throw new Error('EXT_color_buffer_float extension not supported');
    }
    
    if (!floatBlend) {
      console.warn('EXT_float_blend extension not supported: required for additive blending to float textures. Performance may be degraded.');
      this._disableFloatBlend = true;
    }
    
    const caps = {
      maxVertexTextureUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
      maxTextureUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
      maxDrawBuffers: gl.getParameter(gl.MAX_DRAW_BUFFERS),
    };
    console.log('WebGL caps:', caps);

    console.log('WebGL2 extensions check passed');
  }

  calculateTextureDimensions() {
    // Octree configuration: 64³ voxels with Z-slice stacking
    this.octreeGridSize = 64; // 64x64x64 3D grid
    this.octreeSlicesPerRow = 8; // 8x8 grid of Z-slices
    this.numLevels = 7; // 64 → 32 → 16 → 8 → 4 → 2 → 1
    
    // L0 texture size: gridSize * slicesPerRow (64 * 8 = 512)
    this.L0Size = this.octreeGridSize * this.octreeSlicesPerRow;
    const maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    if (this.L0Size > maxTex) {
      throw new Error(`Octree L0 size ${this.L0Size} exceeds max texture size ${maxTex}`);
    }
    
    // Particle texture dimensions (unchanged)
    this.textureWidth = Math.ceil(Math.sqrt(this.options.particleCount));
    this.textureHeight = Math.ceil(this.options.particleCount / this.textureWidth);
    this.actualTextureSize = this.textureWidth * this.textureHeight;
    
    console.log(`Octree: L0=${this.octreeGridSize}³ voxels (${this.L0Size}x${this.L0Size} texture), ${this.numLevels} levels`);
    console.log(`Z-slice stacking: ${this.octreeSlicesPerRow}x${this.octreeSlicesPerRow} grid of ${this.octreeGridSize} slices`);
    console.log(`Position texture: ${this.textureWidth}x${this.textureHeight} for ${this.options.particleCount} particles (${this.actualTextureSize} total texels)`);
  }

  createShaderPrograms() {
    const gl = this.gl;
    
    this.programs.aggregation = this.createProgram(aggregationVert, aggregationFrag);
    this.programs.reduction = this.createProgram(fsQuadVert, reductionFrag);
    this.programs.traversal = this.createProgram(fsQuadVert, traversalFrag);
    this.programs.velIntegrate = this.createProgram(fsQuadVert, velIntegrateFrag);
    this.programs.posIntegrate = this.createProgram(fsQuadVert, posIntegrateFrag);
    
    console.log('Shader programs created successfully');
  }

  createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;
    
    const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentSource);
    
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const info = gl.getProgramInfoLog(program);
      gl.deleteProgram(program);
      throw new Error(`Shader program link failed: ${info}`);
    }
    
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    
    return program;
  }

  createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const info = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`Shader compile failed: ${info}\nSource:\n${source}`);
    }
    
    return shader;
  }

  createTextures() {
    const gl = this.gl;
    
    this.levelTextures = [];
    this.levelFramebuffers = [];
    
    let currentSize = this.L0Size;
    let currentGridSize = this.octreeGridSize;
    let currentSlicesPerRow = this.octreeSlicesPerRow;
    
    for (let i = 0; i < this.numLevels; i++) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, currentSize, currentSize, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      
      this.levelTextures.push({
        texture, 
        size: currentSize, 
        gridSize: currentGridSize,
        slicesPerRow: currentSlicesPerRow
      });
      this.levelFramebuffers.push(framebuffer);
      
      currentGridSize = Math.max(1, Math.floor(currentGridSize / 2));
      currentSlicesPerRow = Math.max(1, Math.floor(currentSlicesPerRow / 2));
      currentSize = currentGridSize * currentSlicesPerRow;
    }
    
    this.positionTextures = this.createPingPongTextures(this.textureWidth, this.textureHeight);
    this.velocityTextures = this.createPingPongTextures(this.textureWidth, this.textureHeight);
    this.forceTexture = this.createRenderTexture(this.textureWidth, this.textureHeight);
    this.colorTexture = this.createRenderTexture(this.textureWidth, this.textureHeight, gl.RGBA8, gl.UNSIGNED_BYTE);
    
    console.log(`Created ${this.numLevels} octree level textures and particle textures`);
  }

  createPingPongTextures(width, height) {
    const gl = this.gl;
    const textures = [];
    const framebuffers = [];
    
    for (let i = 0; i < 2; i++) {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
      
      textures.push(texture);
      framebuffers.push(framebuffer);
    }
    
    return {
      textures,
      framebuffers,
      currentIndex: 0,
      getCurrentTexture: function() { return this.textures[this.currentIndex]; },
      getTargetTexture: function() { return this.textures[1 - this.currentIndex]; },
      getTargetFramebuffer: function() { return this.framebuffers[1 - this.currentIndex]; },
      swap: function() { this.currentIndex = 1 - this.currentIndex; }
    };
  }

  createRenderTexture(width, height, internalFormat = this.gl.RGBA32F, type = this.gl.FLOAT) {
    const gl = this.gl;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, gl.RGBA, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

    return { texture, framebuffer };
  }

  createGeometry() {
    const gl = this.gl;
    
    const quadVertices = new Float32Array([
      -1, -1,  1, -1,  -1, 1,  1, 1
    ]);
    
    this.quadVAO = gl.createVertexArray();
    gl.bindVertexArray(this.quadVAO);
    
    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    
    const particleIndices = new Float32Array(this.options.particleCount);
    for (let i = 0; i < this.options.particleCount; i++) {
      particleIndices[i] = i;
    }
    
    this.particleVAO = gl.createVertexArray();
    gl.bindVertexArray(this.particleVAO);
    
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, particleIndices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
    
    gl.bindVertexArray(null);
  }

  initializeParticles() {
    const positions = new Float32Array(this.actualTextureSize * 4);
    const velocities = new Float32Array(this.actualTextureSize * 4);
    const colors = new Uint8Array(this.actualTextureSize * 4);
    
    const bounds = this.options.worldBounds;
    const center = [
      (bounds.min[0] + bounds.max[0]) / 2,
      (bounds.min[1] + bounds.max[1]) / 2,
      (bounds.min[2] + bounds.max[2]) / 2
    ];
    const speed = this.options.initialSpeed;
    
    for (let i = 0; i < this.options.particleCount; i++) {
      const base = i * 4;
      
      const angle = Math.random() * Math.PI * 2;
      const radius = Math.random() * 3 + Math.random() * 1;
      const height = (Math.random() - 0.5) * 2;
      
      positions[base + 0] = center[0] + Math.cos(angle) * radius;
      positions[base + 1] = center[1] + Math.sin(angle) * radius;
      positions[base + 2] = center[2] + height;
      positions[base + 3] = 0.5 + Math.random() * 1.5; // mass
      
      velocities[base + 0] = (Math.random() - 0.5) * 2.0 * speed;
      velocities[base + 1] = (Math.random() - 0.5) * 2.0 * speed;
      velocities[base + 2] = (Math.random() - 0.5) * 2.0 * speed;
      velocities[base + 3] = 0.0;

      // Color gradient based on initial position (shows intermixing)
      const x = (positions[base + 0] - bounds.min[0]) / (bounds.max[0] - bounds.min[0]);
      const y = (positions[base + 1] - bounds.min[1]) / (bounds.max[1] - bounds.min[1]);
      const z = (positions[base + 2] - bounds.min[2]) / (bounds.max[2] - bounds.min[2]);
      
      colors[base + 0] = Math.floor(x * 255); // Red varies with X
      colors[base + 1] = Math.floor(y * 255); // Green varies with Y
      colors[base + 2] = Math.floor(z * 255); // Blue varies with Z
      colors[base + 3] = 255;
    }
    
    this.uploadTextureData(this.positionTextures.textures[0], positions);
    this.uploadTextureData(this.positionTextures.textures[1], positions);
    this.uploadTextureData(this.velocityTextures.textures[0], velocities);
    this.uploadTextureData(this.velocityTextures.textures[1], velocities);
    this.uploadTextureData(this.colorTexture.texture, colors, this.gl.RGBA, this.gl.UNSIGNED_BYTE);
    
    console.log(`Particle data initialized: ${this.options.particleCount} particles`);
  }

  uploadTextureData(texture, data, format = this.gl.RGBA, type = this.gl.FLOAT) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, format, type, data);
  }

  step() {
    if (!this.isInitialized) return;
    
    if ((this.frameCount % 10) === 0) {
      pipelineUpdateBounds(this, 256);
    }
    this.buildQuadtree();
    this.clearForceTexture();
    pipelineCalculateForces(this);
    pipelineIntegratePhysics(this);
    
    this.frameCount++;
  }

  buildQuadtree() {
    const gl = this.gl;
    this.unbindAllTextures();

    for (let i = 0; i < this.numLevels; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.levelFramebuffers[i]);
      gl.viewport(0, 0, this.levelTextures[i].size, this.levelTextures[i].size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    
    aggregateL0(this);
    
    for (let level = 0; level < this.numLevels - 1; level++) {
      pyramidReduce(this, level, level + 1);
    }
  }

  clearForceTexture() {
    const gl = this.gl;
    this.unbindAllTextures();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.forceTexture.framebuffer);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.textureWidth, this.textureHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  getPositionTexture() {
    return this.positionTextures.getCurrentTexture();
  }
  
  getPositionTextures() {
    // Returns BOTH textures for ping-pong
    return this.positionTextures.textures;
  }
  
  getCurrentIndex() {
    return this.positionTextures.currentIndex;
  }
  
  getColorTexture() {
    return this.colorTexture.texture;
  }
  
  getTextureSize() {
    return { width: this.textureWidth, height: this.textureHeight };
  }

  dispose() {
    if (!this.gl) return;
    
    const gl = this.gl;
    
    this.levelTextures.forEach(level => gl.deleteTexture(level.texture));
    this.levelFramebuffers.forEach(fbo => gl.deleteFramebuffer(fbo));
    
    if (this.positionTextures) {
      this.positionTextures.textures.forEach(tex => gl.deleteTexture(tex));
      this.positionTextures.framebuffers.forEach(fbo => gl.deleteFramebuffer(fbo));
    }
    if (this.velocityTextures) {
      this.velocityTextures.textures.forEach(tex => gl.deleteTexture(tex));
      this.velocityTextures.framebuffers.forEach(fbo => gl.deleteFramebuffer(fbo));
    }
    if (this.forceTexture) {
      gl.deleteTexture(this.forceTexture.texture);
      gl.deleteFramebuffer(this.forceTexture.framebuffer);
    }
    if (this.colorTexture) {
      gl.deleteTexture(this.colorTexture.texture);
      gl.deleteFramebuffer(this.colorTexture.framebuffer);
    }
    
    Object.values(this.programs).forEach(program => gl.deleteProgram(program));
    
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.particleVAO) gl.deleteVertexArray(this.particleVAO);
    
    this.isInitialized = false;
    console.log('BarnesHutSystem disposed');
  }
}
