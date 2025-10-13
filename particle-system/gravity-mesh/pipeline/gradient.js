// @ts-check

import fsQuadVert from '../../shaders/fullscreen.vert.js';
import gradientFrag from '../../gravity-spectral/shaders/gradient.frag.js';
import { createProgram } from '../../utils/common.js';

/**
 * Ensure gradient program and force spectrum textures are initialized.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
function initMeshGradient(psys) {
  const gl = psys.gl;

  if (!psys.meshPrograms.gradient) {
    psys.meshPrograms.gradient = createProgram(gl, fsQuadVert, gradientFrag);
    console.log('[Mesh Gradient] Program created');
  }

  if (!psys.meshForceSpectrum) {
    if (!psys.pmGrid) {
      throw new Error('Mesh Gradient requires pmGrid to be initialized');
    }

    const size = psys.pmGrid.size;

    const makeTexture = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, size, size, 0, gl.RG, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    };

    psys.meshForceSpectrum = {
      x: { texture: makeTexture(), framebuffer: gl.createFramebuffer() },
      y: { texture: makeTexture(), framebuffer: gl.createFramebuffer() },
      z: { texture: makeTexture(), framebuffer: gl.createFramebuffer() },
      gridSize: psys.pmGrid.gridSize,
      textureSize: size
    };

    console.log(`[Mesh Gradient] Force spectrum textures created (${size}x${size} x3)`);
  }
}

/**
 * Compute force spectra from potential spectrum for mesh pipeline.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @param {{ boxSize?: number }} [options]
 */
export function meshComputeGradient(psys, options = {}) {
  initMeshGradient(psys);

  const gl = psys.gl;
  const program = psys.meshPrograms.gradient;
  const potentialSpectrum = psys.meshPotentialSpectrum;
  const forceSpectrum = psys.meshForceSpectrum;
  const pmGrid = psys.pmGrid;

  if (!program || !potentialSpectrum || !forceSpectrum || !pmGrid) {
    throw new Error('Mesh Gradient resources not initialized');
  }

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

  gl.viewport(0, 0, pmGrid.size, pmGrid.size);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.colorMask(true, true, true, true);

  gl.useProgram(program);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, potentialSpectrum.texture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_potentialSpectrum'), 0);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), pmGrid.gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), pmGrid.slicesPerRow);
  gl.uniform1f(gl.getUniformLocation(program, 'u_boxSize'), boxSize);

  const axes = [
    { axisIndex: 0, target: forceSpectrum.x },
    { axisIndex: 1, target: forceSpectrum.y },
    { axisIndex: 2, target: forceSpectrum.z }
  ];

  gl.bindVertexArray(psys.quadVAO);

  for (const { axisIndex, target } of axes) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.texture, 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_axis'), axisIndex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  gl.bindVertexArray(null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
