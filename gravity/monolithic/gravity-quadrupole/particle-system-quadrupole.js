// @ts-check

/**
 * ParticleSystem Quadrupole - Barnes-Hut with Quadrupole Approximation
 * 
 * GPU-resident octree using WebGL2 fragment shaders for large-scale
 * particle simulation with O(N log N) complexity via Barnes-Hut algorithm.
 * Uses texture arrays and quadrupole moments for higher accuracy.
 * Includes KDK symplectic integrator and debug staging infrastructure.
 */

// Shader sources
import fsQuadVert from '../shaders/fullscreen.vert.js';
import reductionFrag from '../shaders/reduction.frag.js';
import reductionArrayFrag from '../shaders/reduction-array.frag.js';
import aggregationVert from '../shaders/aggregation.vert.js';
import aggregationFrag from '../shaders/aggregation.frag.js';
import traversalFrag from '../shaders/traversal.frag.js';
import traversalQuadrupoleFrag from '../shaders/traversal-quadrupole.frag.js';
import velIntegrateFrag from '../shaders/vel_integrate.frag.js';
import posIntegrateFrag from '../shaders/pos_integrate.frag.js';

// Force modules
import { LaplacianForceModuleMonolithic } from '../graph-laplacian/laplacian-force-module.js';

// Pipeline utilities
import { unbindAllTextures as dbgUnbindAllTextures, checkGl as dbgCheckGl, checkFBO as dbgCheckFBO } from '../utils/debug.js';
import { aggregateParticlesIntoL0 as aggregateL0 } from './aggregator.js';
import { runReductionPass as pyramidReduce } from './pyramid.js';
import { calculateForces as pipelineCalculateForces } from './traversal.js';
import { integratePhysics as pipelineIntegratePhysics } from '../utils/integrator.js';

import { updateWorldBoundsFromTexture as pipelineUpdateBounds } from '../utils/bounds.js';
import { createOccupancyMaskTextures, createOccupancyMaskArray, updateOccupancyMasks } from './occupancy.js';
import { GPUProfiler } from '../utils/gpu-profiler.js';

// Debug staging modules (Plan C)
import {
  runAggregationOnly,
  runReductionOnly,
  runTraversalOnly,
  runIntegratorOnly,
  runFullPipeline_Record,
  runFullPipeline_Replay
} from './debug/router.js';

export class ParticleSystemQuadrupoleMonolithic {

  /**
   * ParticleSystemQuadrupole constructor
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
      particleCount,
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
    /** @type {{a0: WebGLTexture, a1: WebGLTexture, a2: WebGLTexture, layer: number, size: number, gridSize: number, slicesPerRow: number}[]} */
    this.levelTargets = []; // Array of {a0, a1, a2, size, gridSize, slicesPerRow}
    /** @type {WebGLFramebuffer[]} */
    this.levelFramebuffers = []; // Array of framebuffers for MRT rendering
    /** @type {ReturnType<typeof this.createPingPongTextures>} */
    this.positionTextures = /** @type {*} */(null);
    this.velocityTextures = null;
    /** @type {{texture: WebGLTexture, framebuffer: WebGLFramebuffer}|null} */
    this.forceTexture = null;
    /** @type {{texture: WebGLTexture, framebuffer: WebGLFramebuffer}|null} */
    this.forceTexturePrev = null; // For KDK integrator (Plan C)
    this.colorTexture = null;
    /** @type {{aggregation?: WebGLProgram, reduction?: WebGLProgram, traversal?: WebGLProgram, velIntegrate?: WebGLProgram, posIntegrate?: WebGLProgram, traversalQuadrupole?: WebGLProgram|null, traversalQuadrupoleOccupancy?: WebGLProgram|null, reductionArray?: WebGLProgram|null}} */
    this.programs = {};

    // Quadrupole-specific: always use texture arrays and KDK integrator option
    this.textureMode = 'array';  // Always use texture arrays for quadrupole

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

    // Occupancy masks for traversal optimization (optional)
    this.occupancyMasks = null;  // Array of textures (one per level)
    this.occupancyMaskArray = null;  // 2D texture array (Plan C)
    this._occupancyMasksEnabled = false;
    this._lastOccupancyUpdateFrame = -1;
    this._occupancyFirstUpdateLogged = false;

    // GPU Profiler (created only if enabled)
    this.profiler = null;
    if (this.options.enableProfiling) {
      this.profiler = new GPUProfiler(gl);
    }

    // Debug state for staging (Plan C)
    this.debugMode = 'FullPipeline';
    /** @type {{useKDK?: boolean}} */
    this.debugFlags = {};

    // Laplacian force module for graph edges (auto-created if edges provided)
    this.laplacianModule = null;
    this.laplacianModuleOptions = null;
    // @ts-ignore - edges/springStrength added to options type above
    if (options.edges) {
      // Store options for lazy initialization in init()
      // @ts-ignore - edges/springStrength
      this.laplacianModuleOptions = {
        // @ts-ignore
        edges: options.edges,
        // @ts-ignore
        k: options.springStrength || 0.001
      };
    }

    let finished = false;
    try {
      this.checkWebGL2Support();
      this.calculateTextureDimensions();
      this.createShaderPrograms();
      this.createTextures();
      this.createGeometry();
      this.uploadParticleData();

      if (this.laplacianModuleOptions) {
        this.laplacianModule = new LaplacianForceModuleMonolithic(
          this.laplacianModuleOptions.edges,
          this.gl,
          {
            k: this.laplacianModuleOptions.k,
            //positionTextures: this.positionTextures.textures,
            textureWidth: this.textureWidth,
            textureHeight: this.textureHeight,
            particleCount: this.options.particleCount,
            disableFloatBlend: this._disableFloatBlend
          }
        );
      }

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

  // Debug helper: unbind all textures on commonly used units to avoid feedback loops
  unbindAllTextures() {
    dbgUnbindAllTextures(this.gl);
  }

  // Debug helper: log gl errors with a tag
  /**
   * @param {string} tag
   */
  checkGl(tag) {
    return dbgCheckGl(this.gl, tag);
  }

  // Debug helper: check FBO completeness and tag
  /**
   * @param {string} tag
   */
  checkFBO(tag) {
    dbgCheckFBO(this.gl, tag);
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

    // Compile quadrupole traversal shaders (always enabled for this class)
    try {
      // Compile both variants: with and without occupancy masking
      const quadShaderNoMask = traversalQuadrupoleFrag(false);
      const quadShaderWithMask = traversalQuadrupoleFrag(true);

      this.programs.traversalQuadrupole = this.createProgram(fsQuadVert, quadShaderNoMask);
      this.programs.traversalQuadrupoleOccupancy = this.createProgram(fsQuadVert, quadShaderWithMask);
    } catch (e) {
      console.warn('[ParticleSystem] Failed to compile quadrupole shader, falling back to monopole:', e);
      this.programs.traversalQuadrupole = null;
      this.programs.traversalQuadrupoleOccupancy = null;
    }

    try {
      this.programs.reductionArray = this.createProgram(fsQuadVert, reductionArrayFrag);
    } catch (e) {
      console.warn('[ParticleSystem] Failed to compile reduction array shader, falling back to standard:', e);
      this.programs.reductionArray = null;
    }
  }

  /**
   * @param {string} vertexSource
   * @param {string} fragmentSource
   * @returns {WebGLProgram}
   */
  createProgram(vertexSource, fragmentSource) {
    const gl = this.gl;

    const vertexShader = this.createShader(gl.VERTEX_SHADER, vertexSource);
    const fragmentShader = this.createShader(gl.FRAGMENT_SHADER, fragmentSource);

    if (!vertexShader || !fragmentShader) {
      throw new Error('Failed to create shaders');
    }

    const program = gl.createProgram();
    if (!program) {
      throw new Error('Failed to create program');
    }

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

  /**
   * @param {number} type
   * @param {string} source
   * @returns {WebGLShader|null}
   */
  createShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    if (!shader) return null;

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

    this.levelTargets = [];
    this.levelFramebuffers = [];

    // Quadrupole mode: use texture arrays instead of individual textures
    // This reduces texture unit usage from 24 (8 levels × 3 attachments) to 3
    // Create 3 texture arrays (A0, A1, A2), each with 8 layers for 8 levels
    const maxSize = this.L0Size; // Use L0 size for all layers

    // Create A0 array (monopole moments: Σ(m·x), Σ(m·y), Σ(m·z), Σm)
    this.levelTextureArrayA0 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA0);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA32F, maxSize, maxSize, 8, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Create A1 array (second moments: Σ(m·x²), Σ(m·y²), Σ(m·z²), Σ(m·xy))
    this.levelTextureArrayA1 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA32F, maxSize, maxSize, 8, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Create A2 array (second moments: Σ(m·xz), Σ(m·yz), 0, 0)
    this.levelTextureArrayA2 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA2);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA32F, maxSize, maxSize, 8, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Create per-level 2D render textures (one triple per level) and framebuffers.
    // We'll render into small 2D textures to avoid feedback loops, then copy each
    // rendered color attachment into the corresponding layer of the large texture arrays
    // using copyTexSubImage3D. This preserves the low texture-unit footprint while
    // avoiding sampling from a texture that's currently bound to the draw framebuffer.
    let currentSize = this.L0Size;
    let currentGridSize = this.octreeGridSize;
    let currentSlicesPerRow = this.octreeSlicesPerRow;

    for (let i = 0; i < this.numLevels; i++) {
      // Create three 2D render textures (A0,A1,A2) per level
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

      // Create framebuffer with MRT attachments bound to the 2D textures
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
        layer: i,
        size: currentSize,
        gridSize: /** @type {number} */ (currentGridSize),
        slicesPerRow: /** @type {number} */ (currentSlicesPerRow)
      });
      this.levelFramebuffers.push(framebuffer);

      currentGridSize = Math.max(1, Math.floor(/** @type {number} */(currentGridSize) / 2));
      currentSlicesPerRow = Math.max(1, Math.floor(/** @type {number} */(currentSlicesPerRow) / 2));
      currentSize = currentGridSize * currentSlicesPerRow;
    }

    // Backward compatibility: levelTextures points to per-level A0 attachments
    this.levelTextures = this.levelTargets.map(level => ({
      texture: level.a0,
      size: level.size,
      gridSize: level.gridSize,
      slicesPerRow: level.slicesPerRow,
      layer: level.layer
    }));

    // Create occupancy masks for traversal optimization
    this.occupancyMasks = createOccupancyMaskTextures(gl, this.numLevels, this.levelTargets);
    this.occupancyMaskArray = createOccupancyMaskArray(gl, this.numLevels, this.levelTargets);
    this._occupancyMasksEnabled = true;  // ENABLED - using shader variants

    this.positionTextures = this.createPingPongTextures(this.textureWidth, this.textureHeight);
    this.velocityTextures = this.createPingPongTextures(this.textureWidth, this.textureHeight);
    this.forceTexture = this.createRenderTexture(this.textureWidth, this.textureHeight);
    this.forceTexturePrev = this.createRenderTexture(this.textureWidth, this.textureHeight);
    this.colorTexture = this.createRenderTexture(this.textureWidth, this.textureHeight, gl.RGBA8, gl.UNSIGNED_BYTE);
  }

  /**
   * @param {number} width
   * @param {number} height
   */
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
      getCurrentTexture: function () { return this.textures[this.currentIndex]; },
      getTargetTexture: function () { return this.textures[1 - this.currentIndex]; },
      getTargetFramebuffer: function () { return this.framebuffers[1 - this.currentIndex]; },
      swap: function () { this.currentIndex = 1 - this.currentIndex; }
    };
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {number} [internalFormat]
   * @param {number} [type]
   */
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
      -1, -1, 1, -1, -1, 1, 1, 1
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
    const expectedLength = (this.actualTextureSize || 0) * 4;
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

    if (this.positionTextures) {
      this.uploadTextureData(this.positionTextures.textures[0], positions);
      this.uploadTextureData(this.positionTextures.textures[1], positions);
    }
    if (this.velocityTextures) {
      this.uploadTextureData(this.velocityTextures.textures[0], velData);
      this.uploadTextureData(this.velocityTextures.textures[1], velData);
    }
    if (this.colorTexture) {
      this.uploadTextureData(this.colorTexture.texture, colorData, this.gl.RGBA, this.gl.UNSIGNED_BYTE);
    }
  }

  /**
   * @param {WebGLTexture} texture
   * @param {Float32Array|Uint8Array} data
   * @param {number} [format]
   * @param {number} [type]
   */
  uploadTextureData(texture, data, format = this.gl.RGBA, type = this.gl.FLOAT) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, format, type, data);
  }

  step() {
    // Update profiler (collect completed query results)
    if (this.profiler) {
      this.profiler.update();
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

    // Use KDK integrator if useKDK flag is set
    const useKDK = this.debugFlags.useKDK || false;

    if (useKDK) {
      this.step_KDK();
    } else {
      // Standard Euler integration
      this.buildQuadtree();
      this.clearForceTexture();

      // Profile force calculation
      if (this.profiler) this.profiler.begin('traversal');
      pipelineCalculateForces(this);
      if (this.profiler) this.profiler.end();

      // Profile integration (split into velocity + position for granularity)
      pipelineIntegratePhysics(this);
    }

    this.frameCount++;
  }

  /**
   * KDK (Kick-Drift-Kick) symplectic integrator (Plan C)
   * Provides better energy conservation than Euler
   */
  step_KDK() {
    // 1) First half-kick using previous frame's forces
    if (this.profiler) this.profiler.begin('kick_1');
    if (this.forceTexture) this.kick(0.5, this.forceTexture);
    if (this.profiler) this.profiler.end();

    // 2) Drift positions with full timestep
    if (this.profiler) this.profiler.begin('drift');
    this.drift(1.0);
    if (this.profiler) this.profiler.end();

    // 3) Rebuild quadtree at new positions and compute current forces
    this.buildQuadtree();

    if (this.profiler) this.profiler.begin('traversal');
    // Store new forces in forceTexturePrev (will become "current" after swap)
    if (this.forceTexturePrev) {
      this.clearForceTexture(this.forceTexturePrev);
      this.accumulateForces(this.forceTexturePrev);
    }
    if (this.profiler) this.profiler.end();

    // 4) Second half-kick using newly computed forces
    if (this.profiler) this.profiler.begin('kick_2');
    if (this.forceTexturePrev) this.kick(0.5, this.forceTexturePrev);
    if (this.profiler) this.profiler.end();

    // 5) Swap force textures (current becomes previous for next frame)
    const temp = this.forceTexture;
    this.forceTexture = this.forceTexturePrev;
    this.forceTexturePrev = temp;
  }

  /**
   * Kick: update velocities from forces
   * @param {number} dtScale - Fraction of timestep (0.5 for half-kick)
   * @param {{texture: WebGLTexture, framebuffer: WebGLFramebuffer}} forceTex - Force texture to use
   */
  kick(dtScale, forceTex) {
    const gl = this.gl;
    const prog = this.programs.velIntegrate;
    if (!prog) return;

    gl.useProgram(prog);
    this.unbindAllTextures();

    // Bind target framebuffer (ping-pong)
    const targetFBO = this.velocityTextures?.getTargetFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO || null);
    gl.viewport(0, 0, this.textureWidth, this.textureHeight);

    // Bind current velocity
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.velocityTextures?.getCurrentTexture() || null);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_velocity'), 0);

    // Bind force texture
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, forceTex.texture);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_force'), 1);

    // Bind current position (for mass)
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.positionTextures?.getCurrentTexture() || null);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_position'), 2);

    // Uniforms (scaled dt)
    const effectiveDt = this.options.dt * dtScale;
    gl.uniform1f(gl.getUniformLocation(prog, 'u_dt'), effectiveDt);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_damping'), this.options.damping);
    gl.uniform1f(gl.getUniformLocation(prog, 'u_maxSpeed'), this.options.maxSpeed);

    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // Swap velocity buffers
    this.velocityTextures?.swap();

    this.unbindAllTextures();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Drift: update positions from velocities
   * @param {number} dtScale - Fraction of timestep (usually 1.0)
   */
  drift(dtScale) {
    const gl = this.gl;
    const prog = this.programs.posIntegrate;
    if (!prog) return;

    gl.useProgram(prog);
    this.unbindAllTextures();

    // Bind target framebuffer (ping-pong)
    const targetFBO = this.positionTextures?.getTargetFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO || null);
    gl.viewport(0, 0, this.textureWidth, this.textureHeight);

    // Bind current position
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.positionTextures?.getCurrentTexture() || null);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_position'), 0);

    // Bind current velocity
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.velocityTextures?.getCurrentTexture() || null);
    gl.uniform1i(gl.getUniformLocation(prog, 'u_velocity'), 1);

    // Uniforms (scaled dt)
    const effectiveDt = this.options.dt * dtScale;
    gl.uniform1f(gl.getUniformLocation(prog, 'u_dt'), effectiveDt);

    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // Swap position buffers
    this.positionTextures?.swap();

    this.unbindAllTextures();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Accumulate forces into specified texture
   * @param {{texture: WebGLTexture, framebuffer: WebGLFramebuffer}} forceTex - Target force texture
   */
  accumulateForces(forceTex) {
    // Temporarily swap forceTexture to accumulate into target
    const originalForce = this.forceTexture;
    this.forceTexture = forceTex;

    // Accumulate gravity forces from quadtree traversal
    pipelineCalculateForces(this);

    // Accumulate forces from external modules (e.g., springs, edges)
    if (this.laplacianModule) {
      this.laplacianModule.accumulate({
        gl: this.gl,
        targetForce: forceTex,
        positionTextures: this.positionTextures.textures,
        currentIndex: this.positionTextures.currentIndex,
        textureSize: {
          width: this.textureWidth,
          height: this.textureHeight
        },
        dt: this.options.dt
      });
    }

    this.forceTexture = originalForce;
  }

  buildQuadtree() {
    const gl = this.gl;
    this.unbindAllTextures();

    // Profile octree clear (clear all MRT attachments)
    if (this.profiler) this.profiler.begin('octree_clear');
    for (let i = 0; i < this.numLevels; i++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.levelFramebuffers[i]);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      gl.viewport(0, 0, this.levelTargets[i].size, this.levelTargets[i].size);
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

    // Update occupancy masks for traversal optimization
    // Only update every 4 frames to reduce CPU readback overhead
    if (this._occupancyMasksEnabled && this.frameCount % 4 === 0) {
      updateOccupancyMasks(this.gl, this);
    }
  }

  /**
   * Clear force texture
   * @param {{texture: WebGLTexture, framebuffer: WebGLFramebuffer}|null} [forceTex] - Optional force texture to clear (defaults to this.forceTexture)
   */
  clearForceTexture(forceTex = null) {
    const target = forceTex || this.forceTexture;
    if (!target) return;

    const gl = this.gl;
    this.unbindAllTextures();
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
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
    // Returns BOTH textures for ping-pong
    return this.positionTextures?.textures || [];
  }

  getCurrentIndex() {
    return this.positionTextures?.currentIndex || 0;
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

  /**
   * Set debug mode for stage isolation (Plan C)
   * @param {string} mode - 'FullPipeline'|'AggregateOnly'|'ReduceOnly'|'TraverseOnly'|'IntegrateOnly'|'Record'|'Replay'
   */
  setDebugMode(mode) {
    this.debugMode = mode;
  }

  /**
   * Set debug flags for staging workflow (Plan C)
   * @param {object} flags - Debug flags object
   */
  setDebugFlags(flags) {
    this.debugFlags = { ...this.debugFlags, ...flags };
  }

  /**
   * Execute step with debug routing (Plan C staging)
   */
  step_Debug() {
    // Update profiler if enabled
    if (this.profiler) {
      this.profiler.update();
    }

    switch (this.debugMode) {
      case 'FullPipeline':
        this.step();
        break;

      case 'AggregateOnly':
        runAggregationOnly(this);
        break;

      case 'ReduceOnly':
        runReductionOnly(this);
        break;

      case 'TraverseOnly':
        runTraversalOnly(this);
        break;

      case 'IntegrateOnly':
        runIntegratorOnly(this);
        break;

      case 'Record':
        runFullPipeline_Record(this);
        break;

      case 'Replay':
        runFullPipeline_Replay(this);
        break;

      default:
        console.warn(`[ParticleSystem] Unknown debug mode: ${this.debugMode}, falling back to FullPipeline`);
        this.step();
    }

    this.frameCount++;
  }

  dispose() {
    const gl = this.gl;

    // Clean up MRT level textures (A0, A1, A2)
    if (this.levelTextureArrayA0) {
      // Plan C: delete texture arrays
      gl.deleteTexture(this.levelTextureArrayA0);
      if (this.levelTextureArrayA1) gl.deleteTexture(this.levelTextureArrayA1);
      if (this.levelTextureArrayA2) gl.deleteTexture(this.levelTextureArrayA2);
    } else {
      // Non-Plan-C: delete individual textures
      this.levelTargets.forEach(level => {
        if (level.a0) gl.deleteTexture(level.a0);
        if (level.a1) gl.deleteTexture(level.a1);
        if (level.a2) gl.deleteTexture(level.a2);
      });
    }
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
    if (this.forceTexturePrev) {
      gl.deleteTexture(this.forceTexturePrev.texture);
      gl.deleteFramebuffer(this.forceTexturePrev.framebuffer);
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

    // Dispose external force modules
    if (this.laplacianModule) {
      this.laplacianModule.dispose();
      this.laplacianModule = null;
    }

  }
}
