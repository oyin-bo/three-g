// @ts-check

import { ParticleSystemMonopoleKernels } from './gravity-multipole/particle-system-monopole-kernels.js';
import { ParticleSystemQuadrupoleKernels } from './gravity-multipole/particle-system-quadrupole-kernels.js';
import { ParticleSystemSpectralKernels } from './gravity-spectral-kernels/particle-system-spectral-kernels.js';
import { ParticleSystemMeshKernels } from './gravity-mesh-kernels/particle-system-mesh-kernels.js';

/**
 * Create a kernel-based particle system instance.
 * Loads CPU particle data into GPU textures and returns the underlying system without a legacy wrapper.
 *
 * @param {{
 *   gl: WebGL2RenderingContext,
 *   particles: {
 *     x?: number, y?: number, z?: number,
 *     vx?: number, vy?: number, vz?: number,
 *     mass?: number 
 *    }[],
 *   get?: (spot: any, out: {
 *     index: number,
 *     x?: number, y?: number, z?: number,
 *     vx?: number, vy?: number, vz?: number,
 *     mass?: number
 *   }) => void,
 *   method?: 'quadrupole' | 'monopole' | 'spectral' | 'mesh',
 *   theta?: number,
 *   gravityStrength?: number,
 *   dt?: number,
 *   softening?: number,
 *   damping?: number,
 *   maxSpeed?: number,
 *   maxAccel?: number,
 *   worldBounds?: { min: [number, number, number], max: [number, number, number] },
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
export function particleSystemKernels(options) {
  const {
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
    mesh: meshConfig
  } = options;

  if (!(gl instanceof WebGL2RenderingContext))
    throw new Error('particleSystemKernels requires a WebGL2RenderingContext');

  if (particles.length < 0)
    throw new Error('particleSystemKernels requires a non-empty particles array');

  const particleData = prepareParticleData({ particles, get });

  let system;
  
  switch (method) {
    case 'mesh':
      system = new ParticleSystemMeshKernels({
        gl,
        particleData,
        worldBounds,
        dt,
        gravityStrength,
        softening,
        damping,
        maxSpeed,
        maxAccel,
        mesh: meshConfig || undefined
      });
      break;

    case 'spectral':
      system = new ParticleSystemSpectralKernels({
        gl,
        particleData,
        worldBounds,
        dt,
        gravityStrength,
        softening,
        damping,
        maxSpeed,
        maxAccel
      });
      break;

    case 'monopole':
      system = new ParticleSystemMonopoleKernels({
        gl,
        particleData,
        worldBounds,
        theta: theta !== undefined ? theta : 0.65,
        gravityStrength,
        dt,
        softening,
        damping,
        maxSpeed,
        maxAccel
      });
      break;

    case 'quadrupole':
    default:
      system = new ParticleSystemQuadrupoleKernels({
        gl,
        particleData,
        worldBounds,
        theta: theta !== undefined ? theta : 0.65,
        gravityStrength,
        dt,
        softening,
        damping,
        maxSpeed,
        maxAccel
      });
      break;
  }
  
  // Return the system directly - it already has all the methods we added
  return system;
}

/**
 * Reads GPU particle textures into CPU typed arrays for validation or persistence.
 *
 * @param {{
 *   system: {
 *     gl?: WebGL2RenderingContext,
 *     positionTexture?: WebGLTexture | null,
 *     velocityTexture?: WebGLTexture | null,
 *     textureWidth?: number,
 *     textureHeight?: number,
 *     options?: { particleCount?: number }
 *   }
 * }} payload
 * @returns {{
 *   positions: Float32Array,
 *   velocities: Float32Array,
 *   masses: Float32Array
 * }}
 */
export function unloadKernelParticleData({ system }) {
  if (!system) throw new Error('unloadKernelParticleData requires a system');

  const { gl, positionTexture, velocityTexture, textureWidth, textureHeight, options } = system;
  if (!(gl instanceof WebGL2RenderingContext)) {
    throw new Error('System does not expose a WebGL2RenderingContext');
  }

  if (!positionTexture || !velocityTexture) {
    throw new Error('System is missing position or velocity textures');
  }

  if (!textureWidth || !textureHeight || !options?.particleCount) {
    throw new Error('System is missing texture dimensions or particle count');
  }

  const totalTexels = textureWidth * textureHeight;
  const particleCount = options.particleCount;

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
    gl.readPixels(0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, positionData);

    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velocityTexture, 0);
    gl.readPixels(0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, velocityData);
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, previousFramebuffer);
    gl.deleteFramebuffer(tempFramebuffer);
  }

  const positions = new Float32Array(particleCount * 3);
  const velocities = new Float32Array(particleCount * 3);
  const masses = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    const src = i * 4;
    const dst = i * 3;

    positions[dst + 0] = positionData[src + 0];
    positions[dst + 1] = positionData[src + 1];
    positions[dst + 2] = positionData[src + 2];
    masses[i] = positionData[src + 3];

    velocities[dst + 0] = velocityData[src + 0];
    velocities[dst + 1] = velocityData[src + 1];
    velocities[dst + 2] = velocityData[src + 2];
  }

  return { positions, velocities, masses };
}

/**
 * Convert particle objects into packed Float32Array/Uint8Array buffers ready for GPU upload.
 * @param {Pick<Parameters<typeof particleSystemKernels>[0], 'particles' | 'get'>} _
 */
function prepareParticleData({ particles, get }) {
  const particleCount = particles.length;
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  if (!Number.isFinite(textureWidth) || !Number.isFinite(textureHeight)) {
    throw new Error('Failed to compute texture dimensions for particle data');
  }

  const actualTextureSize = textureWidth * textureHeight;
  const positions = new Float32Array(actualTextureSize * 4);
  const velocities = new Float32Array(actualTextureSize * 4);

  const dummy = {
    index: 0,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    mass: 0
  };

  for (let i = 0; i < particleCount; i++) {
    const spot = particles[i];
    dummy.index = i;
    dummy.x = spot?.x || 0;
    dummy.y = spot.y || 0;
    dummy.z = spot?.z || 0;
    dummy.vx = spot?.vx || 0;
    dummy.vy = spot?.vy || 0;
    dummy.vz = spot?.vz || 0;
    dummy.mass = spot?.mass || 0;

    if (typeof get === 'function') {
      get(spot, dummy);
    }

    const base = i * 4;
    positions[base + 0] = dummy.x;
    positions[base + 1] = dummy.y;
    positions[base + 2] = dummy.z;
    positions[base + 3] = dummy.mass;

    velocities[base + 0] = dummy.vx;
    velocities[base + 1] = dummy.vy;
    velocities[base + 2] = dummy.vz;
    velocities[base + 3] = 0;
  }

  return { positions, velocities, textureWidth, textureHeight };
}
