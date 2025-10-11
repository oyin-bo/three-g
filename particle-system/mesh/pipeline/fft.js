// @ts-check

import fsQuadVert from '../../shaders/fullscreen.vert.js';
import fftFrag from '../../shaders/fft.frag.js';
import { createProgram } from '../../utils/common.js';

/**
 * Initialize mesh FFT resources (program + spectrum textures).
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
export function initMeshFFT(psys) {
  const gl = psys.gl;

  if (!psys.meshPrograms.fft) {
    psys.meshPrograms.fft = createProgram(gl, fsQuadVert, fftFrag);
    console.log('[Mesh FFT] Program created');
  }

  if (!psys.meshSpectrum) {
    const gridSize = psys.meshConfig.gridSize;
    const textureSize = psys.pmGrid?.size ?? 0;

    if (!textureSize) {
      throw new Error('Mesh FFT requires pmGrid to be initialized');
    }

    const spectrumTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, spectrumTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, textureSize, textureSize, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const pingPongTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, pingPongTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, textureSize, textureSize, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindTexture(gl.TEXTURE_2D, null);

    const spectrumFBO = gl.createFramebuffer();
    const pingPongFBO = gl.createFramebuffer();

    psys.meshSpectrum = {
      texture: spectrumTex,
      framebuffer: spectrumFBO,
      pingPong: pingPongTex,
      pingPongFBO: pingPongFBO,
      gridSize,
      textureSize,
      width: textureSize,
      height: textureSize
    };

    console.log(`[Mesh FFT] Spectrum textures created (${textureSize}x${textureSize})`);
  }

  if (!psys.meshDensitySpectrum) {
    const densityTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, densityTex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RG32F,
      psys.meshSpectrum.textureSize,
      psys.meshSpectrum.textureSize,
      0,
      gl.RG,
      gl.FLOAT,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const densityFBO = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, densityFBO);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, densityTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    psys.meshDensitySpectrum = {
      texture: densityTex,
      framebuffer: densityFBO,
      gridSize: psys.meshSpectrum.gridSize,
      textureSize: psys.meshSpectrum.textureSize,
      width: psys.meshSpectrum.textureSize,
      height: psys.meshSpectrum.textureSize
    };
  }
}

/**
 * Placeholder forward FFT for mesh pipeline; will be replaced with full Stockham implementation.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
export function meshForwardFFT(psys) {
  initMeshFFT(psys);
  // TODO: Port perform3DFFT/convertRealToComplex pipeline using mesh resources.
}
