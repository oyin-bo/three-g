// @ts-check

import depositVertSrc from '../shaders/deposit.vert.js';
import depositFragSrc from '../shaders/deposit.frag.js';
import { createProgram } from '../../utils/common.js';

const CIC_OFFSETS = [
  [0, 0, 0],
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [0, 0, 1],
  [1, 0, 1],
  [0, 1, 1],
  [1, 1, 1]
];

/**
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @returns {WebGLProgram}
 */
function getDepositProgram(psys) {
  if (psys.meshPrograms.deposit) {
    return psys.meshPrograms.deposit;
  }

  const program = createProgram(psys.gl, depositVertSrc, depositFragSrc);
  psys.meshPrograms.deposit = program;
  console.log('[Mesh Deposit] Program created');
  return program;
}

/**
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @returns {void}
 */
export function meshDepositMass(psys) {
  const gl = psys.gl;
  const grid = psys.pmGrid;
  if (!grid || !psys.pmGridFramebuffer) {
    console.error('[Mesh Deposit] PM grid not initialized');
    return;
  }

  const positionTexture = psys.positionTextures?.getCurrentTexture?.();
  if (!positionTexture) {
    console.error('[Mesh Deposit] Position texture unavailable');
    return;
  }

  const program = getDepositProgram(psys);

  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmGridFramebuffer);
  
  // CRITICAL: Re-attach texture to framebuffer (may have been detached by other code)
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    grid.texture,
    0
  );
  
  const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (fbStatus !== gl.FRAMEBUFFER_COMPLETE) {
    console.error(`[Mesh Deposit] Framebuffer incomplete: ${fbStatus}`);
    return;
  }
  
  gl.viewport(0, 0, grid.size, grid.size);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // CRITICAL: Ensure writes are enabled  
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.colorMask(true, true, true, true);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.blendEquation(gl.FUNC_ADD);

  gl.useProgram(program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, positionTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_positionTexture'), 0);

  gl.uniform2f(gl.getUniformLocation(program, 'u_textureSize'), psys.textureWidth, psys.textureHeight);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), grid.gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), grid.slicesPerRow);

  const bounds = psys.options.worldBounds || {
    min: [-2, -2, -2],
    max: [2, 2, 2]
  };
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMin'), bounds.min[0], bounds.min[1], bounds.min[2]);
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMax'), bounds.max[0], bounds.max[1], bounds.max[2]);

  gl.uniform1f(gl.getUniformLocation(program, 'u_particleSize'), 1.0);
  const assignment = psys.meshConfig.assignment === 'cic' ? 1 : 0;
  gl.uniform1i(gl.getUniformLocation(program, 'u_assignment'), assignment);

  const offsetLoc = gl.getUniformLocation(program, 'u_offset');
  const offsets = assignment === 1 ? CIC_OFFSETS : [[0, 0, 0]];

  gl.bindVertexArray(psys.particleVAO);
  for (const offset of offsets) {
    gl.uniform3f(offsetLoc, offset[0], offset[1], offset[2]);
    gl.drawArrays(gl.POINTS, 0, psys.options.particleCount);
  }
  gl.bindVertexArray(null);

  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
