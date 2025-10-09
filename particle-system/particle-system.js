// @ts-check

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
import { unbindAllTextures, checkGl, checkFBO } from './utils/debug.js';
import { aggregateL0, pyramidReduce, pipelineUpdateBounds, pipelineCalculateForces, pipelineIntegratePhysics } from './pipeline/index.js';
import { GPUProfiler } from './utils/gpu-profiler.js';
import { createPMGrid, createPMGridFramebuffer } from './pm-grid.js';

export class ParticleSystem {

  /**
{{ ... }}
   * ParticleSystem constructor
   * @param {WebGL2RenderingContext} gl - WebGL2 rendering context
   * @param {{
   *   particleData: { positions: Float32Array, velocities?: Float32Array|null, colors?: Uint8Array|null },
   *   particleCount?: number,
   *   worldBounds?: { min: [number,number,number], max: [number,number,number] },
   *   theta?: number,
   *   dt?: number,
   *   gravityStrength?: number,
   *   softening?: number,
   *   damping?: number,
   *   maxSpeed?: number,
   *   maxAccel?: number,
   *   debugSkipQuadtree?: boolean,
   *   enableProfiling?: boolean,
   *   planA?: boolean
   * }} options
   */
  constructor(gl, options) {
    // ONLY dependency: WebGL2 context (reuses existing from THREE.WebGLRenderer)
    this.gl = gl;
    
    // Validate context (don't create!)
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystem requires WebGL2RenderingContext');
    }
    
    // Validate and store particle data
    if (!options.particleData) {
      throw new Error('ParticleSystem requires particleData with positions, velocities, and colors');
    }
    
    this.particleData = options.particleData;
    const particleCount = options.particleData.positions.length / 4;
    
    this.options = {
      particleCount: particleCount,
      worldBounds: options.worldBounds || {
        min: [-4, -4, 0],
        max: [4, 4, 2]
      },
      theta: options.theta || 0.5,
      dt: options.dt || 1 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.2,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.0,
      debugSkipQuadtree: options.debugSkipQuadtree || false,
      enableProfiling: options.enableProfiling || false,
      planA: options.planA || false,
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
    // Time (ms) when bounds were last updated via GPU readback
    this._lastBoundsUpdateTime = -1;
    
    // PM/FFT resources (Plan A)
    this.pmGrid = null;
    this.pmGridFramebuffer = null;
    this.pmDepositProgram = null;
    this.particleCount = options.particleCount;
    
    // GPU Profiler (created only if enabled)
    this.profiler = null;
    if (this.options.enableProfiling) {
      this.profiler = new GPUProfiler(gl);
    }
    
    // PM Debug state (for Plan A debugging)
    this._pmDebugState = null;
  }

  // Debug helper: unbind all textures on commonly used units to avoid feedback loops
  unbindAllTextures() {
    unbindAllTextures(this.gl);
  }

  // Debug helper: log gl errors with a tag
  checkGl(tag) {
    return checkGl(this.gl, tag);
  }

  // Debug helper: check FBO completeness and tag
  checkFBO(tag) {
    checkFBO(this.gl, tag);
  }

  init() {
    let finished = false;
    try {
      this.checkWebGL2Support();
      this.calculateTextureDimensions();
      this.createShaderPrograms();
      this.createTextures();
      this.createGeometry();
      this.uploadParticleData();
      
      // Initialize PM/FFT pipeline if Plan A is enabled
      if (this.options.planA) {
        this.initPMPipeline();
      }
      
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
      finished = true;
    } finally {
      if (!finished)
        this.dispose();
    }
  }

  initPMPipeline() {
    const gl = this.gl;
    
    // Create PM grid (64³ grid by default)
    const gridSize = 64;
    this.pmGrid = createPMGrid(gl, gridSize);
    this.pmGridFramebuffer = createPMGridFramebuffer(gl, this.pmGrid.texture);
    
    console.log('[PM Pipeline] Initialized with', gridSize, '³ grid');
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
  }

  createShaderPrograms() {
    const gl = this.gl;
    
    this.programs.aggregation = this.createProgram(aggregationVert, aggregationFrag);
    this.programs.reduction = this.createProgram(fsQuadVert, reductionFrag);
    this.programs.traversal = this.createProgram(fsQuadVert, traversalFrag);
    this.programs.velIntegrate = this.createProgram(fsQuadVert, velIntegrateFrag);
    this.programs.posIntegrate = this.createProgram(fsQuadVert, posIntegrateFrag);
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

  uploadParticleData() {
    const { positions, velocities, colors } = this.particleData;
    
    // Validate data lengths
    const expectedLength = this.actualTextureSize * 4;
    if (positions.length !== expectedLength) {
      throw new Error(`Position data length mismatch: expected ${expectedLength}, got ${positions.length}`);
    }
    if (velocities && velocities.length !== expectedLength) {
      throw new Error(`Velocity data length mismatch: expected ${expectedLength}, got ${velocities.length}`);
    }
    if (colors && colors.length !== expectedLength) {
      throw new Error(`Color data length mismatch: expected ${expectedLength}, got ${colors.length}`);
    }
    
    // Use provided data or defaults
    const velData = velocities || new Float32Array(expectedLength); // Default to zero velocity
    const colorData = colors || new Uint8Array(expectedLength).fill(255); // Default to white
    
    this.uploadTextureData(this.positionTextures.textures[0], positions);
    this.uploadTextureData(this.positionTextures.textures[1], positions);
    this.uploadTextureData(this.velocityTextures.textures[0], velData);
    this.uploadTextureData(this.velocityTextures.textures[1], velData);
    this.uploadTextureData(this.colorTexture.texture, colorData, this.gl.RGBA, this.gl.UNSIGNED_BYTE);
  }

  uploadTextureData(texture, data, format = this.gl.RGBA, type = this.gl.FLOAT) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, format, type, data);
  }

  step() {
    if (!this.isInitialized) return;
    
    // Update profiler (collect completed query results)
    if (this.profiler) {
      this.profiler.update();
    }
    
    // Check if PM debug is running in single-stage mode
    if (this._pmDebugState?.config?.enabled && this._pmDebugState.config.singleStageRun) {
      // Run exactly one stage in isolation, skip normal pipeline
      const { pmDebugRunSingle } = require('./pm-debug/index.js');
      const { stage, source, sink } = this._pmDebugState.config.singleStageRun;
      pmDebugRunSingle(this, stage, source, sink);
      return;
    }
    
    // Update world bounds from texture infrequently (every 10 seconds) to avoid GPU-CPU stalls.
    const now = performance.now ? performance.now() : Date.now();
    const updateIntervalMs = 10000; // 10 seconds
    if (this._lastBoundsUpdateTime < 0 || (now - this._lastBoundsUpdateTime) >= updateIntervalMs) {
      try {
        pipelineUpdateBounds(this, 16);
      } catch (e) {
        // Swallow errors here to avoid breaking the simulation loop; leave previous bounds in place
        console.warn('updateWorldBoundsFromTexture failed:', e);
      }
      this._lastBoundsUpdateTime = now;
    }
    
    // Run normal pipeline with optional debug hooks
    this.buildQuadtreeWithDebug();
    this.clearForceTexture();
    
    // Profile force calculation
    if (this.profiler) this.profiler.begin('traversal');
    pipelineCalculateForces(this);
    if (this.profiler) this.profiler.end();
    
    // Profile integration (split into velocity + position for granularity)
    pipelineIntegratePhysics(this);
    
    this.frameCount++;
  }
  
  buildQuadtreeWithDebug() {
    // Check for debug hooks before/after deposit stage
    if (this._pmDebugState?.config?.enabled) {
      const { pmDebugBeforeStage, pmDebugAfterStage } = require('./pm-debug/index.js');
      
      // Before hook for pm_deposit
      const sourceBefore = pmDebugBeforeStage(this, 'pm_deposit');
      if (sourceBefore && sourceBefore.kind !== 'live') {
        // Override with synthetic or snapshot source
        // (will be handled by buildQuadtree itself)
      }
      
      // Build quadtree normally
      this.buildQuadtree();
      
      // After hook for pm_deposit
      const sinkAfter = pmDebugAfterStage(this, 'pm_deposit');
      if (sinkAfter && sinkAfter.kind !== 'noop') {
        // Apply sink (snapshot, overlay, metrics, etc.)
        // This will be handled by the pm-debug module
      }
    } else {
      // Build quadtree normally without debug hooks
      this.buildQuadtree();
    }
  }

  buildQuadtree() {
    const gl = this.gl;
    this.unbindAllTextures();

    // Profile octree clear (7 gl.clear() calls)
    if (this.profiler) this.profiler.begin('octree_clear');
    for (let i = 0; i < this.numLevels; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.levelFramebuffers[i]);
      gl.viewport(0, 0, this.levelTextures[i].size, this.levelTextures[i].size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (this.profiler) this.profiler.end();
    
    // Profile aggregation
    if (this.profiler) this.profiler.begin('aggregation');
    aggregateL0(this);
    if (this.profiler) this.profiler.end();
    
    // Profile pyramid reduction
    if (this.profiler) this.profiler.begin('pyramid_reduction');
    for (let level = 0; level < this.numLevels - 1; level++) {
      pyramidReduce(this, level, level + 1);
    }
    if (this.profiler) this.profiler.end();
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

  /**
   * Begin profiling a custom timer (e.g., for rendering)
   * @param {string} name - Timer name
   */
  beginProfile(name) {
    if (this.profiler) {
      this.profiler.begin(name);
    }
  }

  /**
   * End profiling the current timer
   */
  endProfile() {
    if (this.profiler) {
      this.profiler.end();
    }
  }

  dispose() {    
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
    
    // Clean up profiler
    if (this.profiler) {
      this.profiler.dispose();
      this.profiler = null;
    }
    
    this.isInitialized = false;
  }
}
