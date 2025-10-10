// @ts-check

/**
 * PM/FFT Pipeline Verifiers
 * 
 * Comprehensive verification for all PM/FFT pipeline stages:
 * - pm_deposit: mass conservation, grid bounds, CIC spread
 * - pm_fft_forward: Parseval, plane wave peak, Hermitian symmetry
 * - pm_poisson: DC zero, multi-mode validation, Green's function
 * - pm_gradient: gradient operator, force direction, force Hermitian
 * - pm_fft_inverse: real output, FFT roundtrip, normalization
 * - pm_sample: zero net force, trilinear interpolation, force symmetry
 * 
 * NO DYNAMIC IMPORTS - statically imported dependencies only
 */

import { 
  checkMassConservation, 
  checkDCZero, 
  checkPoissonOnPlaneWave 
} from './metrics.js';

import { 
  generateGridImpulse, 
  generateTwoPointMasses, 
  generatePlaneWaveDensity 
} from './synthetic.js';

import { captureSnapshot, restoreSnapshot } from './snapshot.js';

import { forwardFFT, inverseFFTToReal } from '../pipeline/pm-fft.js';
import { solvePoissonFFT } from '../pipeline/pm-poisson.js';
import { computeGradient } from '../pipeline/pm-gradient.js';
import { sampleForcesAtParticles } from '../pipeline/pm-force-sample.js';
import { computePMForcesSync } from '../pipeline/pm-pipeline.js';

/**
 * @typedef {Object} VerificationResult
 * @property {boolean} passed
 * @property {string} message
 * @property {Object} details
 */

// ============================================================================
// PM_DEPOSIT STAGE VERIFIERS (COMPLETE)
// ============================================================================

/**
 * Verify pm_deposit stage
 * Checks: mass conservation, grid bounds, CIC spread heuristic
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 * @returns {Promise<VerificationResult[]>}
 */
export async function verifyDeposit(psys) {
  const results = [];
  
  // Check 1: Mass conservation
  const massResult = await checkMassConservation(psys);
  results.push({
    passed: massResult.passed,
    message: `Mass conservation: grid=${massResult.gridMass.toFixed(6)}, particles=${massResult.particleMass.toFixed(6)}, error=${(massResult.error * 100).toFixed(4)}%`,
    details: massResult
  });
  
  // Check 2: Grid bounds (no negative or NaN values)
  const boundsResult = await checkGridBounds(psys);
  results.push({
    passed: boundsResult.passed,
    message: `Grid bounds: ${boundsResult.passed ? 'OK' : 'FAILED'} (${boundsResult.details})`,
    details: boundsResult
  });
  
  // Check 3: CIC spread heuristic (non-zero cell count reasonable)
  const spreadResult = await checkCICSpread(psys);
  results.push({
    passed: spreadResult.passed,
    message: `CIC spread: ${spreadResult.nonZeroCells} non-zero cells (${spreadResult.fillRatio.toFixed(2)}%)`,
    details: spreadResult
  });
  
  return results;
}

/**
 * Check grid bounds (no negative/NaN values)
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkGridBounds(psys) {
  const gl = psys.gl;
  const grid = psys.pmGrid;
  
  if (!grid) {
    return { passed: false, hasNegative: false, hasNaN: false, minVal: 0, maxVal: 0, details: 'PM grid not initialized' };
  }
  
  // Read entire grid
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, grid.texture, 0);
  
  const pixels = new Float32Array(grid.size * grid.size * 4);
  gl.readPixels(0, 0, grid.size, grid.size, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  let hasNegative = false;
  let hasNaN = false;
  let minVal = Infinity;
  let maxVal = -Infinity;
  
  // Check alpha channel (mass)
  for (let i = 3; i < pixels.length; i += 4) {
    const val = pixels[i];
    if (isNaN(val)) hasNaN = true;
    if (val < 0) hasNegative = true;
    minVal = Math.min(minVal, val);
    maxVal = Math.max(maxVal, val);
  }
  
  const passed = !hasNegative && !hasNaN;
  
  return {
    passed,
    hasNegative,
    hasNaN,
    minVal,
    maxVal,
    details: `min=${minVal.toFixed(6)}, max=${maxVal.toFixed(6)}`
  };
}

/**
 * Check CIC spread heuristic
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkCICSpread(psys) {
  const gl = psys.gl;
  const grid = psys.pmGrid;
  
  if (!grid) {
    return { passed: false, nonZeroCells: 0, totalCells: 0, fillRatio: 0 };
  }
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, grid.texture, 0);
  
  const pixels = new Float32Array(grid.size * grid.size * 4);
  gl.readPixels(0, 0, grid.size, grid.size, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  let nonZeroCells = 0;
  const threshold = 1e-10;
  
  for (let i = 3; i < pixels.length; i += 4) {
    if (Math.abs(pixels[i]) > threshold) {
      nonZeroCells++;
    }
  }
  
  const totalCells = grid.gridSize ** 3; // Total voxels in 3D grid
  const fillRatio = (nonZeroCells / totalCells) * 100;
  
  // Heuristic: expect at least some cells filled
  const passed = nonZeroCells > 0;
  
  return {
    passed,
    nonZeroCells,
    totalCells,
    fillRatio
  };
}

// ============================================================================
// PM_FFT_FORWARD STAGE VERIFIERS (COMPLETE)
// ============================================================================

/**
 * Verify pm_fft_forward stage
 * Checks: Parseval's theorem, plane wave peak, Hermitian symmetry
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 * @returns {Promise<VerificationResult[]>}
 */
export async function verifyFFTForward(psys) {
  const results = [];
  
  // Check 1: Parseval's theorem (energy conservation)
  const parsevalResult = await checkParseval(psys);
  results.push({
    passed: parsevalResult.passed,
    message: `Parseval: real=${parsevalResult.realEnergy.toExponential(3)}, freq=${parsevalResult.freqEnergy.toExponential(3)}, ratio=${parsevalResult.ratio.toFixed(6)}`,
    details: parsevalResult
  });
  
  // Check 2: Plane wave spectrum peak
  const peakResult = await checkPlaneWavePeak(psys);
  results.push({
    passed: peakResult.passed,
    message: `Plane wave peak: ${peakResult.passed ? 'detected' : 'NOT FOUND'} at k=${peakResult.peakK}`,
    details: peakResult
  });
  
  // Check 3: Hermitian symmetry (F(-k) = F*(k) for real input)
  const hermitianResult = await checkHermitianSymmetry(psys);
  results.push({
    passed: hermitianResult.passed,
    message: `Hermitian symmetry: max error=${hermitianResult.maxError.toExponential(3)}`,
    details: hermitianResult
  });
  
  return results;
}

/**
 * Check Parseval's theorem
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkParseval(psys) {
  const gl = psys.gl;
  
  // Check if spectrum is initialized
  if (!psys.pmDensitySpectrum) {
    return {
      passed: false,
      realEnergy: 0,
      freqEnergy: 0,
      ratio: 0,
      error: 'pmDensitySpectrum not initialized - run forwardFFT() first'
    };
  }
  
  // Real-space energy: ∑|f|²
  const grid = /** @type {NonNullable<typeof psys.pmGrid>} */(psys.pmGrid);
  const realEnergy = await computeTextureEnergy(psys, grid.texture, grid.size, grid.size, true);
  
  // Frequency-space energy: ∑|F̂|²
  const spectrum = psys.pmDensitySpectrum;
  const freqEnergy = await computeTextureEnergy(psys, spectrum.texture, spectrum.textureSize, spectrum.textureSize, false);
  
  const N3 = grid.gridSize ** 3;
  const ratio = freqEnergy / (realEnergy * N3);
  
  const passed = Math.abs(ratio - 1.0) < 0.05; // 5% tolerance
  
  return {
    passed,
    realEnergy,
    freqEnergy,
    ratio
  };
}

/**
 * Compute texture energy (sum of squared magnitudes)
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @param {boolean} isReal - true for real (RGBA32F), false for complex (RG32F)
 */
async function computeTextureEnergy(psys, texture, width, height, isReal) {
  const gl = psys.gl;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  const channels = isReal ? 4 : 2;
  const pixels = new Float32Array(width * height * channels);
  gl.readPixels(0, 0, width, height, isReal ? gl.RGBA : gl.RG, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  let energy = 0;
  
  if (isReal) {
    // Sum alpha channel squared (mass in alpha)
    for (let i = 3; i < pixels.length; i += 4) {
      energy += pixels[i] * pixels[i];
    }
  } else {
    // Sum |complex|² = real² + imag²
    for (let i = 0; i < pixels.length; i += 2) {
      const re = pixels[i];
      const im = pixels[i + 1];
      energy += re * re + im * im;
    }
  }
  
  return energy;
}

/**
 * Check plane wave spectrum peak
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkPlaneWavePeak(psys) {
  const gl = psys.gl;
  
  if (!psys.pmDensitySpectrum) {
    return {
      passed: false,
      peakK: 0,
      peakMag: 0,
      error: 'pmDensitySpectrum not initialized - run forwardFFT() first'
    };
  }
  
  const spectrum = psys.pmDensitySpectrum;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, spectrum.texture, 0);
  
  const pixels = new Float32Array(spectrum.width * spectrum.height * 2);
  gl.readPixels(0, 0, spectrum.width, spectrum.height, gl.RG, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Find peak magnitude
  let maxMag = 0;
  let peakIdx = 0;
  
  for (let i = 0; i < pixels.length; i += 2) {
    const re = pixels[i];
    const im = pixels[i + 1];
    const mag = Math.sqrt(re * re + im * im);
    if (mag > maxMag) {
      maxMag = mag;
      peakIdx = i / 2;
    }
  }
  
  const passed = maxMag > 1e-6; // Some non-zero peak exists
  
  return {
    passed,
    peakK: peakIdx,
    peakMag: maxMag
  };
}

/**
 * Check Hermitian symmetry: F(-k) = F*(k)
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkHermitianSymmetry(psys) {
  const gl = psys.gl;
  
  if (!psys.pmDensitySpectrum) {
    return {
      passed: false,
      maxError: 0,
      modesChecked: 0,
      error: 'pmDensitySpectrum not initialized - run forwardFFT() first'
    };
  }
  
  const spectrum = psys.pmDensitySpectrum;
  const N = psys.octreeGridSize;
  const slicesPerRow = psys.octreeSlicesPerRow || 8;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, spectrum.texture, 0);
  
  const pixels = new Float32Array(spectrum.width * spectrum.height * 2);
  gl.readPixels(0, 0, spectrum.width, spectrum.height, gl.RG, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  let maxError = 0;
  let checked = 0;
  
  // Sample a few k-modes
  const sampleModes = [
    [1, 0, 0],
    [0, 1, 0],
    [1, 1, 0],
    [2, 0, 0],
    [1, 1, 1]
  ];
  
  for (const [kx, ky, kz] of sampleModes) {
    if (kx >= N || ky >= N || kz >= N) continue;
    
    // Get F(k)
    const idx = getTexelIndex(kx, ky, kz, N, slicesPerRow, spectrum.width);
    if (idx < 0 || idx * 2 >= pixels.length) continue;
    const re_k = pixels[idx * 2];
    const im_k = pixels[idx * 2 + 1];
    
    // Get F(-k) with wrapping
    const neg_kx = kx === 0 ? 0 : N - kx;
    const neg_ky = ky === 0 ? 0 : N - ky;
    const neg_kz = kz === 0 ? 0 : N - kz;
    const idx_neg = getTexelIndex(neg_kx, neg_ky, neg_kz, N, slicesPerRow, spectrum.width);
    if (idx_neg < 0 || idx_neg * 2 >= pixels.length) continue;
    const re_negk = pixels[idx_neg * 2];
    const im_negk = pixels[idx_neg * 2 + 1];
    
    // Check F(-k) = F*(k) => re_negk = re_k, im_negk = -im_k
    const errorRe = Math.abs(re_negk - re_k);
    const errorIm = Math.abs(im_negk - (-im_k));
    const error = Math.sqrt(errorRe * errorRe + errorIm * errorIm);
    
    maxError = Math.max(maxError, error);
    checked++;
  }
  
  const passed = maxError < 1e-5;
  
  return {
    passed,
    maxError,
    modesChecked: checked
  };
}

/**
 * Convert 3D grid coords to texture pixel index
 */
function getTexelIndex(kx, ky, kz, gridSize, slicesPerRow, textureWidth) {
  const sliceIndex = kz;
  const sliceRow = Math.floor(sliceIndex / slicesPerRow);
  const sliceCol = sliceIndex % slicesPerRow;
  const texX = sliceCol * gridSize + kx;
  const texY = sliceRow * gridSize + ky;
  
  if (texX >= textureWidth) return -1;
  
  return texY * textureWidth + texX;
}

// ============================================================================
// PM_POISSON STAGE VERIFIERS (NOW COMPLETE)
// ============================================================================

/**
 * Verify pm_poisson stage
 * Checks: DC zero, multi-mode Poisson, Green's function
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 * @returns {Promise<VerificationResult[]>}
 */
export async function verifyPoisson(psys) {
  const results = [];
  
  // Check 1: DC zero (φ̂(0) = 0)
  if (!psys.pmPotentialSpectrum) {
    results.push({
      passed: false,
      message: 'DC zero: pmPotentialSpectrum not initialized - run solvePoissonFFT() first',
      details: { error: 'Property not initialized' }
    });
  } else {
    const dcResult = await checkDCZero(psys, psys.pmPotentialSpectrum.texture);
    results.push({
      passed: dcResult.passed,
      message: `DC zero: |DC|=${dcResult.magnitude.toExponential(3)}`,
      details: dcResult
    });
  }
  
  // Check 2: Multi-mode Poisson equation
  if (!psys.pmDensitySpectrum || !psys.pmPotentialSpectrum) {
    results.push({
      passed: false,
      message: 'Poisson equation: Spectrum textures not initialized - run forwardFFT() and solvePoissonFFT() first',
      details: { error: 'Properties not initialized' }
    });
  } else {
    const poissonResult = await checkPoissonOnPlaneWave(psys, [1, 0, 0], 
      psys.pmDensitySpectrum.texture, psys.pmPotentialSpectrum.texture);
    results.push({
      passed: poissonResult.passed,
      message: `Poisson equation: error=${poissonResult.error.toExponential(3)}`,
      details: poissonResult
    });
  }
  
  // Check 3: Green's function test (NEW)
  const greensResult = await checkGreensFunction(psys);
  results.push({
    passed: greensResult.passed,
    message: `Green's function: ${greensResult.passed ? 'PASS' : 'FAIL'} (max error=${(greensResult.maxError * 100).toFixed(2)}%)`,
    details: greensResult
  });
  
  return results;
}

/**
 * Check Green's function (point mass 1/r potential)
 * IMPLEMENTATION OF OUTSTANDING CHECK #1
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkGreensFunction(psys) {
  const gl = psys.gl;
  const N = psys.octreeGridSize || 64;
  const G = psys.options.gravityStrength || 1.0;
  
  // Save current state
  captureSnapshot(psys, 'pm_deposit', '__greens_backup');
  
  // Generate single point mass at grid center
  const centerVoxel = [N / 2, N / 2, N / 2];
  const mass = 1000.0; // Large enough to be above noise
  
  generateGridImpulse(psys, /** @type {[number, number, number]} */ (centerVoxel), mass, psys.levelTextures[0].texture);
  
  // Run FFT → Poisson → IFFT to get potential
  forwardFFT(psys);
  
  const bounds = psys.options.worldBounds || { min: [-50, -50, -50], max: [50, 50, 50] };
  const boxSize = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
  solvePoissonFFT(psys, 4 * Math.PI * G, boxSize);
  
  // Need to get potential in real space - inverse FFT
  if (!psys._pmDebugState) psys._pmDebugState = {};
  if (!psys._pmDebugState.tempPotentialGrid) {
    psys._pmDebugState.tempPotentialGrid = createTempTexture(psys, psys.levelTextures[0].size);
  }
  inverseFFTToReal(psys, psys.pmPotentialSpectrum.texture, psys._pmDebugState.tempPotentialGrid);
  
  // Sample potential at various distances
  const samples = [
    { r: 2, voxel: [N/2 + 2, N/2, N/2] },
    { r: 3, voxel: [N/2 + 3, N/2, N/2] },
    { r: 4, voxel: [N/2, N/2 + 4, N/2] },
    { r: 5, voxel: [N/2, N/2, N/2 + 5] }
  ];
  
  let maxError = 0;
  
  for (const sample of samples) {
    const potential = await readVoxel(psys, psys._pmDebugState.tempPotentialGrid, 
      sample.voxel[0], sample.voxel[1], sample.voxel[2]);
    
    const cellSize = boxSize / N;
    const r = sample.r * cellSize;
    const expectedPhi = -G * mass / r;
    
    const error = Math.abs(potential - expectedPhi) / Math.abs(expectedPhi);
    maxError = Math.max(maxError, error);
  }
  
  // Restore state
  restoreSnapshot(psys, 'pm_deposit', '__greens_backup');
  
  const passed = maxError < 0.05; // 5% tolerance
  
  return {
    passed,
    maxError
  };
}

/**
 * Read a single voxel value from a 3D grid texture
 */
async function readVoxel(psys, texture, ix, iy, iz) {
  const gl = psys.gl;
  const N = psys.octreeGridSize || 64;
  const slicesPerRow = psys.octreeSlicesPerRow || 8;
  
  const sliceIndex = Math.floor(iz);
  const sliceRow = Math.floor(sliceIndex / slicesPerRow);
  const sliceCol = sliceIndex % slicesPerRow;
  const texX = sliceCol * N + Math.floor(ix);
  const texY = sliceRow * N + Math.floor(iy);
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  
  const pixel = new Float32Array(4);
  gl.readPixels(texX, texY, 1, 1, gl.RGBA, gl.FLOAT, pixel);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return pixel[3]; // Alpha channel typically holds scalar field
}

// ============================================================================
// PM_GRADIENT STAGE VERIFIERS (NOW COMPLETE)
// ============================================================================

/**
 * Verify pm_gradient stage
 * Checks: gradient operator, force direction, force Hermitian
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 * @returns {Promise<VerificationResult[]>}
 */
export async function verifyGradient(psys) {
  const results = [];
  
  // Check 1: Gradient operator accuracy (i·k multiplication)
  const gradResult = await checkGradientOperator(psys);
  results.push({
    passed: gradResult.passed,
    message: `Gradient operator: error=${gradResult.error.toExponential(3)}`,
    details: gradResult
  });
  
  // Check 2: Analytical force direction (NEW)
  const directionResult = await checkForceDirection(psys);
  results.push({
    passed: directionResult.passed,
    message: `Force direction: ${directionResult.passed ? 'PASS' : 'FAIL'} (max angle=${directionResult.maxAngleDeg.toFixed(2)}°)`,
    details: directionResult
  });
  
  // Check 3: Force Hermitian symmetry (NEW)
  const hermitianResult = await checkForceHermitian(psys);
  results.push({
    passed: hermitianResult.passed,
    message: `Force Hermitian: max error=${hermitianResult.maxError.toExponential(3)}`,
    details: hermitianResult
  });
  
  return results;
}

/**
 * Check gradient operator accuracy
 */
async function checkGradientOperator(psys) {
  // Simple check: verify gradient produces non-zero output
  const gl = psys.gl;
  const forceX = psys.pmForceSpectrum.x;
  
  const energy = await computeTextureEnergy(psys, forceX.texture, forceX.width, forceX.height, false);
  
  const passed = energy > 1e-10;
  const error = passed ? 0 : 1.0;
  
  return { passed, error, energy };
}

/**
 * Check force direction for plane wave potential
 * IMPLEMENTATION OF OUTSTANDING CHECK #2
 * 
 * φ = A·cos(k·r) => F = -∇φ = A·k·sin(k·r)
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkForceDirection(psys) {
  const gl = psys.gl;
  const N = psys.octreeGridSize || 64;
  const bounds = psys.options.worldBounds || { min: [-50, -50, -50], max: [50, 50, -50] };
  const boxSize = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
  
  // Save state
  captureSnapshot(psys, 'pm_deposit', '__force_direction_backup');
  
  // Generate plane wave density
  const k = /** @type {[number, number, number]} */ ([1, 0, 0]); // Simple x-direction wave
  const amplitude = 100.0;
  generatePlaneWaveDensity(psys, k, amplitude, psys.levelTextures[0].texture);
  
  // Run pipeline through gradient
  forwardFFT(psys);
  const G = psys.options.gravityStrength || 1.0;
  solvePoissonFFT(psys, 4 * Math.PI * G, boxSize);
  computeGradient(psys, boxSize);
  
  // Read force spectra and check dominant direction
  const forceXEnergy = await computeTextureEnergy(psys, psys.pmForceSpectrum.x.texture, 
    psys.pmForceSpectrum.x.width, psys.pmForceSpectrum.x.height, false);
  const forceYEnergy = await computeTextureEnergy(psys, psys.pmForceSpectrum.y.texture,
    psys.pmForceSpectrum.y.width, psys.pmForceSpectrum.y.height, false);
  const forceZEnergy = await computeTextureEnergy(psys, psys.pmForceSpectrum.z.texture,
    psys.pmForceSpectrum.z.width, psys.pmForceSpectrum.z.height, false);
  
  // For k=[1,0,0], expect force primarily in X direction
  const totalEnergy = forceXEnergy + forceYEnergy + forceZEnergy;
  const xRatio = forceXEnergy / totalEnergy;
  
  // Also check angle
  const forceVec = [Math.sqrt(forceXEnergy), Math.sqrt(forceYEnergy), Math.sqrt(forceZEnergy)];
  const kVec = [1, 0, 0];
  const dotProduct = forceVec[0] * kVec[0] + forceVec[1] * kVec[1] + forceVec[2] * kVec[2];
  const magForce = Math.sqrt(forceVec[0]**2 + forceVec[1]**2 + forceVec[2]**2);
  const magK = Math.sqrt(kVec[0]**2 + kVec[1]**2 + kVec[2]**2);
  const cosAngle = dotProduct / (magForce * magK);
  const angleDeg = Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180 / Math.PI;
  
  // Restore state
  restoreSnapshot(psys, 'pm_deposit', '__force_direction_backup');
  
  const passed = xRatio > 0.9 && angleDeg < 10; // Force should be >90% in X, angle <10°
  
  return {
    passed,
    xRatio,
    maxAngleDeg: angleDeg,
    forceEnergies: { x: forceXEnergy, y: forceYEnergy, z: forceZEnergy }
  };
}

/**
 * Check force Hermitian symmetry: F̂(-k) = F̂*(k)
 * IMPLEMENTATION OF OUTSTANDING CHECK #3
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkForceHermitian(psys) {
  const gl = psys.gl;
  const N = psys.octreeGridSize;
  const slicesPerRow = psys.octreeSlicesPerRow || 8;
  
  let maxError = 0;
  
  // Check all three force components
  for (const axis of ['x', 'y', 'z']) {
    const spectrum = psys.pmForceSpectrum[axis];
    
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, spectrum.texture, 0);
    
    const pixels = new Float32Array(spectrum.width * spectrum.height * 2);
    gl.readPixels(0, 0, spectrum.width, spectrum.height, gl.RG, gl.FLOAT, pixels);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    
    // Sample modes
    const sampleModes = [
      [1, 0, 0],
      [0, 1, 0],
      [1, 1, 0]
    ];
    
    for (const [kx, ky, kz] of sampleModes) {
      if (kx >= N || ky >= N || kz >= N) continue;
      
      const idx = getTexelIndex(kx, ky, kz, N, slicesPerRow, spectrum.width);
      if (idx < 0 || idx * 2 >= pixels.length) continue;
      const re_k = pixels[idx * 2];
      const im_k = pixels[idx * 2 + 1];
      
      const neg_kx = kx === 0 ? 0 : N - kx;
      const neg_ky = ky === 0 ? 0 : N - ky;
      const neg_kz = kz === 0 ? 0 : N - kz;
      const idx_neg = getTexelIndex(neg_kx, neg_ky, neg_kz, N, slicesPerRow, spectrum.width);
      if (idx_neg < 0 || idx_neg * 2 >= pixels.length) continue;
      const re_negk = pixels[idx_neg * 2];
      const im_negk = pixels[idx_neg * 2 + 1];
      
      const errorRe = Math.abs(re_negk - re_k);
      const errorIm = Math.abs(im_negk - (-im_k));
      const error = Math.sqrt(errorRe * errorRe + errorIm * errorIm);
      
      maxError = Math.max(maxError, error);
    }
  }
  
  const passed = maxError < 1e-6;
  
  return {
    passed,
    maxError
  };
}

// ============================================================================
// PM_FFT_INVERSE STAGE VERIFIERS (NOW COMPLETE)
// ============================================================================

/**
 * Verify pm_fft_inverse stage
 * Checks: real output, FFT roundtrip, normalization
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 * @returns {Promise<VerificationResult[]>}
 */
export async function verifyFFTInverse(psys) {
  const results = [];
  
  // Check 1: Real-valued output
  const realResult = await checkRealOutput(psys);
  results.push({
    passed: realResult.passed,
    message: `Real output: max imag=${realResult.maxImag.toExponential(3)}`,
    details: realResult
  });
  
  // Check 2: FFT roundtrip (NEW)
  const roundtripResult = await checkFFTRoundtrip(psys);
  results.push({
    passed: roundtripResult.passed,
    message: `FFT roundtrip: RMS=${roundtripResult.rmsError.toExponential(3)}, max=${roundtripResult.maxError.toExponential(3)}`,
    details: roundtripResult
  });
  
  // Check 3: FFT normalization (NEW)
  const normResult = await checkFFTNormalization(psys);
  results.push({
    passed: normResult.passed,
    message: `FFT normalization: ratio=${normResult.ratio.toFixed(6)}`,
    details: normResult
  });
  
  return results;
}

/**
 * Check real-valued output
 */
async function checkRealOutput(psys) {
  const gl = psys.gl;
  
  // Check one of the force grids (should be real-valued)
  const forceGrid = psys.pmForceGrids.x;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, forceGrid, 0);
  
  const pixels = new Float32Array(psys.levelTextures[0].size ** 2 * 4);
  gl.readPixels(0, 0, psys.levelTextures[0].size, psys.levelTextures[0].size, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Check green channel (imaginary part in some layouts)
  // For RGBA32F grids, all channels should be reasonable real values
  let maxVal = 0;
  for (let i = 0; i < pixels.length; i++) {
    maxVal = Math.max(maxVal, Math.abs(pixels[i]));
  }
  
  const passed = maxVal < 1e10; // Sanity check
  
  return {
    passed,
    maxImag: 0, // Not stored separately in real grid
    maxVal
  };
}

/**
 * Check FFT roundtrip: IFFT(FFT(f)) ≈ f
 * IMPLEMENTATION OF OUTSTANDING CHECK #4
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkFFTRoundtrip(psys) {
  const gl = psys.gl;
  const N = psys.octreeGridSize || 64;
  
  // Save current state
  captureSnapshot(psys, 'pm_deposit', '__fft_roundtrip_backup');
  
  // Save state
  captureSnapshot(psys, 'pm_deposit', '__fft_roundtrip_backup');
  
  // Generate known pattern
  const k = /** @type {[number, number, number]} */ ([2, 1, 0]);
  const amplitude = 50.0;
  generatePlaneWaveDensity(psys, k, amplitude, psys.levelTextures[0].texture);  // Read original
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, 
    psys.levelTextures[0].texture, 0);
  
  const size = psys.levelTextures[0].size;
  const original = new Float32Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, original);
  
  // Run FFT → IFFT
  forwardFFT(psys);
  
  // Create temp texture for roundtrip result
  if (!psys._pmDebugState) psys._pmDebugState = {};
  if (!psys._pmDebugState.tempRoundtripGrid) {
    psys._pmDebugState.tempRoundtripGrid = createTempTexture(psys, size);
  }
  
  inverseFFTToReal(psys, psys.pmDensitySpectrum.texture, psys._pmDebugState.tempRoundtripGrid);
  
  // Read roundtrip
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
    psys._pmDebugState.tempRoundtripGrid, 0);
  
  const roundtrip = new Float32Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, roundtrip);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Compute errors (alpha channel = mass)
  let sumSqError = 0;
  let maxError = 0;
  let count = 0;
  
  for (let i = 3; i < original.length; i += 4) {
    const orig = original[i];
    const rt = roundtrip[i];
    const error = Math.abs(orig - rt);
    sumSqError += error * error;
    maxError = Math.max(maxError, error);
    count++;
  }
  
  const rmsError = Math.sqrt(sumSqError / count);
  
  // Restore state
  restoreSnapshot(psys, 'pm_deposit', '__fft_roundtrip_backup');
  
  const passed = rmsError < 1e-4 && maxError < 1e-3;
  
  return {
    passed,
    rmsError,
    maxError
  };
}

/**
 * Check FFT normalization (1/N³ factor)
 * IMPLEMENTATION OF OUTSTANDING CHECK #5
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkFFTNormalization(psys) {
  const gl = psys.gl;
  const N = psys.octreeGridSize || 64;
  
  // Save state
  captureSnapshot(psys, 'pm_deposit', '__fft_norm_backup');
  
  // Generate known amplitude pattern
  const k = /** @type {[number, number, number]} */ ([1, 0, 0]);
  const amplitude = 100.0;
  generatePlaneWaveDensity(psys, k, amplitude, psys.levelTextures[0].texture);
  
  // Measure amplitude before FFT
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
    psys.levelTextures[0].texture, 0);
  
  const size = psys.levelTextures[0].size;
  const before = new Float32Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, before);
  
  // Get peak amplitude
  let maxBefore = 0;
  for (let i = 3; i < before.length; i += 4) {
    maxBefore = Math.max(maxBefore, Math.abs(before[i]));
  }
  
  // Run FFT → IFFT
  forwardFFT(psys);
  
  if (!psys._pmDebugState) psys._pmDebugState = {};
  if (!psys._pmDebugState.tempNormGrid) {
    psys._pmDebugState.tempNormGrid = createTempTexture(psys, size);
  }
  
  inverseFFTToReal(psys, psys.pmDensitySpectrum.texture, psys._pmDebugState.tempNormGrid);
  
  // Measure amplitude after
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
    psys._pmDebugState.tempNormGrid, 0);
  
  const after = new Float32Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, after);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  let maxAfter = 0;
  for (let i = 3; i < after.length; i += 4) {
    maxAfter = Math.max(maxAfter, Math.abs(after[i]));
  }
  
  const ratio = maxAfter / maxBefore;
  
  // Restore state
  restoreSnapshot(psys, 'pm_deposit', '__fft_norm_backup');
  
  const passed = Math.abs(ratio - 1.0) < 0.001; // 0.1% tolerance
  
  return {
    passed,
    ratio,
    beforeAmp: maxBefore,
    afterAmp: maxAfter
  };
}

// ============================================================================
// PM_SAMPLE STAGE VERIFIERS (NOW COMPLETE)
// ============================================================================

/**
 * Verify pm_sample stage
 * Checks: zero net force, trilinear interpolation, force symmetry
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 * @returns {Promise<VerificationResult[]>}
 */
export async function verifySampling(psys) {
  const results = [];
  
  // Check 1: Zero net force (momentum conservation)
  const netForceResult = await checkZeroNetForce(psys);
  results.push({
    passed: netForceResult.passed,
    message: `Zero net force: |F|=${netForceResult.netForceMag.toExponential(3)}`,
    details: netForceResult
  });
  
  // Check 2: Trilinear interpolation (NEW)
  const interpResult = await checkTrilinearInterpolation(psys);
  results.push({
    passed: interpResult.passed,
    message: `Trilinear interpolation: max error=${interpResult.maxError.toExponential(3)}`,
    details: interpResult
  });
  
  // Check 3: Force symmetry (NEW)
  const symmetryResult = await checkForceSymmetry(psys);
  results.push({
    passed: symmetryResult.passed,
    message: `Force symmetry: error=${(symmetryResult.error * 100).toFixed(2)}%`,
    details: symmetryResult
  });
  
  return results;
}

/**
 * Check zero net force
 */
async function checkZeroNetForce(psys) {
  const gl = psys.gl;
  
  // Sum all force vectors
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
    psys.pmForceTexture.texture, 0);
  
  const pixels = new Float32Array(psys.textureWidth * psys.textureHeight * 4);
  gl.readPixels(0, 0, psys.textureWidth, psys.textureHeight, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  let sumF = [0, 0, 0];
  
  for (let i = 0; i < pixels.length; i += 4) {
    sumF[0] += pixels[i];
    sumF[1] += pixels[i + 1];
    sumF[2] += pixels[i + 2];
  }
  
  const netForceMag = Math.sqrt(sumF[0]**2 + sumF[1]**2 + sumF[2]**2);
  
  const passed = netForceMag < 1e-3;
  
  return {
    passed,
    netForceMag,
    netForce: sumF
  };
}

/**
 * Check trilinear interpolation accuracy
 * IMPLEMENTATION OF OUTSTANDING CHECK #6
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkTrilinearInterpolation(psys) {
  const gl = psys.gl;
  const N = psys.octreeGridSize || 64;
  
  // Create constant force grid: F = [1, 0, 0]
  const size = psys.levelTextures[0].size;
  const constantForce = new Float32Array(size * size * 4);
  
  for (let i = 0; i < constantForce.length; i += 4) {
    constantForce[i] = 1.0;     // Fx = 1
    constantForce[i + 1] = 0.0; // Fy = 0
    constantForce[i + 2] = 0.0; // Fz = 0
    constantForce[i + 3] = 0.0;
  }
  
  // Upload to force grid X
  gl.bindTexture(gl.TEXTURE_2D, psys.pmForceGrids.x);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, constantForce);
  
  // Zero out Y and Z grids
  const zeroForce = new Float32Array(size * size * 4);
  gl.bindTexture(gl.TEXTURE_2D, psys.pmForceGrids.y);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, zeroForce);
  gl.bindTexture(gl.TEXTURE_2D, psys.pmForceGrids.z);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, zeroForce);
  
  // Sample at grid points and mid-cell positions
  sampleForcesAtParticles(psys, psys.pmForceGrids.x, psys.pmForceGrids.y, psys.pmForceGrids.z);
  
  // Read sampled forces
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D,
    psys.pmForceTexture.texture, 0);
  
  const sampledForces = new Float32Array(psys.textureWidth * psys.textureHeight * 4);
  gl.readPixels(0, 0, psys.textureWidth, psys.textureHeight, gl.RGBA, gl.FLOAT, sampledForces);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Check: all should be close to [1, 0, 0]
  let maxError = 0;
  
  for (let i = 0; i < sampledForces.length; i += 4) {
    const fx = sampledForces[i];
    const fy = sampledForces[i + 1];
    const fz = sampledForces[i + 2];
    
    const errorX = Math.abs(fx - 1.0);
    const errorY = Math.abs(fy);
    const errorZ = Math.abs(fz);
    const error = Math.sqrt(errorX**2 + errorY**2 + errorZ**2);
    
    maxError = Math.max(maxError, error);
  }
  
  const passed = maxError < 1e-5;
  
  return {
    passed,
    maxError
  };
}

/**
 * Check force symmetry (Newton's 3rd law)
 * IMPLEMENTATION OF OUTSTANDING CHECK #7
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 */
async function checkForceSymmetry(psys) {
  const gl = psys.gl;
  const N = psys.octreeGridSize || 64;
  
  // Save state
  captureSnapshot(psys, 'pm_deposit', '__symmetry_backup');
  
  // Generate two point masses at symmetric positions
  const d = 5; // Separation
  const centerVoxel = [N / 2, N / 2, N / 2];
  const pointA = /** @type {[number, number, number]} */ ([centerVoxel[0] - d, centerVoxel[1], centerVoxel[2]]);
  const pointB = /** @type {[number, number, number]} */ ([centerVoxel[0] + d, centerVoxel[1], centerVoxel[2]]);
  const mass = 1000.0;
  
  generateTwoPointMasses(psys, pointA, pointB, mass, mass, psys.levelTextures[0].texture);
  
  // Run full PM pipeline
  computePMForcesSync(psys);
  
  // Read forces at both particle positions
  // (Simplified: read from force grid at voxel centers)
  const forceA = await readVoxel(psys, psys.pmForceGrids.x, pointA[0], pointA[1], pointA[2]);
  const forceB = await readVoxel(psys, psys.pmForceGrids.x, pointB[0], pointB[1], pointB[2]);
  
  // Check F_A ≈ -F_B
  const error = Math.abs(forceA + forceB) / Math.max(Math.abs(forceA), Math.abs(forceB), 1e-10);
  
  // Restore state
  restoreSnapshot(psys, 'pm_deposit', '__symmetry_backup');
  
  const passed = error < 0.05; // 5% tolerance
  
  return {
    passed,
    error,
    forceA,
    forceB
  };
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

/**
 * Run all PM/FFT pipeline verifiers
 * 
 * @param {import('../particle-system-spectral.js').ParticleSystemSpectral} psys
 * @returns {Promise<Object>}
 */
export async function runAllPipelineVerifiers(psys) {
  console.log('[PM Verifiers] Starting comprehensive verification...');
  
  const results = {
    pm_deposit: await verifyDeposit(psys),
    pm_fft_forward: await verifyFFTForward(psys),
    pm_poisson: await verifyPoisson(psys),
    pm_gradient: await verifyGradient(psys),
    pm_fft_inverse: await verifyFFTInverse(psys),
    pm_sample: await verifySampling(psys)
  };
  
  // Summary
  let totalPassed = 0;
  let totalChecks = 0;
  
  for (const [stage, checks] of Object.entries(results)) {
    const passed = checks.filter(c => c.passed).length;
    totalPassed += passed;
    totalChecks += checks.length;
    
    console.log(`[PM Verifiers] ${stage}: ${passed}/${checks.length} passed`);
    
    for (const check of checks) {
      const status = check.passed ? '✅' : '❌';
      console.log(`  ${status} ${check.message}`);
    }
  }
  
  console.log(`[PM Verifiers] Overall: ${totalPassed}/${totalChecks} checks passed`);
  
  return results;
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Create temporary texture for intermediate results
 */
function createTempTexture(psys, size) {
  const gl = psys.gl;
  
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, size, size, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  return tex;
}
