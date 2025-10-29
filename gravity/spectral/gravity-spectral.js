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

import { KBoundsReduce } from '../multipole/k-bounds-reduce.js';
import { KIntegrateEuler } from '../multipole/k-integrate-euler.js';
import { KDeposit } from './k-deposit.js';
import { KFFT } from './k-fft.js';
import { KForceSample } from './k-force-sample.js';
import { KGradient } from './k-gradient.js';
import { KPoisson } from './k-poisson.js';

export class GravitySpectral {
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
   *   gridSize?: number,
   *   assignment?: 'NGP'|'CIC'
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
    gridSize,
    assignment
  }) {
    this.gl = gl;

    if (!(this.gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystemSpectralKernels requires WebGL2RenderingContext');
    }

    if (!textureWidth || !textureHeight)
      throw new Error('GravitySpectral requires textureWidth and textureHeight');

    this.positionMassTexture = positionMassTexture;
    this.velocityColorTexture = velocityColorTexture;

    this.textureWidth = textureWidth;
    this.textureHeight = textureHeight;
    this.actualTextureSize = this.textureWidth * this.textureHeight;

    // Validate or derive particleCount
    this.particleCount = particleCount !== undefined ? particleCount : this.actualTextureSize;
    if (this.particleCount > this.actualTextureSize)
      throw new Error(`particleCount ${this.particleCount} exceeds texture capacity ${this.actualTextureSize}`);

    // Infer bounds from particle positions if not provided. NOTE: This is a placeholder.
    // In the texture-first model, bounds should ideally be provided or computed on GPU.
    // For now, we'll use a default if not provided.
    this.worldBounds = worldBounds || { min: [-4, -4, -4], max: [4, 4, 4] };
    this.dt = dt || 1 / 60;
    this.gravityStrength = gravityStrength || 0.0003;
    this.softening = softening || 0.2;
    this.damping = damping || 0.0;
    this.maxSpeed = maxSpeed || 2.0;
    this.maxAccel = maxAccel || 1.0;
    this.gridSize = gridSize || 64;
    this.assignment = assignment || 'CIC';

    this.frameCount = 0;

    // PM grid configuration
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
    this.gl.getExtension('EXT_color_buffer_float');

    const floatBlend = this.gl.getExtension('EXT_float_blend');
    this.disableFloatBlend = !floatBlend;

    // Compute world size for kernels
    const bounds = this.worldBounds;
    const worldSize = [
      bounds.max[0] - bounds.min[0],
      bounds.max[1] - bounds.min[1],
      bounds.max[2] - bounds.min[2]
    ];
    const fourPiG = 4 * Math.PI * this.gravityStrength;

    // Compute mass-to-density scaling: ΔV = (Lx·Ly·Lz) / N³
    // massToDensity = 1 / ΔV = N³ / (Lx·Ly·Lz)
    const voxelVolume = (worldSize[0] * worldSize[1] * worldSize[2]) /
      (this.gridSize * this.gridSize * this.gridSize);
    const massToDensity = 1.0 / voxelVolume;

    // Create shared texture objects to wire kernels together
    // These prevent auto-creation of textures inside kernels
    // Textures are square: (gridSize×slicesPerRow) × (gridSize×sliceRows)
    // where sliceRows ≈ slicesPerRow due to sqrt formula

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

    this.depositKernel = new KDeposit({
      gl: this.gl,
      inPosition: this.positionMassTexture,
      particleCount: this.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureWidth: this.textureWidth3D,
      textureHeight: this.textureHeight3D,
      worldBounds: /** @type {any} */ (this.worldBounds),
      assignment: this.assignment,
      disableFloatBlend: this.disableFloatBlend
    });

    this.fftKernel = new KFFT({
      gl: this.gl,
      real: null, // will be set to outMassGrid
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureWidth: this.textureWidth3D,
      textureHeight: this.textureHeight3D,
      inverse: false,
      massToDensity: massToDensity
    });

    // Choose a small Gaussian smoothing sigma (fraction of average extent) to damp high-k noise
    const avgExtent = (worldSize[0] + worldSize[1] + worldSize[2]) / 3.0;
    const gaussianSigma = avgExtent * 0.02; // 2% of average box size

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
      assignment: this.assignment,
      treePMSigma: gaussianSigma,
      splitMode: 2 // enable Gaussian low-pass by default
    });

    this.gradientKernel = new KGradient({
      gl: this.gl,
      inPotentialSpectrum: null,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureWidth: this.textureWidth3D,
      textureHeight: this.textureHeight3D,
      worldSize: /** @type {[number, number, number]} */ (worldSize)
    });

    // Note: We reuse the single fftKernel for inverse transforms by toggling the inverse flag
    // The three inverse FFTs are executed sequentially with different input textures

    this.forceSampleKernel = new KForceSample({
      gl: this.gl,
      inPosition: null,  // Will be ultimately propagated from positionMassTexture
      particleCount: this.particleCount,
      particleTexWidth: this.textureWidth,
      particleTexHeight: this.textureHeight,
      gridSize: this.gridSize,
      slicesPerRow: this.slicesPerRow,
      textureWidth: this.textureWidth3D,
      textureHeight: this.textureHeight3D,
      worldBounds: /** @type {any} */ (this.worldBounds)
    });

    // GPU bounds reduction kernel (cloned and reused locally)
    this.boundsReduce = new KBoundsReduce({
      gl: this.gl,
      inPosition: this.positionMassTexture,
      particleTextureWidth: this.textureWidth,
      particleTextureHeight: this.textureHeight,
      particleCount: this.particleCount
    });

    // How often to run bounds reduction (frames)
    this.boundsInterval = 30;

    // Create reusable resources for bounds readback (hot path - no alloc/dealloc per frame)
    this.boundsReadbackBuffer = new Float32Array(8);
    this.boundsReadbackFBO = this.gl.createFramebuffer();
  }

  /**
   * Step the simulation forward one frame
   */
  step() {
    this.frameCount++;

    // Set current position for deposit and force sample
    this.depositKernel.inPosition = this.positionMassTexture;
    this.forceSampleKernel.inPosition = this.positionMassTexture;

    // Run PM/FFT pipeline
    this.depositKernel.run();           // Step 1: Deposit particles to grid

    // Periodic GPU bounds check: run KBoundsReduce every boundsInterval frames
    if (this.boundsReduce && (this.frameCount % this.boundsInterval === 0)) {
      this.boundsReduce.inPosition = this.positionMassTexture;
      this.boundsReduce.particleTextureWidth = this.textureWidth;
      this.boundsReduce.particleTextureHeight = this.textureHeight;
      this.boundsReduce.particleCount = this.particleCount;
      this.boundsReduce.run();

      // Read back 2x1 bounds texture (min, max) using pre-allocated resources
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.boundsReadbackFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.boundsReduce.outBounds, 0);
      gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, this.boundsReadbackBuffer);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      const newMin = [this.boundsReadbackBuffer[0], this.boundsReadbackBuffer[1], this.boundsReadbackBuffer[2]];
      const newMax = [this.boundsReadbackBuffer[4], this.boundsReadbackBuffer[5], this.boundsReadbackBuffer[6]];

      // Add small margin to avoid thrashing
      const marginFactor = 0.05;
      const outMin = [0, 0, 0], outMax = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const span = Math.max(1e-6, newMax[i] - newMin[i]);
        outMin[i] = newMin[i] - marginFactor * span;
        outMax[i] = newMax[i] + marginFactor * span;
      }
      this.worldBounds = { min: /** @type {[number,number,number]} */(outMin), max: /** @type {[number,number,number]} */(outMax) };

      const newWorldSize = [outMax[0] - outMin[0], outMax[1] - outMin[1], outMax[2] - outMin[2]];
      const voxelVolume = (newWorldSize[0] * newWorldSize[1] * newWorldSize[2]) / (this.gridSize * this.gridSize * this.gridSize);
      const massToDensity = 1.0 / voxelVolume;

      if (this.fftKernel) this.fftKernel.massToDensity = massToDensity;
      if (this.poissonKernel) this.poissonKernel.worldSize = /** @type {[number,number,number]} */ (newWorldSize);
      if (this.gradientKernel) this.gradientKernel.worldSize = /** @type {[number,number,number]} */ (newWorldSize);
      if (this.forceSampleKernel) this.forceSampleKernel.worldBounds = { min: /** @type {[number,number,number]} */(outMin), max: /** @type {[number,number,number]} */(outMax) };
      if (this.depositKernel) this.depositKernel.worldBounds = { min: /** @type {[number,number,number]} */(outMin), max: /** @type {[number,number,number]} */(outMax) };
    }


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
    this.fftKernel.real = /** @type {WebGLTexture} */ (this.depositKernel.outMassGrid);
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
    if (!this.fftKernel.complexTo) throw new Error('FFT kernel complexTo texture is null');
    this.gradientKernel.inPotentialSpectrum = null;

    this.fftKernel.real = /** @type {WebGLTexture} */ (this.forceSampleKernel.inForceGridX);
    this.fftKernel.run();

    this.gradientKernel.outForceSpectrumX = this.fftKernel.complexFrom;
    this.fftKernel.complexFrom = null; // returned

    // Inverse FFT/Y: gradient's forceSpectrumY (scratch already there) → real
    this.fftKernel.complexFrom = this.gradientKernel.outForceSpectrumY;
    this.gradientKernel.outForceSpectrumY = null;

    this.fftKernel.real = /** @type {WebGLTexture} */ (this.forceSampleKernel.inForceGridY);
    this.fftKernel.run();

    this.gradientKernel.outForceSpectrumY = this.fftKernel.complexFrom;
    this.fftKernel.complexFrom = null; // returned

    // Inverse FFT/Z: gradient's forceSpectrumZ (scratch already there) → real
    if (!this.gradientKernel.outForceSpectrumZ) throw new Error('Gradient kernel outForceSpectrumZ texture is null');
    this.fftKernel.complexFrom = this.gradientKernel.outForceSpectrumZ;
    this.gradientKernel.outForceSpectrumZ = null;

    this.fftKernel.real = /** @type {WebGLTexture} */ (this.forceSampleKernel.inForceGridZ);
    this.fftKernel.run();

    this.gradientKernel.outForceSpectrumZ = this.fftKernel.complexFrom;
    if (!this.poissonKernel.inDensitySpectrum) throw new Error('Poisson kernel inDensitySpectrum texture is null');
    this.fftKernel.complexFrom = this.poissonKernel.inDensitySpectrum; // finally reclaiming from Poisson
    this.poissonKernel.inDensitySpectrum = null;


    // Sampling forces
    this.forceSampleKernel.run();

    // allow external inputs
    this.integrateEulerKernel.inVelocity = this.velocityColorTexture;
    this.integrateEulerKernel.inPosition = this.positionMassTexture;
    this.integrateEulerKernel.inForce = this.forceSampleKernel.outForce;
    this.integrateEulerKernel.run();

    // swap and leave updated textures in system properties
    this.positionMassTexture = this.integrateEulerKernel.outPosition;
    this.velocityColorTexture = this.integrateEulerKernel.outVelocity;

    this.integrateEulerKernel.outVelocity = this.integrateEulerKernel.inVelocity;
    this.integrateEulerKernel.outPosition = this.integrateEulerKernel.inPosition;
    this.integrateEulerKernel.inPosition = this.positionMassTexture;
    this.integrateEulerKernel.inVelocity = this.velocityColorTexture;

    // Swap force textures for next frame
    const temp = this.integrateEulerKernel.inForce;
    this.integrateEulerKernel.inForce = this.forceSampleKernel.outForce;
    this.forceSampleKernel.outForce = temp;
  }

  /**
   * Capture complete system state with kernel reflections
   * @param {{pixels?: boolean}} [options]
   * @returns {object & {toString: () => string}}
   */
  valueOf(options) {
    const snapshot = {
      frameCount: this.frameCount,
      particleCount: this.particleCount,
      gridSize: this.gridSize,
      dt: this.dt,
      gravityStrength: this.gravityStrength,
      softening: this.softening,
      damping: this.damping,

      // Kernel snapshots
      deposit: this.depositKernel ? this.depositKernel.valueOf(options) : null,
      fft: this.fftKernel ? this.fftKernel.valueOf(options) : null,
      poisson: this.poissonKernel ? this.poissonKernel.valueOf(options) : null,
      gradient: this.gradientKernel ? this.gradientKernel.valueOf(options) : null,
      forceSample: this.forceSampleKernel ? this.forceSampleKernel.valueOf(options) : null,
      integrate: this.integrateEulerKernel ? this.integrateEulerKernel.valueOf(options) : null,
    };
    // always capture to materialise at a point in time
    const snapshotStr = this._formatSnapshot(snapshot);
    snapshot.toString = () => snapshotStr;

    return snapshot;
  }

  /**
   * Format snapshot as compact readable string
   * @param {any} snapshot
   * @returns {string}
   */
  _formatSnapshot(snapshot) {
    let output = `\nParticleSystemSpectralKernels(${snapshot.particleCount}p grid=${snapshot.gridSize}³) frame=${snapshot.frameCount}\n`;
    output += `  dt=${snapshot.dt.toExponential(2)} G=${snapshot.gravityStrength.toExponential(2)} soft=${snapshot.softening.toFixed(2)} damp=${snapshot.damping.toFixed(2)}\n`;

    if (snapshot.deposit) output += '\n' + snapshot.deposit.toString().replace(/^/gm, '  ');
    if (snapshot.poisson) output += '\n' + snapshot.poisson.toString().replace(/^/gm, '  ');
    if (snapshot.gradient) output += '\n' + snapshot.gradient.toString().replace(/^/gm, '  ');
    if (snapshot.fft) output += '\n' + snapshot.fft.toString().replace(/^/gm, '  ');
    if (snapshot.forceSample) output += '\n' + snapshot.forceSample.toString().replace(/^/gm, '  ');
    if (snapshot.integrate) output += '\n' + snapshot.integrate.toString().replace(/^/gm, '  ');

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
    if (this.integrateEulerKernel) this.integrateEulerKernel.dispose();
    if (this.boundsReduce) this.boundsReduce.dispose();
    if (this.boundsReadbackFBO) this.gl.deleteFramebuffer(this.boundsReadbackFBO);
  }
}
