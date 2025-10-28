// @ts-check

/**
 * ParticleSystemMonopoleKernels - Kernel-based monopole particle system
 * 
 * Texture-first architecture per docs/11-lowering-level.md.
 * Operates purely on GPU textures; no CPU particle data handling.
 * Uses composition of small, testable kernels instead of monolithic pipeline.
 */

import { KAggregatorMonopole } from './k-aggregator-monopole.js';
import { KBoundsReduce } from './k-bounds-reduce.js';
import { KIntegrateEuler } from './k-integrate-euler.js';
import { KPyramidBuild } from './k-pyramid-build.js';
import { KTraversal } from './k-traversal.js';

export class GravityMonopole {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   textureWidth: number,
   *   textureHeight: number,
   *   particleCount?: number,
   *   positionMassTexture?: WebGLTexture,
   *   velocityColorTexture?: WebGLTexture,
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
  constructor({
    gl,
    textureWidth,
    textureHeight,
    particleCount,
    positionMassTexture,
    velocityColorTexture,
    worldBounds,
    theta,
    dt,
    gravityStrength,
    softening,
    damping,
    maxSpeed,
    maxAccel
  }) {
    this.gl = gl;

    if (!textureWidth || !textureHeight)
      throw new Error('GravityMonopole requires textureWidth and textureHeight');

    this.positionMassTexture = positionMassTexture;
    this.velocityColorTexture = velocityColorTexture;

    this.textureWidth = textureWidth;
    this.textureHeight = textureHeight;
    this.actualTextureSize = textureWidth * textureHeight;

    // Validate or derive particleCount
    this.particleCount = particleCount !== undefined ? particleCount : this.actualTextureSize;
    if (this.particleCount > this.actualTextureSize)
      throw new Error(`particleCount ${this.particleCount} exceeds texture capacity ${this.actualTextureSize}`);

    this.worldBounds = worldBounds || { min: [-4, -4, -4], max: [4, 4, 4] };

    this.theta = theta !== undefined ? theta : 0.5;
    this.dt = dt !== undefined ? dt : 1 / 60;
    this.gravityStrength = gravityStrength !== undefined ? gravityStrength : 0.0003;
    this.softening = softening !== undefined ? softening : 0.2;
    this.damping = damping !== undefined ? damping : 0.0;
    this.maxSpeed = maxSpeed !== undefined ? maxSpeed : 2.0;
    this.maxAccel = maxAccel !== undefined ? maxAccel : 1.0;

    this.frameCount = 0;

    // Bounds update scheduling
    this.boundsUpdateInterval = 90;  // Update bounds every 90 frames (1.5 seconds at 60fps)
    this.lastBoundsUpdateFrame = -this.boundsUpdateInterval;  // Force initial update

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
      particleCount: this.particleCount,
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
      theta: this.theta,
      gravityStrength: this.gravityStrength,
      softening: this.softening
    });

    // Create integrator kernels. These kernels will accept external ping-pong
    // textures (positions/velocities) each frame and write to targets; we do
    // not force them to own the system-level ping-pong textures.
    this.integrateEulerKernel = new KIntegrateEuler({
      gl: this.gl,
      inPosition: this.positionMassTexture,
      inVelocity: this.velocityColorTexture,
      inForce: null,
      width: this.textureWidth,
      height: this.textureHeight,
      dt: this.dt,
      damping: this.damping,
      maxSpeed: this.maxSpeed,
      maxAccel: this.maxAccel
    });

    this.positionMassTexture = this.integrateEulerKernel.inPosition;
    this.velocityColorTexture = this.integrateEulerKernel.inVelocity;

    // Create bounds reduction kernel for GPU-resident dynamic bounds updates
    this.boundsKernel = new KBoundsReduce({
      gl: this.gl,
      inPosition: null,  // set per-run
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      particleCount: this.particleCount
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
    this.aggregatorKernel.inPosition = this.positionMassTexture;
    this.aggregatorKernel.run();
    let err = this.gl.getError();
    if (err !== this.gl.NO_ERROR) {
      console.error(`[Aggregator] GL error: ${err}`);
    }

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
      err = this.gl.getError();
      if (err !== this.gl.NO_ERROR) {
        console.error(`[Pyramid ${i}] GL error: ${err}`);
      }
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

    this.traversalKernel.inPosition = this.positionMassTexture;
    this.traversalKernel.inLevelA0 = levelA0s;
    this.traversalKernel.run();
    const err = this.gl.getError();
    if (err !== this.gl.NO_ERROR) console.error(`[Traversal] GL error: ${err}`);

    // Wire traversal result into velocity integrator
    this.integrateEulerKernel.inForce = this.traversalKernel.outForce;
  }

  _integratePhysics() {
    // allow external inputs
    this.integrateEulerKernel.inVelocity = this.velocityColorTexture;
    this.integrateEulerKernel.inPosition = this.positionMassTexture;
    this.integrateEulerKernel.run();

    // swap and leave updated textures in system properties
    this.positionMassTexture = this.integrateEulerKernel.outPosition;
    this.velocityColorTexture = this.integrateEulerKernel.outVelocity;

    this.integrateEulerKernel.outPosition = this.integrateEulerKernel.inPosition;
    this.integrateEulerKernel.outVelocity = this.integrateEulerKernel.inVelocity;
    this.integrateEulerKernel.inPosition = this.positionMassTexture;
    this.integrateEulerKernel.inVelocity = this.velocityColorTexture;
  }

  /**
   * Update world bounds from GPU reduction
   * Runs every boundsUpdateInterval frames to prevent particle escape.
   * Direct minimal readback: reads 2×1 RGBA32F texture (8 floats = 32 bytes)
   * Reuses pre-allocated FBO and buffer (no hot-path allocations)
   */
  _updateBounds() {
    if (!this.boundsKernel || !this.boundsKernel.outBounds) return;
    if (!this.positionMassTexture) return;

    // Run bounds reduction kernel
    this.boundsKernel.inPosition = this.positionMassTexture;
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
    this.aggregatorKernel?.dispose();
    this.pyramidKernels?.forEach(k => k.dispose());
    this.traversalKernel?.dispose();
    this.integrateEulerKernel?.dispose();
    this.boundsKernel?.dispose();

    // Clean up bounds readback resources
    if (this.boundsReadbackFBO) this.gl.deleteFramebuffer(this.boundsReadbackFBO);
  }
}
