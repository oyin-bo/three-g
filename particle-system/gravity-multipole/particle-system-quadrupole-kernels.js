// @ts-check

/**
 * ParticleSystemQuadrupoleKernels - Kernel-based quadrupole particle system
 * 
 * Reimplementation using WebGL2 Kernel architecture from docs/8.1-multipole-migration.md.
 * Uses composition of small, testable kernels instead of monolithic pipeline.
 * Extends monopole with quadrupole moments (A1, A2) for higher accuracy.
 */

import { KIntegrateVelocity } from './k-integrate-velocity.js';
import { KIntegratePosition } from './k-integrate-position.js';
import { KAggregatorQuadrupole } from './k-aggregator-quadrupole.js';
import { KPyramidBuild } from './k-pyramid-build.js';
import { KTraversalQuadrupole } from './k-traversal-quadrupole.js';
import { KBoundsReduce } from './k-bounds-reduce.js';

export class ParticleSystemQuadrupoleKernels {
  /**
   * @param {{
   *  gl: WebGL2RenderingContext,
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
   *   useOccupancyMasks?: boolean
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    if (!(this.gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystemQuadrupoleKernels requires WebGL2RenderingContext');
    }

    if (!options.particleData) {
      throw new Error('ParticleSystemQuadrupoleKernels requires particleData with positions');
    }

    const particleCount = options.particleData.positions.length / 4;

    this.options = {
      particleCount,
      worldBounds: options.worldBounds || { min: [-4, -4, 0], max: [4, 4, 2] },
      theta: options.theta || 0.5,
      dt: options.dt || 1 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.2,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.0,
      useOccupancyMasks: options.useOccupancyMasks !== undefined ? options.useOccupancyMasks : false
    };

    this.particleData = options.particleData;
    this.frameCount = 0;

    // Bounds update scheduling
    this.boundsUpdateInterval = 90;  // Update bounds every 90 frames (1.5 seconds at 60fps)
    this.lastBoundsUpdateFrame = -this.boundsUpdateInterval;  // Force initial update

    // Calculate texture dimensions
    this.textureWidth = Math.ceil(Math.sqrt(particleCount));
    this.textureHeight = Math.ceil(particleCount / this.textureWidth);
    this.actualTextureSize = this.textureWidth * this.textureHeight;

    // Octree configuration
    // CRITICAL: Limited to 4 levels due to WebGL2 texture unit constraint (16 max)
    // Each level needs 3 samplers (A0, A1, A2), so 4 levels = 12 units (safe margin)
    this.numLevels = 4;
    this.octreeGridSize = 64;
    this.octreeSlicesPerRow = 8;
    this.L0Size = this.octreeGridSize * this.octreeSlicesPerRow;

    // Check WebGL2 support
    const colorBufferFloat = this.gl.getExtension('EXT_color_buffer_float');
    if (!colorBufferFloat)
      throw new Error('EXT_color_buffer_float extension not supported');

    const floatBlend = this.gl.getExtension('EXT_float_blend');
    this.disableFloatBlend = !floatBlend;
    if (!floatBlend)
      console.warn('EXT_float_blend not supported: reduced accumulation accuracy');

  // Declare texture slots (nullable for lifecycle)
  /** @type {WebGLTexture|null} */ this.positionTexture = null;
  /** @type {WebGLTexture|null} */ this.positionTextureWrite = null;
  /** @type {WebGLTexture|null} */ this.velocityTexture = null;
  /** @type {WebGLTexture|null} */ this.velocityTextureWrite = null;
  /** @type {WebGLTexture|null} */ this.levelTextureArrayA0 = null;
  /** @type {WebGLTexture|null} */ this.levelTextureArrayA1 = null;
  /** @type {WebGLTexture|null} */ this.levelTextureArrayA2 = null;

    // Create position textures: public active texture and internal write target
    this.positionTexture = createTexture2D(this.gl, this.textureWidth, this.textureHeight);
    this.positionTextureWrite = createTexture2D(this.gl, this.textureWidth, this.textureHeight);

    // Create velocity textures: public active texture and internal write target
    this.velocityTexture = createTexture2D(this.gl, this.textureWidth, this.textureHeight);
    this.velocityTextureWrite = createTexture2D(this.gl, this.textureWidth, this.textureHeight);

    // Upload particle data
    const { positions, velocities } = this.particleData;

    const expectedLength = this.actualTextureSize * 4;
    if (positions.length !== expectedLength)
      throw new Error(`Position data length mismatch: expected ${expectedLength}, got ${positions.length}`);

    const velData = velocities || new Float32Array(expectedLength);

    // Sanity checks to satisfy @ts-check and ensure textures were created
    if (!this.positionTexture)
      throw new Error('Position textures not initialized');
    if (!this.velocityTexture)
      throw new Error('Velocity textures not initialized');

    // Upload positions into both active and write textures so first-frame reads are valid
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.positionTexture);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, this.gl.RGBA, this.gl.FLOAT, positions);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.positionTextureWrite);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, this.gl.RGBA, this.gl.FLOAT, positions);

    // Upload velocities into both active and write textures
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.velocityTexture);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, this.gl.RGBA, this.gl.FLOAT, velData);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.velocityTextureWrite);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, this.gl.RGBA, this.gl.FLOAT, velData);

    this.gl.bindTexture(this.gl.TEXTURE_2D, null);

    // Prepare levelConfigs (sizes for each pyramid level)
    this.levelConfigs = [];
    let currentSize = this.L0Size;
    let currentGridSize = this.octreeGridSize;
    let currentSlicesPerRow = this.octreeSlicesPerRow;
    for (let i = 0; i < this.numLevels; i++) {
      this.levelConfigs.push({
        size: currentSize,
        gridSize: currentGridSize,
        slicesPerRow: currentSlicesPerRow
      });

      currentGridSize = Math.max(1, Math.floor(currentGridSize / 2));
      currentSlicesPerRow = Math.max(1, Math.floor(currentSlicesPerRow / 2));
      currentSize = currentGridSize * currentSlicesPerRow;
    }

    // Create texture arrays for all pyramid levels (A0, A1, A2)
    // Each layer has its own size from levelConfigs. We allocate with the max size
    // to ensure all layers fit, but we must copy only the appropriate region per layer.
    const gl = this.gl;
    const maxSize = this.L0Size; // Maximum size for array allocation

    // Create A0 array (monopole moments: Σ(m·x), Σ(m·y), Σ(m·z), Σm)
    this.levelTextureArrayA0 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA0);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA32F, maxSize, maxSize, this.numLevels, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Create A1 array (second moments: Σ(m·x²), Σ(m·y²), Σ(m·z²), Σ(m·xy))
    this.levelTextureArrayA1 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA1);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA32F, maxSize, maxSize, this.numLevels, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Create A2 array (second moments: Σ(m·xz), Σ(m·yz), 0, 0)
    this.levelTextureArrayA2 = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA2);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.RGBA32F, maxSize, maxSize, this.numLevels, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);

    // Create quadrupole aggregator kernel for L0 with occupancy support.
    // Let the kernel allocate output textures (outA0/outA1/outA2/outOccupancy).
    this.aggregatorKernel = new KAggregatorQuadrupole({
      gl: this.gl,
      inPosition: null,  // set per-frame before run
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      octreeSize: this.L0Size,
      gridSize: this.octreeGridSize,
      slicesPerRow: this.octreeSlicesPerRow,
      worldBounds: this.options.worldBounds,
      disableFloatBlend: this.disableFloatBlend
    });

    // Create pyramid build kernels for each reduction level. Per kernel contract,
    // omit output texture options so kernels allocate their own. Pass null for
    // inputs since they will be wired at runtime from previous-level outputs.
    this.pyramidKernels = [];
    for (let i = 0; i < this.numLevels - 1; i++) {
      this.pyramidKernels.push(new KPyramidBuild({
        gl: this.gl,
        inA0: null,
        inA1: null,
        inA2: null,
        outSize: this.levelConfigs[i + 1].size,
        outGridSize: this.levelConfigs[i + 1].gridSize,
        outSlicesPerRow: this.levelConfigs[i + 1].slicesPerRow,
        inGridSize: this.levelConfigs[i].gridSize,
        inSlicesPerRow: this.levelConfigs[i].slicesPerRow
      }));
    }

    // Create quadrupole traversal kernel. Omit outForce so kernel allocates it.
    // Pass null for inPosition (set per-frame). Texture arrays will be wired per-frame.
    // Occupancy texture will be wired from aggregator output.
    this.traversalKernel = new KTraversalQuadrupole({
      gl: this.gl,
      inPosition: null,  // set per-frame
      inLevelsA0: null,  // set per-frame from texture arrays
      inLevelsA1: null,  // set per-frame from texture arrays
      inLevelsA2: null,  // set per-frame from texture arrays
      inOccupancy: null,  // set per-frame from aggregator
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      numLevels: this.numLevels,
      levelConfigs: this.levelConfigs,
      worldBounds: this.options.worldBounds,
      theta: this.options.theta,
      gravityStrength: this.options.gravityStrength,
      softening: this.options.softening,
      useOccupancyMasks: this.options.useOccupancyMasks
    });

    // Create integrator kernels. These kernels will accept external ping-pong
    // textures (positions/velocities) each frame and write to targets; we do
    // not force them to own the system-level ping-pong textures.
    this.velocityKernel = new KIntegrateVelocity({
      gl: this.gl,
      inVelocity: null,
      inForce: null,
      inPosition: null,
      outVelocity: null,
      width: this.textureWidth,
      height: this.textureHeight,
      dt: this.options.dt,
      damping: this.options.damping,
      maxSpeed: this.options.maxSpeed,
      maxAccel: this.options.maxAccel
    });

    this.positionKernel = new KIntegratePosition({
      gl: this.gl,
      inPosition: null,
      inVelocity: null,
      outPosition: null,
      width: this.textureWidth,
      height: this.textureHeight,
      dt: this.options.dt
    });

    // Create bounds reduction kernel for GPU-resident dynamic bounds updates
    this.boundsKernel = new KBoundsReduce({
      gl: this.gl,
      inPosition: null,  // set per-run
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      particleCount: this.options.particleCount
    });
  }

  /**
   * Step the simulation forward one frame
   */
  step() {
    // 0. Update world bounds (scheduled every N frames)
    const framesSinceLastUpdate = this.frameCount - this.lastBoundsUpdateFrame;
    if (framesSinceLastUpdate >= this.boundsUpdateInterval) {
      this._updateBounds();
      this.lastBoundsUpdateFrame = this.frameCount;
    }

    // 1. Build octree
    this._buildOctree();

    // 2. Calculate forces
    this._calculateForces();

    // 3. Integrate physics
    this._integratePhysics();

    this.frameCount++;
  }

  _buildOctree() {
    // Aggregate particles into L0
    if (!this.aggregatorKernel) throw new Error('Aggregator kernel missing');
    if (!this.positionTexture) throw new Error('Position texture missing');

    this.aggregatorKernel.inPosition = this.positionTexture;
    // Wire bounds texture if available (after first bounds update)
    if (this.boundsKernel?.outBounds) {
      this.aggregatorKernel.inBounds = this.boundsKernel.outBounds;
    }
    this.aggregatorKernel.run();

    // Copy aggregator MRT outputs to texture array layer 0
    this._copyToArrayLayer(0, this.aggregatorKernel);

    // Wire and run pyramid kernels sequentially
    let prevOut = {
      a0: this.aggregatorKernel.outA0,
      a1: this.aggregatorKernel.outA1,
      a2: this.aggregatorKernel.outA2
    };

    for (let i = 0; i < this.pyramidKernels.length; i++) {
      const kernel = this.pyramidKernels[i];
      if (!kernel) continue;
      kernel.inA0 = prevOut.a0;
      kernel.inA1 = prevOut.a1;
      kernel.inA2 = prevOut.a2;
      kernel.run();

      // Copy pyramid output to array layer (i+1 since layer 0 is L0)
      this._copyToArrayLayer(i + 1, kernel);

      prevOut = { a0: kernel.outA0, a1: kernel.outA1, a2: kernel.outA2 };
    }
  }

  /**
   * Copy MRT outputs to texture array layer using copyTexSubImage3D
   * @param {number} layer - Target layer index in texture arrays
   * @param {any} kernel - Kernel with outFramebuffer and outA0/A1/A2 textures
   */
  _copyToArrayLayer(layer, kernel) {
    const gl = this.gl;
    const config = this.levelConfigs[layer];

    // Compute the actual texture dimensions used by the kernel
    // based on gridSize and slicesPerRow (NOT the flattened size)
    const gridSize = config.gridSize;
    const slicesPerRow = config.slicesPerRow;
    const width = gridSize * slicesPerRow;
    const sliceRows = Math.ceil(gridSize / slicesPerRow);
    const height = gridSize * sliceRows;

    // Bind the kernel's output framebuffer for reading (explicit READ target)
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, kernel.outFramebuffer);
    const status = gl.checkFramebufferStatus(gl.READ_FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      throw new Error(`_copyToArrayLayer: source framebuffer incomplete (status=${status})`);
    }

    // Copy COLOR_ATTACHMENT0 -> levelTextureArrayA0[layer]
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA0);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, width, height);
    {
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error(`_copyToArrayLayer: copy A0 failed (glError=${err})`);
    }

    // Copy COLOR_ATTACHMENT1 -> levelTextureArrayA1[layer]
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA1);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, width, height);
    {
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error(`_copyToArrayLayer: copy A1 failed (glError=${err})`);
    }

    // Copy COLOR_ATTACHMENT2 -> levelTextureArrayA2[layer]
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.levelTextureArrayA2);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, 0, 0, width, height);
    {
      const err = gl.getError();
      if (err !== gl.NO_ERROR) throw new Error(`_copyToArrayLayer: copy A2 failed (glError=${err})`);
    }

    // Reset read buffer and unbind
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  }

  _calculateForces() {
    // Run tree traversal to compute forces using quadrupole moments
    if (!this.traversalKernel) throw new Error('Traversal kernel missing');
    if (!this.positionTexture) throw new Error('Position texture missing');

    // Wire texture arrays to traversal (all levels in 3 arrays)
    this.traversalKernel.inPosition = this.positionTexture;
    this.traversalKernel.inLevelsA0 = this.levelTextureArrayA0;
    this.traversalKernel.inLevelsA1 = this.levelTextureArrayA1;
    this.traversalKernel.inLevelsA2 = this.levelTextureArrayA2;

    // Wire bounds texture if available (after first bounds update)
    if (this.boundsKernel?.outBounds) {
      this.traversalKernel.inBounds = this.boundsKernel.outBounds;
    }

    // Wire occupancy from aggregator L0 (only L0 occupancy needed for traversal)
    if (this.options.useOccupancyMasks && this.aggregatorKernel?.outOccupancy) {
      this.traversalKernel.inOccupancy = this.aggregatorKernel.outOccupancy;
    }

    this.traversalKernel.run();

    // Wire traversal result into velocity integrator
    if (this.velocityKernel) {
      this.velocityKernel.inForce = this.traversalKernel.outForce || null;
    }
  }

  _integratePhysics() {
    // Update velocities
    if (!this.velocityKernel) throw new Error('Velocity kernel missing');
    if (!this.velocityTexture || !this.positionTexture) throw new Error('Textures missing');

    this.velocityKernel.inVelocity = this.velocityTexture;
    this.velocityKernel.inPosition = this.positionTexture;
    this.velocityKernel.outVelocity = this.velocityTextureWrite;
    this.velocityKernel.run();

    // Swap velocity textures: write becomes active
    {
      const tmp = this.velocityTexture;
      this.velocityTexture = this.velocityTextureWrite;
      this.velocityTextureWrite = tmp;
    }

    // Update positions
    if (!this.positionKernel) throw new Error('Position kernel missing');

    this.positionKernel.inPosition = this.positionTexture;
    this.positionKernel.inVelocity = this.velocityTexture;
    this.positionKernel.outPosition = this.positionTextureWrite;
    this.positionKernel.run();

    // Swap position textures: write becomes active
    {
      const tmp = this.positionTexture;
      this.positionTexture = this.positionTextureWrite;
      this.positionTextureWrite = tmp;
    }
  }

  /**
   * Update world bounds from GPU reduction (Phase 1 complete)
   * Runs every boundsUpdateInterval frames to prevent particle escape.
   * Bounds stay GPU-resident in boundsKernel.outBounds texture.
   * No CPU readback - kernels sample the texture directly.
   */
  _updateBounds() {
    if (!this.boundsKernel || !this.positionTexture) return;

    // Run GPU reduction to compute bounds (stays GPU-resident in boundsKernel.outBounds)
    this.boundsKernel.inPosition = this.positionTexture;
    this.boundsKernel.run();

    // Bounds texture is now updated and ready for kernels to sample
    // No CPU readback needed - aggregator/traversal will sample boundsKernel.outBounds directly
  }

  dispose() {
    const gl = this.gl;

    // Dispose kernels
    if (this.aggregatorKernel) this.aggregatorKernel.dispose();
    if (this.pyramidKernels) this.pyramidKernels.forEach(k => k.dispose());
    if (this.traversalKernel) this.traversalKernel.dispose();
    if (this.velocityKernel) this.velocityKernel.dispose();
    if (this.positionKernel) this.positionKernel.dispose();
    if (this.boundsKernel) this.boundsKernel.dispose();

    // Clean up textures
    if (this.positionTexture) {
      gl.deleteTexture(this.positionTexture);
      this.positionTexture = null;
    }
    if (this.positionTextureWrite) {
      gl.deleteTexture(this.positionTextureWrite);
      this.positionTextureWrite = null;
    }
    if (this.velocityTexture) {
      gl.deleteTexture(this.velocityTexture);
      this.velocityTexture = null;
    }
    if (this.velocityTextureWrite) {
      gl.deleteTexture(this.velocityTextureWrite);
      this.velocityTextureWrite = null;
    }

    // Clean up texture arrays
    if (this.levelTextureArrayA0) {
      gl.deleteTexture(this.levelTextureArrayA0);
      this.levelTextureArrayA0 = null;
    }
    if (this.levelTextureArrayA1) {
      gl.deleteTexture(this.levelTextureArrayA1);
      this.levelTextureArrayA1 = null;
    }
    if (this.levelTextureArrayA2) {
      gl.deleteTexture(this.levelTextureArrayA2);
      this.levelTextureArrayA2 = null;
    }
  }
}

/**
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @param {number} [internalFormat]
 * @param {number} [type]
 */
function createTexture2D(gl, width, height, internalFormat, type) {
  const fmt = internalFormat || gl.RGBA32F;
  const tp = type || gl.FLOAT;

  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt, width, height, 0, gl.RGBA, tp, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}
