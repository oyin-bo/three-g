// @ts-check

import { ParticleSystemMesh } from './gravity-mesh/particle-system-mesh.js';
import { ParticleSystemMonopole } from './gravity-monopole/particle-system-monopole.js';
import { ParticleSystemQuadrupole } from './gravity-quadrupole/particle-system-quadrupole.js';
import { ParticleSystemSpectral } from './gravity-spectral/particle-system-spectral.js';
import * as pipelineDebug from './gravity-quadrupole/debug/index.js';
import { pmDebugInit, pmDebugRunSingle, pmSnapshotDispose, pmSnapshotLoad, pmSnapshotStore } from './gravity-spectral/debug/index.js';
import * as pmMetrics from './gravity-spectral/debug/metrics.js';
import * as pmOverlay from './gravity-spectral/debug/overlay.js';
import { listSnapshots } from './gravity-spectral/debug/snapshot.js';
import * as pmSynthetic from './gravity-spectral/debug/synthetic.js';
import * as pmTestRunner from './gravity-spectral/debug/test-runner.js';
import { quickDiagnostic, runAllTests } from './gravity-spectral/debug/test-runner.js';

/**
 * @typedef {{
 *   compute: () => void,
 *   getPositionTexture: () => WebGLTexture,
 *   getPositionTextures: () => WebGLTexture[],
 *   getCurrentIndex: () => 0 | 1,
 *   getColorTexture: () => WebGLTexture|null,
 *   getTextureSize: () => { width: number, height: number },
 *   options: object,
 *   particleCount: number,
 *   stats: () => any,
 *   beginProfile: (name: any) => void,
 *   endProfile: () => void,
 *   unload(particles: any[], set?: (payload: {
 *     particle: any,
 *     index: number,
 *     x: number, y: number, z: number,
 *     vx: number, vy: number, vz: number
 *   }) => void): void,
 *   dispose: () => void,
 *   setDebugMode?: (mode: any) => any,
 *   setDebugFlags?: (flags: any) => any,
 *   step_Debug?: () => any,
 *   _system: import('./gravity-quadrupole/particle-system-quadrupole.js').ParticleSystemQuadrupole | import('./gravity-monopole/particle-system-monopole.js').ParticleSystemMonopole | import('./gravity-spectral/particle-system-spectral.js').ParticleSystemSpectral | import('./gravity-mesh/particle-system-mesh.js').ParticleSystemMesh,
 *   pmForceTexture?: WebGLTexture,
 *   pmGrid?: any,
 *   pmGridFramebuffer?: WebGLFramebuffer,
 *   pmDepositProgram?: WebGLProgram,
 *   pmDebug?: {
 *     quickDiag: () => Promise<any>,
 *     runAllTests: () => Promise<any>,
 *     init: (config: any) => any,
 *     runStage: (stage: import('./gravity-spectral/debug/types.js').PMStageID, source?: any, sink?: any) => any,
 *     snapshot: {
 *       store: (key: string, atStage: import('./gravity-spectral/debug/types.js').PMStageID) => any,
 *       load: (key: string, forStage: import('./gravity-spectral/debug/types.js').PMStageID) => any,
 *       dispose: (key: string) => any,
 *       list: () => any
 *     },
 *     modules: {
 *       metrics: typeof import('./gravity-spectral/debug/metrics.js'),
 *       overlay: typeof import('./gravity-spectral/debug/overlay.js'),
 *       synthetic: typeof import('./gravity-spectral/debug/synthetic.js'),
 *       testRunner: typeof import('./gravity-spectral/debug/test-runner.js')
 *     }
 *   },
 *   _debug?: () => typeof import('./gravity-spectral/debug/index.js'),
 * }} ParticleSystemAPI
 */

/**
 * Create a GPU-accelerated N-body simulation
 * Methods:
 * - 'quadrupole' (default): 2nd-order Barnes-Hut tree-code
 * - 'monopole': 1st-order Barnes-Hut tree-code
 * - 'spectral': Particle-Mesh with FFT (spectral method)
 * @param {{
 *   gl: WebGL2RenderingContext,
 *   particles: any[],
 *   get?: (spot: any, out: {
 *    x?: number, y?: number, z?: number,
 *    vx?: number, vy?: number, vz?: number,
 *    mass?: number,
 *    rgb?: number }) => void,
 *   method?: 'quadrupole' | 'monopole' | 'spectral' | 'mesh',
 *   theta?: number,
 *   gravityStrength?: number,
 *   dt?: number,
 *   softening?: number,
 *   damping?: number,
 *   maxSpeed?: number,
 *   maxAccel?: number,
 *   worldBounds?: { min: [number,number,number], max: [number,number,number] },
 *   debugSkipQuadtree?: boolean,
 *   enableProfiling?: boolean,
 *   edges?: Iterable<{from: number, to: number, strength: number}>,
 *   springStrength?: number,
 *   mesh?: {
 *     assignment?: 'ngp' | 'cic',
 *     gridSize?: number,
 *     slicesPerRow?: number,
 *     kCut?: number,
 *     splitSigma?: number,
 *     nearFieldRadius?: number
 *   }
 * }} options
 * @returns {ParticleSystemAPI}
 */
export function particleSystem({
  gl,
  particles,
  get,
  method = 'quadrupole',
  theta,
  gravityStrength = 0.0003,
  dt = 1 / 60,
  softening = 0.2,
  damping = 0.0,
  maxSpeed = 2.0,
  maxAccel = 1.0,
  worldBounds,
  debugSkipQuadtree = false,
  enableProfiling = false,
  edges,
  springStrength = 0.001,
  mesh: meshConfig
}) {
  // Compute particle count from positions array (RGBA = 4 components per particle)
  const particleCount = particles.length;

  // Calculate texture dimensions
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  const actualTextureSize = textureWidth * textureHeight;

  // possibly padded!
  const positions = new Float32Array(actualTextureSize * 4);
  const velocities = new Float32Array(actualTextureSize * 4);
  const colors = new Uint8Array(actualTextureSize * 4);

  populateBuffers({ particles, get, positionsBuf: positions, velocitiesBuf: velocities, colorsBuf: colors });

  /** @type {ParticleSystemQuadrupole | ParticleSystemMonopole | ParticleSystemSpectral | ParticleSystemMesh} */
  let system;

  switch (method) {
    case 'mesh': {
      system = new ParticleSystemMesh(gl, {
        particleCount,
        particleData: {
          positions,
          velocities,
          colors
        },
        gravityStrength,
        dt,
        softening,
        damping,
        maxSpeed,
        maxAccel,
        worldBounds,
        enableProfiling,
        mesh: meshConfig
      });
      break;
    }
    case 'spectral': {
      system = new ParticleSystemSpectral(gl, {
        particleCount,
        particleData: {
          positions,
          velocities,
          colors
        },
        worldBounds,
        dt,
        gravityStrength,
        softening,
        damping,
        maxSpeed,
        maxAccel,
        enableProfiling
      });
      break;
    }
    case 'monopole': {
      system = new ParticleSystemMonopole(gl, {
        particleCount,
        particleData: {
          positions,
          velocities,
          colors
        },
        theta: theta !== undefined ? theta : 0.65,
        gravityStrength,
        dt,
        softening,
        damping,
        maxSpeed,
        maxAccel,
        worldBounds,
        debugSkipQuadtree,
        enableProfiling,
        edges,
        springStrength,
        assignment: 'CIC',
        poissonUseDiscrete: 0,
        treePMSigma: 0.0
      });
      break;
    }
    case 'quadrupole':
    default: {
      system = new ParticleSystemQuadrupole(gl, {
        particleCount,
        particleData: {
          positions,
          velocities,
          colors
        },
        theta: theta !== undefined ? theta : 0.65,
        gravityStrength,
        dt,
        softening,
        damping,
        maxSpeed,
        maxAccel,
        worldBounds,
        debugSkipQuadtree,
        enableProfiling,
        edges,
        springStrength,
        assignment: 'CIC',
        poissonUseDiscrete: 0,
        treePMSigma: 0.0
      });
      break;
    }
  }

  let disposed = false;

  // Base API common to all methods
  /** @type {ParticleSystemAPI} */
  const baseAPI = {
    // Step simulation forward (main loop call)
    compute: () => {
      if (disposed) return;
      system.step();
    },

    // Get GPU textures for rendering (GPU-to-GPU data flow)
    // These return WebGLTexture objects that can be wrapped in THREE.ExternalTexture
    getPositionTexture: () => system.getPositionTexture(),
    getPositionTextures: () => system.getPositionTextures(),  // Returns array of BOTH ping-pong textures
    getCurrentIndex: () => system.getCurrentIndex(),          // Returns current ping-pong index (0 or 1)
    getColorTexture: () => system.getColorTexture(),
    getTextureSize: () => system.getTextureSize(),

    unload: (particles, set) => {
      const expected = system.options.particleCount;
      if (particles.length !== expected) {
        throw new Error(`unload expected ${expected} particles, received ${particles.length}`);
      }

      const gl = system.gl;
      if (!gl) {
        throw new Error('WebGL context unavailable for unload');
      }

      const positionTextures = system.getPositionTextures();
      const velocityTextures = system.velocityTextures?.textures || [];
      if (!positionTextures.length || !velocityTextures.length) {
        throw new Error('Particle textures are not available for unload');
      }

      const positionIndex = system.getCurrentIndex();
      const velocityIndex = system.velocityTextures?.currentIndex ?? positionIndex;
      const positionTexture = positionTextures[positionIndex];
      const velocityTexture = velocityTextures[velocityIndex];
      if (!positionTexture || !velocityTexture) {
        throw new Error('Active particle textures missing during unload');
      }

      const { width, height } = system.getTextureSize();
      const totalTexels = width * height;
      const positionData = new Float32Array(totalTexels * 4);
      const velocityData = new Float32Array(totalTexels * 4);

      const previousFramebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      const tempFramebuffer = gl.createFramebuffer();
      if (!tempFramebuffer) {
        throw new Error('Failed to allocate framebuffer for unload');
      }

      try {
        gl.bindFramebuffer(gl.FRAMEBUFFER, tempFramebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, positionTexture, 0);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, positionData);

        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velocityTexture, 0);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, velocityData);
      } finally {
        gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
        gl.deleteFramebuffer(tempFramebuffer);
      }

      for (let i = 0; i < expected; i++) {
        const base = i * 4;
        const x = positionData[base + 0];
        const y = positionData[base + 1];
        const z = positionData[base + 2];
        const vx = velocityData[base + 0];
        const vy = velocityData[base + 1];
        const vz = velocityData[base + 2];

        if (typeof set === 'function') {
          set({
            particle: particles[i],
            index: i,
            x,
            y,
            z,
            vx,
            vy,
            vz
          });
        } else {
          const particle = particles[i];
          if (particle && typeof particle === 'object') {
            particle.x = x;
            particle.y = y;
            particle.z = z;
            particle.vx = vx;
            particle.vy = vy;
            particle.vz = vz;
          } else {
            particles[i] = { x, y, z, vx, vy, vz };
          }
        }
      }
    },

    // Access configuration
    options: system.options,
    particleCount: system.options.particleCount,

    // Get profiling statistics (if profiling enabled)
    stats: () => {
      if (disposed) return null;
      if (!system.profiler || !system.profiler.enabled) return null;
      return system.profiler.getAll();
    },

    // Custom profiling timers (for profiling rendering, etc.)
    beginProfile: (/** @type {any} */ name) => system.beginProfile(name),
    endProfile: () => system.endProfile(),

    // Direct access to internal ParticleSystem instance (for validators/harnesses)
    _system: system,

    // Cleanup GPU resources
    dispose: () => {
      if (disposed) return;
      system.dispose();
      disposed = true;
    }
  };

  // Add method-specific APIs
  if (method === 'spectral') {
    // Spectral method (PM/FFT) specific exports
    const spectralSystem = /** @type {any} */ (system);
    return {
      ...baseAPI,
      // PM/FFT grid access
      get pmGrid() { return spectralSystem.pmGrid; },
      get pmGridFramebuffer() { return spectralSystem.pmGridFramebuffer; },
      get pmDepositProgram() { return spectralSystem.pmDepositProgram; },
      get pmForceTexture() { return spectralSystem.pmForceTexture; }, // PM force texture

      // PM Debug API (Plan A staging)
      pmDebug: {
        /**
         * Run quick diagnostic on PM/FFT pipeline
         * @returns {Promise<{massResult: any, poissonResult: any}>}
         */
        quickDiag: () => {
          return quickDiagnostic(spectralSystem);
        },

        /**
         * Run all PM/FFT tests
         * @returns {Promise<{massConservation: any, dcZero: any, poissonEquation: any}>}
         */
        runAllTests: () => {
          return runAllTests(spectralSystem);
        },

        /**
         * Initialize PM debug system
         * @param {any} config - Debug configuration
         */
        init: (config) => {
          return pmDebugInit(spectralSystem, config);
        },

        /**
         * Run a single stage in isolation
         * @param {import('./gravity-spectral/debug/types.js').PMStageID} stage - Stage ID
         * @param {any=} source - Source spec
         * @param {any=} sink - Sink spec
         */
        runStage: (stage, source, sink) => {
          return pmDebugRunSingle(spectralSystem, stage, source, sink);
        },

        /**
         * Snapshot management
         */
        snapshot: {
          /**
           * @param {string} key
           * @param {import('./gravity-spectral/debug/types.js').PMStageID} atStage
           */
          store: (key, atStage) => {
            return pmSnapshotStore(spectralSystem, key, atStage);
          },
          /**
           * @param {string} key
           * @param {import('./gravity-spectral/debug/types.js').PMStageID} forStage
           */
          load: (key, forStage) => {
            return pmSnapshotLoad(spectralSystem, key, forStage);
          },
          /**
           * @param {string} key
           */
          dispose: (key) => {
            return pmSnapshotDispose(spectralSystem, key);
          },
          list: () => {
            return listSnapshots(spectralSystem);
          }
        },

        /**
         * Direct access to debug modules
         */
        modules: {
          get metrics() {
            return pmMetrics;
          },
          get overlay() {
            return pmOverlay;
          },
          get synthetic() {
            return pmSynthetic;
          },
          get testRunner() {
            return pmTestRunner;
          }
        }
      }
    };
  } else {
    // Tree-code methods (monopole/quadrupole) specific exports
    return {
      ...baseAPI,
      // Plan C staging API (only available for tree-code methods)
      setDebugMode: (/** @type {any} */ mode) => {
        if ('setDebugMode' in system) {
          return (/** @type {any} */ (system)).setDebugMode(mode);
        }
      },
      setDebugFlags: (/** @type {any} */ flags) => {
        if ('setDebugFlags' in system) {
          return (/** @type {any} */ (system)).setDebugFlags(flags);
        }
      },
      step_Debug: () => {
        if ('step_Debug' in system) {
          return (/** @type {any} */ (system)).step_Debug();
        }
      },

      // Direct access to debug utilities (advanced usage)
      _debug: () => {
        return pipelineDebug;
      },
    };
  }

}

/**
 * @param {Pick<Parameters<typeof particleSystem>[0], 'particles' | 'get'> & {
 *  positionsBuf: Float32Array,
 *  velocitiesBuf: Float32Array,
 *  colorsBuf: Uint8Array,
 * }} _
 */
function populateBuffers({ particles, get, positionsBuf, velocitiesBuf, colorsBuf }) {
  const dummy = {
    index: 0,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    mass: 0,
    rgb: 0
  };

  for (let i = 0; i < particles.length; i++) {
    const spot = particles[i] || {};
    dummy.index = i;
    dummy.x = spot.x || 0;
    dummy.y = spot.y || 0;
    dummy.z = spot.z || 0;
    dummy.vx = spot.vx || 0;
    dummy.vy = spot.vy || 0;
    dummy.vz = spot.vz || 0;
    dummy.mass = spot.mass || 0;
    dummy.rgb = spot.rgb || 0;
    if (typeof get === 'function') get(spot, dummy);

    const b = i * 4;
    positionsBuf[b + 0] = dummy.x;
    positionsBuf[b + 1] = dummy.y;
    positionsBuf[b + 2] = dummy.z;
    positionsBuf[b + 3] = dummy.mass;

    velocitiesBuf[b + 0] = dummy.vx;
    velocitiesBuf[b + 1] = dummy.vy;
    velocitiesBuf[b + 2] = dummy.vz;
    velocitiesBuf[b + 3] = 0;

    let rgbNum = 0;
    if (Array.isArray(dummy.rgb)) {
      const c = dummy.rgb;
      rgbNum = ((c[0] & 0xff) << 16) | ((c[1] & 0xff) << 8) | (c[2] & 0xff);
    } else {
      rgbNum = Number(dummy.rgb) || 0;
    }

    colorsBuf[b + 0] = (rgbNum >> 16) & 0xff;
    colorsBuf[b + 1] = (rgbNum >> 8) & 0xff;
    colorsBuf[b + 2] = (rgbNum) & 0xff;
    colorsBuf[b + 3] = 255;
  }
}
