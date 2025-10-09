// @ts-check

/**
 * PM/FFT Pipeline - Force Sampling
 * 
 * Samples force field from PM grid at particle positions
 * Uses trilinear interpolation for smooth force field
 */

import forceSampleVert from '../shaders/force-sample.vert.js';
import forceSampleFrag from '../shaders/force-sample.frag.js';

/**
 * Initialize force sampling resources
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export function initForceSampling(psys) {
  const gl = psys.gl;
  
  // Create force sampling program
  if (!psys.pmForceSampleProgram) {
    psys.pmForceSampleProgram = psys.createProgram(forceSampleVert, forceSampleFrag);
    console.log('[PM Force Sample] Program created');
  }
  
  // Create force output texture (stores sampled forces for each particle)
  if (!psys.pmForceTexture) {
    const texWidth = psys.textureWidth;
    const texHeight = psys.textureHeight;
    
    const forceTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, forceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, texWidth, texHeight, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    
    const forceFBO = gl.createFramebuffer();
    
    psys.pmForceTexture = forceTex;
    psys.pmForceFBO = forceFBO;
    
    console.log(`[PM Force Sample] Force texture created (${texWidth}x${texHeight})`);
  }
}

/**
 * Create real-space force grid textures (for storing inverse FFT results)
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export function initForceGridTextures(psys) {
  if (psys.pmForceGrids) return; // Already initialized
  
  const gl = psys.gl;
  const textureSize = psys.pmGrid.size;
  
  const createForceGrid = () => {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, textureSize, textureSize, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); // Linear for interpolation
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  };
  
  psys.pmForceGrids = {
    x: createForceGrid(),
    y: createForceGrid(),
    z: createForceGrid(),
    textureSize: textureSize
  };
  
  console.log(`[PM Force Sample] Force grid textures created (${textureSize}x${textureSize} x 3)`);
}

/**
 * Sample forces from PM grids at particle positions
 * @param {import('../particle-system.js').ParticleSystem} psys
 * @param {WebGLTexture} forceGridX - Real-space force grid X
 * @param {WebGLTexture} forceGridY - Real-space force grid Y
 * @param {WebGLTexture} forceGridZ - Real-space force grid Z
 */
export function sampleForcesAtParticles(psys, forceGridX, forceGridY, forceGridZ) {
  initForceSampling(psys);
  
  const gl = psys.gl;
  const program = psys.pmForceSampleProgram;
  const gridSize = psys.pmGrid.gridSize;
  const slicesPerRow = psys.pmGrid.slicesPerRow;
  
  // Bind output framebuffer
  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmForceFBO);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    psys.pmForceTexture,
    0
  );
  
  gl.viewport(0, 0, psys.textureWidth, psys.textureHeight);
  
  // Set GL state
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.colorMask(true, true, true, true);
  
  gl.useProgram(program);
  
  // Bind particle position texture
  gl.activeTexture(gl.TEXTURE0);
  const posTexture = psys.positionTextures.getCurrentTexture();
  gl.bindTexture(gl.TEXTURE_2D, posTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_positionTexture'), 0);
  
  // Bind force grid textures
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, forceGridX);
  gl.uniform1i(gl.getUniformLocation(program, 'u_forceGridX'), 1);
  
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, forceGridY);
  gl.uniform1i(gl.getUniformLocation(program, 'u_forceGridY'), 2);
  
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, forceGridZ);
  gl.uniform1i(gl.getUniformLocation(program, 'u_forceGridZ'), 3);
  
  // Set uniforms
  gl.uniform2f(
    gl.getUniformLocation(program, 'u_textureSize'),
    psys.textureWidth,
    psys.textureHeight
  );
  
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), slicesPerRow);
  
  // World bounds
  const bounds = psys.options.worldBounds || {
    min: [-50, -50, -50],
    max: [50, 50, 50]
  };
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMin'), bounds.min[0], bounds.min[1], bounds.min[2]);
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMax'), bounds.max[0], bounds.max[1], bounds.max[2]);
  
  // Draw all particles as points
  gl.drawArrays(gl.POINTS, 0, psys.particleCount);
  
  gl.finish(); // Ensure completion
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  console.log(`[PM Force Sample] Sampled forces for ${psys.particleCount} particles`);
}

/**
 * Complete PM/FFT force computation pipeline
 * 
 * Note: This function requires dynamic imports since we can't use static imports
 * for circular dependency reasons. Call it like:
 * 
 * const { computePMForcesAsync } = await import('./pm-force-sample.js');
 * await computePMForcesAsync(psys);
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function computePMForcesAsync(psys) {
  // Initialize force grid textures if needed
  initForceGridTextures(psys);
  
  // Dynamic imports to avoid circular dependencies
  const { depositParticlesToGrid } = await import('./pm-deposit.js');
  const { forwardFFT, inverseFFTToReal } = await import('./pm-fft.js');
  const { solvePoissonFFT } = await import('./pm-poisson.js');
  const { computeGradient } = await import('./pm-gradient.js');
  
  // Step 1: Deposit particles to grid
  depositParticlesToGrid(psys);
  
  // Step 2: Forward FFT (density → spectrum)
  forwardFFT(psys);
  
  // Step 3: Solve Poisson equation (density spectrum → potential spectrum)
  const G = psys.options.gravityStrength || 0.0003;
  const fourPiG = 4 * Math.PI * G;
  const bounds = psys.options.worldBounds || { min: [-50, -50, -50], max: [50, 50, 50] };
  const boxSize = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
  solvePoissonFFT(psys, fourPiG, boxSize);
  
  // Step 4: Compute gradient (potential spectrum → force spectra)
  computeGradient(psys, boxSize);
  
  // Step 5: Inverse FFT (force spectra → real-space force grids)
  inverseFFTToReal(psys, psys.pmForceSpectrum.x.texture, psys.pmForceGrids.x);
  inverseFFTToReal(psys, psys.pmForceSpectrum.y.texture, psys.pmForceGrids.y);
  inverseFFTToReal(psys, psys.pmForceSpectrum.z.texture, psys.pmForceGrids.z);
  
  // Step 6: Sample forces at particle positions
  sampleForcesAtParticles(psys, psys.pmForceGrids.x, psys.pmForceGrids.y, psys.pmForceGrids.z);
  
  console.log('[PM Force Sample] Complete PM/FFT pipeline executed');
}

/**
 * Read sampled force for debugging
 * @param {import('../particle-system.js').ParticleSystem} psys
 * @param {number} particleIndex
 * @returns {{fx: number, fy: number, fz: number, mass: number}}
 */
export function readParticleForce(psys, particleIndex) {
  const gl = psys.gl;
  const texWidth = psys.textureWidth;
  
  const x = particleIndex % texWidth;
  const y = Math.floor(particleIndex / texWidth);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, psys.pmForceFBO);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    psys.pmForceTexture,
    0
  );
  
  const data = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  return {
    fx: data[0],
    fy: data[1],
    fz: data[2],
    mass: data[3]
  };
}
