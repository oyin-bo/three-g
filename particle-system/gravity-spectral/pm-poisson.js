// @ts-check

/**
 * PM/FFT Pipeline - Poisson Solver
 * 
 * Solves Poisson equation in Fourier space:
 * ∇²φ = 4πGρ  →  φ(k) = -4πGρ(k) / k²
 */

/**
 * Solve Poisson equation in Fourier space
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectral} psys
 * @param {number} gravitationalConstant - 4πG (default: use system value)
 * @param {number} boxSize - Physical size of simulation box (default: use world bounds)
 */
export function solvePoissonFFT(psys, gravitationalConstant, boxSize) {
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
  
  // Calculate world size (per-axis) from bounds; fallback to scalar boxSize if provided
  let worldSize = [100.0, 100.0, 100.0];
  {
    const bounds = psys.options.worldBounds;
    if (bounds) {
      const dx = bounds.max[0] - bounds.min[0];
      const dy = bounds.max[1] - bounds.min[1];
      const dz = bounds.max[2] - bounds.min[2];
      worldSize = [dx, dy, dz];
    } else if (boxSize !== undefined && boxSize !== null) {
      worldSize = [boxSize, boxSize, boxSize];
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
  gl.uniform3f(
    gl.getUniformLocation(program, 'u_worldSize'),
    worldSize[0], worldSize[1], worldSize[2]
  );

  // --- Shader Controls ---

  // Deconvolution order depends on the mass assignment scheme.
  // This corrects for the smearing effect of assignment.
  const assignment = (/** @type {any} */ (psys.options)).assignment || 'CIC';
  let deconvolveOrder = 2; // Default for CIC
  if (assignment === 'TSC') deconvolveOrder = 3;
  if (assignment === 'NGP') deconvolveOrder = 1;
  gl.uniform1i(gl.getUniformLocation(program, 'u_deconvolveOrder'), deconvolveOrder);

  // Use discrete Laplacian by default, as it's more accurate for grid calculations.
  const useDiscrete = ((/** @type {any} */ (psys.options)).poissonUseDiscrete === false) ? 0 : 1;
  gl.uniform1i(gl.getUniformLocation(program, 'u_useDiscrete'), useDiscrete);

  // Gaussian smoothing for Tree-PM hybrid methods.
  const gaussianSigma = (/** @type {any} */ (psys.options)).treePMSigma || 0.0;
  gl.uniform1f(gl.getUniformLocation(program, 'u_gaussianSigma'), gaussianSigma);
  
  // Draw fullscreen quad
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  gl.finish(); // Ensure completion
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  console.log(`[PM Poisson] Solved Poisson equation (4πG=${gravitationalConstant.toFixed(6)}, L=[${worldSize.map(v=>v.toFixed(2)).join(', ')}])`);
}

/**
 * Read potential spectrum for debugging
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectral} psys
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
