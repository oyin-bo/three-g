// @ts-check

/**
 * ParticleSystemMeshKernels - Kernel-based mesh particle system
 * 
 * Reimplementation using WebGL2 Kernel architecture.
 * Uses composition of small, testable kernels instead of monolithic pipeline.
 */

import { KDeposit } from './k-deposit.js';
// Reuse the lean spectral KFFT implementation
import { KFFT } from '../spectral/k-fft.js';
// Reuse spectral KPoisson (non-square textures, unified options)
import { KPoisson } from '../spectral/k-poisson.js';
import { KGradient } from './k-gradient.js';
// Reuse spectral KForceSample (non-square textures, unified mapping)
import { KForceSample } from '../spectral/k-force-sample.js';
import { KNearField } from './k-near-field.js';
import { KIntegrateEuler } from '../multipole/k-integrate-euler.js';
import { KBoundsReduce } from '../multipole/k-bounds-reduce.js';

export class GravityMesh {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   textureWidth: number,
   *   textureHeight: number,
   *   particleCount?: number,
   *   positionMassTexture?: WebGLTexture,
   *   velocityColorTexture?: WebGLTexture,
   *   worldBounds?: { min: [number,number,number], max: [number,number,number] },
   *   dt?: number,
   *   gravityStrength?: number,
   *   softening?: number,
   *   damping?: number,
   *   maxSpeed?: number,
   *   maxAccel?: number,
   *   mesh?: {
   *     assignment?: 'ngp' | 'cic',
   *     gridSize?: number,
   *     slicesPerRow?: number,
   *     kCut?: number,
   *     splitSigma?: number,
   *     nearFieldRadius?: number
   *   }
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
    dt,
    gravityStrength,
    softening,
    damping,
    maxSpeed,
    maxAccel,
    mesh: meshConfig
  }) {
    this.gl = gl;

    if (!(this.gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystemMeshKernels requires WebGL2RenderingContext');
    }
    
    if (!textureWidth || !textureHeight)
      throw new Error('GravityMesh requires textureWidth and textureHeight');

    this.textureWidth = textureWidth;
    this.textureHeight = textureHeight;
    this.actualTextureSize = this.textureWidth * this.textureHeight;

    this.particleCount = particleCount !== undefined ? particleCount : this.actualTextureSize;
    if (this.particleCount > this.actualTextureSize)
      throw new Error(`particleCount ${this.particleCount} exceeds texture capacity ${this.actualTextureSize}`);

    this.worldBounds = worldBounds || { min: [-4, -4, -4], max: [4, 4, 4] };
    this.dt = dt || 1 / 60;
    this.gravityStrength = gravityStrength || 0.0003;
    this.softening = softening || 0.15;
    this.damping = damping || 0.0;
    this.maxSpeed = maxSpeed || 2.0;
    this.maxAccel = maxAccel || 1.5;
    
    // Mesh configuration
    const meshOptions = meshConfig || {};
    this.meshConfig = {
      assignment: meshOptions.assignment || 'ngp',
      gridSize: meshOptions.gridSize || 64,
      slicesPerRow: meshOptions.slicesPerRow || Math.ceil(Math.sqrt(meshOptions.gridSize || 64)),
      kCut: meshOptions.kCut ?? 0,
      splitSigma: meshOptions.splitSigma ?? 0,
      nearFieldRadius: Math.max(1, Math.floor(meshOptions.nearFieldRadius ?? 2))
    };
    
    this.frameCount = 0;
    
  // Grid configuration (packed 3D as non-square 2D)
  this.sliceRows = Math.ceil(this.meshConfig.gridSize / this.meshConfig.slicesPerRow);
  this.gridTextureWidth = this.meshConfig.gridSize * this.meshConfig.slicesPerRow;
  this.gridTextureHeight = this.meshConfig.gridSize * this.sliceRows;

    // Check WebGL2 support
    const colorBufferFloat = this.gl.getExtension('EXT_color_buffer_float');
    if (!colorBufferFloat) {
      throw new Error('EXT_color_buffer_float extension not supported');
    }

    const floatBlend = this.gl.getExtension('EXT_float_blend');
    this.disableFloatBlend = !floatBlend;
    if (!floatBlend) {
      console.warn('EXT_float_blend not supported: reduced accumulation accuracy');
    }

    this.positionMassTexture = positionMassTexture;
    this.velocityColorTexture = velocityColorTexture;

  // Create force grid textures for mesh method (R32F grid textures for inverse FFT output)
  const gridTextureWidth = this.gridTextureWidth;
  const gridTextureHeight = this.gridTextureHeight;
  // Spectral-style: system-owned resources for clear ownership (now non-square)
  this.massGridTexture = createTexture2D(this.gl, gridTextureWidth, gridTextureHeight, this.gl.R32F);
  this.fftComplexTexture1 = createComplexTexture(this.gl, gridTextureWidth, gridTextureHeight);
  this.fftComplexTexture2 = createComplexTexture(this.gl, gridTextureWidth, gridTextureHeight);
  this.forceSpectrumXTexture = createComplexTexture(this.gl, gridTextureWidth, gridTextureHeight);
  this.forceSpectrumYTexture = createComplexTexture(this.gl, gridTextureWidth, gridTextureHeight);
  this.forceSpectrumZTexture = createComplexTexture(this.gl, gridTextureWidth, gridTextureHeight);
    this.forceGridX = createTexture2D(this.gl, gridTextureWidth, gridTextureHeight, this.gl.R32F);
    this.forceGridY = createTexture2D(this.gl, gridTextureWidth, gridTextureHeight, this.gl.R32F);
    this.forceGridZ = createTexture2D(this.gl, gridTextureWidth, gridTextureHeight, this.gl.R32F);

    // Create shared quad VAO
    const vao = this.gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    
    this.gl.bindVertexArray(vao);
    const buffer = this.gl.createBuffer();
    if (!buffer) throw new Error('Failed to create buffer');
    
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const quadData = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, quadData, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    
    this.quadVAO = vao;

    // Calculate world size vector and voxel volume (match Spectral method scaling)
    const bounds = this.worldBounds;
    this.worldSize = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    ];
    const worldVolume = Math.max(1e-12, this.worldSize[0] * this.worldSize[1] * this.worldSize[2]);
    const n = this.meshConfig.gridSize;
    // Per-voxel volume = worldVolume / n^3; density = mass / cellVolume
    this.cellVolume = worldVolume / (n * n * n);

    // Create kernels inline
    // Deposit kernel
    this.depositKernel = new KDeposit({
      gl: this.gl,
      inPosition: null,
      particleCount: this.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureWidth: this.gridTextureWidth,
      textureHeight: this.gridTextureHeight,
      outGrid: this.massGridTexture,
      worldBounds: this.worldBounds,
      assignment: this.meshConfig.assignment,
      disableFloatBlend: this.disableFloatBlend
    });
    
    // Unified KFFT (reuse spectral implementation). We'll toggle inverse per use.
    this.fftKernel = new KFFT({
      gl: this.gl,
      // Don't bind real here; set per-run to latest massGrid
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
  // Use non-square packed texture dims
  textureWidth: this.gridTextureWidth,
  textureHeight: this.gridTextureHeight,
      inverse: false,
      // massToDensity = 1 / cellVolume
      massToDensity: 1.0 / this.cellVolume
    });
    
    // Poisson solver kernel (reuse spectral version)
    this.poissonKernel = new KPoisson(/** @type {any} */ ({
      gl: this.gl,
      inDensitySpectrum: null,
      outPotentialSpectrum: null,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureWidth: this.gridTextureWidth,
      textureHeight: this.gridTextureHeight,
      worldSize: /** @type {[number, number, number]} */ (this.worldSize),
      gravitationalConstant: 4.0 * Math.PI * this.gravityStrength,
      assignment: /** @type {'NGP'|'CIC'|'TSC'} */ (this.meshConfig.assignment.toUpperCase()),
      poissonUseDiscrete: true,
      splitMode: this.meshConfig.splitSigma > 0 ? 2 : (this.meshConfig.kCut > 0 ? 1 : 0),
      kCut: this.meshConfig.kCut,
      treePMSigma: this.meshConfig.splitSigma
    }));
    
    // Gradient kernel
    this.gradientKernel = new KGradient({
      gl: this.gl,
      inPotentialSpectrum: null,
      outForceSpectrumX: this.forceSpectrumXTexture,
      outForceSpectrumY: this.forceSpectrumYTexture,
      outForceSpectrumZ: this.forceSpectrumZTexture,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureWidth: this.gridTextureWidth,
      textureHeight: this.gridTextureHeight,
      worldSize: /** @type {[number, number, number]} */ (this.worldSize)
    });
    
    // Note: No separate inverse kernel needed when reusing spectral KFFT.
    
    // Force sampling kernel
    this.forceSampleKernel = new KForceSample({
      gl: this.gl,
      particleCount: this.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureWidth: this.gridTextureWidth,
      textureHeight: this.gridTextureHeight,
      worldBounds: this.worldBounds,
      accumulate: false
    });
    
    // Near-field kernel
    this.nearFieldKernel = new KNearField({
      gl: this.gl,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureWidth: this.gridTextureWidth,
      textureHeight: this.gridTextureHeight,
      worldBounds: this.worldBounds,
      softening: this.softening,
      gravityStrength: this.gravityStrength,
      nearFieldRadius: this.meshConfig.nearFieldRadius
    });
    
    // Near-field force sampling kernel (accumulate mode)
    this.nearFieldSampleKernel = new KForceSample({
      gl: this.gl,
      particleCount: this.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureWidth: this.gridTextureWidth,
      textureHeight: this.gridTextureHeight,
      worldBounds: this.worldBounds,
      accumulate: true
    });

    // Create velocity and position integrator kernels
    this.integrateEulerKernel = new KIntegrateEuler({
      gl: this.gl,
      inPosition: this.positionMassTexture,
      inVelocity: this.velocityColorTexture,
      width: this.textureWidth,
      height: this.textureHeight,
      dt: this.dt,
      damping: this.damping,
      maxSpeed: this.maxSpeed,
      maxAccel: this.maxAccel
    });

    this.positionMassTexture = this.integrateEulerKernel.inPosition;
    this.velocityColorTexture = this.integrateEulerKernel.inVelocity;

    // GPU bounds reduction (periodic)
    this.boundsReduce = new KBoundsReduce({
      gl: this.gl,
      inPosition: this.positionMassTexture,
      particleTextureWidth: this.textureWidth,
      particleTextureHeight: this.textureHeight,
      particleCount: this.particleCount
    });
    this.boundsInterval = 30;
    this.boundsReadbackBuffer = new Float32Array(8);
    this.boundsReadbackFBO = this.gl.createFramebuffer();
  }

  /**
   * Step the simulation forward one frame
   */
  step() {
    // 1. Deposit particles onto mesh
    this._depositMass();

    // Periodic GPU bounds check: run KBoundsReduce every boundsInterval frames
    if (this.boundsReduce && (this.frameCount % this.boundsInterval === 0)) {
      const gl = this.gl;
      this.boundsReduce.inPosition = this.positionMassTexture;
      this.boundsReduce.particleTextureWidth = this.textureWidth;
      this.boundsReduce.particleTextureHeight = this.textureHeight;
      this.boundsReduce.particleCount = this.particleCount;
      this.boundsReduce.run();

      // Read back 2x1 bounds texture (min, max) using pre-allocated resources
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundsReadbackFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.boundsReduce.outBounds, 0);
      gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, this.boundsReadbackBuffer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const newMin = [this.boundsReadbackBuffer[0], this.boundsReadbackBuffer[1], this.boundsReadbackBuffer[2]];
      const newMax = [this.boundsReadbackBuffer[4], this.boundsReadbackBuffer[5], this.boundsReadbackBuffer[6]];
      const marginFactor = 0.05;
      const outMin = [0, 0, 0], outMax = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const span = Math.max(1e-6, newMax[i] - newMin[i]);
        outMin[i] = newMin[i] - marginFactor * span;
        outMax[i] = newMax[i] + marginFactor * span;
      }
      this.worldBounds = { min: /** @type {[number,number,number]} */(outMin), max: /** @type {[number,number,number]} */(outMax) };

      const newWorldSize = [outMax[0] - outMin[0], outMax[1] - outMin[1], outMax[2] - outMin[2]];
      const n = this.meshConfig.gridSize;
      const newCellVolume = (newWorldSize[0] * newWorldSize[1] * newWorldSize[2]) / (n * n * n);
      const massToDensity = 1.0 / newCellVolume;
      this.cellVolume = newCellVolume;

      // Propagate scaling/bounds updates
      if (this.fftKernel) this.fftKernel.massToDensity = massToDensity;
      if (this.poissonKernel) this.poissonKernel.worldSize = /** @type {[number,number,number]} */ (newWorldSize);
      if (this.gradientKernel) this.gradientKernel.worldSize = /** @type {[number,number,number]} */ (newWorldSize);
      if (this.forceSampleKernel) this.forceSampleKernel.worldBounds = { min: /** @type {[number,number,number]} */(outMin), max: /** @type {[number,number,number]} */(outMax) };
      if (this.depositKernel) this.depositKernel.worldBounds = { min: /** @type {[number,number,number]} */(outMin), max: /** @type {[number,number,number]} */(outMax) };
      if (this.nearFieldKernel) this.nearFieldKernel.worldBounds = { min: /** @type {[number,number,number]} */(outMin), max: /** @type {[number,number,number]} */(outMax) };
      if (this.nearFieldSampleKernel) this.nearFieldSampleKernel.worldBounds = { min: /** @type {[number,number,number]} */(outMin), max: /** @type {[number,number,number]} */(outMax) };
    }
    
    // 2. Compute mesh forces
    this._computeMeshForces();
    
    // 3. Sample forces at particles
    this._sampleForces();
    
    // 4. Compute near-field correction
    this._computeNearField();
    
    // 5. Integrate physics
    this._integratePhysics();
    
    this.frameCount++;
  }

  /**
   * Expose particle texture size for external modules (e.g., graph forces)
   * @returns {{ width: number, height: number }}
   */
  getTextureSize() {
    return { width: this.textureWidth, height: this.textureHeight };
  }

  /**
   * Reflection snapshot of system state for Daebug/diagnostics
   * Mirrors kernel-style valueOf contract (see docs/10-reflection.md)
   * @param {{ pixels?: boolean }} [options]
   */
  valueOf({ pixels } = {}) {
    // Kernels already expose rich valueOf snapshots; here we summarize system-level wiring
    const value = {
      worldBounds: { min: [...this.worldBounds.min], max: [...this.worldBounds.max] },
      worldSize: [...this.worldSize],
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureWidth: this.gridTextureWidth,
      textureHeight: this.gridTextureHeight,
      cellVolume: this.cellVolume,
      massToDensity: this.fftKernel ? this.fftKernel.massToDensity : (1 / this.cellVolume),
      particleTexture: { width: this.textureWidth, height: this.textureHeight, count: this.particleCount },
      resources: {
        massGridTexture: !!this.massGridTexture,
        forceGridX: !!this.forceGridX,
        forceGridY: !!this.forceGridY,
        forceGridZ: !!this.forceGridZ,
        fftComplex1: !!this.fftComplexTexture1,
        fftComplex2: !!this.fftComplexTexture2,
        forceSpectrumXTexture: !!this.forceSpectrumXTexture,
        forceSpectrumYTexture: !!this.forceSpectrumYTexture,
        forceSpectrumZTexture: !!this.forceSpectrumZTexture
      },
      frameCount: this.frameCount,
      kernels: {
        deposit: this.depositKernel && this.depositKernel.renderCount,
        poisson: this.poissonKernel && this.poissonKernel.renderCount,
        gradient: this.gradientKernel && this.gradientKernel.renderCount,
        nearField: this.nearFieldKernel && this.nearFieldKernel.renderCount,
        forceSample: this.forceSampleKernel && this.forceSampleKernel.renderCount
      }
    };

    value.toString = () =>
`GravityMesh(grid=${value.gridSize}³, packed=${value.textureWidth}×${value.textureHeight}) frames=${value.frameCount}
bounds=[${value.worldBounds.min}]→[${value.worldBounds.max}] worldSize=[${value.worldSize}] cellVolume=${value.cellVolume.toExponential()} massToDensity=${value.massToDensity.toExponential()}
resources: massGrid=${value.resources.massGridTexture} forceGrids=[${value.resources.forceGridX},${value.resources.forceGridY},${value.resources.forceGridZ}] spectra=[${value.resources.forceSpectrumXTexture},${value.resources.forceSpectrumYTexture},${value.resources.forceSpectrumZTexture}]`;

    return value;
  }

  /**
   * Compact human-readable system summary
   */
  toString() {
    return this.valueOf().toString();
  }
  
  _depositMass() {
  if (!this.depositKernel) throw new Error('Deposit kernel missing');
  if (!this.positionMassTexture) throw new Error('Position textures missing');

  this.depositKernel.inPosition = this.positionMassTexture;
    this.depositKernel.run();
  }
  
  _computeMeshForces() {
    // Texture ownership and borrowing protocol (see docs and GravitySpectral):
    // - Forward FFT writes density spectrum to fftKernel.complexTo.
    //   We hand off complexTo → Poisson.inDensitySpectrum and null local slot to avoid dual-ownership.
    // - Poisson writes potential spectrum to fftKernel.complexFrom; we hand off to Gradient.inPotentialSpectrum.
    // - Gradient produces three force spectra (X,Y,Z). For each component, we set fftKernel.inverse=true,
    //   borrow the component spectrum into fftKernel.complexFrom, and set fftKernel.real to the target force grid.
    //   When possible, we reuse freed spectra (e.g., Gradient.inPotentialSpectrum) as fftKernel.complexTo scratch.
    // - After each inverse, we return complexFrom back to the producer for reuse, and reclaim Poisson input at the end
    //   to complete the cycle. All hand-offs null the source field to clearly transfer ownership and prevent races.
    if (!this.fftKernel || !this.poissonKernel || !this.gradientKernel) {
      throw new Error('Mesh force kernels missing');
    }

    // Forward FFT: mass grid -> density spectrum
    this.fftKernel.inverse = false;
  this.fftKernel.real = /** @type {WebGLTexture} */ (this.depositKernel.outGrid);
    this.fftKernel.run();

    // Solve Poisson: density spectrum -> potential spectrum
    this.poissonKernel.inDensitySpectrum = this.fftKernel.complexTo;
    this.fftKernel.complexTo = null; // handoff
    this.poissonKernel.outPotentialSpectrum = this.fftKernel.complexFrom;
    this.fftKernel.complexFrom = null; // handoff
    this.poissonKernel.run();

    // Compute gradient: potential spectrum -> force spectra
    this.gradientKernel.inPotentialSpectrum = this.poissonKernel.outPotentialSpectrum;
    this.poissonKernel.outPotentialSpectrum = null; // handoff
    this.gradientKernel.run();

    // Inverse FFT for each force component: force spectra -> force grids
    this.fftKernel.inverse = true;

    // X component
    this.fftKernel.complexFrom = this.gradientKernel.outForceSpectrumX;
    this.gradientKernel.outForceSpectrumX = null;
    // Reuse gradient's input spectrum as scratch if available
    if (this.gradientKernel.inPotentialSpectrum) {
      this.fftKernel.complexTo = this.gradientKernel.inPotentialSpectrum;
      this.gradientKernel.inPotentialSpectrum = null;
    }
    this.fftKernel.real = this.forceGridX;
    this.fftKernel.run();
    this.gradientKernel.outForceSpectrumX = this.fftKernel.complexFrom; // returned
    this.fftKernel.complexFrom = null;

    // Y component
    this.fftKernel.complexFrom = this.gradientKernel.outForceSpectrumY;
    this.gradientKernel.outForceSpectrumY = null;
    this.fftKernel.real = this.forceGridY;
    this.fftKernel.run();
    this.gradientKernel.outForceSpectrumY = this.fftKernel.complexFrom; // returned
    this.fftKernel.complexFrom = null;

    // Z component
    this.fftKernel.complexFrom = this.gradientKernel.outForceSpectrumZ;
    this.gradientKernel.outForceSpectrumZ = null;
    this.fftKernel.real = this.forceGridZ;
    this.fftKernel.run();
    this.gradientKernel.outForceSpectrumZ = this.fftKernel.complexFrom; // returned
    // Reclaim Poisson input back to FFT scratch to complete the cycle
    if (!this.poissonKernel.inDensitySpectrum) throw new Error('Poisson kernel inDensitySpectrum texture is null');
    this.fftKernel.complexFrom = this.poissonKernel.inDensitySpectrum;
    this.poissonKernel.inDensitySpectrum = null;

    // Ensure forward FFT has a valid complex target for the next frame
    if (!this.fftKernel.complexTo) this.fftKernel.complexTo = this.fftComplexTexture1 || this.fftKernel.complexFrom;
  }
  
  _sampleForces() {
    if (!this.forceSampleKernel) throw new Error('Force sample kernel missing');
    if (!this.positionMassTexture) throw new Error('Position textures missing');
    
    // Sample far-field forces at particle positions
  this.forceSampleKernel.inPosition = this.positionMassTexture;
    this.forceSampleKernel.inForceGridX = this.forceGridX;
    this.forceSampleKernel.inForceGridY = this.forceGridY;
    this.forceSampleKernel.inForceGridZ = this.forceGridZ;
    this.forceSampleKernel.run();
  }
  
  _computeNearField() {
    if (!this.nearFieldKernel || !this.nearFieldSampleKernel) {
      throw new Error('Near-field kernels missing');
    }
    if (!this.positionMassTexture) throw new Error('Position textures missing');
    
    // Compute near-field correction per voxel
    this.nearFieldKernel.inMassGrid = this.depositKernel.outGrid;
    this.nearFieldKernel.run();
    
    // Sample near-field forces and accumulate
  this.nearFieldSampleKernel.inPosition = this.positionMassTexture;
    this.nearFieldSampleKernel.inForceGridX = this.nearFieldKernel.outForceX;
    this.nearFieldSampleKernel.inForceGridY = this.nearFieldKernel.outForceY;
    this.nearFieldSampleKernel.inForceGridZ = this.nearFieldKernel.outForceZ;
    this.nearFieldSampleKernel.outForce = this.forceSampleKernel.outForce;
    this.nearFieldSampleKernel.run();
  }
  
  _integratePhysics() {
    // allow external inputs
    this.integrateEulerKernel.inVelocity = this.velocityColorTexture;
    this.integrateEulerKernel.inPosition = this.positionMassTexture;
    this.integrateEulerKernel.inForce = this.forceSampleKernel.outForce;
    this.integrateEulerKernel.run();

    // swap and leave updated textures in system properties
    this.positionMassTexture = this.integrateEulerKernel.outPosition;
    this.velocityColorTexture = this.integrateEulerKernel.outVelocity;

    this.integrateEulerKernel.outPosition = this.integrateEulerKernel.inPosition;
    this.integrateEulerKernel.outVelocity = this.integrateEulerKernel.inVelocity;
    this.integrateEulerKernel.inPosition = this.positionMassTexture;
    this.integrateEulerKernel.inVelocity = this.velocityColorTexture;
  }
  

  
  dispose() {
    const gl = this.gl;
    
    // Dispose kernels
    if (this.depositKernel) this.depositKernel.dispose();
  if (this.fftKernel) this.fftKernel.dispose();
    if (this.poissonKernel) this.poissonKernel.dispose();
    if (this.gradientKernel) this.gradientKernel.dispose();
    if (this.forceSampleKernel) this.forceSampleKernel.dispose();
    if (this.nearFieldKernel) this.nearFieldKernel.dispose();
    if (this.nearFieldSampleKernel) this.nearFieldSampleKernel.dispose();
    if (this.integrateEulerKernel) this.integrateEulerKernel.dispose();
  if (this.boundsReduce) this.boundsReduce.dispose();
  if (this.boundsReadbackFBO) gl.deleteFramebuffer(this.boundsReadbackFBO);
    
    // Clean up textures
    if (this.massGridTexture) gl.deleteTexture(this.massGridTexture);
    if (this.fftComplexTexture1) gl.deleteTexture(this.fftComplexTexture1);
    if (this.fftComplexTexture2) gl.deleteTexture(this.fftComplexTexture2);
    if (this.forceSpectrumXTexture) gl.deleteTexture(this.forceSpectrumXTexture);
    if (this.forceSpectrumYTexture) gl.deleteTexture(this.forceSpectrumYTexture);
    if (this.forceSpectrumZTexture) gl.deleteTexture(this.forceSpectrumZTexture);
    if (this.forceGridX) {
      gl.deleteTexture(this.forceGridX);
    }
    if (this.forceGridY) {
      gl.deleteTexture(this.forceGridY);
    }
    if (this.forceGridZ) {
      gl.deleteTexture(this.forceGridZ);
    }
    
    if (this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
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
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt, width, height, 0,
    fmt === gl.R32F ? gl.RED : gl.RGBA, tp, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

/**
 * Create a complex RG32F texture for FFT spectra
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createComplexTexture(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  return texture;
}
