// @ts-check

/**
 * PM Particle Deposition
 * 
 * Deposits particle masses onto 3D grid using additive blending.
 * This is the first stage of the PM/FFT force calculation.
 */

import pmDepositVertSrc from '../shaders/pm-deposit.vert.js';
import pmDepositFragSrc from '../shaders/pm-deposit.frag.js';

/**
 * Create PM deposit program
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
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
 * @param {import('../particle-system.js').ParticleSystem} psys
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
  
  // Bind framebuffer
  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmGridFramebuffer);
  gl.viewport(0, 0, grid.size, grid.size);
  
  // Clear grid
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  // Enable additive blending for mass accumulation
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE); // Additive blending
  gl.blendEquation(gl.FUNC_ADD);
  
  // Use program
  gl.useProgram(program);
  
  // Set uniforms
  const positionTexture = psys.positionTextures.getCurrentTexture();
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
  gl.uniform1f(gl.getUniformLocation(program, 'u_particleSize'), 1.0); // NGP: 1 pixel
  gl.uniform1i(gl.getUniformLocation(program, 'u_depositionScheme'), 0); // 0 = NGP
  
  // Draw particles as points
  gl.drawArrays(gl.POINTS, 0, psys.particleCount);
  
  // Cleanup
  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  console.log('[PM Deposit] Deposited', psys.particleCount, 'particles to grid');
}
