// @ts-check

/**
 * PM Debug Snapshot System
 * 
 * Record and replay stage inputs/outputs for deterministic debugging:
 * - Capture textures at any stage
 * - Store in snapshot bank
 * - Replay as source for later stages
 * - Support A/B comparison workflows
 */

/**
 * Capture a snapshot at a specific stage
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {string} key - Snapshot identifier
 */
export function captureSnapshot(psys, stage, key) {
  if (!psys._pmDebugState) return;
  
  const gl = psys.gl;
  const snapshot = {};
  
  // Capture appropriate textures based on stage
  switch (stage) {
    case 'pm_deposit':
      // Capture mass grid (L0)
      if (psys.levelTextures && psys.levelTextures[0]) {
        snapshot.pmMassGrid = copyTexture(gl, 
          psys.levelTextures[0].texture, 
          psys.levelTextures[0].size, 
          psys.levelTextures[0].size,
          gl.RGBA32F);
      }
      break;
      
    case 'pm_fft_forward':
      // Capture density spectrum
      // Will be implemented when FFT passes are added
      break;
      
    case 'pm_poisson':
      // Capture potential spectrum
      break;
      
    case 'pm_gradient':
      // Capture acceleration spectrum (3 components)
      break;
      
    case 'pm_fft_inverse':
      // Capture real-space acceleration fields (3 components)
      break;
      
    case 'pm_sample':
      // Capture sampled forces
      if (psys.forceTexture) {
        snapshot.sampledForces = copyTexture(gl,
          psys.forceTexture.texture,
          psys.textureWidth,
          psys.textureHeight,
          gl.RGBA32F);
      }
      break;
  }
  
  // Store snapshot
  psys._pmDebugState.snapshots.set(key, snapshot);
  console.log(`[PM Debug] Captured snapshot '${key}' at stage ${stage}`);
}

/**
 * Restore a snapshot as source for a stage
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {string} key 
 */
export function restoreSnapshot(psys, stage, key) {
  if (!psys._pmDebugState) return;
  
  const snapshot = psys._pmDebugState.snapshots.get(key);
  if (!snapshot) {
    console.warn(`[PM Debug] Snapshot '${key}' not found`);
    return;
  }
  
  const gl = psys.gl;
  
  // Restore appropriate textures based on stage
  switch (stage) {
    case 'pm_deposit':
      // This stage generates mass grid, so snapshot would override output
      // Typically used for testing downstream stages
      if (snapshot.pmMassGrid && psys.levelTextures && psys.levelTextures[0]) {
        blitTexture(gl, 
          snapshot.pmMassGrid, 
          psys.levelTextures[0].texture,
          psys.levelTextures[0].size,
          psys.levelTextures[0].size);
      }
      break;
      
    case 'pm_fft_forward':
      // Restore mass grid as input
      if (snapshot.pmMassGrid && psys.levelTextures && psys.levelTextures[0]) {
        blitTexture(gl,
          snapshot.pmMassGrid,
          psys.levelTextures[0].texture,
          psys.levelTextures[0].size,
          psys.levelTextures[0].size);
      }
      break;
      
    // Add other stages as needed
  }
  
  console.log(`[PM Debug] Restored snapshot '${key}' for stage ${stage}`);
}

/**
 * Copy a texture to a new texture
 * 
 * @param {WebGL2RenderingContext} gl 
 * @param {WebGLTexture} srcTexture 
 * @param {number} width 
 * @param {number} height 
 * @param {number} internalFormat 
 * @returns {WebGLTexture}
 */
function copyTexture(gl, srcTexture, width, height, internalFormat) {
  // Create destination texture
  const dstTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, dstTexture);
  
  const format = gl.RGBA;
  const type = gl.FLOAT;
  
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, width, height, 0, format, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  // Create FBO and copy
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTexture, 0);
  
  // Blit using a simple copy shader
  blitTexture(gl, srcTexture, dstTexture, width, height);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return dstTexture;
}

/**
 * Blit (copy) one texture to another
 * 
 * @param {WebGL2RenderingContext} gl 
 * @param {WebGLTexture} srcTexture 
 * @param {WebGLTexture} dstTexture 
 * @param {number} width 
 * @param {number} height 
 */
function blitTexture(gl, srcTexture, dstTexture, width, height) {
  // Use WebGL2's blitFramebuffer or a simple copy shader
  // For now, use copyTexSubImage2D approach
  
  const readFBO = gl.createFramebuffer();
  const drawFBO = gl.createFramebuffer();
  
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readFBO);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, srcTexture, 0);
  
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, drawFBO);
  gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, dstTexture, 0);
  
  gl.blitFramebuffer(
    0, 0, width, height,
    0, 0, width, height,
    gl.COLOR_BUFFER_BIT,
    gl.NEAREST
  );
  
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
  gl.deleteFramebuffer(readFBO);
  gl.deleteFramebuffer(drawFBO);
}

/**
 * List all stored snapshots
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @returns {string[]}
 */
export function listSnapshots(psys) {
  if (!psys._pmDebugState) return [];
  return Array.from(psys._pmDebugState.snapshots.keys());
}

/**
 * Get snapshot metadata
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {string} key 
 * @returns {object | null}
 */
export function getSnapshotInfo(psys, key) {
  if (!psys._pmDebugState) return null;
  
  const snapshot = psys._pmDebugState.snapshots.get(key);
  if (!snapshot) return null;
  
  const info = {
    key,
    textures: {}
  };
  
  if (snapshot.pmMassGrid) info.textures.pmMassGrid = true;
  if (snapshot.rhoSpectrum) info.textures.rhoSpectrum = true;
  if (snapshot.phiSpectrum) info.textures.phiSpectrum = true;
  if (snapshot.accelSpectrumXYZ) info.textures.accelSpectrumXYZ = true;
  if (snapshot.pmAccelXYZ) info.textures.pmAccelXYZ = true;
  if (snapshot.sampledForces) info.textures.sampledForces = true;
  
  return info;
}
