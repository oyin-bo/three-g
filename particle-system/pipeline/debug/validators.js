// Validators for checking pipeline invariants and correctness
// Used in debug staging to verify stage outputs

/**
 * Assert mass conservation in level set
 * @param {ParticleSystem} ctx - Particle system context
 * @param {number} levelIndex - Level to check
 * @param {number} expectedMass - Expected total mass
 * @param {number} tolerance - Relative tolerance
 * @returns {object} Validation result
 */
export function assertMassConservation(ctx, levelIndex, expectedMass, tolerance = 0.01) {
  console.log(`[Validator] Checking mass conservation for L${levelIndex}`);
  
  const gl = ctx.gl;
  const level = ctx.levelTargets[levelIndex];
  const size = level.size;
  
  // Read A0 texture (mass in .w component)
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, level.a0, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const data = new Float32Array(size * size * 4);
  gl.readPixels(0, 0, size, size, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Sum all mass values
  let totalMass = 0;
  for (let i = 0; i < data.length; i += 4) {
    totalMass += data[i + 3]; // Mass in alpha channel
  }
  
  const error = Math.abs(totalMass - expectedMass);
  const relativeError = expectedMass > 0 ? error / expectedMass : error;
  const passed = relativeError <= tolerance;
  
  const result = {
    passed,
    level: levelIndex,
    expectedMass,
    actualMass: totalMass,
    error,
    relativeError,
    tolerance
  };
  
  if (passed) {
    console.log(`[Validator] ✓ Mass conservation passed: ${totalMass.toFixed(6)} (expected ${expectedMass.toFixed(6)})`);
  } else {
    console.error(`[Validator] ✗ Mass conservation failed: ${totalMass.toFixed(6)} vs ${expectedMass.toFixed(6)} (error: ${(relativeError * 100).toFixed(2)}%)`);
  }
  
  return result;
}

/**
 * Check for NaN or Inf values in texture
 * @param {ParticleSystem} ctx - Particle system context
 * @param {WebGLTexture} texture - Texture to check
 * @param {number} width - Texture width
 * @param {number} height - Texture height
 * @param {string} name - Texture name for logging
 * @returns {object} Validation result
 */
export function assertNoNaNs(ctx, texture, width, height, name = 'texture') {
  console.log(`[Validator] Checking for NaN/Inf in ${name}`);
  
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
  
  // Check for invalid values
  let nanCount = 0;
  let infCount = 0;
  
  for (let i = 0; i < data.length; i++) {
    if (isNaN(data[i])) nanCount++;
    if (!isFinite(data[i])) infCount++;
  }
  
  const passed = nanCount === 0 && infCount === 0;
  
  const result = {
    passed,
    name,
    nanCount,
    infCount,
    totalValues: data.length
  };
  
  if (passed) {
    console.log(`[Validator] ✓ No NaN/Inf found in ${name}`);
  } else {
    console.error(`[Validator] ✗ Invalid values in ${name}: ${nanCount} NaNs, ${infCount} Infs`);
  }
  
  return result;
}

/**
 * Validate momentum is reasonable (not exploding)
 * @param {ParticleSystem} ctx - Particle system context
 * @param {number} maxMomentumPerParticle - Maximum reasonable momentum magnitude
 * @returns {object} Validation result
 */
export function assertMomentumReasonable(ctx, maxMomentumPerParticle = 100.0) {
  console.log('[Validator] Checking momentum bounds');
  
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  
  // Read velocity texture
  const velTex = ctx.velocityTextures.getCurrentTexture();
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const velData = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, velData);
  
  // Read position texture for mass
  const posTex = ctx.positionTextures.getCurrentTexture();
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  
  const posData = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, posData);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Compute momentum magnitudes
  let maxMomentum = 0;
  let totalMomentum = [0, 0, 0];
  let particlesChecked = 0;
  
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const mass = posData[idx + 3];
    
    if (mass > 0) {
      const vx = velData[idx + 0];
      const vy = velData[idx + 1];
      const vz = velData[idx + 2];
      
      const px = mass * vx;
      const py = mass * vy;
      const pz = mass * vz;
      
      const pMag = Math.sqrt(px * px + py * py + pz * pz);
      
      if (pMag > maxMomentum) maxMomentum = pMag;
      
      totalMomentum[0] += px;
      totalMomentum[1] += py;
      totalMomentum[2] += pz;
      
      particlesChecked++;
    }
  }
  
  const passed = maxMomentum <= maxMomentumPerParticle;
  
  const result = {
    passed,
    maxMomentum,
    threshold: maxMomentumPerParticle,
    totalMomentum,
    particlesChecked
  };
  
  if (passed) {
    console.log(`[Validator] ✓ Momentum reasonable: max=${maxMomentum.toFixed(4)} (threshold=${maxMomentumPerParticle})`);
  } else {
    console.error(`[Validator] ✗ Momentum too large: max=${maxMomentum.toFixed(4)} exceeds threshold=${maxMomentumPerParticle}`);
  }
  
  return result;
}

/**
 * Compare two textures and compute RMSE
 * @param {ParticleSystem} ctx - Particle system context
 * @param {WebGLTexture} texture1 - First texture
 * @param {WebGLTexture} texture2 - Second texture (reference)
 * @param {number} width - Texture width
 * @param {number} height - Texture height
 * @param {string} name - Comparison name for logging
 * @returns {object} Comparison result
 */
export function compareTexturesRMSE(ctx, texture1, texture2, width, height, name = 'comparison') {
  console.log(`[Validator] Computing RMSE for ${name}`);
  
  const gl = ctx.gl;
  
  // Read first texture
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture1, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const data1 = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data1);
  
  // Read second texture
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture2, 0);
  
  const data2 = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data2);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Compute RMSE
  let sumSquaredError = 0;
  let count = 0;
  
  for (let i = 0; i < data1.length; i++) {
    const diff = data1[i] - data2[i];
    sumSquaredError += diff * diff;
    count++;
  }
  
  const rmse = Math.sqrt(sumSquaredError / count);
  
  const result = {
    name,
    rmse,
    count
  };
  
  console.log(`[Validator] RMSE for ${name}: ${rmse.toExponential(4)}`);
  
  return result;
}

/**
 * Compute total mass and center of mass from position texture
 * @param {ParticleSystem} ctx - Particle system context
 * @returns {object} Mass and COM
 */
export function computeMassAndCOM(ctx) {
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  
  // Read position texture
  const posTex = ctx.positionTextures.getCurrentTexture();
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const data = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  let totalMass = 0;
  let com = [0, 0, 0];
  
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const mass = data[idx + 3];
    
    if (mass > 0) {
      const x = data[idx + 0];
      const y = data[idx + 1];
      const z = data[idx + 2];
      
      totalMass += mass;
      com[0] += x * mass;
      com[1] += y * mass;
      com[2] += z * mass;
    }
  }
  
  if (totalMass > 0) {
    com[0] /= totalMass;
    com[1] /= totalMass;
    com[2] /= totalMass;
  }
  
  return { totalMass, com };
}
