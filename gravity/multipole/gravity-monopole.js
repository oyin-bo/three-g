// @ts-check

/**
 * ParticleSystemMonopoleKernels - Kernel-based monopole particle system
 * 
 * Reimplementation using WebGL2 Kernel architecture from docs/8.1-multipole-migration.md.
 * Uses composition of small, testable kernels instead of monolithic pipeline.
 */

import { KIntegrateVelocity } from './k-integrate-velocity.js';
import { KIntegratePosition } from './k-integrate-position.js';
import { KAggregatorMonopole } from './k-aggregator-monopole.js';
import { KPyramidBuild } from './k-pyramid-build.js';
import { KTraversal } from './k-traversal.js';
import { KBoundsReduce } from './k-bounds-reduce.js';

export class GravityMonopole {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   particleData: { positions: Float32Array, velocities?: Float32Array|null },
   *   particleCount?: number,
   *   worldBounds?: { min: [number,number,number], max: [number,number,number] },
   *   theta?: number,
   *   dt?: number,
   *   gravityStrength?: number,
   *   softening?: number,
   *   damping?: number,
   *   maxSpeed?: number,
   *   maxAccel?: number
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    if (!options.particleData)
      throw new Error('ParticleSystemMonopoleKernels requires particleData with positions');

    const particleCount = options.particleData.positions.length / 4;

    this.worldBounds = options.worldBounds || { min: [-4, -4, -4], max: [4, 4, 4] };
    this.options = {
      particleCount,
      theta: options.theta || 0.5,
      dt: options.dt || 1 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.2,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.0
    };

    this.frameCount = 0;

    // Bounds update scheduling
    this.boundsUpdateInterval = 90;  // Update bounds every 90 frames (1.5 seconds at 60fps)
    this.lastBoundsUpdateFrame = -this.boundsUpdateInterval;  // Force initial update

    // Calculate texture dimensions
    this.textureWidth = Math.ceil(Math.sqrt(particleCount));
    this.textureHeight = Math.ceil(particleCount / this.textureWidth);
    this.actualTextureSize = this.textureWidth * this.textureHeight;

    // Octree configuration
    this.numLevels = 7;
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

    // Create textures:

    // Create position textures: public active texture and internal write target
    this.positionTexture = createTexture2D(this.gl, this.textureWidth, this.textureHeight);
    this.positionTextureWrite = createTexture2D(this.gl, this.textureWidth, this.textureHeight);

    // Create velocity textures: public active texture and internal write target
    this.velocityTexture = createTexture2D(this.gl, this.textureWidth, this.textureHeight);
    this.velocityTextureWrite = createTexture2D(this.gl, this.textureWidth, this.textureHeight);

    // Note: We intentionally do NOT create forceTexture or level textures here.
    // Kernels (aggregator/pyramid/traversal) are responsible for allocating
    // any internal textures or FBOs they need. The particle system only owns
    // the particle ping-pong textures (position/velocity) and the color
    // texture used for rendering.


    // Upload particle data
    const { positions, velocities } = options.particleData;

    const expectedLength = this.actualTextureSize * 4;
    if (positions.length !== expectedLength) {
      throw new Error(`Position data length mismatch: expected ${expectedLength}, got ${positions.length}`);
    }

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

    // Kernels are allowed to create and own their internal textures/FBOs unless
    // an explicit texture is passed in the options.
    // The particle system does not own
    // the particle ping-pong textures (positions/velocities),
    // instead it passes them into the kernels and let the kernels keep ownership.

    // Prepare levelConfigs (sizes for each pyramid level). We do NOT create
    // the A0/A1/A2 textures here; kernels will create their own resources.
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

    // Create aggregator kernel for L0. Do not pass concrete output textures;
    // let the kernel allocate them and expose them as properties (outA0/outA1/outA2).
    // Per kernel contract: omit options (don't pass null) to trigger creation.
    this.aggregatorKernel = new KAggregatorMonopole({
      gl: this.gl,
      inPosition: null,  // set per-frame before run
      // outA0/outA1/outA2 omitted - kernel will create them
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      octreeSize: this.L0Size,
      gridSize: this.octreeGridSize,
      slicesPerRow: this.octreeSlicesPerRow,
      worldBounds: this.worldBounds,
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
        // outA0/outA1/outA2 omitted - kernel will create them
        outSize: this.levelConfigs[i + 1].size,
        outGridSize: this.levelConfigs[i + 1].gridSize,
        outSlicesPerRow: this.levelConfigs[i + 1].slicesPerRow,
        // Pass actual input level dimensions (not guessed via doubling formula)
        inGridSize: this.levelConfigs[i].gridSize,
        inSlicesPerRow: this.levelConfigs[i].slicesPerRow
      }));
    }

    // Create traversal kernel. Omit outForce so kernel allocates it. Pass null for
    // inPosition (set per-frame). We'll wire inLevelA0 from pyramid outputs after build.
    this.traversalKernel = new KTraversal({
      gl: this.gl,
      inPosition: null,  // set per-frame
      inLevelA0: undefined,
      // outForce omitted - kernel will create it
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      numLevels: this.numLevels,
      levelConfigs: this.levelConfigs,
      worldBounds: this.worldBounds,
      theta: this.options.theta,
      gravityStrength: this.options.gravityStrength,
      softening: this.options.softening
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

    // Create reusable resources for bounds readback (hot path - no alloc/dealloc per frame)
    this.boundsReadbackBuffer = new Float32Array(8);
    this.boundsReadbackFBO = this.gl.createFramebuffer();
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
    this.aggregatorKernel.inPosition = this.positionTexture;
    this.aggregatorKernel.run();

    // Wire and run pyramid kernels sequentially. Each pyramid kernel owns
    // its outputs (outA0/outA1/outA2). We pass the previous-level outputs
    // as inputs to the next-level kernel.
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
      prevOut = { a0: kernel.outA0, a1: kernel.outA1, a2: kernel.outA2 };
    }
  }

  _calculateForces() {
    // Run tree traversal to compute forces

    // Build array of A0 textures per level (aggregator + pyramid outputs)
    const levelA0s = [];
    if (this.aggregatorKernel && this.aggregatorKernel.outA0) levelA0s.push(this.aggregatorKernel.outA0);
    for (const k of this.pyramidKernels) {
      if (k && k.outA0) levelA0s.push(k.outA0);
    }

    this.traversalKernel.inPosition = this.positionTexture;
    this.traversalKernel.inLevelA0 = levelA0s;
    this.traversalKernel.run();

    // Wire traversal result into velocity integrator
    if (this.velocityKernel) {
      this.velocityKernel.inForce = this.traversalKernel.outForce || null;
    }
  }

  _integratePhysics() {
    // Update velocities
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
   * Update world bounds from GPU reduction
   * Runs every boundsUpdateInterval frames to prevent particle escape.
   * Direct minimal readback: reads 2×1 RGBA32F texture (8 floats = 32 bytes)
   * Reuses pre-allocated FBO and buffer (no hot-path allocations)
   */
  _updateBounds() {
    if (!this.boundsKernel || !this.boundsKernel.outBounds) return;
    if (!this.positionTexture) return;

    // Run bounds reduction kernel
    this.boundsKernel.inPosition = this.positionTexture;
    this.boundsKernel.run();

    // Reuse pre-allocated FBO
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.boundsReadbackFBO);
    this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, this.boundsKernel.outBounds, 0);

    // Direct readback: 2×1 pixels, RGBA32F into pre-allocated buffer
    this.gl.readPixels(0, 0, 2, 1, this.gl.RGBA, this.gl.FLOAT, this.boundsReadbackBuffer);

    // Unbind FBO
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, null);

    this.worldBounds.min[0] = this.boundsReadbackBuffer[0];
    this.worldBounds.min[1] = this.boundsReadbackBuffer[1];
    this.worldBounds.min[2] = this.boundsReadbackBuffer[2];
    this.worldBounds.max[0] = this.boundsReadbackBuffer[4];
    this.worldBounds.max[1] = this.boundsReadbackBuffer[5];
    this.worldBounds.max[2] = this.boundsReadbackBuffer[6];
  }

  dispose() {
    // Dispose kernels
    if (this.aggregatorKernel) this.aggregatorKernel.dispose();
    if (this.pyramidKernels) this.pyramidKernels.forEach(k => k.dispose());
    if (this.traversalKernel) this.traversalKernel.dispose();
    if (this.velocityKernel) this.velocityKernel.dispose();
    if (this.positionKernel) this.positionKernel.dispose();
    if (this.boundsKernel) this.boundsKernel.dispose();

    // Clean up bounds readback resources
    if (this.boundsReadbackFBO) {
      this.gl.deleteFramebuffer(this.boundsReadbackFBO);
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
