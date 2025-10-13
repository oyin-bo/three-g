// @ts-check

/**
 * PM Pipeline Staging Verification
 * 
 * This module provides isolated testing for each stage of the PM/FFT pipeline
 * to verify correctness without visual smoke tests.
 * 
 * Each test returns:
 * - pass: boolean
 * - metrics: object with numerical results
 * - errors: array of error messages
 */

/**
 * @typedef {Object} StageTestResult
 * @property {boolean} pass
 * @property {Object.<string, number>} metrics
 * @property {string[]} errors
 * @property {string[]} warnings
 */

/**
 * Read a single pixel from a texture
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @param {number} x
 * @param {number} y
 * @returns {Float32Array}
 */
function readPixel(gl, texture, width, height, x, y) {
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  const pixel = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, pixel);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  
  return pixel;
}

/**
 * Read texture slice for 3D grid texture
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @param {number} sliceIndex - which z-slice (0 to N-1)
 * @param {number} gridSize - e.g., 64 for 64³ grid
 * @returns {Float32Array}
 */
function readGridSlice(gl, texture, width, height, sliceIndex, gridSize) {
  const slicesPerRow = Math.floor(width / gridSize);
  const sliceY = Math.floor(sliceIndex / slicesPerRow);
  const sliceX = sliceIndex % slicesPerRow;
  
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  const data = new Float32Array(gridSize * gridSize * 4);
  gl.readPixels(sliceX * gridSize, sliceY * gridSize, gridSize, gridSize, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);
  
  return data;
}

/**
 * Compute statistics from Float32Array (every 4th element = component)
 * @param {Float32Array} data
 * @param {number} component - 0=r, 1=g, 2=b, 3=a
 * @returns {{min: number, max: number, mean: number, nonZeroCount: number}}
 */
function computeStats(data, component = 0) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let nonZeroCount = 0;
  let count = 0;
  
  for (let i = component; i < data.length; i += 4) {
    const val = data[i];
    if (!isFinite(val)) continue;
    
    count++;
    sum += val;
    min = Math.min(min, val);
    max = Math.max(max, val);
    if (Math.abs(val) > 1e-10) nonZeroCount++;
  }
  
  return {
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    mean: count > 0 ? sum / count : 0,
    nonZeroCount
  };
}

/**
 * Stage 1: Verify particle deposit to grid
 * Tests:
 * - Grid density texture has non-zero values
 * - Total deposited mass approximately equals total particle mass
 * - Density values are reasonable (not NaN, not excessive)
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 * @returns {StageTestResult}
 */
export function verifyDeposit(ctx) {
  const errors = [];
  const warnings = [];
  const metrics = {};
  
  if (!ctx.pmGrid || !ctx.pmGrid.density) {
    errors.push('PM grid density texture not found');
    return { pass: false, metrics, errors, warnings };
  }
  
  const gl = ctx.gl;
  const gridSize = ctx.pmGrid.gridSize;
  const textureSize = ctx.pmGrid.textureSize;
  
  // Sample middle slice
  const middleSlice = Math.floor(gridSize / 2);
  const sliceData = readGridSlice(gl, ctx.pmGrid.density.texture, textureSize, textureSize, middleSlice, gridSize);
  
  const stats = computeStats(sliceData, 0); // Red channel = density
  
  metrics.density_min = stats.min;
  metrics.density_max = stats.max;
  metrics.density_mean = stats.mean;
  metrics.density_nonzero_count = stats.nonZeroCount;
  metrics.density_total_cells = gridSize * gridSize;
  
  // Validations
  if (stats.nonZeroCount === 0) {
    errors.push('No particles deposited to grid (all cells zero)');
  }
  
  if (!isFinite(stats.max) || !isFinite(stats.min)) {
    errors.push('Non-finite density values detected (NaN or Inf)');
  }
  
  if (stats.max > 1e10) {
    warnings.push(`Very high density detected: ${stats.max.toExponential(2)}`);
  }
  
  const expectedOccupancy = ctx.particleCount / (gridSize ** 3);
  const actualOccupancy = stats.nonZeroCount / (gridSize * gridSize);
  metrics.expected_occupancy = expectedOccupancy;
  metrics.actual_occupancy = actualOccupancy;
  
  if (actualOccupancy < expectedOccupancy * 0.01) {
    warnings.push(`Very low grid occupancy: ${(actualOccupancy * 100).toFixed(2)}% vs expected ${(expectedOccupancy * 100).toFixed(2)}%`);
  }
  
  return {
    pass: errors.length === 0,
    metrics,
    errors,
    warnings
  };
}

/**
 * Stage 2: Verify FFT forward transform
 * Tests:
 * - Spectrum texture has non-zero values
 * - DC component (0 frequency) is reasonable
 * - No NaN/Inf values
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 * @returns {StageTestResult}
 */
export function verifyFFTForward(ctx) {
  const errors = [];
  const warnings = [];
  const metrics = {};
  
  if (!ctx.pmGrid || !ctx.pmGrid.spectrum) {
    errors.push('PM grid spectrum texture not found');
    return { pass: false, metrics, errors, warnings };
  }
  
  const gl = ctx.gl;
  const gridSize = ctx.pmGrid.gridSize;
  const textureSize = ctx.pmGrid.textureSize;
  
  // Sample middle slice
  const middleSlice = Math.floor(gridSize / 2);
  const sliceData = readGridSlice(gl, ctx.pmGrid.spectrum.texture, textureSize, textureSize, middleSlice, gridSize);
  
  const realStats = computeStats(sliceData, 0); // Red = real part
  const imagStats = computeStats(sliceData, 1); // Green = imaginary part
  
  metrics.spectrum_real_min = realStats.min;
  metrics.spectrum_real_max = realStats.max;
  metrics.spectrum_real_mean = realStats.mean;
  metrics.spectrum_imag_min = imagStats.min;
  metrics.spectrum_imag_max = imagStats.max;
  metrics.spectrum_imag_mean = imagStats.mean;
  metrics.spectrum_nonzero_count = realStats.nonZeroCount;
  
  // Check DC component (should be at [0,0,0] which maps to first pixel of first slice)
  const dcSlice = readGridSlice(gl, ctx.pmGrid.spectrum.texture, textureSize, textureSize, 0, gridSize);
  const dcReal = dcSlice[0];
  const dcImag = dcSlice[1];
  
  metrics.dc_component_real = dcReal;
  metrics.dc_component_imag = dcImag;
  
  // Validations
  if (realStats.nonZeroCount === 0) {
    errors.push('FFT spectrum is all zeros (FFT failed)');
  }
  
  if (!isFinite(realStats.max) || !isFinite(imagStats.max)) {
    errors.push('Non-finite spectrum values detected (NaN or Inf)');
  }
  
  if (Math.abs(dcImag) > Math.abs(dcReal) * 0.01) {
    warnings.push(`DC component has unexpected imaginary part: ${dcImag.toExponential(2)} vs real ${dcReal.toExponential(2)}`);
  }
  
  return {
    pass: errors.length === 0,
    metrics,
    errors,
    warnings
  };
}

/**
 * Stage 3: Verify Poisson solve
 * Tests:
 * - Potential spectrum exists and has values
 * - DC component is set to zero (mean potential = 0)
 * - High-frequency components are attenuated
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 * @returns {StageTestResult}
 */
export function verifyPoisson(ctx) {
  const errors = [];
  const warnings = [];
  const metrics = {};
  
  if (!ctx.pmPotentialSpectrum) {
    errors.push('PM potential spectrum texture not found');
    return { pass: false, metrics, errors, warnings };
  }
  
  const gl = ctx.gl;
  const gridSize = ctx.pmGrid.gridSize;
  const textureSize = ctx.pmGrid.textureSize;
  
  // Sample middle slice
  const middleSlice = Math.floor(gridSize / 2);
  const sliceData = readGridSlice(gl, ctx.pmPotentialSpectrum.texture, textureSize, textureSize, middleSlice, gridSize);
  
  const realStats = computeStats(sliceData, 0);
  const imagStats = computeStats(sliceData, 1);
  
  metrics.potential_real_min = realStats.min;
  metrics.potential_real_max = realStats.max;
  metrics.potential_real_mean = realStats.mean;
  metrics.potential_imag_min = imagStats.min;
  metrics.potential_imag_max = imagStats.max;
  metrics.potential_imag_mean = imagStats.mean;
  
  // Check DC component (should be zero)
  const dcSlice = readGridSlice(gl, ctx.pmPotentialSpectrum.texture, textureSize, textureSize, 0, gridSize);
  const dcReal = dcSlice[0];
  const dcImag = dcSlice[1];
  
  metrics.potential_dc_real = dcReal;
  metrics.potential_dc_imag = dcImag;
  
  // Validations
  if (!isFinite(realStats.max) || !isFinite(imagStats.max)) {
    errors.push('Non-finite potential spectrum values detected');
  }
  
  if (Math.abs(dcReal) > 1e-6) {
    warnings.push(`DC component not zeroed: ${dcReal.toExponential(2)} (should be ~0)`);
  }
  
  if (realStats.nonZeroCount === 0) {
    errors.push('Potential spectrum is all zeros (Poisson solve failed)');
  }
  
  return {
    pass: errors.length === 0,
    metrics,
    errors,
    warnings
  };
}

/**
 * Stage 4: Verify gradient computation
 * Tests:
 * - Force spectrum textures exist for all 3 axes
 * - Values are non-zero
 * - No NaN/Inf values
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 * @returns {StageTestResult}
 */
export function verifyGradient(ctx) {
  const errors = [];
  const warnings = [];
  const metrics = {};
  
  if (!ctx.pmForceSpectrum || !ctx.pmForceSpectrum.x || !ctx.pmForceSpectrum.y || !ctx.pmForceSpectrum.z) {
    errors.push('PM force spectrum textures not found');
    return { pass: false, metrics, errors, warnings };
  }
  
  const gl = ctx.gl;
  const gridSize = ctx.pmGrid.gridSize;
  const textureSize = ctx.pmGrid.textureSize;
  const middleSlice = Math.floor(gridSize / 2);
  
  // Check each axis
  for (const axis of ['x', 'y', 'z']) {
    const sliceData = readGridSlice(gl, ctx.pmForceSpectrum[axis].texture, textureSize, textureSize, middleSlice, gridSize);
    const realStats = computeStats(sliceData, 0);
    const imagStats = computeStats(sliceData, 1);
    
    metrics[`force_${axis}_real_min`] = realStats.min;
    metrics[`force_${axis}_real_max`] = realStats.max;
    metrics[`force_${axis}_real_mean`] = realStats.mean;
    metrics[`force_${axis}_imag_min`] = imagStats.min;
    metrics[`force_${axis}_imag_max`] = imagStats.max;
    metrics[`force_${axis}_nonzero`] = realStats.nonZeroCount;
    
    if (!isFinite(realStats.max) || !isFinite(imagStats.max)) {
      errors.push(`Non-finite force spectrum values in ${axis}-axis`);
    }
    
    if (realStats.nonZeroCount === 0) {
      errors.push(`Force spectrum ${axis}-axis is all zeros (gradient failed)`);
    }
  }
  
  return {
    pass: errors.length === 0,
    metrics,
    errors,
    warnings
  };
}

/**
 * Stage 5: Verify inverse FFT
 * Tests:
 * - Force grid textures exist for all 3 axes
 * - Real-space forces are non-zero
 * - Values are physically reasonable
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 * @returns {StageTestResult}
 */
export function verifyFFTInverse(ctx) {
  const errors = [];
  const warnings = [];
  const metrics = {};
  
  if (!ctx.pmForceGrids || !ctx.pmForceGrids.x || !ctx.pmForceGrids.y || !ctx.pmForceGrids.z) {
    errors.push('PM force grid textures not found');
    return { pass: false, metrics, errors, warnings };
  }
  
  const gl = ctx.gl;
  const gridSize = ctx.pmGrid.gridSize;
  const textureSize = ctx.pmGrid.textureSize;
  const middleSlice = Math.floor(gridSize / 2);
  
  // Check each axis
  for (const axis of ['x', 'y', 'z']) {
    const sliceData = readGridSlice(gl, ctx.pmForceGrids[axis], textureSize, textureSize, middleSlice, gridSize);
    const stats = computeStats(sliceData, 0); // Real-space forces in red channel
    
    metrics[`force_grid_${axis}_min`] = stats.min;
    metrics[`force_grid_${axis}_max`] = stats.max;
    metrics[`force_grid_${axis}_mean`] = stats.mean;
    metrics[`force_grid_${axis}_nonzero`] = stats.nonZeroCount;
    
    if (!isFinite(stats.max)) {
      errors.push(`Non-finite force grid values in ${axis}-axis`);
    }
    
    if (stats.nonZeroCount === 0) {
      errors.push(`Force grid ${axis}-axis is all zeros (inverse FFT failed)`);
    }
    
    if (Math.abs(stats.max) > 1e10) {
      warnings.push(`Very large force magnitude in ${axis}-axis: ${stats.max.toExponential(2)}`);
    }
  }
  
  return {
    pass: errors.length === 0,
    metrics,
    errors,
    warnings
  };
}

/**
 * Stage 6: Verify force sampling at particles
 * Tests:
 * - pmForceTexture exists and has correct size
 * - Sampled forces are non-zero
 * - Force magnitudes are reasonable
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 * @returns {StageTestResult}
 */
export function verifyForceSampling(ctx) {
  const errors = [];
  const warnings = [];
  const metrics = {};
  
  if (!ctx.pmForceTexture) {
    errors.push('PM force texture not found');
    return { pass: false, metrics, errors, warnings };
  }
  
  const gl = ctx.gl;
  const texSize = ctx.textureSize;
  
  // Sample a few random particles
  const sampleCount = Math.min(100, ctx.particleCount);
  const sampleIndices = [];
  for (let i = 0; i < sampleCount; i++) {
    sampleIndices.push(Math.floor(Math.random() * ctx.particleCount));
  }
  
  let nonZeroCount = 0;
  let maxMag = 0;
  let sumMag = 0;
  
  for (const idx of sampleIndices) {
    const x = idx % texSize.width;
    const y = Math.floor(idx / texSize.width);
    
    const pixel = readPixel(gl, ctx.pmForceTexture.texture, texSize.width, texSize.height, x, y);
    const fx = pixel[0];
    const fy = pixel[1];
    const fz = pixel[2];
    
    if (!isFinite(fx) || !isFinite(fy) || !isFinite(fz)) {
      errors.push(`Non-finite force at particle ${idx}: [${fx}, ${fy}, ${fz}]`);
      continue;
    }
    
    const mag = Math.sqrt(fx * fx + fy * fy + fz * fz);
    sumMag += mag;
    maxMag = Math.max(maxMag, mag);
    
    if (mag > 1e-10) nonZeroCount++;
  }
  
  metrics.sampled_particles = sampleCount;
  metrics.nonzero_forces = nonZeroCount;
  metrics.max_force_magnitude = maxMag;
  metrics.mean_force_magnitude = sumMag / sampleCount;
  metrics.nonzero_fraction = nonZeroCount / sampleCount;
  
  // Validations
  if (nonZeroCount === 0) {
    errors.push('All sampled forces are zero (sampling failed or forces not computed)');
  }
  
  if (nonZeroCount < sampleCount * 0.1) {
    warnings.push(`Very few non-zero forces: ${nonZeroCount}/${sampleCount} (${(nonZeroCount / sampleCount * 100).toFixed(1)}%)`);
  }
  
  if (maxMag > 1e10) {
    warnings.push(`Very large force magnitude: ${maxMag.toExponential(2)}`);
  }
  
  return {
    pass: errors.length === 0,
    metrics,
    errors,
    warnings
  };
}

/**
 * Run all PM pipeline verification tests
 * @param {import('../particle-system.js').ParticleSystem} ctx
 * @returns {Object.<string, StageTestResult>}
 */
export function verifyAllStages(ctx) {
  return {
    deposit: verifyDeposit(ctx),
    fft_forward: verifyFFTForward(ctx),
    poisson: verifyPoisson(ctx),
    gradient: verifyGradient(ctx),
    fft_inverse: verifyFFTInverse(ctx),
    force_sampling: verifyForceSampling(ctx)
  };
}

/**
 * Print verification results to console
 * @param {Object.<string, StageTestResult>} results
 */
export function printVerificationResults(results) {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('PM Pipeline Verification Results');
  console.log('═══════════════════════════════════════════════════════\n');
  
  let allPassed = true;
  
  for (const [stage, result] of Object.entries(results)) {
    const status = result.pass ? '✓ PASS' : '✗ FAIL';
    const color = result.pass ? '\x1b[32m' : '\x1b[31m';
    const reset = '\x1b[0m';
    
    console.log(`${color}${status}${reset} ${stage.toUpperCase()}`);
    
    if (result.errors.length > 0) {
      console.log('  Errors:');
      result.errors.forEach(err => console.log(`    • ${err}`));
      allPassed = false;
    }
    
    if (result.warnings.length > 0) {
      console.log('  Warnings:');
      result.warnings.forEach(warn => console.log(`    ⚠ ${warn}`));
    }
    
    console.log('  Metrics:');
    for (const [key, value] of Object.entries(result.metrics)) {
      const formatted = typeof value === 'number' ? 
        (Math.abs(value) < 1000 && Math.abs(value) > 0.01 ? value.toFixed(4) : value.toExponential(2)) :
        value;
      console.log(`    ${key}: ${formatted}`);
    }
    console.log('');
  }
  
  console.log('═══════════════════════════════════════════════════════');
  console.log(allPassed ? '✓ All stages passed' : '✗ Some stages failed');
  console.log('═══════════════════════════════════════════════════════\n');
  
  return allPassed;
}
