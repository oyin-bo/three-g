// @ts-check

/**
 * ParticleSystemSpectralKernels - Kernel-based spectral particle system
 * 
 * Reimplementation using WebGL2 Kernel architecture similar to ParticleSystemMonopoleKernels.
 * Uses composition of small, testable kernels instead of monolithic pipeline.
 * 
 * PM/FFT Pipeline:
 * 1. Deposit particles to grid (KDeposit)
 * 2. Forward FFT (KFFT forward)
 * 3. Solve Poisson equation (KPoisson)
 * 4. Compute gradient (KGradient)
 * 5. Inverse FFT (KFFT inverse, 3 axes)
 * 6. Sample forces at particles (KForceSample)
 */

import { KDeposit } from './k-deposit.js';
import { KFFT } from './k-fft.js';
import { KPoisson } from './k-poisson.js';
import { KGradient } from './k-gradient.js';
import { KForceSample } from './k-force-sample.js';
import { KIntegrateVelocity } from '../gravity-multipole/k-integrate-velocity.js';
import { KIntegratePosition } from '../gravity-multipole/k-integrate-position.js';

export class ParticleSystemSpectralKernels {
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
   *   gridSize?: number,
   *   assignment?: 'NGP'|'CIC'
   * }} options
   */
  constructor(gl, options) {
    this.gl = gl;
    
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystemSpectralKernels requires WebGL2RenderingContext');
    }
    
    if (!options.particleData) {
      throw new Error('ParticleSystemSpectralKernels requires particleData with positions');
    }
    
    const particleCount = options.particleData.positions.length / 4;
    
    // Infer bounds from particle positions if not provided
    const inferredBounds = this._inferBounds(options.particleData.positions);
    
    this.options = {
      particleCount,
      worldBounds: options.worldBounds || inferredBounds,
      dt: options.dt || 1 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.2,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.0,
      gridSize: options.gridSize || 64,
      assignment: options.assignment || 'CIC'
    };
    
    this.particleData = options.particleData;
    this.frameCount = 0;
    
    // Calculate texture dimensions
    this.textureWidth = Math.ceil(Math.sqrt(particleCount));
    this.textureHeight = Math.ceil(particleCount / this.textureWidth);
    this.actualTextureSize = this.textureWidth * this.textureHeight;
    
    // PM grid configuration
    this.gridSize = this.options.gridSize;
    this.slicesPerRow = Math.ceil(Math.sqrt(this.gridSize));
    this.textureSize = this.gridSize * this.slicesPerRow;
    
    // Check WebGL2 support
    this._checkWebGL2Support();
    
    // Create textures
    this._createTextures();
    
    // Upload particle data
    this._uploadParticleData();
    
    // Create kernels
    
    // 1. Deposit kernel
    this.depositKernel = new KDeposit({
      gl: this.gl,
      inPosition: null,  // set per-frame
      outMassGrid: null, // will be set to internal texture
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      worldBounds: this.options.worldBounds,
      assignment: this.options.assignment,
      disableFloatBlend: this.disableFloatBlend
    });
    
    // 2. Forward FFT kernel
    this.fftForwardKernel = new KFFT({
      gl: this.gl,
      inReal: null,      // will be mass grid
      outComplex: null,  // will be density spectrum
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: false
    });
    
    // 3. Poisson solver kernel
    const fourPiG = 4 * Math.PI * this.options.gravityStrength;
    const bounds = this.options.worldBounds;
    const worldSize = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    ];
    
    this.poissonKernel = new KPoisson({
      gl: this.gl,
      inDensitySpectrum: null,     // will be density spectrum
      outPotentialSpectrum: null,  // will be potential spectrum
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      gravitationalConstant: fourPiG,
      worldSize: /** @type {[number, number, number]} */ (worldSize),
      assignment: this.options.assignment
    });
    
    // 4. Gradient kernel
    this.gradientKernel = new KGradient({
      gl: this.gl,
      inPotentialSpectrum: null,   // will be potential spectrum
      outForceSpectrumX: null,     // will be force spectrum X
      outForceSpectrumY: null,     // will be force spectrum Y
      outForceSpectrumZ: null,     // will be force spectrum Z
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      worldSize: /** @type {[number, number, number]} */ (worldSize)
    });
    
    // 5. Inverse FFT kernels (one per axis)
    this.fftInverseX = new KFFT({
      gl: this.gl,
      inComplex: null,   // will be force spectrum X
      outReal: null,     // will be force grid X
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: true
    });
    
    this.fftInverseY = new KFFT({
      gl: this.gl,
      inComplex: null,   // will be force spectrum Y
      outReal: null,     // will be force grid Y
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: true
    });
    
    this.fftInverseZ = new KFFT({
      gl: this.gl,
      inComplex: null,   // will be force spectrum Z
      outReal: null,     // will be force grid Z
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: true
    });
    
    // 6. Force sampling kernel
    this.forceSampleKernel = new KForceSample({
      gl: this.gl,
      inPosition: null,      // set per-frame
      inForceGridX: null,    // will be force grid X
      inForceGridY: null,    // will be force grid Y
      inForceGridZ: null,    // will be force grid Z
      outForce: null,        // will be force texture
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      worldBounds: this.options.worldBounds
    });
    
    // 7. Integration kernels (reuse from monopole)
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
  
  /**
   * Infer world bounds from particle positions
   * @private
   */
  _inferBounds(positions) {
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 4) {
      const x = positions[i + 0];
      const y = positions[i + 1];
      const z = positions[i + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const marginX = (maxX - minX) * 0.05;
    const marginY = (maxY - minY) * 0.05;
    const marginZ = (maxZ - minZ) * 0.05;
    return {
      min: [minX - marginX, minY - marginY, minZ - marginZ],
      max: [maxX + marginX, maxY + marginY, maxZ + marginZ]
    };
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
    
    // Create PM grid textures
    this.massGridTexture = this._createTexture2D(this.textureSize, this.textureSize, gl.R32F, gl.FLOAT);
    this.densitySpectrumTexture = this._createComplexTexture(this.textureSize, this.textureSize);
    this.potentialSpectrumTexture = this._createComplexTexture(this.textureSize, this.textureSize);
    this.forceSpectrumX = this._createComplexTexture(this.textureSize, this.textureSize);
    this.forceSpectrumY = this._createComplexTexture(this.textureSize, this.textureSize);
    this.forceSpectrumZ = this._createComplexTexture(this.textureSize, this.textureSize);
    this.forceGridX = this._createTexture2D(this.textureSize, this.textureSize);
    this.forceGridY = this._createTexture2D(this.textureSize, this.textureSize);
    this.forceGridZ = this._createTexture2D(this.textureSize, this.textureSize);
    this.forceTexture = this._createTexture2D(this.textureWidth, this.textureHeight);
    
    // Set kernel textures
    this.depositKernel.outMassGrid = this.massGridTexture;
    this.fftForwardKernel.inReal = this.massGridTexture;
    this.fftForwardKernel.outComplex = this.densitySpectrumTexture;
    this.poissonKernel.inDensitySpectrum = this.densitySpectrumTexture;
    this.poissonKernel.outPotentialSpectrum = this.potentialSpectrumTexture;
    this.gradientKernel.inPotentialSpectrum = this.potentialSpectrumTexture;
    this.gradientKernel.outForceSpectrumX = this.forceSpectrumX;
    this.gradientKernel.outForceSpectrumY = this.forceSpectrumY;
    this.gradientKernel.outForceSpectrumZ = this.forceSpectrumZ;
    this.fftInverseX.inComplex = this.forceSpectrumX;
    this.fftInverseX.outReal = this.forceGridX;
    this.fftInverseY.inComplex = this.forceSpectrumY;
    this.fftInverseY.outReal = this.forceGridY;
    this.fftInverseZ.inComplex = this.forceSpectrumZ;
    this.fftInverseZ.outReal = this.forceGridZ;
    this.forceSampleKernel.inForceGridX = this.forceGridX;
    this.forceSampleKernel.inForceGridY = this.forceGridY;
    this.forceSampleKernel.inForceGridZ = this.forceGridZ;
    this.forceSampleKernel.outForce = this.forceTexture;
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
   * Create a complex RG32F texture for FFT spectra
   * @param {number} width
   * @param {number} height
   */
  _createComplexTexture(width, height) {
    const gl = this.gl;
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
    gl.texImage2D(gl.TEXTURE_2D, 0, fmt, width, height, 0, 
                  fmt === gl.R32F ? gl.RED : gl.RGBA, tp, null);
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
    // 1. Compute PM forces
    this._computePMForces();
    
    // 2. Integrate physics
    this._integratePhysics();
    
    this.frameCount++;
  }
  
  _computePMForces() {
    // Set current position for deposit and force sample
    this.depositKernel.inPosition = this.positionTextures.getCurrentTexture();
    this.forceSampleKernel.inPosition = this.positionTextures.getCurrentTexture();
    
    // Run PM/FFT pipeline
    this.depositKernel.run();           // Step 1: Deposit particles to grid
    this.fftForwardKernel.run();        // Step 2: Forward FFT
    this.poissonKernel.run();           // Step 3: Solve Poisson
    this.gradientKernel.run();          // Step 4: Compute gradient
    this.fftInverseX.run();             // Step 5a: Inverse FFT X
    this.fftInverseY.run();             // Step 5b: Inverse FFT Y
    this.fftInverseZ.run();             // Step 5c: Inverse FFT Z
    this.forceSampleKernel.run();       // Step 6: Sample forces
    
    // Wire force result into velocity integrator
    if (this.velocityKernel) {
      this.velocityKernel.inForce = this.forceTexture;
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

    this.velocityTextures.swap();

    // Update positions
    if (!this.positionKernel) throw new Error('Position kernel missing');

    this.positionKernel.inPosition = this.positionTextures.getCurrentTexture();
    this.positionKernel.inVelocity = this.velocityTextures.getCurrentTexture();
    this.positionKernel.outPosition = this.positionTextures.getTargetTexture();
    this.positionKernel.run();

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
      fftInverseX: this.fftInverseX,
      fftInverseY: this.fftInverseY,
      fftInverseZ: this.fftInverseZ,
      forceSample: this.forceSampleKernel,
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
    if (this.depositKernel) this.depositKernel.dispose();
    if (this.fftForwardKernel) this.fftForwardKernel.dispose();
    if (this.poissonKernel) this.poissonKernel.dispose();
    if (this.gradientKernel) this.gradientKernel.dispose();
    if (this.fftInverseX) this.fftInverseX.dispose();
    if (this.fftInverseY) this.fftInverseY.dispose();
    if (this.fftInverseZ) this.fftInverseZ.dispose();
    if (this.forceSampleKernel) this.forceSampleKernel.dispose();
    if (this.velocityKernel) this.velocityKernel.dispose();
    if (this.positionKernel) this.positionKernel.dispose();
    
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
    
    // Clean up PM textures
    if (this.massGridTexture) gl.deleteTexture(this.massGridTexture);
    if (this.densitySpectrumTexture) gl.deleteTexture(this.densitySpectrumTexture);
    if (this.potentialSpectrumTexture) gl.deleteTexture(this.potentialSpectrumTexture);
    if (this.forceSpectrumX) gl.deleteTexture(this.forceSpectrumX);
    if (this.forceSpectrumY) gl.deleteTexture(this.forceSpectrumY);
    if (this.forceSpectrumZ) gl.deleteTexture(this.forceSpectrumZ);
    if (this.forceGridX) gl.deleteTexture(this.forceGridX);
    if (this.forceGridY) gl.deleteTexture(this.forceGridY);
    if (this.forceGridZ) gl.deleteTexture(this.forceGridZ);
    if (this.forceTexture) gl.deleteTexture(this.forceTexture);
  }
}
