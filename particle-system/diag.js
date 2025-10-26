// @ts-check

/**
 * Diagnostic utilities for kernel reflection
 * Provides readLinear() and readGrid3D() for capturing GPU state
 */

/**
 * Get readPixels parameters for a given texture format
 * @param {WebGL2RenderingContext} gl
 * @param {number|string} format - Either WebGL constant (gl.RGBA32F) or string ('RGBA32F')
 */
function getFormatInfo(gl, format) {
  const fmt = typeof format === 'string' ? format.toUpperCase() : format;
  switch (fmt) {
    case gl.RGBA32F:
    case 'RGBA32F':
      return { readPixelsFormat: gl.RGBA, type: gl.FLOAT, bufferChannels: 4, ArrayType: Float32Array, formatName: 'RGBA32F', dataChannels: 4 };
    case gl.R32F:
    case 'R32F':
      // R32F must be read as RGBA in WebGL2 (only R channel has data, GBA are 0,0,1)
      return { readPixelsFormat: gl.RGBA, type: gl.FLOAT, bufferChannels: 4, ArrayType: Float32Array, formatName: 'R32F', dataChannels: 1 };
    case gl.RG32F:
    case 'RG32F':
      // RG32F must be read as RGBA in WebGL2 (only RG channels have data, BA are 0,1)
      return { readPixelsFormat: gl.RGBA, type: gl.FLOAT, bufferChannels: 4, ArrayType: Float32Array, formatName: 'RG32F', dataChannels: 2 };
    case gl.RGBA8:
    case 'RGBA8':
      return { readPixelsFormat: gl.RGBA, type: gl.UNSIGNED_BYTE, bufferChannels: 4, ArrayType: Uint8Array, formatName: 'RGBA8', dataChannels: 4 };
    default:
      throw new Error(`Unsupported texture format: ${format}`);
  }
}

const blocks = ' ▁▂▃▄▅▆▇█';

/**
 * Compute statistics for an array of values
 */
function computeStats(values) {
  if (!values.length) {
    return {
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      stddev: 0,
      histogram: '',
      profile: '',
      belowAbs0_001: 0,
      nearMin_5pc: 0,
      nearMax_5pc: 0,
      outliers_ex3stddev: 0,
      nonzero: 0
    };
  }

  // Sort for median and percentiles
  const sorted = [...values].sort((a, b) => a - b);
  const n = values.length;
  
  // Basic stats
  const min = sorted[0];
  const max = sorted[n - 1];
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const median = n % 2 === 0 
    ? (sorted[n/2 - 1] + sorted[n/2]) / 2 
    : sorted[Math.floor(n/2)];
  
  // Standard deviation
  const variance = values.reduce((acc, val) => acc + (val - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  
  // Distribution counts
  const belowAbs0_001 = values.filter(v => Math.abs(v) < 0.001).length;
  const nonzero = values.filter(v => v !== 0).length;
  
  // Near min/max (within 5% of range)
  const range = max - min;
  const threshold = range * 0.05;
  const nearMin_5pc = values.filter(v => Math.abs(v - min) <= threshold).length;
  const nearMax_5pc = values.filter(v => Math.abs(v - max) <= threshold).length;
  
  // Outliers (beyond 3 stddev from mean)
  const outliers_ex3stddev = stddev > 0 
    ? values.filter(v => Math.abs(v - mean) > 3 * stddev).length
    : 0;
  
  // Histogram (value distribution)
  const histogram = createHistogram(values, min, max);
  
  return {
    min,
    max,
    mean,
    median,
    stddev,
    histogram,
    belowAbs0_001,
    nearMin_5pc,
    nearMax_5pc,
    outliers_ex3stddev,
    nonzero
  };
}

/**
 * Create visual histogram using Unicode blocks
 */
function createHistogram(values, min, max, bins = 16) {
  if (values.length === 0) return '';
  
  const range = max - min || 1;
  const binCounts = new Array(bins).fill(0);
  
  // Count values in each bin
  for (const val of values) {
    const binIndex = Math.min(Math.floor((val - min) / range * bins), bins - 1);
    binCounts[binIndex]++;
  }
  
  // Normalize and convert to blocks
  const maxCount = Math.max(...binCounts);
  return binCounts
    .map(count => blocks[Math.floor(count / maxCount * 8)])
    .join('');
}

/**
 * Create profile (values along array)
 */
function createProfile(values, windowSize = 16) {
  if (values.length === 0) return '';
  
  const samples = [];
  const step = Math.max(1, Math.floor(values.length / windowSize));
  
  // Sample values at intervals
  for (let i = 0; i < values.length; i += step) {
    const window = values.slice(i, Math.min(i + step, values.length));
    const avg = window.reduce((a, b) => a + b, 0) / window.length;
    samples.push(avg);
  }
  
  // Normalize and convert to blocks
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const range = max - min || 1;
  
  return samples
    .map(val => blocks[Math.floor((val - min) / range * 8)])
    .join('');
}

/**
 * Create axis profiles for 3D grid
 */
function createAxisProfiles(pixels, gridSize, channelIndex) {
  const profileX = [];
  const profileY = [];
  const profileZ = [];
  
  // Average along each axis
  for (let i = 0; i < gridSize; i++) {
    let sumX = 0, sumY = 0, sumZ = 0;
    let countX = 0, countY = 0, countZ = 0;
    
    for (let z = 0; z < gridSize; z++) {
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const val = pixels[z][y][x][channelIndex];
          
          if (x === i) { sumX += val; countX++; }
          if (y === i) { sumY += val; countY++; }
          if (z === i) { sumZ += val; countZ++; }
        }
      }
    }
    
    profileX.push(countX > 0 ? sumX / countX : 0);
    profileY.push(countY > 0 ? sumY / countY : 0);
    profileZ.push(countZ > 0 ? sumZ / countZ : 0);
  }
  
  const normalize = (values) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min || 1;
    return values.map(v => blocks[Math.floor((v - min) / range * 8)]).join('');
  };
  
  return {
    profileX: normalize(profileX),
    profileY: normalize(profileY),
    profileZ: normalize(profileZ)
  };
}

/**
 * Format number for display
 */
export function formatNumber(num) {
  if (num === 0) return '0';
  if (num === undefined) return 'undefined';
  if (num === null) return 'null';
  if (Math.abs(num) < 0.001 || Math.abs(num) >= 10000) return num.toExponential(2);
  if (Math.abs(num) >= 100) return num.toFixed(1);
  if (Math.abs(num) >= 10) return num.toFixed(2);
  if (Math.abs(num) >= 1) return num.toFixed(3);
  return num.toFixed(4);
}

/**
 * Read linear (1D) data from 2D texture
 * @param {{
 *   gl: WebGL2RenderingContext,
 *   texture: WebGLTexture,
 *   width: number,
 *   height: number,
 *   count?: number,
 *   channels?: string[],
 *   pixels?: boolean,
 *   format?: number|string
 * }} options
 */
export function readLinear({ gl, texture, width, height, count, channels = ['x', 'y', 'z', 'w'], pixels: capturePixels, format = gl.RGBA32F }) {
  
  if (!texture) {
    return {
      width: 0,
      height: 0,
      count: 0,
      channels: 0,
      format: 'null',
      bytesPerPixel: 0,
      pixels: undefined,
      toString() { return '# Linear Texture\n\n*null texture*\n'; }
    };
  }
  
  if (!width || !height) {
    throw new Error('readLinear requires width and height parameters');
  }
  
  // Get format info
  const formatInfo = getFormatInfo(gl, format);
  
  // Bind and read texture
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  // Read pixels
  const bytesPerPixel = formatInfo.bufferChannels * (formatInfo.type === gl.FLOAT ? 4 : 1);
  const totalPixels = width * height;
  const actualCount = count || totalPixels;
  
  const buffer = new formatInfo.ArrayType(totalPixels * formatInfo.bufferChannels);
  gl.readPixels(0, 0, width, height, formatInfo.readPixelsFormat, formatInfo.type, buffer);
  
  // Auto-decide pixel capture
  const shouldCapturePixels = capturePixels !== undefined 
    ? capturePixels 
    : actualCount <= 1000;
  
  // Compute per-channel statistics
  const result = {
    width,
    height,
    count: actualCount,
    channels: channels.length,
    format: formatInfo.formatName,
    bytesPerPixel
  };
  
  // Extract channel values
  const dataChannels = formatInfo.dataChannels || formatInfo.bufferChannels;
  const numChannels = Math.min(channels.length, dataChannels);
  for (let i = 0; i < numChannels; i++) {
    const values = [];
    for (let j = 0; j < actualCount; j++) {
      values.push(buffer[j * formatInfo.bufferChannels + i]);
    }
    
    const stats = computeStats(values);
    stats.profile = createProfile(values);
    result[channels[i]] = stats;
  }
  
  // Capture pixel data if requested
  if (shouldCapturePixels) {
    const pixelData = [];
    for (let i = 0; i < actualCount; i++) {
      const pixel = {};
      for (let j = 0; j < numChannels; j++) {
        pixel[channels[j]] = buffer[i * formatInfo.bufferChannels + j];
      }
      pixelData.push(pixel);
    }
    result.pixels = pixelData;
  } else {
    result.pixels = undefined;
  }
  
  // Clean up
  gl.deleteFramebuffer(fbo);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Generate toString output immediately (not lazily) to preserve snapshot state
  const toStringValue = (() => {
    const lines = [];
    
    // Metadata line
    lines.push(`${result.width}x${result.height} ${result.format} ${result.count}el`);
    
    // Compact channel statistics
    for (const channel of channels) {
      if (!result[channel]) continue;
      const s = result[channel];
      
      // Format: channel[min▃▄▅▆▇█+max] mean=X std=Y |hist| nz=count
      const minStr = s.min === 0 ? '0' : formatNumber(s.min);
      const maxStr = s.max === 0 ? '0' : (s.max > 0 ? '+' : '') + formatNumber(s.max);
      let line = `${channel}[${minStr}${s.profile}${maxStr}]`;
      line += ` mean=${formatNumber(s.mean)} std=${formatNumber(s.stddev)}`;
      line += ` median=${formatNumber(s.median)}`;
      line += ` |${s.histogram}|`;
      line += ` nz=${s.nonzero}/${result.count}`;
      
      // Concentration metrics
      if (s.belowAbs0_001 > 0) {
        line += ` near0=${s.belowAbs0_001}`;
      }
      if (s.nearMin_5pc > 0) {
        line += ` nearMin=${s.nearMin_5pc}`;
      }
      if (s.nearMax_5pc > 0) {
        line += ` nearMax=${s.nearMax_5pc}`;
      }
      if (s.outliers_ex3stddev > 0) {
        line += ` outliers=${s.outliers_ex3stddev}`;
      }
      
      lines.push(line);
    }
    
    return lines.join('\n');
  })();
  
  result.toString = () => toStringValue;
  
  return result;
}

/**
 * Read 3D grid data from 2D texture (Z-slices packed)
 * @param {{
 *   gl: WebGL2RenderingContext,
 *   texture: WebGLTexture,
 *   width: number,
 *   height: number,
 *   gridSize: number,
 *   channels?: string[],
 *   pixels?: boolean,
 *   format?: number|string
 * }} options
 */
export function readGrid3D({ gl, texture, width, height, gridSize, channels = ['density'], pixels: capturePixels, format = gl.RGBA32F }) {
  
  if (!texture) {
    return {
      width: 0,
      height: 0,
      gridSize: 0,
      slicesPerRow: 0,
      voxelCount: 0,
      channels: 0,
      format: 'null',
      bytesPerPixel: 0,
      pixels: undefined,
      toString() { return '# Grid3D Texture\n*null texture*\n'; }
    };
  }
  
  if (!width || !height) {
    throw new Error('readGrid3D requires width and height parameters');
  }
  
  // Get format info
  const formatInfo = getFormatInfo(gl, format);
  
  // Bind and read texture
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  // Calculate slice packing
  const slicesPerRow = Math.ceil(width / gridSize);
  const voxelCount = gridSize * gridSize * gridSize;
  
  // Read pixels
  const bytesPerPixel = formatInfo.bufferChannels * (formatInfo.type === gl.FLOAT ? 4 : 1);
  const buffer = new formatInfo.ArrayType(width * height * formatInfo.bufferChannels);
  gl.readPixels(0, 0, width, height, formatInfo.readPixelsFormat, formatInfo.type, buffer);
  
  // Auto-decide pixel capture
  const shouldCapturePixels = capturePixels !== undefined 
    ? capturePixels 
    : voxelCount <= 4096;  // 16^3
  
  // Create 3D array if capturing pixels
  /** @type {any} */
  let pixels3D = null;
  const actualChannels = formatInfo.dataChannels || formatInfo.bufferChannels;
  const numChannels = Math.min(channels.length, actualChannels);
  if (shouldCapturePixels) {
    pixels3D = [];
    for (let z = 0; z < gridSize; z++) {
      pixels3D[z] = [];
      for (let y = 0; y < gridSize; y++) {
        pixels3D[z][y] = [];
        for (let x = 0; x < gridSize; x++) {
          // Calculate texture coordinates for this voxel
          const sliceX = z % slicesPerRow;
          const sliceY = Math.floor(z / slicesPerRow);
          const texX = sliceX * gridSize + x;
          const texY = sliceY * gridSize + y;
          const texIndex = (texY * width + texX) * formatInfo.bufferChannels;
          
          const voxel = {};
          for (let c = 0; c < numChannels; c++) {
            voxel[channels[c]] = buffer[texIndex + c];
          }
          pixels3D[z][y][x] = voxel;
        }
      }
    }
  }
  
  // Compute statistics
  const result = {
    width,
    height,
    gridSize,
    slicesPerRow,
    voxelCount,
    channels: channels.length,
    format: formatInfo.formatName,
    bytesPerPixel
  };
  
  // Extract channel values for statistics
  for (let c = 0; c < numChannels; c++) {
    const values = [];
    
    for (let z = 0; z < gridSize; z++) {
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const sliceX = z % slicesPerRow;
          const sliceY = Math.floor(z / slicesPerRow);
          const texX = sliceX * gridSize + x;
          const texY = sliceY * gridSize + y;
          const texIndex = (texY * width + texX) * formatInfo.bufferChannels;
          values.push(buffer[texIndex + c]);
        }
      }
    }
    
    const stats = computeStats(values);
    
    // Add axis profiles
    if (pixels3D) {
      const profiles = createAxisProfiles(pixels3D, gridSize, channels[c]);
      Object.assign(stats, profiles);
    }
    
    result[channels[c]] = stats;
  }
  
  if (shouldCapturePixels) {
    result.pixels = pixels3D;
  } else {
    result.pixels = undefined;
  }
  
  // Clean up
  gl.deleteFramebuffer(fbo);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Generate toString output immediately (not lazily) to preserve snapshot state
  const toStringValue = (() => {
    const lines = [];
    
    // Metadata line
    lines.push(`${result.width}x${result.height} ${result.format} grid${result.gridSize}^3=${result.voxelCount}vox slices=${result.slicesPerRow}`);
    
    // Compact channel statistics
    for (const channel of channels) {
      if (!result[channel]) continue;
      const s = result[channel];
      
      // Format: channel[min|hist|+max] mean=X std=Y X:▃▄█ Y:▃▄█ Z:▃▄█
      const minStr = s.min === 0 ? '0' : formatNumber(s.min);
      const maxStr = s.max === 0 ? '0' : (s.max > 0 ? '+' : '') + formatNumber(s.max);
      let line = `${channel.padEnd(7)}[${minStr}|${s.histogram}|${maxStr}]`;
      line += ` mean=${formatNumber(s.mean)} std=${formatNumber(s.stddev)}`;
      line += ` median=${formatNumber(s.median)}`;
      
      // Add axis profiles if available
      if (s.profileX) {
        line += ` X:${s.profileX} Y:${s.profileY} Z:${s.profileZ}`;
      }
      
      line += ` nz=${s.nonzero}/${result.voxelCount}`;
      
      // Concentration metrics
      if (s.belowAbs0_001 > 0) {
        line += ` near0=${s.belowAbs0_001}`;
      }
      if (s.nearMin_5pc > 0) {
        line += ` nearMin=${s.nearMin_5pc}`;
      }
      if (s.nearMax_5pc > 0) {
        line += ` nearMax=${s.nearMax_5pc}`;
      }
      if (s.outliers_ex3stddev > 0) {
        line += ` outliers=${s.outliers_ex3stddev}`;
      }
      
      lines.push(line);
    }
    
    return lines.join('\n');
  })();
  
  result.toString = () => toStringValue;
  
  return result;
}
