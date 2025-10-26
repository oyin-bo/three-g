// Visualization helpers for debug staging
// Provides on-screen feedback for texture contents and pipeline state

/**
 * Blit a level attachment to the screen for visualization
 * @param {ParticleSystem} ctx - Particle system context
 * @param {number} levelIndex - Level to visualize
 * @param {string} attachment - 'a0' | 'a1' | 'a2'
 * @param {object} options - Visualization options
 */
export function blitLevelAttachment(ctx, levelIndex, attachment = 'a0', options = {}) {
  const {
    x = 0,
    y = 0,
    width = 256,
    height = 256,
    scale = 1.0,
    colorMap = 'grayscale' // 'grayscale' | 'heat' | 'mass'
  } = options;
  
  console.log(`[Visualizer] Blitting L${levelIndex}.${attachment} to screen`);
  
  const gl = ctx.gl;
  const level = ctx.levelTargets[levelIndex];
  
  // Select texture based on attachment
  let texture;
  switch (attachment) {
    case 'a0': texture = level.a0; break;
    case 'a1': texture = level.a1; break;
    case 'a2': texture = level.a2; break;
    default: 
      console.warn(`[Visualizer] Unknown attachment: ${attachment}`);
      return;
  }
  
  // Bind default framebuffer for screen output
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(x, y, width, height);
  
  // Use fullscreen program with texture visualization
  // TODO: Implement proper visualization shader
  console.log('[Visualizer] Visualization shader not yet implemented, skipping blit');
  
  // Placeholder: would use a dedicated vis shader here
  // gl.useProgram(ctx.programs.visualize);
  // gl.activeTexture(gl.TEXTURE0);
  // gl.bindTexture(gl.TEXTURE_2D, texture);
  // gl.uniform1i(gl.getUniformLocation(ctx.programs.visualize, 'u_texture'), 0);
  // gl.uniform1f(gl.getUniformLocation(ctx.programs.visualize, 'u_scale'), scale);
  // gl.bindVertexArray(ctx.quadVAO);
  // gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

/**
 * Overlay center-of-mass markers on level visualization
 * @param {ParticleSystem} ctx - Particle system context
 * @param {number} levelIndex - Level to visualize
 */
export function overlayCOMMarkers(ctx, levelIndex) {
  console.log(`[Visualizer] Overlaying COM markers for L${levelIndex}`);
  
  const gl = ctx.gl;
  const level = ctx.levelTargets[levelIndex];
  const size = level.size;
  
  // Read A0 texture to compute COM per voxel
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, level.a0, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const data = new Float32Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Extract occupied voxels and their COM
  const markers = [];
  for (let i = 0; i < size * size; i++) {
    const idx = i * 4;
    const mass = data[idx + 3];
    
    if (mass > 0) {
      const weightedX = data[idx + 0];
      const weightedY = data[idx + 1];
      const weightedZ = data[idx + 2];
      
      const comX = weightedX / mass;
      const comY = weightedY / mass;
      const comZ = weightedZ / mass;
      
      markers.push({ x: comX, y: comY, z: comZ, mass });
    }
  }
  
  console.log(`[Visualizer] Found ${markers.length} occupied voxels with COM`);
  
  // TODO: Render markers to screen
  // Would typically use instanced point rendering or overlay texture
}

/**
 * Visualize force field as vector arrows
 * @param {ParticleSystem} ctx - Particle system context
 * @param {object} options - Visualization options
 */
export function showForceField(ctx, options = {}) {
  const {
    sampleRate = 4, // Sample every Nth pixel
    arrowScale = 10.0,
    colorByMagnitude = true
  } = options;
  
  console.log('[Visualizer] Visualizing force field');
  
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  
  // Read force texture
  const forceTex = ctx.forceTexture.texture;
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, forceTex, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const data = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Sample force vectors
  const vectors = [];
  for (let y = 0; y < height; y += sampleRate) {
    for (let x = 0; x < width; x += sampleRate) {
      const idx = (y * width + x) * 4;
      const fx = data[idx + 0];
      const fy = data[idx + 1];
      const fz = data[idx + 2];
      
      const magnitude = Math.sqrt(fx * fx + fy * fy + fz * fz);
      
      if (magnitude > 0) {
        vectors.push({ x, y, fx, fy, fz, magnitude });
      }
    }
  }
  
  console.log(`[Visualizer] Sampled ${vectors.length} force vectors`);
  
  // TODO: Render arrows to screen
  // Would typically use instanced line rendering or arrow geometry
}

/**
 * Create a heatmap visualization of scalar field
 * @param {ParticleSystem} ctx - Particle system context
 * @param {WebGLTexture} texture - Source texture
 * @param {number} width - Texture width
 * @param {number} height - Texture height
 * @param {object} options - Visualization options
 * @returns {ImageData} Heatmap as image data
 */
export function createHeatmap(ctx, texture, width, height, options = {}) {
  const {
    channel = 3, // Which channel to visualize (0=R, 1=G, 2=B, 3=A)
    minValue = 0,
    maxValue = 1,
    colorScheme = 'viridis' // 'viridis' | 'hot' | 'cool'
  } = options;
  
  console.log('[Visualizer] Creating heatmap');
  
  const gl = ctx.gl;
  
  // Read texture data
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const data = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Create ImageData for canvas output
  const imageData = new Uint8ClampedArray(width * height * 4);
  
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const value = data[idx + channel];
    
    // Normalize to [0, 1]
    const normalized = (value - minValue) / (maxValue - minValue);
    const clamped = Math.max(0, Math.min(1, normalized));
    
    // Apply color scheme
    const color = applyColorScheme(clamped, colorScheme);
    
    imageData[idx + 0] = color.r;
    imageData[idx + 1] = color.g;
    imageData[idx + 2] = color.b;
    imageData[idx + 3] = 255;
  }
  
  return new ImageData(imageData, width, height);
}

/**
 * Apply color scheme to normalized value [0, 1]
 * @param {number} t - Normalized value
 * @param {string} scheme - Color scheme name
 * @returns {object} RGB color
 */
function applyColorScheme(t, scheme) {
  switch (scheme) {
    case 'hot':
      // Black -> Red -> Yellow -> White
      if (t < 0.33) {
        return { r: Math.floor(t * 3 * 255), g: 0, b: 0 };
      } else if (t < 0.66) {
        return { r: 255, g: Math.floor((t - 0.33) * 3 * 255), b: 0 };
      } else {
        return { r: 255, g: 255, b: Math.floor((t - 0.66) * 3 * 255) };
      }
      
    case 'cool':
      // Cyan -> Blue -> Magenta
      return {
        r: Math.floor(t * 255),
        g: Math.floor((1 - t) * 255),
        b: 255
      };
      
    case 'viridis':
    default:
      // Simplified viridis approximation
      const r = Math.floor(Math.min(255, Math.max(0, 280 * t - 80)));
      const g = Math.floor(Math.min(255, Math.max(0, 255 * t)));
      const b = Math.floor(Math.min(255, Math.max(0, 255 - 255 * t)));
      return { r, g, b };
  }
}

/**
 * Log texture statistics to console
 * @param {ParticleSystem} ctx - Particle system context
 * @param {WebGLTexture|string} textureOrName - Texture to analyze or name (e.g., 'L0', 'force', 'positions')
 * @param {number} width - Texture width (optional if using name)
 * @param {number} height - Texture height (optional if using name)
 * @param {string} name - Texture name for logging (optional)
 * @returns {object} Statistics object with min, max, mean per channel
 */
export function logTextureStats(ctx, textureOrName, width, height, name) {
  let texture, texWidth, texHeight, texName;
  
  // Handle string identifiers
  if (typeof textureOrName === 'string') {
    texName = textureOrName;
    
    if (textureOrName.startsWith('L')) {
      // Level texture (e.g., 'L0', 'L1')
      const levelIndex = parseInt(textureOrName.substring(1));
      const level = ctx.levelTargets[levelIndex];
      texture = level.a0;
      texWidth = level.size;
      texHeight = level.size;
    } else if (textureOrName === 'force') {
      texture = ctx.forceTexture.texture;
      texWidth = ctx.textureWidth;
      texHeight = ctx.textureHeight;
    } else if (textureOrName === 'positions') {
      texture = ctx.positionTextures.getCurrentTexture();
      texWidth = ctx.textureWidth;
      texHeight = ctx.textureHeight;
    } else if (textureOrName === 'velocities') {
      texture = ctx.velocityTextures.getCurrentTexture();
      texWidth = ctx.textureWidth;
      texHeight = ctx.textureHeight;
    } else {
      throw new Error(`Unknown texture name: ${textureOrName}`);
    }
  } else {
    // Direct texture object
    texture = textureOrName;
    texWidth = width;
    texHeight = height;
    texName = name || 'texture';
  }
  
  const gl = ctx.gl;
  
  // Read texture data
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const data = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Compute statistics per channel
  const stats = {
    r: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    g: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    b: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    a: { min: Infinity, max: -Infinity, sum: 0, count: 0 },
    mean: 0  // Overall mean for compatibility
  };
  
  const channels = ['r', 'g', 'b', 'a'];
  
  for (let i = 0; i < texWidth * texHeight; i++) {
    for (let c = 0; c < 4; c++) {
      const value = data[i * 4 + c];
      const ch = channels[c];
      
      if (isFinite(value)) {
        stats[ch].min = Math.min(stats[ch].min, value);
        stats[ch].max = Math.max(stats[ch].max, value);
        stats[ch].sum += value;
        stats[ch].count++;
      }
    }
  }
  
  // Compute means
  let totalSum = 0;
  let totalCount = 0;
  for (const ch of channels) {
    const mean = stats[ch].count > 0 ? stats[ch].sum / stats[ch].count : 0;
    stats[ch].mean = mean;
    totalSum += stats[ch].sum;
    totalCount += stats[ch].count;
  }
  stats.mean = totalCount > 0 ? totalSum / totalCount : 0;
  
  console.log(`[Visualizer] Statistics for ${texName}:`);
  for (const ch of channels) {
    console.log(`  ${ch.toUpperCase()}: min=${stats[ch].min.toFixed(6)}, max=${stats[ch].max.toFixed(6)}, mean=${stats[ch].mean.toFixed(6)}`);
  }
  
  return stats;
}
