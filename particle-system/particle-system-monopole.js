// @ts-check

/**
 * ParticleSystem Monopole - Barnes-Hut with Monopole Approximation
 * 
 * GPU-resident octree using WebGL2 fragment shaders for large-scale
 * particle simulation with O(N log N) complexity via Barnes-Hut algorithm.
 * Uses individual 2D textures per level with monopole moments (mass * position).
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
import { GPUProfiler } from './utils/gpu-profiler.js';

// Common utilities
import {
  createRenderTexture,
  createPingPongTextures,
  createGeometry,
  uploadTextureData,
  createProgram,
  calculateParticleTextureDimensions,
  checkWebGL2Support
} from './utils/common.js';

export class ParticleSystemMonopole {

  /**
   * ParticleSystemMonopole constructor
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
   *   enableProfiling?: boolean
   * }} options
   */
  constructor(gl, options) {
    this.gl = gl;
    
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystemMonopole requires WebGL2RenderingContext');
    }
    
    if (!options.particleData) {
      throw new Error('ParticleSystemMonopole requires particleData with positions, velocities, and colors');
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
      enableProfiling: options.enableProfiling || false
    };
    
    // Internal state
    this.frameCount = 0;
    
    // GPU resources
    /** @type {{a0: WebGLTexture, a1: WebGLTexture, a2: WebGLTexture, size: number, gridSize: number, slicesPerRow: number}[]} */
    this.levelTargets = [];
    /** @type {WebGLFramebuffer[]} */
    this.levelFramebuffers = [];
    /** @type {{texture: WebGLTexture, size: number, gridSize: number, slicesPerRow: number}[]} */
    this.levelTextures = [];
    this.positionTextures = null;
    this.velocityTextures = null;
    this.forceTexture = null;
    this.colorTexture = null;
    /** @type {{aggregation?: WebGLProgram, reduction?: WebGLProgram, traversal?: WebGLProgram, velIntegrate?: WebGLProgram, posIntegrate?: WebGLProgram}} */
    this.programs = {};
    this.quadVAO = null;
    this.particleVAO = null;
    this.textureWidth = 0;
    this.textureHeight = 0;
    this.actualTextureSize = 0;
    this.numLevels = 0;
    this.L0Size = 0;
    this.octreeGridSize = 64;
    this.octreeSlicesPerRow = 8;
    this._disableFloatBlend = false;
    this._lastBoundsUpdateTime = -1;
    
    // GPU Profiler
    this.profiler = null;
    if (this.options.enableProfiling) {
      this.profiler = new GPUProfiler(gl);
    }
  }

  unbindAllTextures() {
    dbgUnbindAllTextures(this.gl);
  }

  /**
   * @param {string} tag
   */
  checkGl(tag) {
    return dbgCheckGl(this.gl, tag);
  }

  /**
   * @param {string} tag
   */
  checkFBO(tag) {
    dbgCheckFBO(this.gl, tag);
  }

  init() {
    let finished = false;
    try {
      this.checkWebGL2Support();
      this.calculateTextureDimensions();
      this.createShaderPrograms();
      this.createTextures();
      this.createGeometry_();
      this.uploadParticleData();
      
      // Restore GL state for THREE.js compatibility
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);
      
      finished = true;
    } finally {
      if (!finished)
        this.dispose();
    }
  }

  checkWebGL2Support() {
    const result = checkWebGL2Support(this.gl);
    this._disableFloatBlend = result.disableFloatBlend;
  }

  calculateTextureDimensions() {
    // Octree configuration: 64³ voxels with Z-slice stacking
    this.numLevels = 7; // 64 → 32 → 16 → 8 → 4 → 2 → 1
    this.L0Size = this.octreeGridSize * this.octreeSlicesPerRow;
    
    const maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    if (this.L0Size > maxTex) {
      throw new Error(`Octree L0 size ${this.L0Size} exceeds max texture size ${maxTex}`);
    }
    
    // Particle texture dimensions
    const dims = calculateParticleTextureDimensions(this.options.particleCount);
    this.textureWidth = dims.width;
    this.textureHeight = dims.height;
    this.actualTextureSize = dims.actualSize;
  }

  createShaderPrograms() {
    const gl = this.gl;
    
    this.programs.aggregation = createProgram(gl, aggregationVert, aggregationFrag);
    this.programs.reduction = createProgram(gl, fsQuadVert, reductionFrag);
    this.programs.traversal = createProgram(gl, fsQuadVert, traversalFrag);
    this.programs.velIntegrate = createProgram(gl, fsQuadVert, velIntegrateFrag);
    this.programs.posIntegrate = createProgram(gl, fsQuadVert, posIntegrateFrag);
  }

  createTextures() {
    const gl = this.gl;
    
    // Create individual 2D textures per level (legacy approach)
    let currentSize = this.L0Size;
    let currentGridSize = this.octreeGridSize;
    let currentSlicesPerRow = this.octreeSlicesPerRow;
    
    for (let i = 0; i < this.numLevels; i++) {
      // Create three textures per level for MRT (A0, A1, A2)
      const a0 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, a0);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, currentSize, currentSize, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      
      const a1 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, a1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, currentSize, currentSize, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      
      const a2 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, a2);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, currentSize, currentSize, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      
      // Create framebuffer with MRT attachments
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, a0, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, a1, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, a2, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      
      this.levelTargets.push({
        a0,
        a1,
        a2,
        size: currentSize,
        gridSize: currentGridSize,
        slicesPerRow: currentSlicesPerRow
      });
      this.levelFramebuffers.push(framebuffer);
      
      currentGridSize = Math.max(1, Math.floor(currentGridSize / 2));
      currentSlicesPerRow = Math.max(1, Math.floor(currentSlicesPerRow / 2));
      currentSize = currentGridSize * currentSlicesPerRow;
    }
    
    // Backward compatibility: levelTextures points to A0 attachment
    this.levelTextures = this.levelTargets.map(level => ({
      texture: level.a0,
      size: level.size,
      gridSize: level.gridSize,
      slicesPerRow: level.slicesPerRow
    }));
    
    // Create particle textures
    this.positionTextures = createPingPongTextures(gl, this.textureWidth, this.textureHeight);
    this.velocityTextures = createPingPongTextures(gl, this.textureWidth, this.textureHeight);
    this.forceTexture = createRenderTexture(gl, this.textureWidth, this.textureHeight);
    this.colorTexture = createRenderTexture(gl, this.textureWidth, this.textureHeight, gl.RGBA8, gl.UNSIGNED_BYTE);
  }

  createGeometry_() {
    const geo = createGeometry(this.gl, this.options.particleCount);
    this.quadVAO = geo.quadVAO;
    this.particleVAO = geo.particleVAO;
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
    const velData = velocities || new Float32Array(expectedLength);
    const colorData = colors || new Uint8Array(expectedLength).fill(255);
    
    const gl = this.gl;
    const pos0 = this.positionTextures?.textures[0];
    const pos1 = this.positionTextures?.textures[1];
    const vel0 = this.velocityTextures?.textures[0];
    const vel1 = this.velocityTextures?.textures[1];
    const colorTex = this.colorTexture?.texture;
    
    if (!pos0 || !pos1 || !vel0 || !vel1 || !colorTex) {
      throw new Error('Textures not initialized');
    }
    
    uploadTextureData(gl, pos0, positions, this.textureWidth, this.textureHeight);
    uploadTextureData(gl, pos1, positions, this.textureWidth, this.textureHeight);
    uploadTextureData(gl, vel0, velData, this.textureWidth, this.textureHeight);
    uploadTextureData(gl, vel1, velData, this.textureWidth, this.textureHeight);
    uploadTextureData(gl, colorTex, colorData, this.textureWidth, this.textureHeight, gl.RGBA, gl.UNSIGNED_BYTE);
  }

  step() {
    // Update profiler (collect completed query results)
    if (this.profiler) {
      this.profiler.update();
    }
    
    // Update world bounds infrequently (every 10 seconds)
    const now = performance.now ? performance.now() : Date.now();
    const updateIntervalMs = 10000;
    if (this._lastBoundsUpdateTime < 0 || (now - this._lastBoundsUpdateTime) >= updateIntervalMs) {
      try {
        pipelineUpdateBounds(this, 16);
      } catch (e) {
        console.warn('updateWorldBoundsFromTexture failed:', e);
      }
      this._lastBoundsUpdateTime = now;
    }
    
    // Standard Euler integration
    this.buildQuadtree();
    this.clearForceTexture();
    
    // Calculate forces
    if (this.profiler) this.profiler.begin('traversal');
    pipelineCalculateForces(this);
    if (this.profiler) this.profiler.end();
    
    // Integrate physics
    pipelineIntegratePhysics(this);
    
    this.frameCount++;
  }

  buildQuadtree() {
    const gl = this.gl;
    this.unbindAllTextures();

    // Clear all MRT attachments
    if (this.profiler) this.profiler.begin('octree_clear');
    for (let i = 0; i < this.numLevels; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.levelFramebuffers[i]);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      gl.viewport(0, 0, this.levelTargets[i].size, this.levelTargets[i].size);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (this.profiler) this.profiler.end();
    
    // Aggregate particles into L0
    if (this.profiler) this.profiler.begin('aggregation');
    aggregateL0(this);
    if (this.profiler) this.profiler.end();
    
    // Pyramid reduction
    if (this.profiler) this.profiler.begin('pyramid_reduction');
    for (let level = 0; level < this.numLevels - 1; level++) {
      pyramidReduce(this, level, level + 1);
    }
    if (this.profiler) this.profiler.end();
  }

  clearForceTexture() {
    const gl = this.gl;
    this.unbindAllTextures();
    const forceFBO = this.forceTexture?.framebuffer;
    if (!forceFBO) {
      throw new Error('Force texture framebuffer not initialized');
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, forceFBO);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, this.textureWidth, this.textureHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  getPositionTexture() {
    return this.positionTextures?.getCurrentTexture() || null;
  }
  
  getPositionTextures() {
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
   * @param {string} name
   */
  beginProfile(name) {
    if (this.profiler) {
      this.profiler.begin(name);
    }
  }

  endProfile() {
    if (this.profiler) {
      this.profiler.end();
    }
  }

  stats() {
    if (this.profiler) {
      return this.profiler.getAll();
    }
    return null;
  }

  dispose() {
    const gl = this.gl;
    
    // Clean up level textures
    this.levelTargets.forEach(level => {
      if (level.a0) gl.deleteTexture(level.a0);
      if (level.a1) gl.deleteTexture(level.a1);
      if (level.a2) gl.deleteTexture(level.a2);
    });
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
    
    if (this.profiler) {
      this.profiler.dispose();
      this.profiler = null;
    }
    
  }
}
