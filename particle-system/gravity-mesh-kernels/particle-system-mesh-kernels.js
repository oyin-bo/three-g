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

export class ParticleSystemMeshKernels {
  /**
   * @param {WebGL2RenderingContext} gl
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
  constructor(gl, options) {
    this.gl = gl;
    
    if (!(gl instanceof WebGL2RenderingContext)) {
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
    this._checkWebGL2Support();
    
    // Create textures
    this._createTextures();
    
    // Upload particle data
    this._uploadParticleData();
    
    // Create shared quad VAO
    this.quadVAO = this._createQuadVAO();
    
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
    
    // Create kernels
    this._createKernels();
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
    
    // Create color texture
    this.colorTexture = this._createRenderTexture(
      this.textureWidth,
      this.textureHeight,
      gl.RGBA8,
      gl.UNSIGNED_BYTE
    );
  }
  
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
  
  _createRenderTexture(width, height, internalFormat, type) {
    const gl = this.gl;
    const fmt = internalFormat || gl.RGBA32F;
    const tp = type || gl.FLOAT;
    
    return this._createTexture2D(width, height, fmt, tp);
  }
  
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
  
  _createQuadVAO() {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create VAO');
    
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    if (!buffer) throw new Error('Failed to create buffer');
    
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const quadData = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    gl.bufferData(gl.ARRAY_BUFFER, quadData, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    
    return vao;
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
  
  _createKernels() {
    // Deposit kernel
    this.depositKernel = new KDeposit({
      gl: this.gl,
      inPosition: null,
      outGrid: null,
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      worldBounds: this.options.worldBounds,
      assignment: this.meshConfig.assignment
    });
    
    // FFT kernel for forward transform
    this.fftForwardKernel = new KFFT({
      gl: this.gl,
      grid: null,
      spectrum: null,
      quadVAO: this.quadVAO,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      inverse: false,
      cellVolume: this.cellVolume
    });
    
    // Poisson solver kernel
    this.poissonKernel = new KPoisson({
      gl: this.gl,
      inDensitySpectrum: null,
      outPotentialSpectrum: null,
      quadVAO: this.quadVAO,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      worldSize: this.worldSize,
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
      inPotentialSpectrum: null,
      outForceSpectrumX: null,
      outForceSpectrumY: null,
      outForceSpectrumZ: null,
      quadVAO: this.quadVAO,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      worldSize: this.worldSize
    });
    
    // FFT kernel for inverse transforms (reused for x, y, z)
    this.fftInverseKernel = new KFFT({
      gl: this.gl,
      grid: null,
      spectrum: null,
      quadVAO: this.quadVAO,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      textureSize: this.gridTextureSize,
      inverse: true,
      cellVolume: this.cellVolume
    });
    
    // Force sampling kernel
    this.forceSampleKernel = new KForceSample({
      gl: this.gl,
      inPosition: null,
      inForceGridX: null,
      inForceGridY: null,
      inForceGridZ: null,
      outForce: null,
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
      inMassGrid: null,
      outForceX: null,
      outForceY: null,
      outForceZ: null,
      quadVAO: this.quadVAO,
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
      inPosition: null,
      inForceGridX: null,
      inForceGridY: null,
      inForceGridZ: null,
      outForce: null,
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.meshConfig.gridSize,
      slicesPerRow: this.meshConfig.slicesPerRow,
      worldBounds: this.options.worldBounds,
      accumulate: true
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
    if (!this.positionTextures) throw new Error('Position textures missing');
    
    this.depositKernel.inPosition = this.positionTextures.getCurrentTexture();
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
    if (!this.positionTextures) throw new Error('Position textures missing');
    
    // Sample far-field forces at particle positions
    this.forceSampleKernel.inPosition = this.positionTextures.getCurrentTexture();
    this.forceSampleKernel.inForceGridX = this.gradientKernel.outForceSpectrumX;
    this.forceSampleKernel.inForceGridY = this.gradientKernel.outForceSpectrumY;
    this.forceSampleKernel.inForceGridZ = this.gradientKernel.outForceSpectrumZ;
    this.forceSampleKernel.run();
  }
  
  _computeNearField() {
    if (!this.nearFieldKernel || !this.nearFieldSampleKernel) {
      throw new Error('Near-field kernels missing');
    }
    if (!this.positionTextures) throw new Error('Position textures missing');
    
    // Compute near-field correction per voxel
    this.nearFieldKernel.inMassGrid = this.depositKernel.outGrid;
    this.nearFieldKernel.run();
    
    // Sample near-field forces and accumulate
    this.nearFieldSampleKernel.inPosition = this.positionTextures.getCurrentTexture();
    this.nearFieldSampleKernel.inForceGridX = this.nearFieldKernel.outForceX;
    this.nearFieldSampleKernel.inForceGridY = this.nearFieldKernel.outForceY;
    this.nearFieldSampleKernel.inForceGridZ = this.nearFieldKernel.outForceZ;
    this.nearFieldSampleKernel.outForce = this.forceSampleKernel.outForce;
    this.nearFieldSampleKernel.run();
  }
  
  _integratePhysics() {
    // This would use velocity and position integrator kernels
    // For now, we'll implement a simple version inline
    // In a complete implementation, this would use KIntegrateVelocity and KIntegratePosition
    // similar to monopole-kernels
    
    if (!this.velocityTextures || !this.positionTextures) {
      throw new Error('Ping-pong textures missing');
    }
    
    // TODO: Implement integrator kernels or reuse from monopole-kernels
    // For now, this is a placeholder that swaps textures
    this.velocityTextures.swap();
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
   * Expose kernels for external inspection or configuration
   */
  getKernels() {
    return {
      deposit: this.depositKernel,
      fftForward: this.fftForwardKernel,
      poisson: this.poissonKernel,
      gradient: this.gradientKernel,
      fftInverse: this.fftInverseKernel,
      forceSample: this.forceSampleKernel,
      nearField: this.nearFieldKernel,
      nearFieldSample: this.nearFieldSampleKernel
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
    if (this.depositKernel) this.depositKernel.dispose();
    if (this.fftForwardKernel) this.fftForwardKernel.dispose();
    if (this.poissonKernel) this.poissonKernel.dispose();
    if (this.gradientKernel) this.gradientKernel.dispose();
    if (this.fftInverseKernel) this.fftInverseKernel.dispose();
    if (this.forceSampleKernel) this.forceSampleKernel.dispose();
    if (this.nearFieldKernel) this.nearFieldKernel.dispose();
    if (this.nearFieldSampleKernel) this.nearFieldSampleKernel.dispose();
    
    // Clean up textures
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
    
    if (this.quadVAO) {
      gl.deleteVertexArray(this.quadVAO);
      this.quadVAO = null;
    }
  }
}
