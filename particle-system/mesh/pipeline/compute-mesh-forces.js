// @ts-check

import { meshDepositMass } from './deposit.js';
import { meshForwardFFT, meshInverseFFTToReal, initMeshForceGrids } from './fft.js';
import { meshSolvePoisson } from './poisson.js';
import { meshComputeGradient } from './gradient.js';
import { sampleForcesAtParticles } from '../../pipeline/pm-force-sample.js';

/**
 * Mesh force computation pipeline (Plan B, without near-field correction yet).
 * Sequence:
 * 1. Deposit particle mass onto mesh grid
 * 2. Forward FFT → density spectrum
 * 3. Solve Poisson equation in k-space
 * 4. Compute gradients → force spectra (Fx, Fy, Fz)
 * 5. Inverse FFT for each axis → real-space force grids
 * 6. Sample forces back to particle texture
 *
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @returns {void}
 */
export function computeMeshForces(psys) {
  const gl = psys.gl;
  if (!psys.pmGrid || !psys.pmGridFramebuffer) {
    console.error('[Mesh Pipeline] PM grid not initialized');
    return;
  }

  const bounds = psys.options.worldBounds || {
    min: [-2, -2, -2],
    max: [2, 2, 2]
  };
  const G = psys.options.gravityStrength || 0.0003;
  const fourPiG = 4 * Math.PI * G;
  const boxSize = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2]
  );

  initMeshForceGrids(psys);

  if (psys.profiler) psys.profiler.begin('mesh_deposit');
  meshDepositMass(psys);
  if (psys.profiler) psys.profiler.end();

  if (psys.profiler) psys.profiler.begin('mesh_fft_forward');
  meshForwardFFT(psys);
  if (psys.profiler) psys.profiler.end();

  if (psys.profiler) psys.profiler.begin('mesh_poisson');
  meshSolvePoisson(psys, { fourPiG, boxSize });
  if (psys.profiler) psys.profiler.end();

  if (psys.profiler) psys.profiler.begin('mesh_gradient');
  meshComputeGradient(psys, { boxSize });
  if (psys.profiler) psys.profiler.end();

  const forceSpectrum = psys.meshForceSpectrum;
  const forceGrids = psys.meshForceGrids;
  if (!forceSpectrum || !forceGrids) {
    console.error('[Mesh Pipeline] Force resources missing after gradient stage');
    return;
  }

  if (psys.profiler) psys.profiler.begin('mesh_fft_inverse');
  meshInverseFFTToReal(psys, forceSpectrum.x.texture, forceGrids.x);
  meshInverseFFTToReal(psys, forceSpectrum.y.texture, forceGrids.y);
  meshInverseFFTToReal(psys, forceSpectrum.z.texture, forceGrids.z);
  if (psys.profiler) psys.profiler.end();

  if (!psys.pmForceTexture || !psys.pmForceFBO) {
    console.error('[Mesh Pipeline] pmForceTexture not initialized');
    return;
  }

  if (psys.profiler) psys.profiler.begin('mesh_force_sample');
  sampleForcesAtParticles(psys, forceGrids.x, forceGrids.y, forceGrids.z);
  if (psys.profiler) psys.profiler.end();
}
