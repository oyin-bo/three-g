// @ts-check

// Per-stage harnesses for isolated execution
// Each harness runs a single pipeline stage with explicit setup/teardown

import { aggregateParticlesIntoL0 } from '../aggregator.js';
import { runReductionPass } from '../pyramid.js';
import { calculateForces } from '../traversal.js';
import { integratePhysics } from '../../utils/integrator.js';

/**
 * Run aggregation stage in isolation
 * @param {import('../particle-system-quadrupole.js').ParticleSystemQuadrupoleMonolithic} ctx - Particle system context
 */
export function runAggregationHarness(ctx) {
  const gl = ctx.gl;
  
  console.log('[Harness] Aggregation stage starting');
  
  // Clear L0 only
  gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.levelFramebuffers[0]);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
  gl.viewport(0, 0, ctx.levelTargets[0].size, ctx.levelTargets[0].size);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  // Profile if enabled
  if (ctx.profiler) ctx.profiler.begin('aggregation_harness');
  
  // Run aggregation
  aggregateParticlesIntoL0(ctx);
  
  if (ctx.profiler) ctx.profiler.end();
  
  console.log('[Harness] Aggregation stage complete');
  
  // Visualize if requested
  if (ctx.debugFlags.visualizeLevel === 0) {
    console.log('[Harness] Visualizing L0 output');
    // TODO: Implement visualization
  }
}

/**
 * Run reduction stage in isolation (all levels)
 * @param {import('../particle-system-quadrupole.js').ParticleSystemQuadrupoleMonolithic} ctx - Particle system context
 */
export function runReductionHarness(ctx) {
  const gl = ctx.gl;
  
  console.log('[Harness] Reduction stage starting');
  
  // Clear all levels except L0
  for (let i = 1; i < ctx.numLevels; i++) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.levelFramebuffers[i]);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.viewport(0, 0, ctx.levelTargets[i].size, ctx.levelTargets[i].size);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  
  // Profile if enabled
  if (ctx.profiler) ctx.profiler.begin('reduction_harness');
  
  // Run reduction passes up the pyramid
  for (let i = 0; i < ctx.numLevels - 1; i++) {
    const sourceLevel = i;
    const targetLevel = i + 1;
    
    if (ctx.profiler) ctx.profiler.begin(`reduction_L${sourceLevel}_to_L${targetLevel}`);
    runReductionPass(ctx, sourceLevel, targetLevel);
    if (ctx.profiler) ctx.profiler.end();
    
    // Break early if requested
    if (ctx.debugFlags.breakAfterStage === `reduction_L${targetLevel}`) {
      console.log(`[Harness] Breaking after reduction to L${targetLevel}`);
      break;
    }
  }
  
  if (ctx.profiler) ctx.profiler.end();
  
  console.log('[Harness] Reduction stage complete');
  
  // Visualize a specific level if requested
  if (ctx.debugFlags.visualizeLevel !== undefined) {
    const level = ctx.debugFlags.visualizeLevel;
    console.log(`[Harness] Visualizing L${level} output`);
    // TODO: Implement visualization
  }
}

/**
 * Run traversal stage in isolation
 * @param {import('../particle-system-quadrupole.js').ParticleSystemQuadrupoleMonolithic} ctx - Particle system context
 */
export function runTraversalHarness(ctx) {
  const gl = ctx.gl;
  
  console.log('[Harness] Traversal stage starting');
  
  // Clear force texture
  gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.forceTexture.framebuffer);
  gl.viewport(0, 0, ctx.textureWidth, ctx.textureHeight);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  // Profile if enabled
  if (ctx.profiler) ctx.profiler.begin('traversal_harness');
  
  // Run traversal
  calculateForces(ctx);
  
  if (ctx.profiler) ctx.profiler.end();
  
  console.log('[Harness] Traversal stage complete');
  
  // Validate forces if requested
  if (ctx.debugFlags.assertNoNaNs) {
    console.log('[Harness] Checking for NaN values in force field');
    // TODO: Implement NaN check
  }
  
  // Visualize force field if requested
  if (ctx.debugFlags.visualizeForces) {
    console.log('[Harness] Visualizing force field');
    // TODO: Implement force visualization
  }
}

/**
 * Run integrator stage in isolation
 * @param {import('../particle-system-quadrupole.js').ParticleSystemQuadrupoleMonolithic} ctx - Particle system context
 */
export function runIntegratorHarness(ctx) {
  console.log('[Harness] Integration stage starting');
  
  // Freeze positions or velocities if requested
  const originalPositions = ctx.debugFlags.freezePositions ? 
    captureTexture(ctx, ctx.positionTextures.getCurrentTexture()) : null;
  const originalVelocities = ctx.debugFlags.freezeVelocities ?
    captureTexture(ctx, ctx.velocityTextures.getCurrentTexture()) : null;
  
  // Profile if enabled
  if (ctx.profiler) ctx.profiler.begin('integration_harness');
  
  // Run integration
  if (ctx.debugFlags.useKDK) {
    console.log('[Harness] Using KDK integrator');
    // TODO: Implement KDK integration
    integratePhysics(ctx);
  } else {
    integratePhysics(ctx);
  }
  
  if (ctx.profiler) ctx.profiler.end();
  
  // Restore frozen state if requested
  if (originalPositions) {
    console.log('[Harness] Restoring frozen positions');
    restoreTexture(ctx, ctx.positionTextures.getCurrentTexture(), originalPositions);
  }
  if (originalVelocities) {
    console.log('[Harness] Restoring frozen velocities');
    restoreTexture(ctx, ctx.velocityTextures.getCurrentTexture(), originalVelocities);
  }
  
  console.log('[Harness] Integration stage complete');
  
  // Validate momentum conservation if requested
  if (ctx.debugFlags.assertMomentumReasonable) {
    console.log('[Harness] Validating momentum conservation');
    // TODO: Implement momentum validation
  }
}

/**
 * Capture texture to CPU (stub)
 * @param {import('../particle-system-quadrupole.js').ParticleSystemQuadrupoleMonolithic} ctx - Context
 * @param {WebGLTexture} texture - Texture to capture
 * @returns {Float32Array} Captured data
 */
function captureTexture(ctx, texture) {
  // TODO: Implement via readPixels
  console.warn('[Harness] captureTexture not yet implemented');
  return null;
}

/**
 * Restore texture from CPU data (stub)
 * @param {import('../particle-system-quadrupole.js').ParticleSystemQuadrupoleMonolithic} ctx - Context
 * @param {WebGLTexture} texture - Target texture
 * @param {Float32Array} data - Data to restore
 */
function restoreTexture(ctx, texture, data) {
  // TODO: Implement via texSubImage2D
  console.warn('[Harness] restoreTexture not yet implemented');
}
