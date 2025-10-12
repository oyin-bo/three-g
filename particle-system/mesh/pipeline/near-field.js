// @ts-check

import fsQuadVert from '../../shaders/fullscreen.vert.js';
import nearFieldFrag from '../../shaders/near-field.frag.js';
import forceSampleVert from '../../shaders/force-sample.vert.js';
import forceSampleFrag from '../../shaders/force-sample.frag.js';
import { createProgram } from '../../utils/common.js';

/**
 * Ensure near-field programs and buffers exist.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
function initNearFieldResources(psys) {
  const gl = psys.gl;

  if (!psys.meshPrograms.nearField) {
    psys.meshPrograms.nearField = createProgram(gl, fsQuadVert, nearFieldFrag);
    console.log('[Mesh Near-Field] Correction program created');
  }

  if (!psys.meshPrograms.nearFieldSample) {
    psys.meshPrograms.nearFieldSample = createProgram(gl, forceSampleVert, forceSampleFrag);
    console.log('[Mesh Near-Field] Sampling program created');
  }

  if (!psys.meshNearForceGrids) {
    const { initMeshForceGrids } = require('./fft.js');
    initMeshForceGrids(psys, { target: 'near' });
  }
}

/**
 * Compute real-space near-field forces and accumulate onto particle forces.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
export function computeNearFieldCorrection(psys) {
  if (!psys.pmGrid) {
    console.error('[Mesh Near-Field] pmGrid not initialized');
    return;
  }

  initNearFieldResources(psys);

  const gl = psys.gl;
  const pmGrid = psys.pmGrid;
  const nearGrids = psys.meshNearForceGrids;

  if (!nearGrids) {
    console.error('[Mesh Near-Field] near force grids unavailable');
    return;
  }

  // Pass 1: evaluate near-field correction per voxel
  gl.bindFramebuffer(gl.FRAMEBUFFER, nearGrids.framebuffer ?? null);
  gl.viewport(0, 0, nearGrids.textureSize, nearGrids.textureSize);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const program = psys.meshPrograms.nearField;
  gl.useProgram(program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, pmGrid.texture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_massGrid'), 0);

  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), pmGrid.gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), pmGrid.slicesPerRow);
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMin'), psys.options.worldBounds.min[0], psys.options.worldBounds.min[1], psys.options.worldBounds.min[2]);
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMax'), psys.options.worldBounds.max[0], psys.options.worldBounds.max[1], psys.options.worldBounds.max[2]);
  gl.uniform1f(gl.getUniformLocation(program, 'u_softening'), psys.options.softening || 0.0);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gravityStrength'), psys.options.gravityStrength || 0.0003);
  gl.uniform1i(gl.getUniformLocation(program, 'u_nearFieldRadius'), psys.meshConfig.nearFieldRadius);

  gl.bindVertexArray(psys.quadVAO);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nearGrids.x, 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_component'), 0);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nearGrids.y, 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_component'), 1);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, nearGrids.z, 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_component'), 2);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  // Pass 2: sample near-field grid at particle positions and accumulate
  if (!psys.pmForceTexture || !psys.pmForceFBO) {
    console.error('[Mesh Near-Field] pmForceTexture not initialized');
    return;
  }

  const positionTexture = psys.positionTextures?.getCurrentTexture?.();
  if (!positionTexture) {
    console.error('[Mesh Near-Field] Position texture unavailable');
    return;
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmForceFBO);
  gl.viewport(0, 0, psys.textureWidth, psys.textureHeight);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.blendEquation(gl.FUNC_ADD);

  const sampleProgram = psys.meshPrograms.nearFieldSample;
  gl.useProgram(sampleProgram);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, positionTexture);
  gl.uniform1i(gl.getUniformLocation(sampleProgram, 'u_positionTexture'), 0);
  gl.uniform2f(gl.getUniformLocation(sampleProgram, 'u_textureSize'), psys.textureWidth, psys.textureHeight);

  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, nearGrids.x);
  gl.uniform1i(gl.getUniformLocation(sampleProgram, 'u_forceGridX'), 1);

  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, nearGrids.y);
  gl.uniform1i(gl.getUniformLocation(sampleProgram, 'u_forceGridY'), 2);

  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, nearGrids.z);
  gl.uniform1i(gl.getUniformLocation(sampleProgram, 'u_forceGridZ'), 3);

  gl.uniform1f(gl.getUniformLocation(sampleProgram, 'u_gridSize'), pmGrid.gridSize);
  gl.uniform1f(gl.getUniformLocation(sampleProgram, 'u_slicesPerRow'), pmGrid.slicesPerRow);
  gl.uniform3f(gl.getUniformLocation(sampleProgram, 'u_worldMin'), psys.options.worldBounds.min[0], psys.options.worldBounds.min[1], psys.options.worldBounds.min[2]);
  gl.uniform3f(gl.getUniformLocation(sampleProgram, 'u_worldMax'), psys.options.worldBounds.max[0], psys.options.worldBounds.max[1], psys.options.worldBounds.max[2]);

  gl.bindVertexArray(psys.particleVAO);
  gl.drawArrays(gl.POINTS, 0, psys.options.particleCount);
  gl.bindVertexArray(null);

  gl.disable(gl.BLEND);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
