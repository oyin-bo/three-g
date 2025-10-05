import { ParticleSystem } from './particle-system.js';

/**
 * Create a GPU-accelerated Barnes-Hut N-body simulation
 * 
 * @param {{
 *   gl: WebGL2RenderingContext,          // REQUIRED: from renderer.getContext()
 *   particleCount?: number,               // Default: 200000
 *   worldBounds?: { 
 *     min: [number, number, number], 
 *     max: [number, number, number] 
 *   },
 *   theta?: number,                       // Barnes-Hut threshold, default: 0.5
 *   gravityStrength?: number,             // Force multiplier, default: 0.0003
 *   initialSpeed?: number,                // Initial velocity, default: 0.05
 *   dt?: number,                          // Timestep, default: 10/60
 *   softening?: number                    // Softening length, default: 0.2
 * }} options
 * 
 * @returns {{
 *   compute: () => void,
 *   getPositionTexture: () => WebGLTexture,
 *   getColorTexture: () => WebGLTexture,
 *   getTextureSize: () => { width: number, height: number },
 *   options: object,
 *   dispose: () => void
 * }}
 */
export function particleSystem(options) {
  if (!options.gl) {
    throw new Error('Barnes/Hut system requires WebGL2 context (options.gl)');
  }
  
  const system = new ParticleSystem(options.gl, options);
  
  // Initialize asynchronously (internal - user doesn't need to await)
  let initPromise = system.init().catch(error => {
    console.error('Barnes-Hut initialization failed:', error);
    throw error;
  });
  
  return {
    // Step simulation forward (main loop call)
    compute: () => {
      if (!system.isInitialized) {
        console.warn('Barnes/Hut system not yet initialized, skipping compute');
        return;
      }
      system.step();
    },
    
    // Get GPU textures for rendering (GPU-to-GPU data flow)
    // These return WebGLTexture objects that can be wrapped in THREE.ExternalTexture
    getPositionTexture: () => system.getPositionTexture(),
    getTargetPositionTexture: () => system.getTargetPositionTexture(),  // Just-written buffer after swap
    getColorTexture: () => system.getColorTexture(),
    getTextureSize: () => system.getTextureSize(),
    
    // Access configuration
    options: system.options,
    particleCount: system.options.particleCount,
    
    // Wait for initialization (if needed)
    ready: () => initPromise,
    
    // Cleanup GPU resources
    dispose: () => system.dispose()
  };
}
