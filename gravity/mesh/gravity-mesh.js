// @ts-check

/**
 * ParticleSystemMeshKernels - Kernel-based mesh particle system
 * 
 * Reimplementation using WebGL2 Kernel architecture.
 * Uses composition of small, testable kernels instead of monolithic pipeline.
 */

import { KDeposit } from './k-deposit.js';
import { KFFT } from './k-fft.js';
import { KPoisson } from './k-poisson.js';
import { KGradient } from './k-gradient.js';
import { KForceSample } from './k-force-sample.js';
import { KNearField } from './k-near-field.js';
import { KIntegrateEuler } from '../multipole/k-integrate-euler.js';

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
    
    // Grid configuration
    this.gridTextureSize = this.meshConfig.gridSize * this.meshConfig.slicesPerRow;

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
    const gridTextureSize = this.meshConfig.gridSize * this.meshConfig.slicesPerRow;
    this.forceGridX = createTexture2D(this.gl, gridTextureSize, gridTextureSize, this.gl.R32F);
    this.forceGridY = createTexture2D(this.gl, gridTextureSize, gridTextureSize, this.gl.R32F);
    this.forceGridZ = createTexture2D(this.gl, gridTextureSize, gridTextureSize, this.gl.R32F);

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

    // Calculate cell volume for FFT
    const bounds = this.worldBounds;
    const boxSize = Math.max(
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    );
    const cellSize = boxSize / this.meshConfig.gridSize;
    this.cellVolume = cellSize * cellSize * cellSize;
    
    // Calculate world size vector
    this.worldSize = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    ];

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
      worldBounds: this.worldBounds,
      assignment: this.meshConfig.assignment,
      disableFloatBlend: this.disableFloatBlend
    });
    
    // FFT kernel for forward transform
    this.fftForwardKernel = new KFFT({
      gl: this.gl,
      grid: null,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      inverse: false,
      cellVolume: this.cellVolume
    });
    
    // Poisson solver kernel
    this.poissonKernel = new KPoisson({
      gl: this.gl,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      worldSize: /** @type {[number, number, number]} */ (this.worldSize),
      gravityStrength: this.gravityStrength,
      splitMode: this.meshConfig.splitSigma > 0 ? 2 : this.meshConfig.kCut > 0 ? 1 : 0,
      kCut: this.meshConfig.kCut,
      gaussianSigma: this.meshConfig.splitSigma,
      deconvolveOrder: this.meshConfig.assignment === 'cic' ? 2 : 1,
      useDiscrete: true
    });
    
    // Gradient kernel
    this.gradientKernel = new KGradient({
      gl: this.gl,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      worldSize: /** @type {[number, number, number]} */ (this.worldSize)
    });
    
    // FFT kernel for inverse transforms (reused for x, y, z)
    this.fftInverseKernel = new KFFT({
      gl: this.gl,
      grid: null,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      inverse: true,
      cellVolume: this.cellVolume
    });
    
    // Force sampling kernel
    this.forceSampleKernel = new KForceSample({
      gl: this.gl,
      particleCount: this.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      worldBounds: this.worldBounds,
      accumulate: false
    });
    
    // Near-field kernel
    this.nearFieldKernel = new KNearField({
      gl: this.gl,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
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
  }

  /**
   * Step the simulation forward one frame
   */
  step() {
    // 1. Deposit particles onto mesh
    this._depositMass();
    
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
  
  _depositMass() {
  if (!this.depositKernel) throw new Error('Deposit kernel missing');
  if (!this.positionMassTexture) throw new Error('Position textures missing');

  this.depositKernel.inPosition = this.positionMassTexture;
    this.depositKernel.run();
  }
  
  _computeMeshForces() {
    if (!this.fftForwardKernel || !this.poissonKernel || !this.gradientKernel || !this.fftInverseKernel) {
      throw new Error('Mesh force kernels missing');
    }
    
    // Forward FFT: mass grid -> density spectrum
    this.fftForwardKernel.grid = this.depositKernel.outGrid;
    this.fftForwardKernel.run();
    
    // Solve Poisson: density spectrum -> potential spectrum
    this.poissonKernel.inDensitySpectrum = this.fftForwardKernel.spectrum;
    this.poissonKernel.run();
    
    // Compute gradient: potential spectrum -> force spectra
    this.gradientKernel.inPotentialSpectrum = this.poissonKernel.outPotentialSpectrum;
    this.gradientKernel.run();
    
    // Inverse FFT for each force component: force spectra -> force grids
    // Set spectrum input and grid output, then run with inverse flag
    this.fftInverseKernel.spectrum = this.gradientKernel.outForceSpectrumX;
    this.fftInverseKernel.grid = this.forceGridX;
    this.fftInverseKernel.run();
    
    this.fftInverseKernel.spectrum = this.gradientKernel.outForceSpectrumY;
    this.fftInverseKernel.grid = this.forceGridY;
    this.fftInverseKernel.run();
    
    this.fftInverseKernel.spectrum = this.gradientKernel.outForceSpectrumZ;
    this.fftInverseKernel.grid = this.forceGridZ;
    this.fftInverseKernel.run();
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
    if (this.fftForwardKernel) this.fftForwardKernel.dispose();
    if (this.poissonKernel) this.poissonKernel.dispose();
    if (this.gradientKernel) this.gradientKernel.dispose();
    if (this.fftInverseKernel) this.fftInverseKernel.dispose();
    if (this.forceSampleKernel) this.forceSampleKernel.dispose();
    if (this.nearFieldKernel) this.nearFieldKernel.dispose();
    if (this.nearFieldSampleKernel) this.nearFieldSampleKernel.dispose();
    if (this.integrateEulerKernel) this.integrateEulerKernel.dispose();
    
    // Clean up textures
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
