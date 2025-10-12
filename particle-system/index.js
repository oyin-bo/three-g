// @ts-check

import { ParticleSystemMonopole } from './particle-system-monopole.js';
import { ParticleSystemQuadrupole } from './particle-system-quadrupole.js';
import { ParticleSystemSpectral } from './particle-system-spectral.js';
import { quickDiagnostic, runAllTests } from './pm-debug/test-runner.js';
import { pmDebugInit, pmDebugRunSingle, pmSnapshotStore, pmSnapshotLoad, pmSnapshotDispose } from './pm-debug/index.js';
import { listSnapshots } from './pm-debug/snapshot.js';
import * as pmMetrics from './pm-debug/metrics.js';
import * as pmOverlay from './pm-debug/overlay.js';
import * as pmSynthetic from './pm-debug/synthetic.js';
import * as pmTestRunner from './pm-debug/test-runner.js';
import * as pipelineDebug from './pipeline/debug/index.js';

/** @typedef {{
 *   compute: () => void,
 *   getPositionTexture: () => WebGLTexture,
 *   getPositionTextures: () => WebGLTexture[],
 *   getCurrentIndex: () => 0 | 1,
 *   getColorTexture: () => WebGLTexture|null,
 *   getTextureSize: () => [number, number],
 *   options: object,
 *   particleCount: number,
 *   stats: () => any,
 *   beginProfile: (name: any) => void,
 *   endProfile: () => void,
 *   _system: import('./particle-system-quadrupole.js').ParticleSystemQuadrupole | import('./particle-system-monopole.js').ParticleSystemMonopole | import('./particle-system-spectral.js').ParticleSystemSpectral,
 *   dispose: () => void
 * }} ParticleSystemAPI
 */

/**
 * Create a GPU-accelerated N-body simulation
 * 
 * @param {{
 *   gl: WebGL2RenderingContext,
 *   particles: any[],
 *   get?: (spot: any, out: {
 *    x?: number, y?: number, z?: number,
 *    vx?: number, vy?: number, vz?: number,
 *    mass?: number,
 *    rgb?: number }) => void,
 *   method?: 'quadrupole' | 'monopole' | 'spectral',
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
 *   springStrength?: number
 * }} options
 * 
 * Method options:
 * - 'quadrupole' (default): 2nd-order Barnes-Hut tree-code
 * - 'monopole': 1st-order Barnes-Hut tree-code
 * - 'spectral': Particle-Mesh with FFT (spectral method)
 * 
 * @returns Particle system API
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
  springStrength = 0.001
}) {
  // Compute particle count from positions array (RGBA = 4 components per particle)
  const particleCount = particles.length;

  let positionsBuf = new Float32Array(particleCount * 4);
  let velocitiesBuf = new Float32Array(particleCount * 4);
  let colorsBuf = new Uint8Array(particleCount * 4);

  populateBuffers();
    
  // Calculate texture dimensions
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  const actualTextureSize = textureWidth * textureHeight;
  
  // Pad particle data to texture size if needed
  const paddedPositions = new Float32Array(actualTextureSize * 4);
  paddedPositions.set(positionsBuf);

  let paddedVelocities = null;
  if (velocitiesBuf) {
    paddedVelocities = new Float32Array(actualTextureSize * 4);
    paddedVelocities.set(velocitiesBuf);
  }

  let paddedColors = null;
  if (colorsBuf) {
    paddedColors = new Uint8Array(actualTextureSize * 4);
    paddedColors.set(colorsBuf);
  }

  // Select implementation based on method
  let SystemClass;
  let defaultTheta;
  let usePlanA = false;
  
  if (method === 'spectral') {
    SystemClass = ParticleSystemSpectral;
    defaultTheta = 0.5;
    usePlanA = true;
  } else if (method === 'monopole') {
    SystemClass = ParticleSystemMonopole;
    defaultTheta = 0.65;
  } else {
    // Default to quadrupole
    SystemClass = ParticleSystemQuadrupole;
    defaultTheta = 0.65;
  }
  
  // Use provided theta or default for the selected method
  const effectiveTheta = theta !== undefined ? theta : defaultTheta;
  
  // Create system with particle data
  const system = new SystemClass(gl, {
    particleCount,
    particleData: {
      positions: paddedPositions,
      velocities: paddedVelocities,
      colors: paddedColors
    },
    // Pass through all configuration parameters
    theta: effectiveTheta,
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
    poissonUseDiscrete: 1,
    treePMSigma: 0.0
  });
  
  // Initialize synchronously (throws if setup fails)
  system.init();
  let disposed = false;

  // Base API common to all methods
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
      gl: gl, // Expose GL context for debugging/testing
      
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
         * @param {import('./pm-debug/types.js').PMStageID} stage - Stage ID
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
           * @param {import('./pm-debug/types.js').PMStageID} atStage
           */
          store: (key, atStage) => {
            return pmSnapshotStore(spectralSystem, key, atStage);
          },
          /**
           * @param {string} key
           * @param {import('./pm-debug/types.js').PMStageID} forStage
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

  function populateBuffers() {
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
}
