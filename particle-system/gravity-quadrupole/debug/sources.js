// Source mocks for injecting synthetic data into pipeline stages
// Enables testing stages in isolation without upstream dependencies

/**
 * Inject constant-force particle data into position texture
 * All particles at rest, arranged in a grid
 * @param {ParticleSystem} ctx - Particle system context
 * @param {object} options - Configuration
 */
export function injectConstantForceParticles(ctx, options = {}) {
  const {
    spacing = 0.5,
    mass = 1.0,
    bounds = ctx.options.worldBounds
  } = options;
  
  console.log('[Sources] Injecting constant-force particle grid');
  
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  const particleCount = width * height;
  
  // Generate grid positions
  const data = new Float32Array(particleCount * 4);
  const min = bounds.min;
  const max = bounds.max;
  
  let idx = 0;
  for (let i = 0; i < particleCount; i++) {
    const x = min[0] + (i % width) * spacing;
    const y = min[1] + Math.floor(i / width) * spacing;
    const z = (min[2] + max[2]) / 2;
    
    data[idx++] = x;
    data[idx++] = y;
    data[idx++] = z;
    data[idx++] = mass;
  }
  
  // Upload to current position texture
  const posTex = ctx.positionTextures.getCurrentTexture();
  gl.bindTexture(gl.TEXTURE_2D, posTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  // Zero velocities
  const velData = new Float32Array(particleCount * 4);
  const velTex = ctx.velocityTextures.getCurrentTexture();
  gl.bindTexture(gl.TEXTURE_2D, velTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, velData);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/**
 * Inject two-body system (binary orbit)
 * @param {ParticleSystem} ctx - Particle system context
 * @param {object} options - Configuration
 */
export function injectTwoBodySystem(ctx, options = {}) {
  const {
    mass1 = 100.0,
    mass2 = 100.0,
    separation = 2.0,
    orbitalVelocity = 0.5
  } = options;
  
  console.log('[Sources] Injecting two-body system');
  
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  const particleCount = width * height;
  
  const posData = new Float32Array(particleCount * 4);
  const velData = new Float32Array(particleCount * 4);
  
  // Body 1 at (-separation/2, 0, 0)
  posData[0] = -separation / 2;
  posData[1] = 0;
  posData[2] = 0;
  posData[3] = mass1;
  
  velData[0] = 0;
  velData[1] = -orbitalVelocity;
  velData[2] = 0;
  velData[3] = 0;
  
  // Body 2 at (+separation/2, 0, 0)
  posData[4] = separation / 2;
  posData[5] = 0;
  posData[6] = 0;
  posData[7] = mass2;
  
  velData[4] = 0;
  velData[5] = orbitalVelocity;
  velData[6] = 0;
  velData[7] = 0;
  
  // Upload to textures
  const posTex = ctx.positionTextures.getCurrentTexture();
  gl.bindTexture(gl.TEXTURE_2D, posTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, posData);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  const velTex = ctx.velocityTextures.getCurrentTexture();
  gl.bindTexture(gl.TEXTURE_2D, velTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, velData);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/**
 * Inject Gaussian blob of particles
 * @param {ParticleSystem} ctx - Particle system context
 * @param {object} options - Configuration
 */
export function injectGaussianBlob(ctx, options = {}) {
  const {
    center = [0, 0, 0],
    sigma = 1.0,
    totalMass = 1000.0
  } = options;
  
  console.log('[Sources] Injecting Gaussian blob');
  
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  const particleCount = width * height;
  
  const data = new Float32Array(particleCount * 4);
  const massPerParticle = totalMass / particleCount;
  
  let idx = 0;
  for (let i = 0; i < particleCount; i++) {
    // Box-Muller transform for Gaussian distribution
    const u1 = Math.random();
    const u2 = Math.random();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const z1 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
    const u3 = Math.random();
    const z2 = Math.sqrt(-2 * Math.log(u3)) * Math.cos(2 * Math.PI * u3);
    
    data[idx++] = center[0] + z0 * sigma;
    data[idx++] = center[1] + z1 * sigma;
    data[idx++] = center[2] + z2 * sigma;
    data[idx++] = massPerParticle;
  }
  
  const posTex = ctx.positionTextures.getCurrentTexture();
  gl.bindTexture(gl.TEXTURE_2D, posTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  // Zero velocities
  const velData = new Float32Array(particleCount * 4);
  const velTex = ctx.velocityTextures.getCurrentTexture();
  gl.bindTexture(gl.TEXTURE_2D, velTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, velData);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/**
 * Inject synthetic L0 with uniform density
 * @param {ParticleSystem} ctx - Particle system context
 * @param {object} options - Configuration
 */
export function injectUniformL0(ctx, options = {}) {
  const {
    density = 1.0
  } = options;
  
  console.log('[Sources] Injecting uniform L0');
  
  const gl = ctx.gl;
  const level = ctx.levelTargets[0];
  const size = level.size;
  const voxelCount = size * size;
  
  // Create uniform data for all voxels
  const a0Data = new Float32Array(voxelCount * 4);
  const a1Data = new Float32Array(voxelCount * 4);
  const a2Data = new Float32Array(voxelCount * 4);
  
  for (let i = 0; i < voxelCount; i++) {
    const idx = i * 4;
    // A0: weighted position (set to voxel center) and mass
    a0Data[idx + 0] = 0; // Simplified: center at origin
    a0Data[idx + 1] = 0;
    a0Data[idx + 2] = 0;
    a0Data[idx + 3] = density;
    
    // A1: second moments (simplified)
    a1Data[idx + 0] = 0;
    a1Data[idx + 1] = 0;
    a1Data[idx + 2] = 0;
    a1Data[idx + 3] = 0;
    
    // A2: second moments (simplified)
    a2Data[idx + 0] = 0;
    a2Data[idx + 1] = 0;
    a2Data[idx + 2] = 0;
    a2Data[idx + 3] = 0;
  }
  
  // Upload to L0 textures
  gl.bindTexture(gl.TEXTURE_2D, level.a0);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.FLOAT, a0Data);
  
  gl.bindTexture(gl.TEXTURE_2D, level.a1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.FLOAT, a1Data);
  
  gl.bindTexture(gl.TEXTURE_2D, level.a2);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, size, size, gl.RGBA, gl.FLOAT, a2Data);
  
  gl.bindTexture(gl.TEXTURE_2D, null);
}

/**
 * Inject constant force field
 * @param {ParticleSystem} ctx - Particle system context
 * @param {object} options - Configuration
 */
export function injectConstantForceField(ctx, options = {}) {
  const {
    force = [0, -0.001, 0] // Downward gravity-like
  } = options;
  
  console.log('[Sources] Injecting constant force field:', force);
  
  const gl = ctx.gl;
  const width = ctx.textureWidth;
  const height = ctx.textureHeight;
  const pixelCount = width * height;
  
  const data = new Float32Array(pixelCount * 4);
  
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * 4;
    data[idx + 0] = force[0];
    data[idx + 1] = force[1];
    data[idx + 2] = force[2];
    data[idx + 3] = 0; // Reserved
  }
  
  // Upload to force texture
  gl.bindTexture(gl.TEXTURE_2D, ctx.forceTexture.texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RGBA, gl.FLOAT, data);
  gl.bindTexture(gl.TEXTURE_2D, null);
}
