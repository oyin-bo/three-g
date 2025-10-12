// @ts-check

import forceSampleVert from '../../shaders/force-sample.vert.js';
import forceSampleFrag from '../../shaders/force-sample.frag.js';
import { createProgram } from '../../utils/common.js';

/**
 * Ensure mesh force sampling program exists.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @returns {WebGLProgram}
 */
function getMeshForceSampleProgram(psys) {
  if (psys.meshPrograms.forceSample) {
    return psys.meshPrograms.forceSample;
  }

  const program = createProgram(psys.gl, forceSampleVert, forceSampleFrag);
  psys.meshPrograms.forceSample = program;
  console.log('[Mesh Force Sample] Program created');
  return program;
}

/**
 * Sample forces from mesh force grids at particle positions.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @param {WebGLTexture} forceGridX
 * @param {WebGLTexture} forceGridY
 * @param {WebGLTexture} forceGridZ
 * @param {{ accumulate?: boolean }} [options]
 * @returns {void}
 */
export function meshSampleForcesAtParticles(psys, forceGridX, forceGridY, forceGridZ, options = {}) {
  const gl = psys.gl;
  const grid = psys.pmGrid;

  if (!grid) {
    console.error('[Mesh Force Sample] pmGrid not initialized');
    return;
  }

  if (!psys.pmForceTexture || !psys.pmForceFBO) {
    console.error('[Mesh Force Sample] pmForceTexture or pmForceFBO not initialized');
    return;
  }

  const positionTexture = psys.positionTextures?.getCurrentTexture?.();
  if (!positionTexture) {
    console.error('[Mesh Force Sample] Position texture unavailable');
    return;
  }

  const program = getMeshForceSampleProgram(psys);
  const { accumulate = false } = options;

  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmForceFBO);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    psys.pmForceTexture,
    0
  );

  gl.viewport(0, 0, psys.textureWidth, psys.textureHeight);

  if (accumulate) {
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.blendEquation(gl.FUNC_ADD);
  } else {
    gl.disable(gl.BLEND);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.disable(gl.DEPTH_TEST);

  gl.useProgram(program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, positionTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_positionTexture'), 0);

  gl.uniform2f(gl.getUniformLocation(program, 'u_textureSize'), psys.textureWidth, psys.textureHeight);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, forceGridX);
  gl.uniform1i(gl.getUniformLocation(program, 'u_forceGridX'), 1);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, forceGridY);
  gl.uniform1i(gl.getUniformLocation(program, 'u_forceGridY'), 2);

  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, forceGridZ);
  gl.uniform1i(gl.getUniformLocation(program, 'u_forceGridZ'), 3);

  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), grid.gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), grid.slicesPerRow);

  const bounds = psys.options.worldBounds || {
    min: [-2, -2, -2],
    max: [2, 2, 2]
  };
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMin'), bounds.min[0], bounds.min[1], bounds.min[2]);
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMax'), bounds.max[0], bounds.max[1], bounds.max[2]);

  gl.bindVertexArray(psys.particleVAO);
  gl.drawArrays(gl.POINTS, 0, psys.options.particleCount);
  gl.bindVertexArray(null);

  if (accumulate) {
    gl.disable(gl.BLEND);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
