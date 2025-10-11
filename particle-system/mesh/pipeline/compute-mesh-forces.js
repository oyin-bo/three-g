// @ts-check

/**
 * Placeholder mesh force computation.
 *
 * TODO: Implement Plan B force pipeline (deposit → FFT → Poisson split →
 * gradient → inverse FFT → near-field correction → sampling).
 *
 * @param {import('../../particle-system-mesh.js').ParticleSystemMesh} psys
 * @returns {void}
 */
export function computeMeshForces(psys) {
  const gl = psys.gl;
  // For now, clear the force texture to ensure integrator has defined values.
  if (psys.forceTexture) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, psys.forceTexture.framebuffer);
    gl.viewport(0, 0, psys.textureWidth, psys.textureHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
}
