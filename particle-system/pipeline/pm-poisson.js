// @ts-check

/**
 * PM/FFT Pipeline - Poisson Solver
 * 
 * Solves Poisson equation in Fourier space:
 * ∇²φ = 4πGρ  →  φ(k) = -4πGρ(k) / k²
 */

import poissonFrag from '../shaders/poisson.frag.js';
import fsQuadVert from '../shaders/fullscreen.vert.js';

/**
 * Initialize Poisson solver resources
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
export function initPoissonSolver(psys) {
  const gl = psys.gl;
  
  // Create Poisson program
  if (!psys.pmPoissonProgram) {
    psys.pmPoissonProgram = psys.createProgram(fsQuadVert, poissonFrag);
    console.log('[PM Poisson] Program created');
  }
  
  // Create potential spectrum texture (complex: RG = real, imaginary)
  if (!psys.pmPotentialSpectrum) {
    const textureSize = psys.pmGrid.size;
    
    const potentialTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, potentialTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, textureSize, textureSize, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    
    const potentialFBO = gl.createFramebuffer();
    
    psys.pmPotentialSpectrum = {
      texture: potentialTex,
      framebuffer: potentialFBO,
      gridSize: psys.pmGrid.gridSize,
      textureSize: textureSize
    };
    
    console.log(`[PM Poisson] Potential spectrum texture created (${textureSize}x${textureSize})`);
  }
}

/**
 * Solve Poisson equation in Fourier space
 * @param {import('../particle-system.js').ParticleSystem} psys
 * @param {number} gravitationalConstant - 4πG (default: use system value)
 * @param {number} boxSize - Physical size of simulation box (default: use world bounds)
 */
export function solvePoissonFFT(psys, gravitationalConstant, boxSize) {
  initPoissonSolver(psys);
  
  const gl = psys.gl;
  const program = psys.pmPoissonProgram;
  const textureSize = psys.pmGrid.size;
  const gridSize = psys.pmGrid.gridSize;
  const slicesPerRow = psys.pmGrid.slicesPerRow;
  
  // Calculate gravitational constant (4πG)
  if (gravitationalConstant === undefined || gravitationalConstant === null) {
    // Use system gravity strength: G_eff = gravityStrength * dt²
    const G = psys.options.gravityStrength || 0.0003;
    gravitationalConstant = 4.0 * Math.PI * G;
  }
  
  // Calculate box size from world bounds
  if (boxSize === undefined || boxSize === null) {
    const bounds = psys.options.worldBounds;
    if (bounds) {
      const dx = bounds.max[0] - bounds.min[0];
      const dy = bounds.max[1] - bounds.min[1];
      const dz = bounds.max[2] - bounds.min[2];
      boxSize = Math.max(dx, dy, dz);
    } else {
      boxSize = 100.0; // Default fallback
    }
  }
  
  // Bind framebuffer for output
  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmPotentialSpectrum.framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, 
    gl.COLOR_ATTACHMENT0, 
    gl.TEXTURE_2D, 
    psys.pmPotentialSpectrum.texture, 
    0
  );
  
  gl.viewport(0, 0, textureSize, textureSize);
  
  // Set GL state
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.colorMask(true, true, true, true);
  
  gl.useProgram(program);
  
  // Bind input (density spectrum from FFT)
  const densityTex = psys.pmDensitySpectrum?.texture || psys.pmSpectrum?.texture;
  if (!densityTex) {
    console.error('[PM Poisson] Missing density spectrum texture');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, densityTex);
  gl.uniform1i(gl.getUniformLocation(program, 'u_densitySpectrum'), 0);
  
  // Set uniforms
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), slicesPerRow);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gravitationalConstant'), gravitationalConstant);
  gl.uniform1f(gl.getUniformLocation(program, 'u_boxSize'), boxSize);

  // Extended controls per spec
  const useDiscrete = psys.options?.poissonUseDiscrete ?? 1; // default discrete k_eff
  const assign = psys.options?.assignment || 'CIC';
  const deconvOrder = assign === 'TSC' ? 3 : assign === 'NGP' ? 1 : 2;
  const gaussianSigma = psys.options?.treePMSigma || 0.0;
  gl.uniform1i(gl.getUniformLocation(program, 'u_useDiscrete'), useDiscrete ? 1 : 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_deconvolveOrder'), deconvOrder);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gaussianSigma'), gaussianSigma);
  
  // Draw fullscreen quad
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  gl.finish(); // Ensure completion
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  console.log(`[PM Poisson] Solved Poisson equation (4πG=${gravitationalConstant.toFixed(6)}, L=${boxSize.toFixed(2)})`);
}

/**
 * Read potential spectrum for debugging
 * @param {import('../particle-system.js').ParticleSystem} psys
 * @param {number} x - Texture x coordinate
 * @param {number} y - Texture y coordinate
 * @returns {{real: number, imag: number, magnitude: number}}
 */
export function readPotentialSpectrum(psys, x, y) {
  const gl = psys.gl;
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmPotentialSpectrum.framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    psys.pmPotentialSpectrum.texture,
    0
  );
  
  const data = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  return {
    real: data[0],
    imag: data[1],
    magnitude: Math.sqrt(data[0] * data[0] + data[1] * data[1])
  };
}
