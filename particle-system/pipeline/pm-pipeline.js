// @ts-check

/**
 * PM/FFT Pipeline Integration
 * 
 * Integrates the PM/FFT gravitational force computation into the main simulation loop
 */

import { depositParticlesToGrid } from './pm-deposit.js';
import { forwardFFT, inverseFFTToReal } from './pm-fft.js';
import { solvePoissonFFT } from './pm-poisson.js';
import { computeGradient } from './pm-gradient.js';
import { initForceGridTextures, sampleForcesAtParticles } from './pm-force-sample.js';

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
export function computePMForcesSync(ctx) {
  const gl = ctx.gl;
  
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
}
