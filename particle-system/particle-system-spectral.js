// @ts-check

/**
 * ParticleSystem Spectral - Particle-Mesh with FFT (Spectral Method)
 * 
 * GPU-accelerated N-body simulation using Particle-Mesh (PM) method with FFT
 * for spectral force computation. Scales well with uniform particle distributions
 * and provides excellent accuracy for smooth density fields.
 * 
 * Uses O(N + M log M) complexity where N is particle count and M is grid size.
 * Fourier-space Poisson solver enables efficient long-range force computation.
 */

// Shader sources
import fsQuadVert from './shaders/fullscreen.vert.js';
import velIntegrateFrag from './shaders/vel_integrate.frag.js';
import posIntegrateFrag from './shaders/pos_integrate.frag.js';

// Debug utilities
import { unbindAllTextures, checkGl, checkFBO } from './utils/debug.js';

// Shared resource helpers
import {
  createRenderTexture,
  createPingPongTextures,
  createGeometry,
  uploadTextureData,
  createProgram,
  calculateParticleTextureDimensions,
  checkWebGL2Support
} from './utils/common.js';

// Pipeline utilities
import { pipelineUpdateBounds, pipelineIntegratePhysics } from './pipeline/index.js';
import { GPUProfiler } from './utils/gpu-profiler.js';
import { createPMGrid, createPMGridFramebuffer } from './pm-grid.js';
import { computePMForcesSync } from './pipeline/pm-pipeline.js';
import { pmDebugRunSingle } from './pm-debug/index.js';

export class ParticleSystemSpectral {

  /**
   * ParticleSystemSpectral constructor
   * @param {WebGL2RenderingContext} gl - WebGL2 rendering context
   * @param {{
   *   particleData: { positions: Float32Array, velocities?: Float32Array|null, colors?: Uint8Array|null },
   *   particleCount?: number,
   *   worldBounds?: { min: [number,number,number], max: [number,number,number] },
   *   dt?: number,
   *   gravityStrength?: number,
   *   softening?: number,
   *   damping?: number,
   *   maxSpeed?: number,
   *   maxAccel?: number,
   *   enableProfiling?: boolean,
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
      dt: options.dt || 1 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.2,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.0,
      enableProfiling: options.enableProfiling || false
    };

    // Internal state
    this.isInitialized = false;
    this.frameCount = 0;

    // GPU resources
    this.positionTextures = null;
    this.velocityTextures = null;
    this.forceTexture = null;
    this.colorTexture = null;
    /** @type {{velIntegrate?: WebGLProgram, posIntegrate?: WebGLProgram}} */
    this.programs = {};
    this.quadVAO = null;
    this.particleVAO = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.actualTextureSize = 0;
    this._lastBoundsUpdateFrame = -1;
    // Time (ms) when bounds were last updated via GPU readback
    this._lastBoundsUpdateTime = -1;

    // PM/FFT resources (Plan A)
    this.pmGrid = null;
    this.pmGridFramebuffer = null;
    /** @type {WebGLProgram|null} */
    this.pmDepositProgram = null;
    this.particleCount = particleCount;

    // GPU Profiler (created only if enabled)
    this.profiler = null;
    if (this.options.enableProfiling) {
      this.profiler = new GPUProfiler(gl);
    }

    // PM Debug state (for Plan A debugging)
    /** @type {any} */
    this._pmDebugState = null;
  }

  // Debug helper: unbind all textures on commonly used units to avoid feedback loops
  unbindAllTextures() {
    unbindAllTextures(this.gl);
  }

  // Debug helper: log gl errors with a tag
  /**
   * @param {string} tag
   */
  checkGl(tag) {
    return checkGl(this.gl, tag);
  }

  // Debug helper: check FBO completeness and tag
  /**
   * @param {string} tag
   */
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

      this.initPMPipeline();

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

    // Create PM grid (64┬│ grid by default)
    const gridSize = 64;
    this.pmGrid = createPMGrid(gl, gridSize);
    this.pmGridFramebuffer = createPMGridFramebuffer(gl, this.pmGrid.texture);

    console.log('[PM Pipeline] Initialized with', gridSize, '┬│ grid');
  }

  checkWebGL2Support() {
    const gl = this.gl;

    const result = checkWebGL2Support(gl);
    if (result.disableFloatBlend) {
      console.warn('EXT_float_blend extension not supported: additive blending performance may degrade.');
    }
  }

  calculateTextureDimensions() {
    const dims = calculateParticleTextureDimensions(this.options.particleCount);
    this.textureWidth = dims.width;
    this.textureHeight = dims.height;
    this.actualTextureSize = dims.actualSize;
  }

  createShaderPrograms() {
    const gl = this.gl;

    this.programs.velIntegrate = createProgram(gl, fsQuadVert, velIntegrateFrag);
    this.programs.posIntegrate = createProgram(gl, fsQuadVert, posIntegrateFrag);
  }

  createTextures() {
    const gl = this.gl;

    this.positionTextures = createPingPongTextures(gl, this.textureWidth, this.textureHeight);
    this.velocityTextures = createPingPongTextures(gl, this.textureWidth, this.textureHeight);
    this.forceTexture = createRenderTexture(gl, this.textureWidth, this.textureHeight);
    this.colorTexture = createRenderTexture(gl, this.textureWidth, this.textureHeight, gl.RGBA8, gl.UNSIGNED_BYTE);
  }

  createGeometry() {
    const gl = this.gl;

    const geometry = createGeometry(gl, this.options.particleCount);
    this.quadVAO = geometry.quadVAO;
    this.particleVAO = geometry.particleVAO;
  }

  uploadParticleData() {
    const { positions, velocities, colors } = this.particleData;

    if (!this.actualTextureSize) {
      throw new Error('actualTextureSize is not initialized');
    }

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

    const pos0 = this.positionTextures?.textures[0];
    const pos1 = this.positionTextures?.textures[1];
    const vel0 = this.velocityTextures?.textures[0];
    const vel1 = this.velocityTextures?.textures[1];
    const colorTex = this.colorTexture?.texture;
    
    if (!pos0 || !pos1 || !vel0 || !vel1 || !colorTex) {
      throw new Error('Textures not initialized');
    }
    
    uploadTextureData(this.gl, pos0, positions, this.textureWidth, this.textureHeight);
    uploadTextureData(this.gl, pos1, positions, this.textureWidth, this.textureHeight);
    uploadTextureData(this.gl, vel0, velData, this.textureWidth, this.textureHeight);
    uploadTextureData(this.gl, vel1, velData, this.textureWidth, this.textureHeight);
    uploadTextureData(this.gl, colorTex, colorData, this.textureWidth, this.textureHeight, this.gl.RGBA, /** @type {number} */ (this.gl.UNSIGNED_BYTE));
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

    computePMForcesSync(this);

    // Profile integration (split into velocity + position for granularity)
    pipelineIntegratePhysics(this);

    this.frameCount++;
  }

  getPositionTexture() {
    return this.positionTextures?.getCurrentTexture() || null;
  }

  getPositionTextures() {
    // Returns BOTH textures for ping-pong
    return this.positionTextures?.textures || [];
  }

  getCurrentIndex() {
    return this.positionTextures?.currentIndex ?? 0;
  }

  getColorTexture() {
    return this.colorTexture?.texture || null;
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
