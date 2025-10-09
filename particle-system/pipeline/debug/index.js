// Debug staging module exports (Plan C)
// Unified entry point for all debug utilities

export {
  runAggregationOnly,
  runReductionOnly,
  runTraversalOnly,
  runIntegratorOnly,
  runFullPipeline_Record,
  runFullPipeline_Replay
} from './router.js';

export {
  runAggregationHarness,
  runReductionHarness,
  runTraversalHarness,
  runIntegratorHarness
} from './harnesses.js';

export {
  captureStageOutput,
  replayStageInput,
  clearRecordings,
  exportRecordings,
  importRecordings
} from './record.js';

export {
  injectConstantForceParticles,
  injectTwoBodySystem,
  injectGaussianBlob,
  injectUniformL0,
  injectConstantForceField
} from './sources.js';

export {
  assertMassConservation,
  assertNoNaNs,
  assertMomentumReasonable,
  compareTexturesRMSE,
  computeMassAndCOM
} from './validators.js';

export {
  blitLevelAttachment,
  overlayCOMMarkers,
  showForceField,
  createHeatmap,
  logTextureStats
} from './visualizers.js';
