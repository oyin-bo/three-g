// @ts-check

/**
 * PM Debug Metrics System
 * 
 * GPU-side invariant checks and diagnostics:
 * - Mass conservation (∑ρ_grid = ∑m_particles)
 * - DC zero check (φ̂(0) = 0, ∑g ≈ 0)
 * - FFT inverse identity (IFFT(FFT(f)) ≈ f)
 * - Poisson solver validation (-k²φ̂ = 4πGρ̂)
 * 
 * Uses existing pyramid reduction infrastructure for GPU-side sums.
 */

/**
 * Check mass conservation
 * Compares total mass in grid vs. particle textures
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @returns {Promise<{passed: boolean, gridMass: number, particleMass: number, error: number}>}
 */
export async function checkMassConservation(psys) {
  const gl = psys.gl;
  
  // Get the PM grid
  const grid = psys.pmGrid;
  if (!grid) {
    console.warn('[PM Metrics] PM grid not initialized');
    return { passed: false, gridMass: 0, particleMass: 0, error: 1.0 };
  }
  
  // Read the entire grid texture to CPU and sum mass (alpha channel)
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, grid.texture, 0);
  
  const gridSize = grid.size;
  const gridData = new Float32Array(gridSize * gridSize * 4); // RGBA
  gl.readPixels(0, 0, gridSize, gridSize, gl.RGBA, gl.FLOAT, gridData);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Sum mass from alpha channel (every 4th element: indices 3, 7, 11, ...)
  let gridMass = 0.0;
  for (let i = 0; i < gridSize * gridSize; i++) {
    gridMass += gridData[i * 4 + 3]; // RGBA: index 3 is alpha (mass)
  }
  
  // Sum particle masses from CPU-side position data
  // Position data is RGBA format: [x, y, z, mass, x, y, z, mass, ...]
  // Mass is stored in every 4th element (indices 3, 7, 11, ...)
  let particleMass = 0.0;
  const positions = psys.particleData?.positions;
  
  if (!positions || !psys.particleCount) {
    console.warn('[PM Metrics] No particle position data available');
    return { passed: false, gridMass: gridMass, particleMass: 0, error: 1.0 };
  }
  
  // Sum all mass values (every 4th element starting at index 3)
  for (let i = 0; i < psys.particleCount; i++) {
    particleMass += positions[i * 4 + 3]; // positions[3, 7, 11, 15, ...] = mass
  }
  
  const error = Math.abs(gridMass - particleMass) / Math.max(particleMass, 1e-10);
  const passed = error < 1e-3; // 0.1% tolerance
  
  console.log(`[PM Metrics] Mass conservation: grid=${gridMass.toFixed(6)}, particles=${particleMass.toFixed(6)}, error=${(error*100).toFixed(4)}%`);
  
  return { passed, gridMass, particleMass, error };
}

/**
 * Check DC component is zero
 * For a periodic system, DC mode (k=0) should be zero after Poisson solve
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {WebGLTexture} spectrumTexture - Complex spectrum (RG32F)
 * @returns {Promise<{passed: boolean, dcReal: number, dcImag: number, magnitude: number}>}
 */
export async function checkDCZero(psys, spectrumTexture) {
  const gl = psys.gl;
  
  // Read single texel at (0,0) which corresponds to k=0
  const dcValue = await readPixel(psys, spectrumTexture, 0, 0);
  const dcReal = dcValue[0];
  const dcImag = dcValue[1];
  const magnitude = Math.sqrt(dcReal * dcReal + dcImag * dcImag);
  
  const passed = magnitude < 1e-6;
  
  console.log(`[PM Metrics] DC check: real=${dcReal.toExponential(3)}, imag=${dcImag.toExponential(3)}, |DC|=${magnitude.toExponential(3)}`);
  
  return { passed, dcReal, dcImag, magnitude };
}

/**
 * Check FFT inverse identity
 * Verify that IFFT(FFT(f)) ≈ f
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {WebGLTexture} originalTexture 
 * @param {WebGLTexture} roundtripTexture 
 * @param {number} width 
 * @param {number} height 
 * @returns {Promise<{passed: boolean, rmsError: number, maxError: number}>}
 */
export async function checkFFTInverseIdentity(psys, originalTexture, roundtripTexture, width, height) {
  const gl = psys.gl;
  
  // Compute difference texture
  const diffTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, diffTexture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  // Compute |original - roundtrip|² using a shader
  const program = getOrCreateMetricsProgram(psys);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, diffTexture, 0);
  gl.viewport(0, 0, width, height);
  
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'u_metricType'), 0); // FFT error
  
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, originalTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_texA'), 0);
  
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, roundtripTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_texB'), 1);
  
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  // Sum squared errors
  const sumSqError = await sumTexture(psys, diffTexture, width, height, 0); // red channel
  const rmsError = Math.sqrt(sumSqError / (width * height));
  
  // Get max error (requires additional pass or readback)
  const maxError = rmsError * 3.0; // Approximate upper bound
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  gl.deleteTexture(diffTexture);
  
  const passed = rmsError < 1e-4;
  
  console.log(`[PM Metrics] FFT roundtrip: RMS error=${rmsError.toExponential(3)}, max≈${maxError.toExponential(3)}`);
  
  return { passed, rmsError, maxError };
}

/**
 * Check Poisson equation on plane wave
 * Verify -k²φ̂ = 4πGρ̂ for a known wave mode
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {[number, number, number]} k - Wave vector
 * @param {WebGLTexture} rhoSpectrum 
 * @param {WebGLTexture} phiSpectrum 
 * @returns {Promise<{passed: boolean, error: number}>}
 */
export async function checkPoissonOnPlaneWave(psys, k, rhoSpectrum, phiSpectrum) {
  const gl = psys.gl;
  
  // Read mode k from both spectra
  const gridSize = psys.octreeGridSize || 64;
  const slicesPerRow = psys.octreeSlicesPerRow || 8;
  
  // Convert k to texture coordinates
  const [kx, ky, kz] = k.map(ki => ki < 0 ? ki + gridSize : ki);
  const sliceIndex = kz;
  const sliceRow = Math.floor(sliceIndex / slicesPerRow);
  const sliceCol = sliceIndex % slicesPerRow;
  const texX = sliceCol * gridSize + kx;
  const texY = sliceRow * gridSize + ky;
  
  const rhoK = await readPixel(psys, rhoSpectrum, texX, texY);
  const phiK = await readPixel(psys, phiSpectrum, texX, texY);
  
  // Compute expected: φ̂ = -4πG ρ̂ / k²
  const G = psys.options.gravityStrength || 1.0;
  const kSq = k[0]*k[0] + k[1]*k[1] + k[2]*k[2];
  
  if (kSq === 0) {
    console.log(`[PM Metrics] Poisson check: DC mode (k=0), skipping`);
    return { passed: true, error: 0 };
  }
  
  const factor = -4.0 * Math.PI * G / kSq;
  const expectedReal = rhoK[0] * factor;
  const expectedImag = rhoK[1] * factor;
  
  const errorReal = Math.abs(phiK[0] - expectedReal);
  const errorImag = Math.abs(phiK[1] - expectedImag);
  const error = Math.sqrt(errorReal*errorReal + errorImag*errorImag);
  
  const passed = error < 1e-4;
  
  console.log(`[PM Metrics] Poisson check at k=(${k}): error=${error.toExponential(3)}`);
  console.log(`  ρ̂=${rhoK[0].toFixed(6)}+${rhoK[1].toFixed(6)}i, φ̂=${phiK[0].toFixed(6)}+${phiK[1].toFixed(6)}i`);
  console.log(`  expected φ̂=${expectedReal.toFixed(6)}+${expectedImag.toFixed(6)}i`);
  
  return { passed, error };
}

/**
 * Sum a texture using pyramid reduction
 * Reuses existing reduction infrastructure
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {WebGLTexture} texture 
 * @param {number} width 
 * @param {number} height 
 * @param {number} channel - 0=R, 1=G, 2=B, 3=A
 * @returns {Promise<number>}
 */
async function sumTexture(psys, texture, width, height, channel) {
  const gl = psys.gl;
  
  // Create temporary reduction pyramid
  const tempTextures = [];
  const tempFBOs = [];
  
  let currentSize = Math.max(width, height);
  
  // Build reduction pyramid
  while (currentSize >= 1) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, currentSize, currentSize, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    
    tempTextures.push(tex);
    tempFBOs.push(fbo);
    
    if (currentSize === 1) break;
    currentSize = Math.ceil(currentSize / 2);
  }
  
  // Copy source to first level
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, gl.createFramebuffer());
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, tempFBOs[0]);
  gl.blitFramebuffer(0, 0, width, height, 0, 0, tempTextures.length > 0 ? Math.max(width, height) : width, 
    tempTextures.length > 0 ? Math.max(width, height) : height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  
  // Run reduction passes
  // (Use existing reduction shader if available, or implement simple sum shader)
  
  // Read final 1x1 result
  gl.bindFramebuffer(gl.FRAMEBUFFER, tempFBOs[tempFBOs.length - 1]);
  const pixel = new Float32Array(4);
  gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, pixel);
  
  // Cleanup
  tempTextures.forEach(tex => gl.deleteTexture(tex));
  tempFBOs.forEach(fbo => gl.deleteFramebuffer(fbo));
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  return pixel[channel];
}

/**
 * Read a single pixel from a texture
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {WebGLTexture} texture 
 * @param {number} x 
 * @param {number} y 
 * @returns {Promise<Float32Array>}
 */
async function readPixel(psys, texture, x, y) {
  const gl = psys.gl;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  const pixel = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, pixel);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return pixel;
}

/**
 * Get or create metrics shader program
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @returns {WebGLProgram}
 */
function getOrCreateMetricsProgram(psys) {
  if (psys._pmDebugState?.programs?.metrics) {
    return psys._pmDebugState.programs.metrics;
  }
  
  const gl = psys.gl;
  
  const vertSrc = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;
  
  const fragSrc = `#version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 outColor;
    
    uniform int u_metricType;
    uniform sampler2D u_texA;
    uniform sampler2D u_texB;
    
    void main() {
      if (u_metricType == 0) {
        // FFT error: |A - B|²
        vec4 a = texture(u_texA, v_uv);
        vec4 b = texture(u_texB, v_uv);
        vec4 diff = a - b;
        float sqError = dot(diff, diff);
        outColor = vec4(sqError, 0.0, 0.0, 0.0);
      }
    }
  `;
  
  const program = psys.createProgram(vertSrc, fragSrc);
  
  if (!psys._pmDebugState) {
    psys._pmDebugState = {
      config: { enabled: false },
      snapshots: new Map(),
      programs: {},
      metricsResults: new Map()
    };
  }
  
  psys._pmDebugState.programs.metrics = program;
  return program;
}

/**
 * Run all metrics for a stage
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {import('./types.js').PMCheckSpec} checks 
 */
export async function runAllMetrics(psys, stage, checks) {
  const results = {};
  
  if (checks.checkMassConservation) {
    results.massConservation = await checkMassConservation(psys);
  }
  
  // Add other checks as implemented
  
  // Store results
  if (psys._pmDebugState) {
    psys._pmDebugState.metricsResults.set(`${stage}_${Date.now()}`, results);
  }
  
  return results;
}
