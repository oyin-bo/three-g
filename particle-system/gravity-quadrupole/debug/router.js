// Debug router for stage-isolated execution (Plan C staging)
// Orchestrates per-stage harnesses, source mocks, and sinks

import { 
  runAggregationHarness,
  runReductionHarness,
  runTraversalHarness,
  runIntegratorHarness
} from './harnesses.js';

import { captureStageOutput, replayStageInput } from './record.js';

/**
 * Execute aggregation stage in isolation
 * @param {ParticleSystem} ctx - Particle system context
 */
export function runAggregationOnly(ctx) {
  console.log('[DebugRouter] Running aggregation-only mode');
  
  // Use actual particle positions or inject mock if debugFlags.mockParticles is set
  if (ctx.debugFlags.mockParticles) {
    console.log('[DebugRouter] Injecting mock particle data');
    // TODO: Inject synthetic particle positions
  }
  
  // Run aggregation harness
  runAggregationHarness(ctx);
  
  // Capture output if recording
  if (ctx.debugFlags.captureOutput) {
    captureStageOutput(ctx, 'aggregation', ctx.levelTargets[0]);
  }
  
  // Validate if requested
  if (ctx.debugFlags.validateMassConservation) {
    console.log('[DebugRouter] Validating mass conservation for L0');
    // TODO: Implement mass validation
  }
}

/**
 * Execute reduction stage in isolation
 * @param {ParticleSystem} ctx - Particle system context
 */
export function runReductionOnly(ctx) {
  console.log('[DebugRouter] Running reduction-only mode');
  
  // Inject mock L0 or replay recorded L0
  if (ctx.debugFlags.mockL0) {
    console.log('[DebugRouter] Injecting mock L0 data');
    // TODO: Inject synthetic L0
  } else if (ctx.debugFlags.replayL0) {
    console.log('[DebugRouter] Replaying recorded L0');
    replayStageInput(ctx, 'aggregation', ctx.levelTargets[0]);
  }
  
  // Run reduction harness
  runReductionHarness(ctx);
  
  // Capture output if recording
  if (ctx.debugFlags.captureOutput) {
    console.log('[DebugRouter] Capturing reduction output');
    // Capture all levels
    for (let i = 1; i < ctx.numLevels; i++) {
      captureStageOutput(ctx, `reduction_L${i}`, ctx.levelTargets[i]);
    }
  }
}

/**
 * Execute traversal stage in isolation
 * @param {ParticleSystem} ctx - Particle system context
 */
export function runTraversalOnly(ctx) {
  console.log('[DebugRouter] Running traversal-only mode');
  
  // Inject mock level set or replay recorded level set
  if (ctx.debugFlags.mockLevelSet) {
    console.log('[DebugRouter] Injecting mock level set');
    // TODO: Inject synthetic level data
  } else if (ctx.debugFlags.replayLevelSet) {
    console.log('[DebugRouter] Replaying recorded level set');
    for (let i = 0; i < ctx.numLevels; i++) {
      replayStageInput(ctx, `level_${i}`, ctx.levelTargets[i]);
    }
  }
  
  // Run traversal harness
  runTraversalHarness(ctx);
  
  // Capture force output if recording
  if (ctx.debugFlags.captureOutput) {
    captureStageOutput(ctx, 'traversal', ctx.forceTexture);
  }
  
  // Validate force field
  if (ctx.debugFlags.validateForces) {
    console.log('[DebugRouter] Validating force field');
    // TODO: Implement force validation
  }
}

/**
 * Execute integration stage in isolation
 * @param {ParticleSystem} ctx - Particle system context
 */
export function runIntegratorOnly(ctx) {
  console.log('[DebugRouter] Running integrator-only mode');
  
  // Inject mock force field or replay recorded forces
  if (ctx.debugFlags.mockForces) {
    console.log('[DebugRouter] Injecting mock force field');
    // TODO: Inject synthetic forces
  } else if (ctx.debugFlags.replayForces) {
    console.log('[DebugRouter] Replaying recorded forces');
    replayStageInput(ctx, 'traversal', ctx.forceTexture);
  }
  
  // Run integrator harness
  runIntegratorHarness(ctx);
  
  // Capture updated positions/velocities if recording
  if (ctx.debugFlags.captureOutput) {
    captureStageOutput(ctx, 'integration_pos', ctx.positionTextures);
    captureStageOutput(ctx, 'integration_vel', ctx.velocityTextures);
  }
}

/**
 * Execute full pipeline with recording
 * @param {ParticleSystem} ctx - Particle system context
 */
export function runFullPipeline_Record(ctx) {
  console.log('[DebugRouter] Running full pipeline with recording');
  
  // Run normal step but capture all stage outputs
  const originalCaptureFlag = ctx.debugFlags.captureOutput;
  ctx.debugFlags.captureOutput = true;
  
  ctx.step();
  
  ctx.debugFlags.captureOutput = originalCaptureFlag;
}

/**
 * Execute full pipeline with replay from recorded data
 * @param {ParticleSystem} ctx - Particle system context
 */
export function runFullPipeline_Replay(ctx) {
  console.log('[DebugRouter] Running full pipeline with replay');
  
  // Replay particle positions
  replayStageInput(ctx, 'particles_initial', ctx.positionTextures);
  
  // Run normal pipeline
  ctx.step();
  
  // Compare outputs against golden recording
  if (ctx.debugFlags.diffAgainstGolden) {
    console.log('[DebugRouter] Diffing against golden recording');
    // TODO: Implement diff comparison
  }
}
