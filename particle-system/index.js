// @ts-check

import { ParticleSystem } from './particle-system.js';

/**
 * Create a GPU-accelerated Barnes-Hut N-body simulation
 * 
 * @param {{
 *   gl: WebGL2RenderingContext,
 *   particles: any[],
 *   get?: (spot: any, out: {
 *    x?: number, y?: number, z?: number,
 *    vx?: number, vy?: number, vz?: number,
 *    mass?: number,
 *    rgb?: number }) => void,
 *   theta?: number, // Barnes-Hut threshold, default: 0.5
 *   gravityStrength?: number, // Force multiplier, default: 0.0003
 *   dt?: number, // Timestep, default: 1/60
 *   softening?: number, // Softening length, default: 0.2
 *   damping?: number, // Velocity damping, default: 0.0
 *   maxSpeed?: number, // Maximum velocity, default: 2.0
 *   maxAccel?: number, // Maximum acceleration, default: 1.0
 *   worldBounds?: { min: [number,number,number], max: [number,number,number] },
 *   debugSkipQuadtree?: boolean, // Debug option to skip quadtree traversal, default: false
 *   enableProfiling?: boolean, // Enable GPU profiling with EXT_disjoint_timer_query_webgl2, default: false
 *   planA?: boolean // Enable Plan A (PM/FFT) debug mode, default: false
 * }} options
 */
export function particleSystem({ gl, particles, get, theta = 0.5, gravityStrength = 0.0003, dt = 1 / 60, softening = 0.2, damping = 0.0, maxSpeed = 2.0, maxAccel = 1.0, worldBounds, debugSkipQuadtree = false, enableProfiling = false, planA = false }) {
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
  
  // Create system with particle data
  const system = new ParticleSystem(gl, {
    particleCount,
    particleData: {
      positions: paddedPositions,
      velocities: paddedVelocities,
      colors: paddedColors
    },
    // Pass through all configuration parameters
    theta,
    gravityStrength,
    dt,
    softening,
    damping,
    maxSpeed,
    maxAccel,
    worldBounds,
    debugSkipQuadtree,
    enableProfiling,
    planA
  });
  
  // Initialize asynchronously (internal - user doesn't need to await)
  system.init();
  
  return {
    // Async initialization (wait for system to be ready)
    ready: async () => {
      // System is initialized synchronously in init(), but we provide this
      // for compatibility with async initialization patterns
      return new Promise((resolve) => {
        if (system.isInitialized) {
          resolve();
        } else {
          // Poll for initialization (should be immediate)
          const checkInit = () => {
            if (system.isInitialized) {
              resolve();
            } else {
              setTimeout(checkInit, 10);
            }
          };
          checkInit();
        }
      });
    },
    
    // Step simulation forward (main loop call)
    compute: () => {
      if (!system.isInitialized) return;
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
    
    // PM/FFT grid access (Plan A)
    get pmGrid() { return system.pmGrid; },
    get pmGridFramebuffer() { return system.pmGridFramebuffer; },
    get pmDepositProgram() { return system.pmDepositProgram; },
    get pmForceTexture() { return system.pmForceTexture; }, // CRITICAL: Expose PM force texture for integrator
    gl: gl, // Expose GL context for debugging/testing
    
    // Internal system access for advanced usage
    _system: system, // Expose full system for PM-debug and advanced features
    
    // Get profiling statistics (if profiling enabled)
    stats: () => {
      if (!system.profiler || !system.profiler.enabled) return null;
      return system.profiler.getAll();
    },
    
    // Custom profiling timers (for profiling rendering, etc.)
    beginProfile: (name) => system.beginProfile(name),
    endProfile: () => system.endProfile(),

    // Cleanup GPU resources
    dispose: () => system.dispose()
  };

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
