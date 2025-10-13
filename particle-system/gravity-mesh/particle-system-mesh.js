// @ts-check

import fsQuadVert from '../shaders/fullscreen.vert.js';
import velIntegrateFrag from '../shaders/vel_integrate.frag.js';
import posIntegrateFrag from '../shaders/pos_integrate.frag.js';

import {
  unbindAllTextures as dbgUnbindAllTextures,
  checkGl as dbgCheckGl,
  checkFBO as dbgCheckFBO
} from '../utils/debug.js';

import {
  createRenderTexture,
  createPingPongTextures,
  createGeometry,
  uploadTextureData,
  createProgram,
  calculateParticleTextureDimensions,
  checkWebGL2Support
} from '../utils/common.js';

import { GPUProfiler } from '../utils/gpu-profiler.js';
import { integratePhysics } from '../utils/integrator.js';
import { createPMGrid, createPMGridFramebuffer } from '../gravity-spectral/pm-grid.js';
import { computeMeshForces } from './pipeline/compute-mesh-forces.js';

const DEFAULT_WORLD_BOUNDS = {
  min: [-4, -4, -4],
  max: [4, 4, 4]
};

/**
 * ParticleSystemMesh - Plan B (PM/FFT/TreePM) implementation scaffold.
 *
 * This class mirrors the resource layout of existing particle systems while
 * delegating force computation to the forthcoming mesh pipeline.
 */
export class ParticleSystemMesh {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {{
   *   particleData: { positions: Float32Array, velocities?: Float32Array|null, colors?: Uint8Array|null },
   *   particleCount?: number,
   *   worldBounds?: { min: [number, number, number], max: [number, number, number] },
   *   dt?: number,
   *   gravityStrength?: number,
   *   softening?: number,
   *   damping?: number,
   *   maxSpeed?: number,
   *   maxAccel?: number,
   *   enableProfiling?: boolean,
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
    if (!(gl instanceof WebGL2RenderingContext)) {
      throw new Error('ParticleSystemMesh requires WebGL2RenderingContext');
    }

    if (!options || !options.particleData) {
      throw new Error('ParticleSystemMesh requires particleData with positions, velocities, and colors');
    }

    this.gl = gl;
    this.particleData = options.particleData;
    const particleCount = options.particleData.positions.length / 4;

    const worldBounds = options.worldBounds || DEFAULT_WORLD_BOUNDS;

    this.options = {
      particleCount,
      worldBounds,
      dt: options.dt || 1 / 60,
      gravityStrength: options.gravityStrength || 0.0003,
      softening: options.softening || 0.15,
      damping: options.damping || 0.0,
      maxSpeed: options.maxSpeed || 2.0,
      maxAccel: options.maxAccel || 1.5,
      enableProfiling: options.enableProfiling || false,
      planA: true // Reuse integrator path that consumes pmForceTexture when present
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

    // Internal state
    this.isInitialized = false;
    this.frameCount = 0;

    // GPU resources
    /** @type {ReturnType<typeof createPingPongTextures> | null} */
    this.positionTextures = null;
    /** @type {ReturnType<typeof createPingPongTextures> | null} */
    this.velocityTextures = null;
    /** @type {{texture: WebGLTexture, framebuffer: WebGLFramebuffer} | null} */
    this.forceTexture = null;
    /** @type {{texture: WebGLTexture, framebuffer: WebGLFramebuffer} | null} */
    this.colorTexture = null;
    /** @type {{velIntegrate?: WebGLProgram, posIntegrate?: WebGLProgram}} */
    this.programs = {};
    /** @type {Record<string, WebGLProgram>} */
    this.meshPrograms = {};
    this.quadVAO = null;
    this.particleVAO = null;

    this.textureWidth = 0;
    this.textureHeight = 0;
    this.actualTextureSize = 0;

    // Mesh pipeline resources (to be created during init)
    this.pmGrid = null;
    this.pmGridFramebuffer = null;
    this.pmForceTexture = null;
    this.pmForceGrids = null;
    this.meshSpectrum = null;
    this.meshDensitySpectrum = null;
    this.meshPotentialSpectrum = null;
    this.meshForceSpectrum = null;
    this.meshForceGrids = null;
    this.meshNearPotentialSpectrum = null;
    this.meshNearForceSpectrum = null;
    this.meshNearForceGrids = null;

    this.profiler = null;
    if (this.options.enableProfiling) {
      this.profiler = new GPUProfiler(gl);
    }
  }

  /** @returns {void} */
  init() {
    let finished = false;
    try {
      this.checkWebGL2Support();
      this.calculateTextureDimensions();
      this.createShaderPrograms();
      this.createTextures();
      this.createGeometry();
      this.uploadParticleData();
      this.initMeshPipeline();

      // Restore GL state for host renderer compatibility
      const gl = this.gl;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.SCISSOR_TEST);

      this.isInitialized = true;
      finished = true;
    } finally {
      if (!finished) {
        this.dispose();
      }
    }
  }

  /** @returns {void} */
  checkWebGL2Support() {
    checkWebGL2Support(this.gl);
  }

  /** @returns {void} */
  calculateTextureDimensions() {
    const dims = calculateParticleTextureDimensions(this.options.particleCount);
    this.textureWidth = dims.width;
    this.textureHeight = dims.height;
    this.actualTextureSize = dims.actualSize;
  }

  /** @returns {void} */
  createShaderPrograms() {
    const gl = this.gl;
    this.programs.velIntegrate = createProgram(gl, fsQuadVert, velIntegrateFrag);
    this.programs.posIntegrate = createProgram(gl, fsQuadVert, posIntegrateFrag);
  }

  /** @returns {void} */
  createTextures() {
    const gl = this.gl;
    this.positionTextures = createPingPongTextures(gl, this.textureWidth, this.textureHeight);
    this.velocityTextures = createPingPongTextures(gl, this.textureWidth, this.textureHeight);
    this.forceTexture = createRenderTexture(gl, this.textureWidth, this.textureHeight);
    this.pmForceTexture = this.forceTexture.texture;
    this.pmForceFBO = this.forceTexture.framebuffer;
    this.colorTexture = createRenderTexture(gl, this.textureWidth, this.textureHeight, gl.RGBA8, gl.UNSIGNED_BYTE);
  }

  /** @returns {void} */
  createGeometry() {
    const { quadVAO, particleVAO } = createGeometry(this.gl, this.options.particleCount);
    this.quadVAO = quadVAO;
    this.particleVAO = particleVAO;
  }

  /** @returns {void} */
  uploadParticleData() {
    const { positions, velocities, colors } = this.particleData;

    if (!this.actualTextureSize) {
      throw new Error('ParticleSystemMesh: actualTextureSize not initialized');
    }

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

    const pos0 = this.positionTextures?.textures[0];
    const pos1 = this.positionTextures?.textures[1];
    const vel0 = this.velocityTextures?.textures[0];
    const vel1 = this.velocityTextures?.textures[1];
    const colorTex = this.colorTexture?.texture;

    if (!pos0 || !pos1 || !vel0 || !vel1 || !colorTex) {
      throw new Error('ParticleSystemMesh: textures not initialized');
    }

    uploadTextureData(this.gl, pos0, positions, this.textureWidth, this.textureHeight);
    uploadTextureData(this.gl, pos1, positions, this.textureWidth, this.textureHeight);
    uploadTextureData(this.gl, vel0, velData, this.textureWidth, this.textureHeight);
    uploadTextureData(this.gl, vel1, velData, this.textureWidth, this.textureHeight);
    uploadTextureData(this.gl, colorTex, colorData, this.textureWidth, this.textureHeight, this.gl.RGBA, /** @type {number} */ (this.gl.UNSIGNED_BYTE));
  }

  /** @returns {void} */
  initMeshPipeline() {
    const gl = this.gl;
    const gridSize = this.meshConfig.gridSize;
    this.pmGrid = createPMGrid(gl, gridSize);
    this.pmGridFramebuffer = createPMGridFramebuffer(gl, this.pmGrid.texture);
  }

  /** @returns {void} */
  step() {
    if (!this.isInitialized) return;

    if (this.profiler) {
      this.profiler.update();
    }

    // Placeholder for mesh force computation (to be implemented in later steps)
    computeMeshForces(this);

    integratePhysics(this);

    this.frameCount++;
  }

  /** @returns {WebGLTexture | null} */
  getPositionTexture() {
    return this.positionTextures?.getCurrentTexture() || null;
  }

  /** @returns {WebGLTexture[]} */
  getPositionTextures() {
    return this.positionTextures?.textures || [];
  }

  /** @returns {number} */
  getCurrentIndex() {
    return this.positionTextures?.currentIndex ?? 0;
  }

  /** @returns {WebGLTexture | null} */
  getColorTexture() {
    return this.colorTexture?.texture || null;
  }

  /** @returns {{width: number, height: number}} */
  getTextureSize() {
    return { width: this.textureWidth, height: this.textureHeight };
  }

  /** @param {string} tag */
  checkGl(tag) {
    return dbgCheckGl(this.gl, tag);
  }

  /** @param {string} tag */
  checkFBO(tag) {
    dbgCheckFBO(this.gl, tag);
  }

  /** @returns {void} */
  unbindAllTextures() {
    dbgUnbindAllTextures(this.gl);
  }

  /** @param {string} name */
  beginProfile(name) {
    if (this.profiler) {
      this.profiler.begin(name);
    }
  }

  /** @returns {void} */
  endProfile() {
    if (this.profiler) {
      this.profiler.end();
    }
  }

  /** @returns {void} */
  dispose() {
    const gl = this.gl;

    if (this.positionTextures) {
      this.positionTextures.textures.forEach(tex => gl.deleteTexture(tex));
      this.positionTextures.framebuffers.forEach(fbo => gl.deleteFramebuffer(fbo));
      this.positionTextures = null;
    }

    if (this.velocityTextures) {
      this.velocityTextures.textures.forEach(tex => gl.deleteTexture(tex));
      this.velocityTextures.framebuffers.forEach(fbo => gl.deleteFramebuffer(fbo));
      this.velocityTextures = null;
    }

    if (this.forceTexture) {
      gl.deleteTexture(this.forceTexture.texture);
      gl.deleteFramebuffer(this.forceTexture.framebuffer);
      this.forceTexture = null;
    }

    if (this.colorTexture) {
      gl.deleteTexture(this.colorTexture.texture);
      gl.deleteFramebuffer(this.colorTexture.framebuffer);
      this.colorTexture = null;
    }

    Object.values(this.programs).forEach(program => {
      if (program) {
        gl.deleteProgram(program);
      }
    });

    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.particleVAO) gl.deleteVertexArray(this.particleVAO);

    if (this.pmGrid) {
      gl.deleteTexture(this.pmGrid.texture);
      this.pmGrid = null;
    }

    if (this.pmGridFramebuffer) {
      gl.deleteFramebuffer(this.pmGridFramebuffer);
      this.pmGridFramebuffer = null;
    }

    Object.values(this.meshPrograms).forEach(program => {
      if (program) {
        gl.deleteProgram(program);
      }
    });
    this.meshPrograms = {};

    if (this.meshSpectrum) {
      gl.deleteTexture(this.meshSpectrum.texture);
      gl.deleteTexture(this.meshSpectrum.pingPong);
      gl.deleteFramebuffer(this.meshSpectrum.framebuffer);
      gl.deleteFramebuffer(this.meshSpectrum.pingPongFBO);
      this.meshSpectrum = null;
    }

    if (this.meshDensitySpectrum) {
      gl.deleteTexture(this.meshDensitySpectrum.texture);
      gl.deleteFramebuffer(this.meshDensitySpectrum.framebuffer);
      this.meshDensitySpectrum = null;
    }

    if (this.meshPotentialSpectrum) {
      gl.deleteTexture(this.meshPotentialSpectrum.texture);
      gl.deleteFramebuffer(this.meshPotentialSpectrum.framebuffer);
      this.meshPotentialSpectrum = null;
    }

    if (this.meshNearPotentialSpectrum) {
      gl.deleteTexture(this.meshNearPotentialSpectrum.texture);
      gl.deleteFramebuffer(this.meshNearPotentialSpectrum.framebuffer);
      this.meshNearPotentialSpectrum = null;
    }

    if (this.meshForceSpectrum) {
      for (const axis of Object.values(this.meshForceSpectrum)) {
        if (axis) {
          gl.deleteTexture(axis.texture);
          gl.deleteFramebuffer(axis.framebuffer);
        }
      }
      this.meshForceSpectrum = null;
    }

    if (this.meshNearForceSpectrum) {
      for (const axis of Object.values(this.meshNearForceSpectrum)) {
        if (axis) {
          gl.deleteTexture(axis.texture);
          gl.deleteFramebuffer(axis.framebuffer);
        }
      }
      this.meshNearForceSpectrum = null;
    }

    if (this.meshForceGrids) {
      const { x, y, z } = this.meshForceGrids;
      if (x) gl.deleteTexture(x);
      if (y) gl.deleteTexture(y);
      if (z) gl.deleteTexture(z);
      this.meshForceGrids = null;
    }

    if (this.meshNearForceGrids) {
      const { x, y, z } = this.meshNearForceGrids;
      if (x) gl.deleteTexture(x);
      if (y) gl.deleteTexture(y);
      if (z) gl.deleteTexture(z);
      this.meshNearForceGrids = null;
    }

    this.pmForceGrids = null;

    if (this.profiler) {
      this.profiler.dispose();
      this.profiler = null;
    }

    this.isInitialized = false;
  }
}
