// @ts-check

/**
 * PM/FFT Pipeline - FFT Transforms
 * 
 * Implements 3D FFT for the PM grid using separable transforms:
 * - Forward FFT: Real space → Fourier space
 * - Inverse FFT: Fourier space → Real space
 * 
 * NORMALIZATION CONVENTION:
 * -------------------------
 * Forward:  F̂(k) = Σ f(x)·exp(-2πikx)           [unnormalized]
 * Inverse:  f(x) = (1/N³)·Σ F̂(k)·exp(2πikx)    [normalized by 1/N³]
 * 
 * Implementation: (1/N) applied per axis at final butterfly stage of inverse.
 * 
 * PROPERTIES:
 * - DC mode: F̂(0,0,0) = Σ f(x) = total mass
 * - Round-trip: IFFT(FFT(f)) = f (mass conserved to machine precision)
 * - Parseval: Σ|F̂(k)|² = N³·Σ|f(x)|² (energy scaled by N³ in frequency domain)
 * 
 * VERIFICATION (debug.js):
 * - Mass conservation: |sumAlphaRecon - sumAlphaOrig| / sumAlphaOrig < 1e-7
 * - DC amplitude: spectrumSample[0] ≈ sumAlphaOrig (within ~1e-8 relative)
 * - Round-trip RMSE: typically ~5 (small compared to total mass ~2.4e5)
 */

import fsQuadVert from '../shaders/fullscreen.vert.js';
import { inspectTexture } from './debug/texture-inspector.js';

/**
 * Convert real-valued mass grid to complex format (zero imaginary part)
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectral} psys
 */
export function convertRealToComplex(psys) {
  const gl = psys.gl;
  const debugFFT = psys._debugFFT || false;
    const textureSize = psys.pmGrid.size;
  
  if (!psys._realToComplexProgram) {
    configureRealToComplex(psys);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmSpectrum.framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, psys.pmSpectrum.texture, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  
  // Check framebuffer completeness
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('[PM FFT] Framebuffer incomplete in convertRealToComplex:', status);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return;
  }
  
  gl.viewport(0, 0, textureSize, textureSize);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  gl.useProgram(psys._realToComplexProgram);
  
  // Clear any previous GL errors
  while (gl.getError() !== gl.NO_ERROR);
  
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, psys.pmGrid.texture);
  gl.uniform1i(gl.getUniformLocation(psys._realToComplexProgram, 'u_massGrid'), 0);
  
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  // Check for GL errors after draw
  const err = gl.getError();
  if (err !== gl.NO_ERROR) {
    console.error('[PM FFT] GL error in convertRealToComplex:', err);
  }
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Debug: inspect converted spectrum
  if (debugFFT) {
    inspectTexture(gl, psys.pmSpectrum.texture, textureSize, textureSize, 'RG', 'After convertRealToComplex');
  }
}

function configureRealToComplex(psys) {
  const gl = psys.gl;

  if (!psys._realToComplexProgram) {
    const convertSrc = `#version 300 es
      precision highp float;
      in vec2 v_uv;
      out vec4 outColor;
      uniform sampler2D u_massGrid;
      void main() {
        float mass = texture(u_massGrid, v_uv).a;
        outColor = vec4(mass, 0.0, 0.0, 0.0);
      }
    `;
    psys._realToComplexProgram = psys.createProgram(fsQuadVert, convertSrc);
  }
}

/**
 * Perform 3D FFT (forward or inverse)
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectral} psys
 * @param {boolean} inverse - true for inverse FFT, false for forward
 */
export function perform3DFFT(psys, inverse = false) {
  const gl = psys.gl;
  const program = psys.pmFFTProgram;
  const gridSize = psys.pmGrid.gridSize;
  const textureSize = psys.pmGrid.size;
  const slicesPerRow = psys.pmGrid.slicesPerRow;
  const debugFFT = psys._debugFFT || false;
  const spectrum = psys.pmSpectrum;
  if (!spectrum) {
    console.error('[PM FFT] pmSpectrum missing; did initFFT run?');
    return;
  }

  const collectSnapshots = Boolean(psys['_collectFFTSnapshots']);
  if (collectSnapshots) {
    psys['_fftStageSnapshots'] = [];
  }
  const stopConfig = psys['_fftStopAfterStage'] || null;
  const debugMode = typeof psys['_fftShaderDebugMode'] === 'number' ? psys['_fftShaderDebugMode'] : 0;
  
  const numStages = Math.log2(gridSize); // 6 for 64³ grid
  
  // Debug: inspect input
  if (debugFFT) {
    const direction = inverse ? 'INVERSE' : 'FORWARD';
    console.log(`[PM FFT] Starting ${direction} FFT`);
    inspectTexture(gl, spectrum.texture, textureSize, textureSize, 'RG', `Before ${direction} FFT`);
  }
  
  gl.useProgram(program);
  gl.viewport(0, 0, textureSize, textureSize);
  
  // Set GL state
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.colorMask(true, true, true, true);
  
  // Set constant uniforms
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), slicesPerRow);
  gl.uniform1i(gl.getUniformLocation(program, 'u_inverse'), inverse ? 1 : 0);
  
  // Perform FFT along each axis
  for (let axis = 0; axis < 3; axis++) {
    gl.uniform1i(gl.getUniformLocation(program, 'u_axis'), axis);
    
    // Multiple stages per axis
    for (let stage = 0; stage < numStages; stage++) {
      gl.uniform1i(gl.getUniformLocation(program, 'u_stage'), stage);
      
      // Ping-pong between textures
      const readFromPrimary = (stage % 2 === 0);
      const readTex = readFromPrimary ? spectrum.texture : spectrum.pingPong;
      const writeFBO = readFromPrimary ? spectrum.pingPongFBO : spectrum.framebuffer;
      const writeTex = readFromPrimary ? spectrum.pingPong : spectrum.texture;
      
      gl.bindFramebuffer(gl.FRAMEBUFFER, writeFBO);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, writeTex, 0);
      
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, readTex);
      gl.uniform1i(gl.getUniformLocation(program, 'u_inputTexture'), 0);
      gl.uniform1i(gl.getUniformLocation(program, 'u_debugMode'), debugMode);
      
      gl.bindVertexArray(psys.quadVAO);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);

      if (collectSnapshots) {
        const label = `FFT axis ${axis} stage ${stage} -> ${writeFBO === spectrum.framebuffer ? 'spectrum' : 'pingPong'}`;
        const stats = inspectTexture(gl, writeTex, textureSize, textureSize, 'RG', label);
        psys['_fftStageSnapshots'].push({ axis, stage, target: writeFBO === spectrum.framebuffer ? 'spectrum' : 'pingPong', stats });
      }

      if (stopConfig && stopConfig.axis === axis && stopConfig.stage === stage) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return;
      }
    }
    
    // After all stages, ensure result is in primary texture
    if (numStages % 2 === 1) {
      // Copy from pingPong back to primary
      copyTexture(gl, spectrum.pingPong, spectrum.texture, textureSize);
      if (collectSnapshots) {
        const stats = inspectTexture(gl, spectrum.texture, textureSize, textureSize, 'RG', `FFT axis ${axis} final copy`);
        psys['_fftStageSnapshots'].push({ axis, stage: 'finalCopy', target: 'spectrum', stats });
      }
    }
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  const direction = inverse ? 'inverse' : 'forward';
  console.log(`[PM FFT] ${direction} 3D FFT completed (${numStages * 3} passes)`);
  
  // Debug: inspect output
  if (debugFFT) {
    const directionLabel = inverse ? 'INVERSE' : 'FORWARD';
    inspectTexture(gl, spectrum.texture, textureSize, textureSize, 'RG', `After ${directionLabel} FFT`);
  }
}

/**
 * Copy texture (helper)
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} src
 * @param {WebGLTexture} dst
 * @param {number} size
 */
function copyTexture(gl, src, dst, size) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, src, 0);
  
  gl.bindTexture(gl.TEXTURE_2D, dst);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, size, size);
  
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
}

/**
 * Forward FFT: mass grid → spectrum
 * 
 * Computes the 3D FFT of the mass grid and stores the result in pmDensitySpectrum.
 * The forward transform is unnormalized, so DC mode equals the total mass.
 * 
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectral} psys
 */
export function forwardFFT(psys) {
  convertRealToComplex(psys);
  perform3DFFT(psys, false);
  
  // Store result as density spectrum for later use
  // IMPORTANT: We must create a COPY, not an alias, because subsequent
  // inverse FFT operations will overwrite psys.pmSpectrum.texture
  const gl = psys.gl;
  const textureSize = psys.pmSpectrum.textureSize;
  
  if (!psys.pmDensitySpectrum) {
    // Create dedicated texture for density spectrum
    const densityTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, densityTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, textureSize, textureSize, 0, gl.RG, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Create framebuffer for the density spectrum
    const densityFb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, densityFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, densityTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    
    psys.pmDensitySpectrum = {
      texture: densityTex,
      framebuffer: densityFb,
      gridSize: psys.pmSpectrum.gridSize,
      textureSize: textureSize,
      width: textureSize,
      height: textureSize
    };
  }
  
  // Copy the spectrum data to the density spectrum texture
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, psys.pmSpectrum.framebuffer);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, psys.pmDensitySpectrum.framebuffer);
  gl.blitFramebuffer(
    0, 0, textureSize, textureSize,
    0, 0, textureSize, textureSize,
    gl.COLOR_BUFFER_BIT, gl.NEAREST
  );
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}

/**
 * Inverse FFT: spectrum → real grid
 * 
 * NORMALIZATION CONVENTION:
 * - Forward FFT is unnormalized: F̂(k) = Σ f(x)·exp(-2πikx)
 * - Inverse FFT applies 1/N³ normalization: f(x) = (1/N³)·Σ F̂(k)·exp(2πikx)
 * - This is implemented as (1/N) per axis at the final butterfly stage
 * - Round-trip property: IFFT(FFT(f)) = f (mass conserved)
 * 
 * ENERGY BEHAVIOR:
 * - Real-space energy: E_real = Σ|f(x)|²
 * - Frequency-space energy: E_freq = Σ|F̂(k)|²
 * - Parseval's theorem: E_freq = N³·E_real (due to unnormalized forward)
 * - After round-trip: reconstructed energy ≈ E_real (within numerical precision)
 * 
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectral} psys
 * @param {WebGLTexture} inputSpectrum - Input complex spectrum (RG32F)
 * @param {WebGLTexture} outputReal - Output real-valued texture (RGBA32F, real stored in R and A)
 */
export function inverseFFTToReal(psys, inputSpectrum, outputReal) {
  const gl = psys.gl;
  const textureSize = psys.pmGrid.size;
  const debugFFT = psys._debugFFT || false;
  
  // Debug: inspect input spectrum
  if (debugFFT) {
    console.log('[PM FFT] inverseFFTToReal called');
    inspectTexture(gl, inputSpectrum, textureSize, textureSize, 'RG', 'inverseFFTToReal input spectrum');
  }
  
  // First, copy input spectrum to working spectrum texture
  const tempFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, tempFbo);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, inputSpectrum, 0);
  gl.bindTexture(gl.TEXTURE_2D, psys.pmSpectrum.texture);
  gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, textureSize, textureSize);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.deleteFramebuffer(tempFbo);
  
  // Debug: verify copy
  if (debugFFT) {
    inspectTexture(gl, psys.pmSpectrum.texture, textureSize, textureSize, 'RG', 'After copying to pmSpectrum.texture');
  }
  
  // Perform inverse FFT
  perform3DFFT(psys, true);
  
  // Extract real part from complex result and write to output
  const extractRealSrc = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 outColor;
    uniform sampler2D u_complexTexture;
    
    void main() {
      vec2 complex = texture(u_complexTexture, v_uv).rg;
      float realPart = complex.r; // Extract real component
      outColor = vec4(realPart, 0.0, 0.0, realPart); // Store in R and A
    }
  `;
  
  if (!psys._extractRealProgram) {
    psys._extractRealProgram = psys.createProgram(
      `#version 300 es
       in vec2 a_position;
       out vec2 v_uv;
       void main() {
         v_uv = a_position * 0.5 + 0.5;
         gl_Position = vec4(a_position, 0.0, 1.0);
       }`,
      extractRealSrc
    );
  }
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outputReal, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return;
  }
  
  gl.viewport(0, 0, textureSize, textureSize);
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);
  gl.disable(gl.BLEND);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  gl.useProgram(psys._extractRealProgram);
  
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, psys.pmSpectrum.texture);
  gl.uniform1i(gl.getUniformLocation(psys._extractRealProgram, 'u_complexTexture'), 0);
  
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Debug: inspect final output
  if (debugFFT) {
    inspectTexture(gl, outputReal, textureSize, textureSize, 'RGBA', 'inverseFFTToReal output real');
  }
}
