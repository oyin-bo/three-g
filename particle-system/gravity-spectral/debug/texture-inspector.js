// @ts-check

/**
 * Texture Inspector - Debug utility for examining WebGL texture contents
 * 
 * Provides utilities to:
 * - Read and analyze texture data
 * - Compute statistics (min, max, mean, energy)
 * - Detect NaNs and infinities
 * - Compare textures
 */

/**
 * Read texture data
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @param {'RGBA'|'RG'} format
 * @returns {Float32Array}
 */
export function readTexture(gl, texture, width, height, format = 'RGBA') {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  const channels = format === 'RGBA' ? 4 : 2;
  const glFormat = format === 'RGBA' ? gl.RGBA : gl.RG;
  const pixels = new Float32Array(width * height * channels);
  
  gl.readPixels(0, 0, width, height, glFormat, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return pixels;
}

/**
 * Analyze texture statistics
 * @param {Float32Array} pixels
 * @param {number} channels - 2 for complex (RG), 4 for RGBA
 * @param {number} targetChannel - which channel to analyze (0-based), or -1 for all
 * @returns {Object}
 */
export function analyzeTextureData(pixels, channels = 4, targetChannel = -1) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  let hasNaN = false;
  let hasInf = false;
  let nonZeroCount = 0;
  
  const threshold = 1e-20;
  
  if (targetChannel === -1) {
    // Analyze all channels
    for (let i = 0; i < pixels.length; i++) {
      const val = pixels[i];
      
      if (isNaN(val)) {
        hasNaN = true;
        continue;
      }
      if (!isFinite(val)) {
        hasInf = true;
        continue;
      }
      
      min = Math.min(min, val);
      max = Math.max(max, val);
      sum += val;
      sumSq += val * val;
      count++;
      
      if (Math.abs(val) > threshold) {
        nonZeroCount++;
      }
    }
  } else {
    // Analyze specific channel
    for (let i = targetChannel; i < pixels.length; i += channels) {
      const val = pixels[i];
      
      if (isNaN(val)) {
        hasNaN = true;
        continue;
      }
      if (!isFinite(val)) {
        hasInf = true;
        continue;
      }
      
      min = Math.min(min, val);
      max = Math.max(max, val);
      sum += val;
      sumSq += val * val;
      count++;
      
      if (Math.abs(val) > threshold) {
        nonZeroCount++;
      }
    }
  }
  
  const mean = count > 0 ? sum / count : 0;
  const variance = count > 0 ? (sumSq / count - mean * mean) : 0;
  const stdDev = Math.sqrt(Math.max(0, variance));
  const energy = sumSq;
  
  return {
    min,
    max,
    mean,
    stdDev,
    energy,
    count,
    nonZeroCount,
    nonZeroRatio: count > 0 ? nonZeroCount / count : 0,
    hasNaN,
    hasInf
  };
}

/**
 * Analyze complex texture (RG format)
 * 
 * Computes statistics for both real and imaginary components,
 * plus magnitude-based metrics (max, mean, energy).
 * 
 * Energy is computed as Σ|z|² = Σ(re² + im²), which is the
 * correct Parseval energy for complex-valued data.
 * 
 * @param {Float32Array} pixels - RG format data
 * @returns {Object}
 */
export function analyzeComplexTexture(pixels) {
  const realStats = analyzeTextureData(pixels, 2, 0);
  const imagStats = analyzeTextureData(pixels, 2, 1);
  
  // Compute magnitude statistics
  let maxMagnitude = 0;
  let meanMagnitude = 0;
  let energyMagnitude = 0;
  let count = 0;
  let nonZeroCount = 0;
  const threshold = 1e-20;
  
  for (let i = 0; i < pixels.length; i += 2) {
    const re = pixels[i];
    const im = pixels[i + 1];
    const magSq = re * re + im * im;
    const mag = Math.sqrt(magSq);
    
    maxMagnitude = Math.max(maxMagnitude, mag);
    meanMagnitude += mag;
    energyMagnitude += magSq; // Energy is sum of |z|² = re² + im²
    count++;
    
    if (mag > threshold) {
      nonZeroCount++;
    }
  }
  
  meanMagnitude /= count;
  
  return {
    real: realStats,
    imag: imagStats,
    magnitude: {
      max: maxMagnitude,
      mean: meanMagnitude,
      energy: energyMagnitude,
      nonZeroCount,
      nonZeroRatio: count > 0 ? nonZeroCount / count : 0
    }
  };
}

/**
 * Inspect texture and log results
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @param {'RGBA'|'RG'} format
 * @param {string} label
 * @returns {Object}
 */
export function inspectTexture(gl, texture, width, height, format = 'RGBA', label = 'Texture') {
  console.log(`[TextureInspector] ${label} (${width}x${height}, ${format})`);
  
  const pixels = readTexture(gl, texture, width, height, format);
  
  if (format === 'RG') {
    const stats = analyzeComplexTexture(pixels);
    const totalCount = pixels.length / 2;
    console.log(`  Real: min=${stats.real.min.toExponential(3)}, max=${stats.real.max.toExponential(3)}, mean=${stats.real.mean.toExponential(3)}, nonZero=${stats.real.nonZeroCount}`);
    console.log(`  Imag: min=${stats.imag.min.toExponential(3)}, max=${stats.imag.max.toExponential(3)}, mean=${stats.imag.mean.toExponential(3)}, nonZero=${stats.imag.nonZeroCount}`);
    console.log(`  Magnitude: max=${stats.magnitude.max.toExponential(3)}, mean=${stats.magnitude.mean.toExponential(3)}, energy=${stats.magnitude.energy.toExponential(3)}, nonZero=${stats.magnitude.nonZeroCount}/${totalCount} (${(stats.magnitude.nonZeroRatio * 100).toFixed(2)}%)`);
    if (stats.real.hasNaN || stats.imag.hasNaN) console.warn('  ⚠️ Contains NaN values');
    if (stats.real.hasInf || stats.imag.hasInf) console.warn('  ⚠️ Contains Inf values');
    return stats;
  } else {
    // RGBA - analyze alpha channel (typically holds scalar field)
    const alphaStats = analyzeTextureData(pixels, 4, 3);
    console.log(`  Alpha: min=${alphaStats.min.toExponential(3)}, max=${alphaStats.max.toExponential(3)}, mean=${alphaStats.mean.toExponential(3)}, energy=${alphaStats.energy.toExponential(3)}`);
    console.log(`  NonZero: ${alphaStats.nonZeroCount}/${alphaStats.count} (${(alphaStats.nonZeroRatio * 100).toFixed(2)}%)`);
    if (alphaStats.hasNaN) console.warn('  ⚠️ Contains NaN values');
    if (alphaStats.hasInf) console.warn('  ⚠️ Contains Inf values');
    return { alpha: alphaStats };
  }
}

/**
 * Sample a specific voxel from a 3D texture
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} ix
 * @param {number} iy
 * @param {number} iz
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {'RGBA'|'RG'} format
 * @returns {Float32Array}
 */
export function sampleVoxel(gl, texture, ix, iy, iz, gridSize, slicesPerRow, format = 'RGBA') {
  const sliceIndex = Math.floor(iz);
  const sliceRow = Math.floor(sliceIndex / slicesPerRow);
  const sliceCol = sliceIndex % slicesPerRow;
  const texX = sliceCol * gridSize + Math.floor(ix);
  const texY = sliceRow * gridSize + Math.floor(iy);
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  const channels = format === 'RGBA' ? 4 : 2;
  const glFormat = format === 'RGBA' ? gl.RGBA : gl.RG;
  const pixel = new Float32Array(channels);
  
  gl.readPixels(texX, texY, 1, 1, glFormat, gl.FLOAT, pixel);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return pixel;
}

/**
 * Compare two textures
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} tex1
 * @param {WebGLTexture} tex2
 * @param {number} width
 * @param {number} height
 * @param {'RGBA'|'RG'} format
 * @returns {Object}
 */
export function compareTextures(gl, tex1, tex2, width, height, format = 'RGBA') {
  const pixels1 = readTexture(gl, tex1, width, height, format);
  const pixels2 = readTexture(gl, tex2, width, height, format);
  
  let maxDiff = 0;
  let sumSqDiff = 0;
  let count = 0;
  
  for (let i = 0; i < pixels1.length; i++) {
    const diff = Math.abs(pixels1[i] - pixels2[i]);
    maxDiff = Math.max(maxDiff, diff);
    sumSqDiff += diff * diff;
    count++;
  }
  
  const rmsDiff = Math.sqrt(sumSqDiff / count);
  
  return {
    maxDiff,
    rmsDiff,
    count
  };
}
