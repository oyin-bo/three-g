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
 * @param {WebGLTexture|string} textureOrName - Texture to check or name (e.g., 'L0', 'force', 'positions')
 * @param {number} width - Texture width (optional if using name)
 * @param {number} height - Texture height (optional if using name)
 * @param {string} name - Texture name for logging (optional)
 * @returns {object} Validation result
 */
export function assertNoNaNs(ctx, textureOrName, width, height, name) {
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
  
  console.log(`[Validator] Checking for NaN/Inf in ${texName}`);
  
  console.log(`[Validator] Checking for NaN/Inf in ${texName}`);
  
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
    name: texName,
    nanCount,
    infCount,
    totalValues: data.length,
    message: passed ? `No NaN/Inf found in ${texName}` : `Invalid values in ${texName}: ${nanCount} NaNs, ${infCount} Infs`
  };
  
  if (passed) {
    console.log(`[Validator] ✓ ${result.message}`);
  } else {
    console.error(`[Validator] ✗ ${result.message}`);
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

/**
 * Compute mean velocity across all particles
 * @param {ParticleSystem} ctx - Particle system context
 * @returns {Array} Mean velocity [vx, vy, vz]
 */
export function computeMeanVelocity(ctx) {
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
  
  let totalMass = 0;
  let totalMomentum = [0, 0, 0];
  
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const mass = posData[idx + 3];
    
    if (mass > 0) {
      totalMass += mass;
      totalMomentum[0] += mass * velData[idx + 0];
      totalMomentum[1] += mass * velData[idx + 1];
      totalMomentum[2] += mass * velData[idx + 2];
    }
  }
  
  const meanVel = [0, 0, 0];
  if (totalMass > 0) {
    meanVel[0] = totalMomentum[0] / totalMass;
    meanVel[1] = totalMomentum[1] / totalMass;
    meanVel[2] = totalMomentum[2] / totalMass;
  }
  
  return meanVel;
}

/**
 * Apply COM velocity clamp (subtract mean velocity from all particles)
 * Pins the center-of-mass frame to prevent spurious drift
 * @param {ParticleSystem} ctx - Particle system context
 * @returns {object} Result with mean velocity that was removed
 */
export function applyCOMClamp(ctx) {
  console.log('[Validator] Applying COM velocity clamp');
  
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  
  // Compute mean velocity
  const meanVel = computeMeanVelocity(ctx);
  const meanSpeed = Math.sqrt(meanVel[0]**2 + meanVel[1]**2 + meanVel[2]**2);
  
  console.log(`[Validator] Mean velocity: [${meanVel.map(v => v.toFixed(6)).join(', ')}], magnitude: ${meanSpeed.toFixed(6)}`);
  
  if (meanSpeed < 1e-10) {
    console.log('[Validator] Mean velocity negligible, skipping clamp');
    return { meanVel, applied: false };
  }
  
  // Read current velocity texture
  const velTex = ctx.velocityTextures.getCurrentTexture();
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const velData = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, velData);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Subtract mean velocity
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    velData[idx + 0] -= meanVel[0];
    velData[idx + 1] -= meanVel[1];
    velData[idx + 2] -= meanVel[2];
  }
  
  // Write back to target velocity texture
  const targetFBO = ctx.velocityTextures.getTargetFramebuffer();
  const targetTex = ctx.velocityTextures.getTargetTexture();
  
  gl.bindTexture(gl.TEXTURE_2D, targetTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, velData);
  
  // Swap buffers
  ctx.velocityTextures.swap();
  
  console.log(`[Validator] ✓ COM clamp applied, removed drift of ${meanSpeed.toFixed(6)}`);
  
  return { meanVel, applied: true, driftRemoved: meanSpeed };
}

/**
 * Forward-reverse time-reversibility test for symplectic integrator
 * Runs KDK forward N steps, flips velocities, runs backward N steps
 * Measures position error to verify KDK is properly symplectic
 * 
 * @param {ParticleSystem} ctx - Particle system context
 * @param {number} steps - Number of steps to run each direction
 * @returns {object} Test result with RMSE error
 */
export function forwardReverseTest(ctx, steps = 100) {
  console.log(`[Validator] Starting forward-reverse test (${steps} steps each direction)`);
  
  if (!ctx.options.planC || !ctx.debugFlags.useKDK) {
    console.warn('[Validator] Forward-reverse test requires Plan C with KDK enabled');
    return { error: 'KDK not enabled', passed: false };
  }
  
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  
  // Save initial positions
  const posTex = ctx.positionTextures.getCurrentTexture();
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const initialPos = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, initialPos);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  console.log('[Validator] Running forward integration...');
  
  // Run forward
  for (let i = 0; i < steps; i++) {
    ctx.step();
  }
  
  console.log('[Validator] Flipping velocities...');
  
  // Flip velocities
  const velTex = ctx.velocityTextures.getCurrentTexture();
  const velFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, velFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, velTex, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const velData = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, velData);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(velFBO);
  
  // Negate velocities
  for (let i = 0; i < velData.length; i += 4) {
    velData[i + 0] = -velData[i + 0];
    velData[i + 1] = -velData[i + 1];
    velData[i + 2] = -velData[i + 2];
  }
  
  // Write back
  const targetTex = ctx.velocityTextures.getTargetTexture();
  gl.bindTexture(gl.TEXTURE_2D, targetTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, velData);
  ctx.velocityTextures.swap();
  
  console.log('[Validator] Running reverse integration...');
  
  // Run backward
  for (let i = 0; i < steps; i++) {
    ctx.step();
  }
  
  // Read final positions
  const finalPosTex = ctx.positionTextures.getCurrentTexture();
  const finalFBO = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, finalFBO);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, finalPosTex, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  
  const finalPos = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, finalPos);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(finalFBO);
  
  // Compute RMSE
  let sumSquaredError = 0;
  let particleCount = 0;
  
  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const mass = initialPos[idx + 3];
    
    if (mass > 0) {
      const dx = finalPos[idx + 0] - initialPos[idx + 0];
      const dy = finalPos[idx + 1] - initialPos[idx + 1];
      const dz = finalPos[idx + 2] - initialPos[idx + 2];
      
      sumSquaredError += dx * dx + dy * dy + dz * dz;
      particleCount++;
    }
  }
  
  const rmse = Math.sqrt(sumSquaredError / particleCount);
  const passed = rmse < 1e-6; // Very tight tolerance for symplectic integrator
  
  const result = {
    passed,
    rmse,
    steps,
    particleCount,
    threshold: 1e-6
  };
  
  if (passed) {
    console.log(`[Validator] ✓ Forward-reverse test PASSED: RMSE=${rmse.toExponential(4)} (excellent time-reversibility)`);
  } else {
    console.warn(`[Validator] ✗ Forward-reverse test FAILED: RMSE=${rmse.toExponential(4)} exceeds threshold=${result.threshold.toExponential(4)}`);
  }
  
  return result;
}
