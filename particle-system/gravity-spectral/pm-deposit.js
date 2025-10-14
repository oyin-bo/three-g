// @ts-check

/**
 * PM Particle Deposition
 * 
 * Deposits particle masses onto 3D grid using additive blending.
 * This is the first stage of the PM/FFT force calculation.
 */

import pmDepositVertSrc from './shaders/pm-deposit.vert.js';
import pmDepositFragSrc from './shaders/pm-deposit.frag.js';

/**
 * Create PM deposit program
 * 
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectral} psys
 * @returns {WebGLProgram}
 */
export function createPMDepositProgram(psys) {
  const gl = psys.gl;
  
  const program = psys.createProgram(pmDepositVertSrc, pmDepositFragSrc);
  
  console.log('[PM Deposit] Program created');
  
  return program;
}

/**
 * Deposit particles onto PM grid
 * 
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectral} psys
 */
export function depositParticlesToGrid(psys) {
  const gl = psys.gl;
  
  if (!psys.pmGrid) {
    console.error('[PM Deposit] PM grid not initialized');
    return;
  }
  
  if (!psys.pmDepositProgram) {
    psys.pmDepositProgram = createPMDepositProgram(psys);
  }
  
  const program = psys.pmDepositProgram;
  const grid = psys.pmGrid;
  
  // Bind framebuffer: prefer single-channel mass FBO if available
  const targetFBO = psys.pmMassFBO || psys.pmGridFramebuffer;
  gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO);
  gl.viewport(0, 0, grid.size, grid.size);

  // Clear grid / mass buffer
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  // Disable depth test and other state that could interfere
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  
  // Enable additive blending for mass accumulation
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE); // Additive blending
  gl.blendEquation(gl.FUNC_ADD);
  
  // Use program
  gl.useProgram(program);
  
  // Set uniforms
  const positionTexture = psys.positionTextures?.getCurrentTexture?.();
  if (!positionTexture) {
    console.error('[PM Deposit] Position texture unavailable');
    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return;
  }
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, positionTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_positionTexture'), 0);
  
  gl.uniform2f(
    gl.getUniformLocation(program, 'u_textureSize'),
    psys.textureWidth,
    psys.textureHeight
  );
  
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), grid.gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), grid.slicesPerRow);
  
  // World bounds
  const bounds = psys.options.worldBounds || {
    min: [-2, -2, -2],
    max: [2, 2, 2]
  };
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMin'), bounds.min[0], bounds.min[1], bounds.min[2]);
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMax'), bounds.max[0], bounds.max[1], bounds.max[2]);
  
  // Deposition parameters
  gl.uniform1f(gl.getUniformLocation(program, 'u_particleSize'), 1.0);
  const assignment = psys.options.assignment === 'NGP' ? 0 : 1; // default CIC (1)
  gl.uniform1i(gl.getUniformLocation(program, 'u_assignment'), assignment);
  
  gl.bindVertexArray(psys.particleVAO);
  if (assignment === 1) {
    const offsets = [
      [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
      [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]
    ];
    const offsetLoc = gl.getUniformLocation(program, 'u_cellOffset');
    for (const offset of offsets) {
      gl.uniform3f(offsetLoc, offset[0], offset[1], offset[2]);
      gl.drawArrays(gl.POINTS, 0, psys.particleCount);
    }
  } else {
    gl.uniform3f(gl.getUniformLocation(program, 'u_cellOffset'), 0, 0, 0);
    gl.drawArrays(gl.POINTS, 0, psys.particleCount);
  }
  gl.bindVertexArray(null);
  
  // Check for GL errors
  const err = gl.getError();
  if (err !== gl.NO_ERROR) {
    console.error('[PM Deposit] GL error after draw:', err);
  }
  
  // Cleanup
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  console.log('[PM Deposit] Deposited', psys.particleCount, 'particles to grid');
}
