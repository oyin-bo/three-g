// @ts-check

/**
 * ParticleSystemMonopoleKernels - Kernel-based monopole particle system
 * 
 * Reimplementation using WebGL2 Kernel architecture from docs/8.1-multipole-migration.md.
 * Uses composition of small, testable kernels instead of monolithic pipeline.
 */

import { KIntegrateVelocity } from './k-integrate-velocity.js';
import { KIntegratePosition } from './k-integrate-position.js';
import { KAggregator } from './k-aggregator.js';
import { KPyramidBuild } from './k-pyramid-build.js';
import { KTraversal } from './k-traversal.js';

export class ParticleSystemMonopoleKernels {
  /**
   * @param {WebGL2RenderingContext} gl
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
   *   maxAccel?: number
   * }} options
   */
  constructor(gl, options) {
    this.gl = gl;
    
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystemMonopoleKernels requires WebGL2RenderingContext');
    }
    
    if (!options.particleData) {
      throw new Error('ParticleSystemMonopoleKernels requires particleData with positions');
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
      maxAccel: options.maxAccel || 1.0
    };
    
    this.particleData = options.particleData;
    this.frameCount = 0;
    
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
    this._checkWebGL2Support();
    
    // Create textures
    this._createTextures();
    
    // Upload particle data
    this._uploadParticleData();
    
    // Create kernels immediately in the constructor (no separate _createKernels method)
    // Kernels are allowed to create and own their internal textures/FBOs unless
    // an explicit texture is passed in the options. The particle system will
    // only own the particle ping-pong textures (positions/velocities/colors).

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
  this.aggregatorKernel = new KAggregator({
      gl: this.gl,
      inPosition: null,  // set per-frame before run
      outA0: null,
      outA1: null,
      outA2: null,
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      octreeSize: this.L0Size,
      gridSize: this.octreeGridSize,
      slicesPerRow: this.octreeSlicesPerRow,
      worldBounds: this.options.worldBounds,
      disableFloatBlend: this.disableFloatBlend
    });

    // Create pyramid build kernels for each reduction level. They will own their
    // own input/output textures; wiring is performed at runtime after the
    // previous-level kernel runs.
    this.pyramidKernels = [];
    for (let i = 0; i < this.numLevels - 1; i++) {
      this.pyramidKernels.push(new KPyramidBuild({
        gl: this.gl,
        inA0: null,
        inA1: null,
        inA2: null,
        outA0: null,
        outA1: null,
        outA2: null,
        outSize: this.levelConfigs[i + 1].size,
        outGridSize: this.levelConfigs[i + 1].gridSize,
        outSlicesPerRow: this.levelConfigs[i + 1].slicesPerRow
      }));
    }

    // Create traversal kernel. Do not pass level textures; we'll wire them
    // from the pyramid kernels after the pyramid build runs.
  this.traversalKernel = new KTraversal({
      gl: this.gl,
      inPosition: null,  // set per-frame
      inLevelA0: undefined,
      outForce: null,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      numLevels: this.numLevels,
      levelConfigs: this.levelConfigs,
      worldBounds: this.options.worldBounds,
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
  }
  
  _checkWebGL2Support() {
    const gl = this.gl;
    const colorBufferFloat = gl.getExtension('EXT_color_buffer_float');
    const floatBlend = gl.getExtension('EXT_float_blend');
    
    if (!colorBufferFloat) {
      throw new Error('EXT_color_buffer_float extension not supported');
    }
    
    this.disableFloatBlend = !floatBlend;
    
    if (!floatBlend) {
      console.warn('EXT_float_blend not supported: reduced accumulation accuracy');
    }
  }
  
  _createTextures() {
    const gl = this.gl;
    
    // Create position ping-pong textures
    this.positionTextures = this._createPingPongTextures(this.textureWidth, this.textureHeight);
    
    // Create velocity ping-pong textures
    this.velocityTextures = this._createPingPongTextures(this.textureWidth, this.textureHeight);
    
    // Create color texture (system-owned for rendering)
    this.colorTexture = this._createRenderTexture(
      this.textureWidth,
      this.textureHeight,
      gl.RGBA8,
      gl.UNSIGNED_BYTE
    );

    // Note: We intentionally do NOT create forceTexture or level textures here.
    // Kernels (aggregator/pyramid/traversal) are responsible for allocating
    // any internal textures or FBOs they need. The particle system only owns
    // the particle ping-pong textures (position/velocity) and the color
    // texture used for rendering.
  }
  
  /**
   * @param {number} width
   * @param {number} height
   */
  _createPingPongTextures(width, height) {
    const textures = [
      this._createTexture2D(width, height),
      this._createTexture2D(width, height)
    ];
    
    return {
      textures,
      currentIndex: 0,
      getCurrentTexture() { return this.textures[this.currentIndex]; },
      getTargetTexture() { return this.textures[1 - this.currentIndex]; },
      swap() { this.currentIndex = 1 - this.currentIndex; }
    };
  }
  
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} [internalFormat]
   * @param {number} [type]
   */
  _createRenderTexture(width, height, internalFormat, type) {
    const gl = this.gl;
    const fmt = internalFormat || gl.RGBA32F;
    const tp = type || gl.FLOAT;
    
    return this._createTexture2D(width, height, fmt, tp);
  }
  
  /**
   * @param {number} width
   * @param {number} height
   * @param {number} [internalFormat]
   * @param {number} [type]
   */
  _createTexture2D(width, height, internalFormat, type) {
    const gl = this.gl;
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
  
  _uploadParticleData() {
    const gl = this.gl;
    const { positions, velocities, colors } = this.particleData;
    
    const expectedLength = this.actualTextureSize * 4;
    if (positions.length !== expectedLength) {
      throw new Error(`Position data length mismatch: expected ${expectedLength}, got ${positions.length}`);
    }
    
    const velData = velocities || new Float32Array(expectedLength);
    const colorData = colors || new Uint8Array(expectedLength).fill(255);
    // Sanity checks to satisfy @ts-check and ensure textures were created
    if (!this.positionTextures || !this.positionTextures.textures) {
      throw new Error('Position textures not initialized');
    }
    if (!this.velocityTextures || !this.velocityTextures.textures) {
      throw new Error('Velocity textures not initialized');
    }
    if (!this.colorTexture) {
      throw new Error('Color texture not initialized');
    }

    // Upload positions
    gl.bindTexture(gl.TEXTURE_2D, this.positionTextures.textures[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, gl.RGBA, gl.FLOAT, positions);
    gl.bindTexture(gl.TEXTURE_2D, this.positionTextures.textures[1]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, gl.RGBA, gl.FLOAT, positions);

    // Upload velocities
    gl.bindTexture(gl.TEXTURE_2D, this.velocityTextures.textures[0]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, gl.RGBA, gl.FLOAT, velData);
    gl.bindTexture(gl.TEXTURE_2D, this.velocityTextures.textures[1]);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, gl.RGBA, gl.FLOAT, velData);

    // Upload colors
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, gl.RGBA, gl.UNSIGNED_BYTE, colorData);

    gl.bindTexture(gl.TEXTURE_2D, null);
  }
  
  /**
   * Step the simulation forward one frame
   */
  step() {
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
    if (!this.positionTextures) throw new Error('Position textures missing');

    this.aggregatorKernel.inPosition = this.positionTextures.getCurrentTexture();
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
    if (!this.traversalKernel) throw new Error('Traversal kernel missing');
    if (!this.positionTextures) throw new Error('Position textures missing');

    // Build array of A0 textures per level (aggregator + pyramid outputs)
    const levelA0s = [];
    if (this.aggregatorKernel && this.aggregatorKernel.outA0) levelA0s.push(this.aggregatorKernel.outA0);
    for (const k of this.pyramidKernels) {
      if (k && k.outA0) levelA0s.push(k.outA0);
    }

    this.traversalKernel.inPosition = this.positionTextures.getCurrentTexture();
    this.traversalKernel.inLevelA0 = levelA0s;
    this.traversalKernel.run();

    // Wire traversal result into velocity integrator
    if (this.velocityKernel) {
      this.velocityKernel.inForce = this.traversalKernel.outForce || null;
    }
  }
  
  _integratePhysics() {
    // Update velocities
    if (!this.velocityKernel) throw new Error('Velocity kernel missing');
    if (!this.velocityTextures || !this.positionTextures) throw new Error('Ping-pong textures missing');

    this.velocityKernel.inVelocity = this.velocityTextures.getCurrentTexture();
    this.velocityKernel.inPosition = this.positionTextures.getCurrentTexture();
    this.velocityKernel.outVelocity = this.velocityTextures.getTargetTexture();
    this.velocityKernel.run();

    // Prefer kernel-owned swap if available; otherwise swap system ping-pong
    // Swap system velocity ping-pong textures
    this.velocityTextures.swap();

    // Update positions
    if (!this.positionKernel) throw new Error('Position kernel missing');

    this.positionKernel.inPosition = this.positionTextures.getCurrentTexture();
    this.positionKernel.inVelocity = this.velocityTextures.getCurrentTexture();
    this.positionKernel.outPosition = this.positionTextures.getTargetTexture();
    this.positionKernel.run();

    // Swap system position ping-pong textures
    this.positionTextures.swap();
  }
  
  /**
   * Get current position texture for rendering
   */
  getPositionTexture() {
    if (!this.positionTextures) return null;
    return this.positionTextures.getCurrentTexture();
  }
  
  /**
   * Get all position textures
   */
  getPositionTextures() {
    if (!this.positionTextures) return [];
    return this.positionTextures.textures;
  }
  
  /**
   * Get current ping-pong index
   */
  getCurrentIndex() {
    if (!this.positionTextures) return 0;
    return this.positionTextures.currentIndex;
  }

  /**
   * Expose kernels for external inspection or configuration.
   * Kernels may own internal textures; do not mutate kernel-owned resources
   * unless you know what you're doing.
   */
  getKernels() {
    return {
      aggregator: this.aggregatorKernel,
      pyramid: this.pyramidKernels,
      traversal: this.traversalKernel,
      velocityIntegrator: this.velocityKernel,
      positionIntegrator: this.positionKernel
    };
  }
  
  /**
   * Get color texture
   */
  getColorTexture() {
    return this.colorTexture;
  }
  
  /**
   * Get texture dimensions
   */
  getTextureSize() {
    return { width: this.textureWidth, height: this.textureHeight };
  }
  
  /**
   * Dispose all resources
   */
  dispose() {
    const gl = this.gl;
    
    // Dispose kernels
    if (this.aggregatorKernel) this.aggregatorKernel.dispose();
    if (this.pyramidKernels) this.pyramidKernels.forEach(k => k.dispose());
    if (this.traversalKernel) this.traversalKernel.dispose();
    if (this.velocityKernel) this.velocityKernel.dispose();
    if (this.positionKernel) this.positionKernel.dispose();
    
    // Clean up textures not owned by kernels
    if (this.positionTextures) {
      this.positionTextures.textures.forEach(tex => gl.deleteTexture(tex));
    }
    if (this.velocityTextures) {
      this.velocityTextures.textures.forEach(tex => gl.deleteTexture(tex));
    }
    if (this.colorTexture) {
      gl.deleteTexture(this.colorTexture);
      this.colorTexture = null;
    }
    
    // Note: forceTexture and levelTextures are owned by kernels and will be disposed by them
  }
}
