// @ts-check

import fsQuadVert from '../../shaders/fullscreen.vert.js';
import fftFrag from '../../gravity-spectral/shaders/fft.frag.js';
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
 * Ensure real→complex conversion program exists.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
function ensureRealToComplexProgram(psys) {
  if (psys.meshPrograms.realToComplex) return;

  const frag = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 outColor;
    uniform sampler2D u_massGrid;

    void main() {
      float mass = texture(u_massGrid, v_uv).a;
      outColor = vec4(mass, 0.0, 0.0, 0.0);
    }
  `;

  psys.meshPrograms.realToComplex = createProgram(psys.gl, fsQuadVert, frag);
  console.log('[Mesh FFT] Real→Complex program created');
}

/**
 * Convert PM mass grid (alpha) to complex spectrum (RG32F).
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
function convertMeshRealToComplex(psys) {
  const gl = psys.gl;
  const meshSpectrum = psys.meshSpectrum;
  const pmGrid = psys.pmGrid;
  if (!meshSpectrum || !pmGrid) {
    throw new Error('Mesh FFT requires pmGrid and spectrum resources');
  }

  ensureRealToComplexProgram(psys);

  gl.bindFramebuffer(gl.FRAMEBUFFER, meshSpectrum.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, meshSpectrum.texture, 0);

  gl.viewport(0, 0, meshSpectrum.textureSize, meshSpectrum.textureSize);
  gl.useProgram(psys.meshPrograms.realToComplex);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, pmGrid.texture);
  gl.uniform1i(gl.getUniformLocation(psys.meshPrograms.realToComplex, 'u_massGrid'), 0);

  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Perform 3D Stockham FFT on mesh spectrum.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @param {boolean=} inverse
 */
function performMesh3DFFT(psys, inverse = false) {
  const gl = psys.gl;
  const program = psys.meshPrograms.fft;
  const meshSpectrum = psys.meshSpectrum;
  const pmGrid = psys.pmGrid;
  if (!program || !meshSpectrum || !pmGrid) {
    throw new Error('Mesh FFT resources not initialized');
  }

  const gridSize = pmGrid.gridSize;
  const textureSize = meshSpectrum.textureSize;
  const slicesPerRow = pmGrid.slicesPerRow;
  const numStages = Math.log2(gridSize) | 0;

  gl.useProgram(program);
  gl.viewport(0, 0, textureSize, textureSize);

  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);

  const uGridSize = gl.getUniformLocation(program, 'u_gridSize');
  const uSlicesPerRow = gl.getUniformLocation(program, 'u_slicesPerRow');
  const uInverse = gl.getUniformLocation(program, 'u_inverse');
  const uAxis = gl.getUniformLocation(program, 'u_axis');
  const uStage = gl.getUniformLocation(program, 'u_stage');
  const uInputTex = gl.getUniformLocation(program, 'u_inputTexture');

  gl.uniform1f(uGridSize, gridSize);
  gl.uniform1f(uSlicesPerRow, slicesPerRow);
  gl.uniform1i(uInverse, inverse ? 1 : 0);

  for (let axis = 0; axis < 3; axis++) {
    gl.uniform1i(uAxis, axis);

    for (let stage = 0; stage < numStages; stage++) {
      gl.uniform1i(uStage, stage);

      const readFromPrimary = (stage % 2 === 0);
      const readTex = readFromPrimary ? meshSpectrum.texture : meshSpectrum.pingPong;
      const writeTex = readFromPrimary ? meshSpectrum.pingPong : meshSpectrum.texture;
      const writeFBO = readFromPrimary ? meshSpectrum.pingPongFBO : meshSpectrum.framebuffer;

      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, writeTex, 0);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.uniform1i(uInputTex, 0);

      gl.bindVertexArray(psys.quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
    }

    if (numStages % 2 === 1) {
      copyMeshTexture(gl, meshSpectrum.pingPong, meshSpectrum.texture, textureSize);
    }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/**
 * Copy helper for ping-pong textures.
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} src
 * @param {WebGLTexture} dst
 * @param {number} size
 */
function copyMeshTexture(gl, src, dst, size) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0);

  gl.bindTexture(gl.TEXTURE_2D, dst);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, size, size);

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
}

/**
 * Forward FFT for mesh pipeline: mass grid → density spectrum.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
export function meshForwardFFT(psys) {
  initMeshFFT(psys);
  convertMeshRealToComplex(psys);
  performMesh3DFFT(psys, false);

  const gl = psys.gl;
  const meshSpectrum = psys.meshSpectrum;
  const densitySpectrum = psys.meshDensitySpectrum;
  if (!meshSpectrum || !densitySpectrum) {
    throw new Error('Mesh FFT spectra not initialized');
  }

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, meshSpectrum.framebuffer);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, meshSpectrum.texture, 0);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, densitySpectrum.framebuffer);
  gl.blitFramebuffer(
    0, 0, meshSpectrum.textureSize, meshSpectrum.textureSize,
    0, 0, densitySpectrum.textureSize, densitySpectrum.textureSize,
    gl.COLOR_BUFFER_BIT, gl.NEAREST
  );
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

function ensureComplexToRealProgram(psys) {
  if (psys.meshPrograms.extractReal) {
    return;
  }

  const frag = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 outColor;
    uniform sampler2D u_complexTexture;

    void main() {
      vec2 complexValue = texture(u_complexTexture, v_uv).rg;
      float realPart = complexValue.r;
      outColor = vec4(realPart, 0.0, 0.0, realPart);
    }
  `;

  psys.meshPrograms.extractReal = createProgram(psys.gl, fsQuadVert, frag);
  console.log('[Mesh FFT] Complex→Real program created');
}

/**
 * Ensure real-space force grids exist for mesh pipeline.
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 */
export function initMeshForceGrids(psys, { target = 'far' } = {}) {
  const prop = target === 'near' ? 'meshNearForceGrids' : 'meshForceGrids';

  if (psys[prop]) {
    if (target !== 'near') {
      psys.pmForceGrids = psys[prop];
    }
    return;
  }

  const gl = psys.gl;
  const grid = psys.pmGrid;
  if (!grid) {
    throw new Error('Mesh FFT requires pmGrid to initialize force grids');
  }

  const size = grid.size;

  const createForceGridTexture = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  };

  const grids = {
    x: createForceGridTexture(),
    y: createForceGridTexture(),
    z: createForceGridTexture(),
    textureSize: size
  };

  if (target === 'near') {
    const framebuffer = gl.createFramebuffer();
    psys[prop] = {
      x: grids.x,
      y: grids.y,
      z: grids.z,
      textureSize: size,
      framebuffer
    };
    console.log(`[Mesh FFT] Near-field force grids created (${size}x${size} x3)`);
    return;
  }

  psys[prop] = grids;
  psys.pmForceGrids = grids;
  console.log(`[Mesh FFT] Force grid textures created (${size}x${size} x3)`);
}

export function meshInverseFFTToReal(psys, inputSpectrum, outputTexture) {
  const gl = psys.gl;
  const meshSpectrum = psys.meshSpectrum;

  if (!meshSpectrum) {
    throw new Error('Mesh FFT spectrum resources not initialized');
  }

  const textureSize = meshSpectrum.textureSize;

  const readFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFBO);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, inputSpectrum, 0);

  gl.bindTexture(gl.TEXTURE_2D, meshSpectrum.texture);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, textureSize, textureSize);

  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.deleteFramebuffer(readFBO);

  performMesh3DFFT(psys, true);

  ensureComplexToRealProgram(psys);

  const drawFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, drawFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputTexture, 0);

  gl.viewport(0, 0, textureSize, textureSize);
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.colorMask(true, true, true, true);
  gl.depthMask(false);

  gl.useProgram(psys.meshPrograms.extractReal);

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, meshSpectrum.texture);
  gl.uniform1i(gl.getUniformLocation(psys.meshPrograms.extractReal, 'u_complexTexture'), 0);

  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(drawFBO);
}
