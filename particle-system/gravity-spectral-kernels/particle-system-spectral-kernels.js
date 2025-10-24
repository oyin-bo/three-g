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
   *   gridSize?: number,
   *   assignment?: 'NGP'|'CIC'
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    if (!(this.gl instanceof WebGL2RenderingContext)) {
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

    // Compute world size for kernels
    const bounds = this.options.worldBounds;
    const worldSize = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    ];
    const fourPiG = 4 * Math.PI * this.options.gravityStrength;

    // 1. Deposit kernel
    this.depositKernel = new KDeposit({
      gl: this.gl,
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
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: false
    });

    // 3. Poisson solver kernel    
    this.poissonKernel = new KPoisson({
      gl: this.gl,
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
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      worldSize: /** @type {[number, number, number]} */ (worldSize)
    });

    // 5. Inverse FFT kernels (one per axis)
    this.fftInverseX = new KFFT({
      gl: this.gl,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: true
    });

    this.fftInverseY = new KFFT({
      gl: this.gl,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: true
    });

    this.fftInverseZ = new KFFT({
      gl: this.gl,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureSize: this.textureSize,
      inverse: true
    });

    // 6. Force sampling kernel
    this.forceSampleKernel = new KForceSample({
      gl: this.gl,
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
   * Infer world bounds from particle positions
   * @param {Float32Array} positions
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
    return /** @type {const} */ ({
      min: [minX - marginX, minY - marginY, minZ - marginZ],
      max: [maxX + marginX, maxY + marginY, maxZ + marginZ]
    });
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
    this.depositKernel.inPosition = this.positionTexture;
    this.forceSampleKernel.inPosition = this.positionTexture;

    // Run PM/FFT pipeline
    this.depositKernel.run();           // Step 1: Deposit particles to grid

    // Wire deposit output into FFT forward
    this.fftForwardKernel.inReal = this.depositKernel.outMassGrid;
    this.fftForwardKernel.run();        // Step 2: Forward FFT

    // Wire FFT output into Poisson
    this.poissonKernel.inDensitySpectrum = this.fftForwardKernel.outComplex;
    this.poissonKernel.run();           // Step 3: Solve Poisson

    // Wire Poisson output into Gradient
    this.gradientKernel.inPotentialSpectrum = this.poissonKernel.outPotentialSpectrum;
    this.gradientKernel.run();          // Step 4: Compute gradient

    // Wire gradient outputs into inverse FFTs
    this.fftInverseX.inComplex = this.gradientKernel.outForceSpectrumX;
    this.fftInverseX.run();             // Step 5a: Inverse FFT X

    this.fftInverseY.inComplex = this.gradientKernel.outForceSpectrumY;
    this.fftInverseY.run();             // Step 5b: Inverse FFT Y

    this.fftInverseZ.inComplex = this.gradientKernel.outForceSpectrumZ;
    this.fftInverseZ.run();             // Step 5c: Inverse FFT Z

    // Wire FFT outputs into force sampler
    this.forceSampleKernel.inForceGridX = this.fftInverseX.outReal;
    this.forceSampleKernel.inForceGridY = this.fftInverseY.outReal;
    this.forceSampleKernel.inForceGridZ = this.fftInverseZ.outReal;
    this.forceSampleKernel.run();       // Step 6: Sample forces
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
    // Dispose kernels (they own their own textures)
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
