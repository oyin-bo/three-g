// Record and replay functionality for debug staging
// Captures GPU texture state to CPU for later replay

/**
 * Storage for recorded stage outputs
 */
const recordedData = new Map();

/**
 * Capture a stage's output texture(s) to CPU memory
 * @param {ParticleSystem} ctx - Particle system context
 * @param {string} stageName - Stage identifier (e.g., 'aggregation', 'traversal')
 * @param {object} target - Texture object or level target with a0/a1/a2
 */
export function captureStageOutput(ctx, stageName, target) {
  const gl = ctx.gl;
  
  console.log(`[Record] Capturing output for stage: ${stageName}`);
  
  // Handle different target types
  if (target.a0 && target.a1 && target.a2) {
    // MRT level target
    const size = target.size;
    const data = {
      a0: captureTextureData(gl, target.a0, size, size),
      a1: captureTextureData(gl, target.a1, size, size),
      a2: captureTextureData(gl, target.a2, size, size),
      size,
      gridSize: target.gridSize,
      slicesPerRow: target.slicesPerRow
    };
    recordedData.set(stageName, data);
  } else if (target.texture) {
    // Single texture render target
    const width = ctx.textureWidth;
    const height = ctx.textureHeight;
    const data = {
      texture: captureTextureData(gl, target.texture, width, height),
      width,
      height
    };
    recordedData.set(stageName, data);
  } else if (target.textures) {
    // Ping-pong texture pair
    const idx = target.currentIndex;
    const width = ctx.textureWidth;
    const height = ctx.textureHeight;
    const data = {
      texture: captureTextureData(gl, target.textures[idx], width, height),
      width,
      height,
      currentIndex: idx
    };
    recordedData.set(stageName, data);
  }
  
  console.log(`[Record] Captured ${stageName}, storage size: ${recordedData.size} entries`);
}

/**
 * Replay a recorded stage input by uploading to GPU
 * @param {ParticleSystem} ctx - Particle system context
 * @param {string} stageName - Stage identifier
 * @param {object} target - Target texture object to upload to
 */
export function replayStageInput(ctx, stageName, target) {
  const gl = ctx.gl;
  
  const recorded = recordedData.get(stageName);
  if (!recorded) {
    console.warn(`[Replay] No recorded data for stage: ${stageName}`);
    return;
  }
  
  console.log(`[Replay] Replaying input for stage: ${stageName}`);
  
  // Handle different target types
  if (target.a0 && target.a1 && target.a2 && recorded.a0) {
    // MRT level target
    uploadTextureData(gl, target.a0, recorded.a0, recorded.size, recorded.size);
    uploadTextureData(gl, target.a1, recorded.a1, recorded.size, recorded.size);
    uploadTextureData(gl, target.a2, recorded.a2, recorded.size, recorded.size);
  } else if (target.texture && recorded.texture) {
    // Single texture render target
    uploadTextureData(gl, target.texture, recorded.texture, recorded.width, recorded.height);
  } else if (target.textures && recorded.texture) {
    // Ping-pong texture pair
    const idx = target.currentIndex;
    uploadTextureData(gl, target.textures[idx], recorded.texture, recorded.width, recorded.height);
  }
  
  console.log(`[Replay] Replayed ${stageName}`);
}

/**
 * Capture texture data from GPU to CPU
 * @param {WebGL2RenderingContext} gl - GL context
 * @param {WebGLTexture} texture - Source texture
 * @param {number} width - Texture width
 * @param {number} height - Texture height
 * @returns {Float32Array} Captured pixel data
 */
function captureTextureData(gl, texture, width, height) {
  // Create temporary FBO
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  // Check FBO status
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('[Record] FBO incomplete for capture:', status);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    return new Float32Array(width * height * 4);
  }
  
  // Read pixels
  const data = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  
  // Cleanup
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return data;
}

/**
 * Upload texture data from CPU to GPU
 * @param {WebGL2RenderingContext} gl - GL context
 * @param {WebGLTexture} texture - Target texture
 * @param {Float32Array} data - Pixel data
 * @param {number} width - Texture width
 * @param {number} height - Texture height
 */
function uploadTextureData(gl, texture, data, width, height) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/**
 * Clear all recorded data
 */
export function clearRecordings() {
  recordedData.clear();
  console.log('[Record] Cleared all recordings');
}

/**
 * Export recorded data for external storage
 * @returns {object} Serializable recording data
 */
export function exportRecordings() {
  const exported = {};
  for (const [key, value] of recordedData.entries()) {
    exported[key] = {
      ...value,
      // Convert Float32Arrays to regular arrays for JSON serialization
      a0: value.a0 ? Array.from(value.a0) : undefined,
      a1: value.a1 ? Array.from(value.a1) : undefined,
      a2: value.a2 ? Array.from(value.a2) : undefined,
      texture: value.texture ? Array.from(value.texture) : undefined
    };
  }
  return exported;
}

/**
 * Import recorded data from external storage
 * @param {object} data - Previously exported recording data
 */
export function importRecordings(data) {
  recordedData.clear();
  for (const [key, value] of Object.entries(data)) {
    recordedData.set(key, {
      ...value,
      // Convert arrays back to Float32Arrays
      a0: value.a0 ? new Float32Array(value.a0) : undefined,
      a1: value.a1 ? new Float32Array(value.a1) : undefined,
      a2: value.a2 ? new Float32Array(value.a2) : undefined,
      texture: value.texture ? new Float32Array(value.texture) : undefined
    });
  }
  console.log(`[Record] Imported ${recordedData.size} recordings`);
}
