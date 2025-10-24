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
import { KIntegrateVelocity } from '../gravity-multipole/k-integrate-velocity.js';
import { KIntegratePosition } from '../gravity-multipole/k-integrate-position.js';

export class ParticleSystemMeshKernels {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   particleData: { positions: Float32Array, velocities?: Float32Array|null, colors?: Uint8Array|null },
   *   particleCount?: number,
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
  constructor(options) {
    this.gl = options.gl;

    if (!(this.gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystemMeshKernels requires WebGL2RenderingContext');
    }
    
    if (!options.particleData) {
      throw new Error('ParticleSystemMeshKernels requires particleData with positions');
    }
    
    const particleCount = options.particleData.positions.length / 4;
    
    this.options = {
      particleCount,
      worldBounds: options.worldBounds || { min: [-4, -4, -4], max: [4, 4, 4] },
      dt: options.dt || 1 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.15,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.5
    };
    
    // Mesh configuration
    const meshOptions = options.mesh || {};
    this.meshConfig = {
      assignment: meshOptions.assignment || 'ngp',
      gridSize: meshOptions.gridSize || 64,
      slicesPerRow: meshOptions.slicesPerRow || Math.ceil(Math.sqrt(meshOptions.gridSize || 64)),
      kCut: meshOptions.kCut ?? 0,
      splitSigma: meshOptions.splitSigma ?? 0,
      nearFieldRadius: Math.max(1, Math.floor(meshOptions.nearFieldRadius ?? 2))
    };
    
    this.particleData = options.particleData;
    this.frameCount = 0;
    
    // Calculate texture dimensions
    this.textureWidth = Math.ceil(Math.sqrt(particleCount));
    this.textureHeight = Math.ceil(particleCount / this.textureWidth);
    this.actualTextureSize = this.textureWidth * this.textureHeight;
    
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

    // Create position textures: public active texture and internal write target
    this.positionTexture = createTexture2D(this.gl, this.textureWidth, this.textureHeight);
    this.positionTextureWrite = createTexture2D(this.gl, this.textureWidth, this.textureHeight);

    // Create velocity textures: public active texture and internal write target
    this.velocityTexture = createTexture2D(this.gl, this.textureWidth, this.textureHeight);
    this.velocityTextureWrite = createTexture2D(this.gl, this.textureWidth, this.textureHeight);

    // Upload particle data
    const { positions, velocities } = this.particleData;
    const velDataVal = velocities || new Float32Array(positions.length);

    const expectedLength = this.actualTextureSize * 4;
    if (positions.length !== expectedLength) {
      throw new Error(`Position data length mismatch: expected ${expectedLength}, got ${positions.length}`);
    }

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
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, this.gl.RGBA, this.gl.FLOAT, velDataVal);
    this.gl.bindTexture(this.gl.TEXTURE_2D, this.velocityTextureWrite);
    this.gl.texSubImage2D(this.gl.TEXTURE_2D, 0, 0, 0, this.textureWidth, this.textureHeight, this.gl.RGBA, this.gl.FLOAT, velDataVal);

    this.gl.bindTexture(this.gl.TEXTURE_2D, null);

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
    const bounds = this.options.worldBounds;
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
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      worldBounds: this.options.worldBounds,
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
      gravityStrength: this.options.gravityStrength,
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
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      worldBounds: this.options.worldBounds,
      accumulate: false
    });
    
    // Near-field kernel
    this.nearFieldKernel = new KNearField({
      gl: this.gl,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      worldBounds: this.options.worldBounds,
      softening: this.options.softening,
      gravityStrength: this.options.gravityStrength,
      nearFieldRadius: this.meshConfig.nearFieldRadius
    });
    
    // Near-field force sampling kernel (accumulate mode)
    this.nearFieldSampleKernel = new KForceSample({
      gl: this.gl,
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      worldBounds: this.options.worldBounds,
      accumulate: true
    });

    // Create velocity and position integrator kernels
    this.velocityKernel = new KIntegrateVelocity({
      gl: this.gl,
      width: this.textureWidth,
      height: this.textureHeight,
      dt: this.options.dt,
      damping: this.options.damping,
      maxSpeed: this.options.maxSpeed,
      maxAccel: this.options.maxAccel
    });

    this.positionKernel = new KIntegratePosition({
      gl: this.gl,
      width: this.textureWidth,
      height: this.textureHeight,
      dt: this.options.dt
    });
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
  if (!this.positionTexture) throw new Error('Position textures missing');

  this.depositKernel.inPosition = this.positionTexture;
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
    this.fftInverseKernel.grid = this.gradientKernel.outForceSpectrumX;
    this.fftInverseKernel.run();
    
    this.fftInverseKernel.spectrum = this.gradientKernel.outForceSpectrumY;
    this.fftInverseKernel.grid = this.gradientKernel.outForceSpectrumY;
    this.fftInverseKernel.run();
    
    this.fftInverseKernel.spectrum = this.gradientKernel.outForceSpectrumZ;
    this.fftInverseKernel.grid = this.gradientKernel.outForceSpectrumZ;
    this.fftInverseKernel.run();
  }
  
  _sampleForces() {
    if (!this.forceSampleKernel) throw new Error('Force sample kernel missing');
    if (!this.positionTexture) throw new Error('Position textures missing');
    
    // Sample far-field forces at particle positions
  this.forceSampleKernel.inPosition = this.positionTexture;
    this.forceSampleKernel.inForceGridX = this.gradientKernel.outForceSpectrumX;
    this.forceSampleKernel.inForceGridY = this.gradientKernel.outForceSpectrumY;
    this.forceSampleKernel.inForceGridZ = this.gradientKernel.outForceSpectrumZ;
    this.forceSampleKernel.run();
  }
  
  _computeNearField() {
    if (!this.nearFieldKernel || !this.nearFieldSampleKernel) {
      throw new Error('Near-field kernels missing');
    }
    if (!this.positionTexture) throw new Error('Position textures missing');
    
    // Compute near-field correction per voxel
    this.nearFieldKernel.inMassGrid = this.depositKernel.outGrid;
    this.nearFieldKernel.run();
    
    // Sample near-field forces and accumulate
  this.nearFieldSampleKernel.inPosition = this.positionTexture;
    this.nearFieldSampleKernel.inForceGridX = this.nearFieldKernel.outForceX;
    this.nearFieldSampleKernel.inForceGridY = this.nearFieldKernel.outForceY;
    this.nearFieldSampleKernel.inForceGridZ = this.nearFieldKernel.outForceZ;
    this.nearFieldSampleKernel.outForce = this.forceSampleKernel.outForce;
    this.nearFieldSampleKernel.run();
  }
  
  _integratePhysics() {
    // Update velocities
    if (!this.velocityKernel) throw new Error('Velocity kernel missing');
    if (!this.velocityTexture || !this.positionTexture) throw new Error('Textures missing');

    this.velocityKernel.inVelocity = this.velocityTexture;
    this.velocityKernel.inPosition = this.positionTexture;
    this.velocityKernel.inForce = this.forceSampleKernel.outForce;
    this.velocityKernel.outVelocity = this.velocityTextureWrite;
    this.velocityKernel.run();

    // Swap velocity textures
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

    // Swap position textures
    {
      const tmp = this.positionTexture;
      this.positionTexture = this.positionTextureWrite;
      this.positionTextureWrite = tmp;
    }
  }
  

  
  /**
   * Dispose all resources
   */
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
    
    if (this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
      this.quadVAO = null;
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
