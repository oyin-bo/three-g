// @ts-check

import fsQuadVert from '../../shaders/fullscreen.vert.js';
import poissonFrag from '../../shaders/poisson.frag.js';
import { createProgram } from '../../utils/common.js';

/**
 * Ensure Poisson program and potential spectrum texture exist.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
function initMeshPoisson(psys) {
  const gl = psys.gl;

  if (!psys.meshPrograms.poisson) {
    psys.meshPrograms.poisson = createProgram(gl, fsQuadVert, poissonFrag);
    console.log('[Mesh Poisson] Program created');
  }

  if (!psys.meshPotentialSpectrum) {
    if (!psys.pmGrid) {
      throw new Error('Mesh Poisson requires pmGrid to be initialized');
    }

    const size = psys.pmGrid.size;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, size, size, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);

    const fbo = gl.createFramebuffer();

    psys.meshPotentialSpectrum = {
      texture: tex,
      framebuffer: fbo,
      gridSize: psys.pmGrid.gridSize,
      textureSize: size,
      width: size,
      height: size
    };

    console.log(`[Mesh Poisson] Potential spectrum texture created (${size}x${size})`);
  }
}

/**
 * Solve Poisson equation in Fourier space for mesh pipeline.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @param {{ fourPiG?: number, boxSize?: number }} [options]
 */
export function meshSolvePoisson(psys, options = {}) {
  initMeshPoisson(psys);

  const gl = psys.gl;
  const program = psys.meshPrograms.poisson;
  const meshSpectrum = psys.meshSpectrum;
  const densitySpectrum = psys.meshDensitySpectrum;
  const potentialSpectrum = psys.meshPotentialSpectrum;
  const pmGrid = psys.pmGrid;

  if (!program || !meshSpectrum || !densitySpectrum || !potentialSpectrum || !pmGrid) {
    throw new Error('Mesh Poisson resources not initialized');
  }

  const fourPiG = options.fourPiG ?? (4.0 * Math.PI * (psys.options.gravityStrength || 0.0003));

  let boxSize = options.boxSize;
  if (boxSize === undefined) {
    const bounds = psys.options.worldBounds || null;
    if (bounds) {
      const dx = bounds.max[0] - bounds.min[0];
      const dy = bounds.max[1] - bounds.min[1];
      const dz = bounds.max[2] - bounds.min[2];
      boxSize = Math.max(dx, dy, dz);
    } else {
      boxSize = 100.0;
    }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, potentialSpectrum.framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    potentialSpectrum.texture,
    0
  );

  gl.viewport(0, 0, potentialSpectrum.textureSize, potentialSpectrum.textureSize);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.colorMask(true, true, true, true);

  gl.useProgram(program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, densitySpectrum.texture || meshSpectrum.texture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_densitySpectrum'), 0);

  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), pmGrid.gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), pmGrid.slicesPerRow);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gravitationalConstant'), fourPiG);
  gl.uniform1f(gl.getUniformLocation(program, 'u_boxSize'), boxSize);

  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
