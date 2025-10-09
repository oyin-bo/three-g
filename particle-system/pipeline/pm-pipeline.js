// @ts-check

/**
 * PM/FFT Pipeline Integration
 * 
 * Integrates the PM/FFT gravitational force computation into the main simulation loop
 */

/**
 * Run complete PM/FFT pipeline to compute gravitational forces
 * 
 * This replaces the octree + traversal approach with the PM/FFT method:
 * 1. Deposit particles to grid (NGP)
 * 2. Forward FFT (density → spectrum)
 * 3. Solve Poisson equation (spectrum → potential spectrum)
 * 4. Compute gradient (potential → force spectra)
 * 5. Inverse FFT (force spectra → real-space force grids)
 * 6. Sample forces at particle positions
 * 
 * Result is stored in ctx.pmForceTexture (same format as ctx.forceTexture)
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 */
export async function computePMForces(ctx) {
  const gl = ctx.gl;
  
  // Import pipeline modules (dynamic to avoid circular dependencies)
  const { depositParticlesToGrid } = await import('./pm-deposit.js');
  const { forwardFFT, inverseFFTToReal } = await import('./pm-fft.js');
  const { solvePoissonFFT } = await import('./pm-poisson.js');
  const { computeGradient } = await import('./pm-gradient.js');
  const { initForceGridTextures, sampleForcesAtParticles } = await import('./pm-force-sample.js');
  
  // Initialize force grid textures if needed
  initForceGridTextures(ctx);
  
  if (ctx.profiler) ctx.profiler.begin('pm_deposit');
  // Step 1: Deposit particles to grid
  depositParticlesToGrid(ctx);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_fft_forward');
  // Step 2: Forward FFT (density → spectrum)
  forwardFFT(ctx);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_poisson');
  // Step 3: Solve Poisson equation (density spectrum → potential spectrum)
  const G = ctx.options.gravityStrength || 0.0003;
  const fourPiG = 4 * Math.PI * G;
  const bounds = ctx.options.worldBounds || { min: [-50, -50, -50], max: [50, 50, 50] };
  const boxSize = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
  solvePoissonFFT(ctx, fourPiG, boxSize);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_gradient');
  // Step 4: Compute gradient (potential spectrum → force spectra)
  computeGradient(ctx, boxSize);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_fft_inverse');
  // Step 5: Inverse FFT (force spectra → real-space force grids) - 3 axes
  inverseFFTToReal(ctx, ctx.pmForceSpectrum.x.texture, ctx.pmForceGrids.x);
  inverseFFTToReal(ctx, ctx.pmForceSpectrum.y.texture, ctx.pmForceGrids.y);
  inverseFFTToReal(ctx, ctx.pmForceSpectrum.z.texture, ctx.pmForceGrids.z);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_force_sample');
  // Step 6: Sample forces at particle positions
  sampleForcesAtParticles(ctx, ctx.pmForceGrids.x, ctx.pmForceGrids.y, ctx.pmForceGrids.z);
  if (ctx.profiler) ctx.profiler.end();
  
  console.log('[PM Pipeline] Complete PM/FFT pipeline executed');
}

/**
 * Synchronous version that runs PM forces (for use in step() loop)
 * 
 * Note: This uses a cached promise to avoid creating new promises each frame
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 */
export function computePMForcesSync(ctx) {
  // Check if modules are already loaded
  if (!ctx._pmModulesLoaded) {
    console.warn('[PM Pipeline] Modules not preloaded, skipping PM forces this frame');
    return;
  }
  
  const gl = ctx.gl;
  
  // Use cached module references
  const { depositParticlesToGrid } = ctx._pmModules.deposit;
  const { forwardFFT, inverseFFTToReal } = ctx._pmModules.fft;
  const { solvePoissonFFT } = ctx._pmModules.poisson;
  const { computeGradient } = ctx._pmModules.gradient;
  const { initForceGridTextures, sampleForcesAtParticles } = ctx._pmModules.forceSample;
  
  // Initialize force grid textures if needed
  initForceGridTextures(ctx);
  
  if (ctx.profiler) ctx.profiler.begin('pm_deposit');
  depositParticlesToGrid(ctx);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_fft_forward');
  forwardFFT(ctx);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_poisson');
  const G = ctx.options.gravityStrength || 0.0003;
  const fourPiG = 4 * Math.PI * G;
  const bounds = ctx.options.worldBounds || { min: [-50, -50, -50], max: [50, 50, 50] };
  const boxSize = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );
  solvePoissonFFT(ctx, fourPiG, boxSize);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_gradient');
  computeGradient(ctx, boxSize);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_fft_inverse');
  inverseFFTToReal(ctx, ctx.pmForceSpectrum.x.texture, ctx.pmForceGrids.x);
  inverseFFTToReal(ctx, ctx.pmForceSpectrum.y.texture, ctx.pmForceGrids.y);
  inverseFFTToReal(ctx, ctx.pmForceSpectrum.z.texture, ctx.pmForceGrids.z);
  if (ctx.profiler) ctx.profiler.end();
  
  if (ctx.profiler) ctx.profiler.begin('pm_force_sample');
  sampleForcesAtParticles(ctx, ctx.pmForceGrids.x, ctx.pmForceGrids.y, ctx.pmForceGrids.z);
  if (ctx.profiler) ctx.profiler.end();
}

/**
 * Preload PM pipeline modules for synchronous use
 * Call this once during initialization
 * 
 * @param {import('../particle-system.js').ParticleSystem} ctx
 */
export async function preloadPMModules(ctx) {
  if (ctx._pmModulesLoaded) return;
  
  console.log('[PM Pipeline] Preloading modules...');
  
  ctx._pmModules = {
    deposit: await import('./pm-deposit.js'),
    fft: await import('./pm-fft.js'),
    poisson: await import('./pm-poisson.js'),
    gradient: await import('./pm-gradient.js'),
    forceSample: await import('./pm-force-sample.js')
  };
  
  ctx._pmModulesLoaded = true;
  
  console.log('[PM Pipeline] Modules preloaded ✅');
}
