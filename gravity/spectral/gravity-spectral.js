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
import { KIntegrateVelocity } from './k-integrate-velocity.js';
import { KIntegratePosition } from './k-integrate-position.js';

export class GravitySpectral {
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
    
    // For spectral method, we pack 3D grid into 2D texture using Z-slice layout.
    // Mathematical property: when slicesPerRow = ceil(sqrt(gridSize)):
    //   sliceRows = ceil(gridSize / slicesPerRow) ≈ ceil(sqrt(gridSize)) ≈ slicesPerRow
    // Therefore textures naturally work out square:
    //   textureWidth = gridSize × slicesPerRow
    //   textureHeight = gridSize × sliceRows ≈ gridSize × slicesPerRow
    // This is intentional - the formula ensures efficient square texture packing.
    this.textureWidth3D = this.gridSize * this.slicesPerRow;
    this.sliceRows3D = Math.ceil(this.gridSize / this.slicesPerRow);
    this.textureHeight3D = this.gridSize * this.sliceRows3D;

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

    // Compute mass-to-density scaling: ΔV = (Lx·Ly·Lz) / N³
    // massToDensity = 1 / ΔV = N³ / (Lx·Ly·Lz)
    const voxelVolume = (worldSize[0] * worldSize[1] * worldSize[2]) / 
                        (this.gridSize * this.gridSize * this.gridSize);
    const massToDensity = 1.0 / voxelVolume;

    // Create shared texture objects to wire kernels together
    // These prevent auto-creation of textures inside kernels
    // Textures are square: (gridSize×slicesPerRow) × (gridSize×sliceRows)
    // where sliceRows ≈ slicesPerRow due to sqrt formula
    this.massGridTexture = createTextureR32F(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.fftComplexTexture1 = createComplexTexture(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.fftComplexTexture2 = createComplexTexture(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.potentialSpectrumTexture = createComplexTexture(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.forceSpectrumXTexture = createComplexTexture(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.forceSpectrumYTexture = createComplexTexture(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.forceSpectrumZTexture = createComplexTexture(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.forceGridXTexture = createTextureR32F(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.forceGridYTexture = createTextureR32F(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.forceGridZTexture = createTextureR32F(this.gl, this.textureWidth3D, this.textureHeight3D);
    this.forceTextureOut = createTexture2D(this.gl, this.textureWidth, this.textureHeight);

    // 1. Deposit kernel
    this.depositKernel = new KDeposit({
      gl: this.gl,
      inPosition: this.positionTexture,
      outMassGrid: this.massGridTexture,
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
  textureWidth: this.textureWidth3D,
  textureHeight: this.textureHeight3D,
      worldBounds: /** @type {any} */ (this.options.worldBounds),
      assignment: this.options.assignment,
      disableFloatBlend: this.disableFloatBlend
    });

    // 2. FFT kernel
    this.fftKernel = new KFFT({
      gl: this.gl,
      real: this.massGridTexture,
      complexFrom: this.fftComplexTexture1,
      complexTo: this.fftComplexTexture2,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
  textureWidth: this.textureWidth3D,
  textureHeight: this.textureHeight3D,
      inverse: false,
      massToDensity: massToDensity
    });

    // 3. Poisson solver kernel    
    this.poissonKernel = new KPoisson({
      gl: this.gl,
      inDensitySpectrum: null,
      outPotentialSpectrum: null,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
  textureWidth: this.textureWidth3D,
  textureHeight: this.textureHeight3D,
      gravitationalConstant: fourPiG,
      worldSize: /** @type {[number, number, number]} */ (worldSize),
      assignment: this.options.assignment
    });

    // 4. Gradient kernel
    this.gradientKernel = new KGradient({
      gl: this.gl,
      inPotentialSpectrum: null,
      outForceSpectrumX: this.forceSpectrumXTexture,
      outForceSpectrumY: this.forceSpectrumYTexture,
      outForceSpectrumZ: this.forceSpectrumZTexture,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
  textureWidth: this.textureWidth3D,
  textureHeight: this.textureHeight3D,
      worldSize: /** @type {[number, number, number]} */ (worldSize)
    });

    // Note: We reuse the single fftKernel for inverse transforms by toggling the inverse flag
    // The three inverse FFTs are executed sequentially with different input textures

    // 6. Force sampling kernel
    this.forceSampleKernel = new KForceSample({
      gl: this.gl,
      inPosition: null,  // Will be set in _computePMForces
      inForceGridX: null,  // Will be set in _computePMForces
      inForceGridY: null,  // Will be set in _computePMForces
      inForceGridZ: null,  // Will be set in _computePMForces
      outForce: this.forceTextureOut,
      particleCount: this.options.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureWidth: this.textureWidth3D,
      textureHeight: this.textureHeight3D,
      worldBounds: /** @type {any} */ (this.options.worldBounds)
    });

    // 7. Integration kernels (reuse from monopole)
    this.velocityKernel = new KIntegrateVelocity({
      gl: this.gl,
      inVelocity: null,  // Will be set in _integratePhysics
      inForce: null,  // Will be set in _integratePhysics
      inPosition: null,  // Will be set in _integratePhysics
      outVelocity: null,  // Will be set in _integratePhysics
      width: this.textureWidth,
      height: this.textureHeight,
      dt: this.options.dt,
      damping: this.options.damping,
      maxSpeed: this.options.maxSpeed,
      maxAccel: this.options.maxAccel
    });

    this.positionKernel = new KIntegratePosition({
      gl: this.gl,
      inPosition: null,  // Will be set in _integratePhysics
      inVelocity: null,  // Will be set in _integratePhysics
      outPosition: null,  // Will be set in _integratePhysics
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


/**

Complex texture ownership
==========================

These complex textures may be swapped around, so we need a system to reason about it.

Few ground rules:
* KFFT holds on its complexFrom and complexTo textures
* Poisson starts with nothing, then borrow its textures from KFFT but in the end returns them
* Gradient holds on to its outForceSpectrumX/Y/Z textures although they may get swapped, but it gets exact same back anyway

Forward Step: FFT, Poisson, Gradient
------------------------------------------------

1. KFFT reads real (massGridTexture), writes complexTo which it kinda owns. Its complexFrom is scratch buffer.
   As part of FFT it swaps complexFrom and complexTo internally many times.
   Doesn't matter they are interchangeable, KFFT keeps both.

2. Poisson takes complexTo from KFFT as inDensitySpectrum, and takes KFFT's complexFrom as outPotentialSpectrum.
    At that point we null out KFFT's references to those textures since Poisson now holds them.

3. Gradient takes Poisson's outPotentialSpectrum as inPotentialSpectrum, and writes to its own outForceSpectrumX/Y/Z textures.
   Again, we null out Poisson's reference to outPotentialSpectrum since Gradient now holds it as input.

Reverse Step: Inverse FFT X/Y/Z
------------------------------------------------

1. KFFT needs actual input from Gradient's outForceSpectrumX texture.
    Poisson now lost its output to Gradient's input, so KFFT takes it for its scratch buffer complexTo.
    Note: Poisson still holds its useless input just for a little longer until the end of the reverse FFT steps.
    This is an inverse FFT, so output is real, and complexTo is a scratch buffer.
    During the FFT run, KFFT swaps complexFrom and complexTo internally many times.
    And so at the end we return complexFrom to Gradient as its outForceSpectrumX texture:
    it could be the same texture, or a different instance.

2. Now KFFT takes input from Gradient's outForceSpectrumY texture as complexFrom.
    KFFT already has complexTo as scratct buffer, no need to assign.
    (Poisson still holds input texture for a time.)
    At the end we return complexFrom to Gradient as its outForceSpectrumY texture
    (potentially swapped).

3. KFFT now takes input from Gradient's outForceSpectrumZ texture as complexFrom.
    KFFT already has complexTo as scratch buffer again.
    (Poisson still holds input texture for a time.)
    At the end of this last inverse KFFT we return complexFrom to Gradient as its outForceSpectrumZ.
    Now KFFT has a scratch complexTo, and it takes back Poisson's input texture for complexFrom
    and nulls out Poison fully. We are ready to start again.

*/

    ///////////////////////////////////////////////////////////////////////////
    // FORWARD


    // Forward FFT: real → complexFrom scratch + complexTo
    this.fftKernel.real = this.massGridTexture;
    this.fftKernel.inverse = false;
    this.fftKernel.run();

    // Solve Poisson: inDensitySpectrum from KFFT complexTo → outPotentialSpectrum taken from KFFT complexFrom
    this.poissonKernel.inDensitySpectrum = this.fftKernel.complexTo;
    this.fftKernel.complexTo = null;

    this.poissonKernel.outPotentialSpectrum = this.fftKernel.complexFrom;
    this.fftKernel.complexFrom = null;

    this.poissonKernel.run();


    // Gradient: potentialSpectrum from Poisson's outPotentialSpectrum → writes to its own forceSpectrum X/Y/Z
    this.gradientKernel.inPotentialSpectrum = this.poissonKernel.outPotentialSpectrum;
    this.poissonKernel.outPotentialSpectrum = null;

    this.gradientKernel.run();



    ///////////////////////////////////////////////////////////////////////////
    // REVERSE

    this.fftKernel.inverse = true;

    //  Inverse FFT/X: gradient's forceSpectrumX, plus gradient's inPotentialSpectrum that's now scratch → real
    this.fftKernel.complexFrom = this.gradientKernel.outForceSpectrumX;
    this.gradientKernel.outForceSpectrumX = null;

    this.fftKernel.complexTo = this.gradientKernel.inPotentialSpectrum;
    this.gradientKernel.inPotentialSpectrum = null;

    this.fftKernel.real = this.forceGridXTexture;
    this.fftKernel.run();

    this.gradientKernel.outForceSpectrumX = this.fftKernel.complexFrom;
    this.fftKernel.complexFrom = null; // returned

    // Inverse FFT/Y: gradient's forceSpectrumY (scratch already there) → real
    this.fftKernel.complexFrom = this.gradientKernel.outForceSpectrumY;
    this.gradientKernel.outForceSpectrumY = null;

    this.fftKernel.real = this.forceGridYTexture;
    this.fftKernel.run();

    this.gradientKernel.outForceSpectrumY = this.fftKernel.complexFrom;
    this.fftKernel.complexFrom = null; // returned

    // Inverse FFT/Z: gradient's forceSpectrumZ (scratch already there) → real
    this.fftKernel.complexFrom = this.gradientKernel.outForceSpectrumZ;
    this.gradientKernel.outForceSpectrumZ = null;

    this.fftKernel.real = this.forceGridZTexture;
    this.fftKernel.run();

    this.gradientKernel.outForceSpectrumZ = this.fftKernel.complexFrom;
    this.fftKernel.complexFrom = this.poissonKernel.inDensitySpectrum; // finally reclaiming from Poisson
    this.poissonKernel.inDensitySpectrum = null;


    // Sampling forces
    this.forceSampleKernel.inForceGridX = this.forceGridXTexture;
    this.forceSampleKernel.inForceGridY = this.forceGridYTexture;
    this.forceSampleKernel.inForceGridZ = this.forceGridZTexture;
    this.forceSampleKernel.run();
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
   * Capture complete system state with kernel reflections
   * @param {{pixels?: boolean}} [options]
   * @returns {object & {toString: () => string}}
   */
  valueOf(options) {
    const snapshot = {
      frameCount: this.frameCount,
      particleCount: this.options.particleCount,
      gridSize: this.gridSize,
      dt: this.options.dt,
      gravityStrength: this.options.gravityStrength,
      softening: this.options.softening,
      damping: this.options.damping,
      
      // Kernel snapshots
      deposit: this.depositKernel ? this.depositKernel.valueOf(options) : null,
      fft: this.fftKernel ? this.fftKernel.valueOf(options) : null,
      poisson: this.poissonKernel ? this.poissonKernel.valueOf(options) : null,
      gradient: this.gradientKernel ? this.gradientKernel.valueOf(options) : null,
      forceSample: this.forceSampleKernel ? this.forceSampleKernel.valueOf(options) : null,
      velocity: this.velocityKernel ? this.velocityKernel.valueOf(options) : null,
      position: this.positionKernel ? this.positionKernel.valueOf(options) : null,
    };
    // always capture to materialise at a point in time
    const snapshotStr = this._formatSnapshot(snapshot);
    snapshot.toString = () => snapshotStr;
    
    return snapshot;
  }

  /**
   * Format snapshot as compact readable string
   * @param {object} snapshot
   * @returns {string}
   */
  _formatSnapshot(snapshot) {
    let output = `\nParticleSystemSpectralKernels(${snapshot.particleCount}p grid=${snapshot.gridSize}³) frame=${snapshot.frameCount}\n`;
    output += `  dt=${snapshot.dt.toExponential(2)} G=${snapshot.gravityStrength.toExponential(2)} soft=${snapshot.softening.toFixed(2)} damp=${snapshot.damping.toFixed(2)}\n`;
    
    if (snapshot.deposit) output += '\n' + snapshot.deposit.toString().split('\n').map(l => '  ' + l).join('\n');
    if (snapshot.poisson) output += '\n' + snapshot.poisson.toString().split('\n').map(l => '  ' + l).join('\n');
    if (snapshot.gradient) output += '\n' + snapshot.gradient.toString().split('\n').map(l => '  ' + l).join('\n');
    if (snapshot.fft) output += '\n' + snapshot.fft.toString().split('\n').map(l => '  ' + l).join('\n');
    if (snapshot.forceSample) output += '\n' + snapshot.forceSample.toString().split('\n').map(l => '  ' + l).join('\n');
    if (snapshot.velocity) output += '\n' + snapshot.velocity.toString().split('\n').map(l => '  ' + l).join('\n');
    if (snapshot.position) output += '\n' + snapshot.position.toString().split('\n').map(l => '  ' + l).join('\n');
    
    return output;
  }

  /**
   * Get compact string representation
   * @returns {string}
   */
  toString() {
    return this.valueOf({ pixels: false }).toString();
  }

  dispose() {
    // Kernels own and dispose all their texture properties
    if (this.depositKernel) this.depositKernel.dispose();
    if (this.fftKernel) this.fftKernel.dispose();
    if (this.poissonKernel) this.poissonKernel.dispose();
    if (this.gradientKernel) this.gradientKernel.dispose();
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

/**
 * Create R32F single-channel texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createTextureR32F(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

/**
 * Create RG32F complex-number texture
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
