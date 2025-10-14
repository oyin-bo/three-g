// @ts-check

// Shader sources
import fsQuadVert from '../shaders/fullscreen.vert.js';
import posIntegrateFrag from '../shaders/pos_integrate.frag.js';
import velIntegrateFrag from '../shaders/vel_integrate.frag.js';
import fftFrag from './shaders/fft.frag.js';
import forceSampleFrag from './shaders/force-sample.frag.js';
import forceSampleVert from './shaders/force-sample.vert.js';
import gradientFrag from './shaders/gradient.frag.js';
import poissonFrag from './shaders/poisson.frag.js';

import { checkFBO, checkGl, unbindAllTextures } from '../utils/debug.js';

// Shared resource helpers
import {
  calculateParticleTextureDimensions,
  checkWebGL2Support,
  createGeometry,
  createProgram as createGLProgram,
  createPingPongTextures,
  createRenderTexture,
  uploadTextureData
} from '../utils/common.js';

// Pipeline utilities
import { updateWorldBoundsFromTexture } from '../utils/bounds.js';
import { GPUProfiler } from '../utils/gpu-profiler.js';
import { integratePhysics } from '../utils/integrator.js';
import { pmDebugRunSingle } from './debug/index.js';
import { createPMDepositProgram } from './pm-deposit.js';
import { createPMGrid, createPMGridFramebuffer } from './pm-grid.js';
import { computePMForcesSync } from './pm-pipeline.js';

/**
 * ParticleSystem Spectral - Particle-Mesh with FFT (Spectral Method)
 * 
 * GPU-accelerated N-body simulation using Particle-Mesh (PM) method with FFT
 * for spectral force computation. Scales well with uniform particle distributions
 * and provides excellent accuracy for smooth density fields.
 * 
 * Uses O(N + M log M) complexity where N is particle count and M is grid size.
 * Fourier-space Poisson solver enables efficient long-range force computation.
 */
export class ParticleSystemSpectral {

  /**
   * ParticleSystemSpectral constructor
   * @param {WebGL2RenderingContext} gl - WebGL2 rendering context
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
   *   enableProfiling?: boolean,
   * }} options
   */
  constructor(gl, options) {
    // ONLY dependency: WebGL2 context (reuses existing from THREE.WebGLRenderer)
    this.gl = gl;

    // Validate context (don't create!)
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystem requires WebGL2RenderingContext');
    }

    // Validate and store particle data
    if (!options.particleData) {
      throw new Error('ParticleSystem requires particleData with positions, velocities, and colors');
    }

    this.particleData = options.particleData;
    const particleCount = options.particleData.positions.length / 4;

    const inferredBounds = (() => {
      const positions = options.particleData.positions;
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
    })();

    this.options = {
      particleCount: particleCount,
      worldBounds: options.worldBounds || inferredBounds,
      dt: options.dt || 1 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.2,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.0,
      enableProfiling: options.enableProfiling || false,
      planA: true
    };

    // Internal state
    this.frameCount = 0;

    this.textureWidth = 0;
    this.textureHeight = 0;
    this.actualTextureSize = 0;
    this._lastBoundsUpdateFrame = -1;
    // Time (ms) when bounds were last updated via GPU readback
    this._lastBoundsUpdateTime = -1;
    this.particleCount = particleCount;

    // GPU Profiler (created only if enabled)
    this.profiler = null;
    if (this.options.enableProfiling) {
      this.profiler = new GPUProfiler(gl);
    }

    // PM Debug state (for Plan A debugging)
    /** @type {any} */
    this._pmDebugState = null;

    // Verify required WebGL2 capabilities and cache dimensions
    this.checkWebGL2Support();
    this.calculateTextureDimensions();

    let finished = false;
    try {
      const gl = this.gl;

      // Compile the integrator shader programs used for velocity/position updates
      /** @type {{velIntegrate: WebGLProgram, posIntegrate: WebGLProgram}} */
      this.programs = {
        velIntegrate: createGLProgram(gl, fsQuadVert, velIntegrateFrag),
        posIntegrate: createGLProgram(gl, fsQuadVert, posIntegrateFrag)
      };

      // Allocate the core simulation textures (ping-pong position/velocity and render targets)
      /** @type {ReturnType<typeof createPingPongTextures>} */
      this.positionTextures = createPingPongTextures(gl, this.textureWidth, this.textureHeight);
      /** @type {ReturnType<typeof createPingPongTextures>} */
      this.velocityTextures = createPingPongTextures(gl, this.textureWidth, this.textureHeight);
      this.forceTexture = createRenderTexture(gl, this.textureWidth, this.textureHeight);
      this.colorTexture = createRenderTexture(gl, this.textureWidth, this.textureHeight, gl.RGBA8, gl.UNSIGNED_BYTE);

      // Upload the initial particle attribute data into GPU textures
      const { positions, velocities, colors } = this.particleData;
      const expectedLength = this.actualTextureSize * 4;
      if (positions.length !== expectedLength) {
        throw new Error(`Position data length mismatch: expected ${expectedLength}, got ${positions.length}`);
      }
      if (velocities && velocities.length !== expectedLength) {
        throw new Error(`Velocity data length mismatch: expected ${expectedLength}, got ${velocities.length}`);
      }
      if (colors && colors.length !== expectedLength) {
        throw new Error(`Color data length mismatch: expected ${expectedLength}, got ${colors.length}`);
      }

      const velData = velocities || new Float32Array(expectedLength);
      const colorData = colors || new Uint8Array(expectedLength).fill(255);

      const pos0 = this.positionTextures.textures[0];
      const pos1 = this.positionTextures.textures[1];
      const vel0 = this.velocityTextures.textures[0];
      const vel1 = this.velocityTextures.textures[1];
      const colorTex = this.colorTexture.texture;

      uploadTextureData(gl, pos0, positions, this.textureWidth, this.textureHeight);
      uploadTextureData(gl, pos1, positions, this.textureWidth, this.textureHeight);
      uploadTextureData(gl, vel0, velData, this.textureWidth, this.textureHeight);
      uploadTextureData(gl, vel1, velData, this.textureWidth, this.textureHeight);
      uploadTextureData(gl, colorTex, colorData, this.textureWidth, this.textureHeight, gl.RGBA, /** @type {number} */(gl.UNSIGNED_BYTE));

      // Create the fullscreen quad and particle index geometry
      const geometry = createGeometry(gl, this.options.particleCount);
      this.quadVAO = geometry.quadVAO;
      this.particleVAO = geometry.particleVAO;

      // Provision PM grid resources used by the spectral force pipeline
      const gridSize = 64;
      const pmGrid = createPMGrid(gl, gridSize);
      this.pmGrid = pmGrid;
      this.pmGridFramebuffer = createPMGridFramebuffer(gl, pmGrid.texture);

      const textureSize = pmGrid.size;
      const gridResolution = pmGrid.gridSize;

      const createRGBA32Texture = () => {
        const tex = gl.createTexture();
        if (!tex) throw new Error('Failed to create RGBA32F texture');
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, textureSize, textureSize, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
      };

      const createRG32Texture = () => {
        const tex = gl.createTexture();
        if (!tex) throw new Error('Failed to create RG32F texture');
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, textureSize, textureSize, 0, gl.RG, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
      };

      const createFramebufferForTexture = (texture) => {
        const fbo = gl.createFramebuffer();
        if (!fbo) throw new Error('Failed to create framebuffer');
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
        const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        if (status !== gl.FRAMEBUFFER_COMPLETE) {
          throw new Error(`Framebuffer incomplete: 0x${status.toString(16)}`);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return fbo;
      };

      // FFT program and spectrum textures
      this.pmFFTProgram = this.createProgram(fsQuadVert, fftFrag);

      const spectrumTexture = createRGBA32Texture();
      const spectrumFBO = createFramebufferForTexture(spectrumTexture);
      const pingPongTexture = createRGBA32Texture();
      const pingPongFBO = createFramebufferForTexture(pingPongTexture);

      this.pmSpectrum = {
        texture: spectrumTexture,
        framebuffer: spectrumFBO,
        pingPong: pingPongTexture,
        pingPongFBO: pingPongFBO,
        gridSize: gridResolution,
        textureSize: textureSize,
        width: textureSize,
        height: textureSize
      };

      const densityTexture = createRGBA32Texture();
      const densityFBO = createFramebufferForTexture(densityTexture);
      this.pmDensitySpectrum = {
        texture: densityTexture,
        framebuffer: densityFBO,
        gridSize: gridResolution,
        textureSize: textureSize,
        width: textureSize,
        height: textureSize
      };

      // Poisson solver resources
      this.pmPoissonProgram = this.createProgram(fsQuadVert, poissonFrag);
      const potentialTexture = createRG32Texture();
      const potentialFBO = gl.createFramebuffer();
      if (!potentialFBO) throw new Error('Failed to create Poisson framebuffer');
      this.pmPotentialSpectrum = {
        texture: potentialTexture,
        framebuffer: potentialFBO,
        gridSize: gridResolution,
        textureSize: textureSize
      };

      // Gradient / force spectra
      this.pmGradientProgram = this.createProgram(fsQuadVert, gradientFrag);
      const makeForceSpectrumTarget = () => {
        const texture = createRG32Texture();
        const framebuffer = gl.createFramebuffer();
        if (!framebuffer) throw new Error('Failed to create force spectrum framebuffer');
        return { texture, framebuffer };
      };
      this.pmForceSpectrum = {
        x: makeForceSpectrumTarget(),
        y: makeForceSpectrumTarget(),
        z: makeForceSpectrumTarget(),
        gridSize: gridResolution,
        textureSize: textureSize
      };

      // Force grids (real-space inverse FFT results)
      const makeForceGridTexture = () => {
        const tex = gl.createTexture();
        if (!tex) throw new Error('Failed to create force grid texture');
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, textureSize, textureSize, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        return tex;
      };
      this.pmForceGrids = {
        x: makeForceGridTexture(),
        y: makeForceGridTexture(),
        z: makeForceGridTexture(),
        textureSize: textureSize
      };

      // Force sampling program and particle force texture
      this.pmForceSampleProgram = this.createProgram(forceSampleVert, forceSampleFrag);
      const forceTexture = gl.createTexture();
      if (!forceTexture) throw new Error('Failed to create particle force texture');
      gl.bindTexture(gl.TEXTURE_2D, forceTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, this.textureWidth, this.textureHeight, 0, gl.RGBA, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      this.pmForceTexture = forceTexture;

      const forceFBO = gl.createFramebuffer();
      if (!forceFBO) throw new Error('Failed to create force framebuffer');
      this.pmForceFBO = forceFBO;

      this.forceTexture = {
        texture: this.pmForceTexture,
        framebuffer: this.pmForceFBO
      };

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindVertexArray(null);
      // NOTE: Don't call gl.useProgram(null) - breaks THREE.js shaders!
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);

      finished = true;
    } finally {
      if (!finished)
        this.dispose();
    }
  }

  createProgram(vertexSource, fragmentSource) {
    return createGLProgram(this.gl, vertexSource, fragmentSource);
  }

  // Debug helper: unbind all textures on commonly used units to avoid feedback loops
  unbindAllTextures() {
    unbindAllTextures(this.gl);
  }

  // Debug helper: log gl errors with a tag
  /**
   * @param {string} tag
   */
  checkGl(tag) {
    return checkGl(this.gl, tag);
  }

  // Debug helper: check FBO completeness and tag
  /**
   * @param {string} tag
   */
  checkFBO(tag) {
    checkFBO(this.gl, tag);
  }

  checkWebGL2Support() {
    const gl = this.gl;

    const result = checkWebGL2Support(gl);
    if (result.disableFloatBlend) {
      console.warn('EXT_float_blend extension not supported: additive blending performance may degrade.');
    }
  }

  calculateTextureDimensions() {
    const dims = calculateParticleTextureDimensions(this.options.particleCount);
    this.textureWidth = dims.width;
    this.textureHeight = dims.height;
    this.actualTextureSize = dims.actualSize;
  }

  step() {
    // Update profiler (collect completed query results)
    if (this.profiler) {
      this.profiler.update();
    }

    // Check if PM debug is running in single-stage mode
    if (this._pmDebugState?.config?.enabled && this._pmDebugState.config.singleStageRun) {
      // Run exactly one stage in isolation, skip normal pipeline
      const { stage, source, sink } = this._pmDebugState.config.singleStageRun;
      pmDebugRunSingle(this, stage, source, sink);
      return;
    }

    // Update world bounds from texture infrequently (every 10 seconds) to avoid GPU-CPU stalls.
    const now = performance.now ? performance.now() : Date.now();
    // DISABLED: Dynamic bounds updates cause feedback loop with any force miscalculation
    // const updateIntervalMs = 10000; // 10 seconds
    // if (this._lastBoundsUpdateTime < 0 || (now - this._lastBoundsUpdateTime) >= updateIntervalMs) {
    //   try {
    //     updateWorldBoundsFromTexture(this, 16);
    //   } catch (e) {
    //     // Swallow errors here to avoid breaking the simulation loop; leave previous bounds in place
    //     console.warn('updateWorldBoundsFromTexture failed:', e);
    //   }
    //   this._lastBoundsUpdateTime = now;
    // }

    computePMForcesSync(this);

    // Profile integration (split into velocity + position for granularity)
    integratePhysics(this);

    this.frameCount++;
  }

  getPositionTexture() {
    return this.positionTextures?.getCurrentTexture() || null;
  }

  getPositionTextures() {
    // Returns BOTH textures for ping-pong
    return this.positionTextures?.textures || [];
  }

  getCurrentIndex() {
    return this.positionTextures?.currentIndex ?? 0;
  }

  getColorTexture() {
    return this.colorTexture?.texture || null;
  }

  getTextureSize() {
    return { width: this.textureWidth, height: this.textureHeight };
  }

  /**
   * Begin profiling a custom timer (e.g., for rendering)
   * @param {string} name - Timer name
   */
  beginProfile(name) {
    if (this.profiler) {
      this.profiler.begin(name);
    }
  }

  /**
   * End profiling the current timer
   */
  endProfile() {
    if (this.profiler) {
      this.profiler.end();
    }
  }

  dispose() {
    const gl = this.gl;

    if (this.positionTextures) {
      this.positionTextures.textures.forEach(tex => gl.deleteTexture(tex));
      this.positionTextures.framebuffers.forEach(fbo => gl.deleteFramebuffer(fbo));
    }
    if (this.velocityTextures) {
      this.velocityTextures.textures.forEach(tex => gl.deleteTexture(tex));
      this.velocityTextures.framebuffers.forEach(fbo => gl.deleteFramebuffer(fbo));
    }
    if (this.forceTexture) {
      gl.deleteTexture(this.forceTexture.texture);
      gl.deleteFramebuffer(this.forceTexture.framebuffer);
    }
    if (this.colorTexture) {
      gl.deleteTexture(this.colorTexture.texture);
      gl.deleteFramebuffer(this.colorTexture.framebuffer);
    }

    Object.values(this.programs).forEach(program => gl.deleteProgram(program));

    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.particleVAO) gl.deleteVertexArray(this.particleVAO);

    // Clean up profiler
    if (this.profiler) {
      this.profiler.dispose();
      this.profiler = null;
    }

  }
}
