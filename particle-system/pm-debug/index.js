// @ts-check

/**
 * PM Debug System - Stage-isolated debugging for Plan A (PM/FFT)
 * 
 * Provides:
 * - Stage isolation: run individual pipeline stages with synthetic inputs
 * - Record/replay: capture and replay stage inputs/outputs
 * - Metrics: GPU-side invariant checks (mass conservation, DC zero, etc.)
 * - Overlays: visual debugging of grids and spectra
 */

import './types.js';

/**
 * Initialize PM debug system
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').DebugPMConfig} cfg 
 */
export function pmDebugInit(psys, cfg) {
  if (!psys.options.planA) {
    console.warn('pmDebugInit: Plan A not enabled, debug system will be inactive');
    return;
  }

  // Create debug state if not exists
  if (!psys._pmDebugState) {
    psys._pmDebugState = {
      config: cfg,
      snapshots: new Map(),
      programs: {},
      metricsResults: new Map()
    };
  } else {
    // Update config
    psys._pmDebugState.config = cfg;
  }

  // Create shader programs for debug operations
  if (cfg.enabled) {
    initDebugPrograms(psys);
  }
}

/**
 * Dispose PM debug system
 * @param {import('../particle-system.js').ParticleSystem} psys 
 */
export function pmDebugDispose(psys) {
  if (!psys._pmDebugState) return;

  const gl = psys.gl;
  const state = psys._pmDebugState;

  // Delete all snapshot textures
  for (const snapshot of state.snapshots.values()) {
    disposeSnapshot(gl, snapshot);
  }
  state.snapshots.clear();

  // Delete debug programs
  if (state.programs.synthetic) gl.deleteProgram(state.programs.synthetic);
  if (state.programs.overlay) gl.deleteProgram(state.programs.overlay);
  if (state.programs.metrics) gl.deleteProgram(state.programs.metrics);

  psys._pmDebugState = null;
}

/**
 * Run a single stage in isolation
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {import('./types.js').PMSourceSpec=} source 
 * @param {import('./types.js').PMSinkSpec=} sink 
 */
export function pmDebugRunSingle(psys, stage, source, sink) {
  if (!psys._pmDebugState?.config.enabled) return;

  psys.beginProfile?.(`pm_debug_single_${stage}`);

  // Provide source (synthetic, snapshot, or live)
  provideSource(psys, stage, source || { kind: 'live' });

  // Run the stage
  runStage(psys, stage);

  // Apply sink (overlay, metrics, snapshot, or noop)
  applySink(psys, stage, sink || { kind: 'noop' });

  psys.endProfile?.();
}

/**
 * Hook called before a stage in normal pipeline
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @returns {import('./types.js').PMSourceSpec | null}
 */
export function pmDebugBeforeStage(psys, stage) {
  if (!psys._pmDebugState?.config.enabled) return null;

  const cfg = psys._pmDebugState.config;

  // Check if we should replay a snapshot before this stage
  if (cfg.replayBeforeStage === stage) {
    // Return snapshot source
    return { kind: 'snapshot', key: `replay_${stage}` };
  }

  return null;
}

/**
 * Hook called after a stage in normal pipeline
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @returns {import('./types.js').PMSinkSpec | null}
 */
export function pmDebugAfterStage(psys, stage) {
  if (!psys._pmDebugState?.config.enabled) return null;

  const cfg = psys._pmDebugState.config;

  // Check if we should record a snapshot after this stage
  if (cfg.recordAfterStage === stage) {
    return { kind: 'snapshot', key: `record_${stage}` };
  }

  // Check if we should run invariants
  if (cfg.assertInvariants) {
    return { kind: 'metrics', checks: getDefaultChecksForStage(stage) };
  }

  return null;
}

/**
 * Provide source for a stage
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {import('./types.js').PMSourceSpec} source 
 */
function provideSource(psys, stage, source) {
  if (source.kind === 'live') {
    // Normal path - no override
    return;
  }

  if (source.kind === 'synthetic') {
    provideSyntheticSource(psys, stage, source.synth);
  } else if (source.kind === 'snapshot') {
    provideSnapshotSource(psys, stage, source.key);
  }
}

/**
 * Apply sink after a stage
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {import('./types.js').PMSinkSpec} sink 
 */
function applySink(psys, stage, sink) {
  if (sink.kind === 'noop') return;

  if (sink.kind === 'snapshot') {
    captureSnapshot(psys, stage, sink.key);
  } else if (sink.kind === 'overlay') {
    renderOverlay(psys, stage, sink.view);
  } else if (sink.kind === 'metrics') {
    runMetrics(psys, stage, sink.checks);
  } else if (sink.kind === 'readback') {
    performReadback(psys, stage, sink.buffers);
  }
}

/**
 * Run a specific stage (placeholder - will be implemented per stage)
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 */
function runStage(psys, stage) {
  // This will call the appropriate pipeline function for the stage
  // For now, we'll add placeholders that integrate with existing code
  console.log(`[PM Debug] Running stage: ${stage}`);
}

/**
 * Initialize debug shader programs
 * @param {import('../particle-system.js').ParticleSystem} psys 
 */
function initDebugPrograms(psys) {
  // Placeholder - will create shaders for synthetic sources, overlays, and metrics
  console.log('[PM Debug] Initializing debug shader programs');
}

/**
 * Provide synthetic source
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {import('./types.js').PMSyntheticSpec} synth 
 */
function provideSyntheticSource(psys, stage, synth) {
  const { generateGridImpulse, generateTwoPointMasses, generatePlaneWaveDensity, generateSpectrumDelta } = require('./synthetic.js');
  
  console.log(`[PM Debug] Providing synthetic source for ${stage}:`, synth.type);
  
  // Get target texture based on stage
  let targetTexture = null;
  if (stage === 'pm_deposit' && psys.levelTextures?.[0]) {
    targetTexture = psys.levelTextures[0].texture;
  }
  
  if (!targetTexture) {
    console.warn(`[PM Debug] No target texture for synthetic source at stage ${stage}`);
    return;
  }
  
  // Generate synthetic pattern
  switch (synth.type) {
    case 'gridImpulse':
      generateGridImpulse(psys, synth.centerVoxel, synth.mass, targetTexture);
      break;
    case 'twoPointMasses':
      generateTwoPointMasses(psys, synth.a, synth.b, synth.ma, synth.mb, targetTexture);
      break;
    case 'planeWaveDensity':
      generatePlaneWaveDensity(psys, synth.k, synth.amplitude, targetTexture);
      break;
    case 'spectrumDelta':
      generateSpectrumDelta(psys, synth.k, synth.amplitude, targetTexture);
      break;
    default:
      console.warn(`[PM Debug] Unknown synthetic type: ${synth.type}`);
  }
}

/**
 * Provide snapshot source
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {string} key 
 */
function provideSnapshotSource(psys, stage, key) {
  const { restoreSnapshot } = require('./snapshot.js');
  
  const snapshot = psys._pmDebugState?.snapshots.get(key);
  if (!snapshot) {
    console.warn(`[PM Debug] Snapshot not found: ${key}`);
    return;
  }
  
  console.log(`[PM Debug] Providing snapshot source for ${stage}: ${key}`);
  restoreSnapshot(psys, stage, key);
}

/**
 * Capture snapshot
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {string} key 
 */
function captureSnapshot(psys, stage, key) {
  const { captureSnapshot: capSnap } = require('./snapshot.js');
  capSnap(psys, stage, key);
}

/**
 * Render overlay
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {import('./types.js').PMOverlaySpec} view 
 */
function renderOverlay(psys, stage, view) {
  const { renderGridSlice, renderSpectrumMagnitude, renderVectorGlyphs } = require('./overlay.js');
  
  console.log(`[PM Debug] Rendering overlay for ${stage}:`, view.type);
  
  // Get appropriate texture based on stage
  let texture = null;
  if (stage === 'pm_deposit' && psys.levelTextures?.[0]) {
    texture = psys.levelTextures[0].texture;
  }
  
  if (!texture) {
    console.warn(`[PM Debug] No texture available for overlay at stage ${stage}`);
    return;
  }
  
  // Render visualization
  switch (view.type) {
    case 'gridSlice':
      renderGridSlice(psys, texture, view.axis, view.index, false, 3); // alpha = mass
      break;
    case 'spectrumMagnitude':
      renderSpectrumMagnitude(psys, texture, view.logScale);
      break;
    case 'vectorGlyphs':
      // Would need 3 textures for X,Y,Z components
      console.log(`[PM Debug] Vector glyphs not yet implemented`);
      break;
  }
}

/**
 * Run metrics
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {import('./types.js').PMCheckSpec} checks 
 */
async function runMetrics(psys, stage, checks) {
  const { runAllMetrics } = require('./metrics.js');
  
  console.log(`[PM Debug] Running metrics for ${stage}:`, checks);
  const results = await runAllMetrics(psys, stage, checks);
  
  // Log results
  console.log(`[PM Debug] Metrics results for ${stage}:`, results);
}

/**
 * Perform readback
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {import('./types.js').PMStageID} stage 
 * @param {import('./types.js').PMReadbackSpec} buffers 
 */
async function performReadback(psys, stage, buffers) {
  const gl = psys.gl;
  
  console.log(`[PM Debug] Performing readback for ${stage}:`, buffers);
  
  if (buffers.forcePatch && psys.forceTexture) {
    const { x, y, width, height } = buffers.forcePatch;
    
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, psys.forceTexture.texture, 0);
    
    const data = new Float32Array(width * height * 4);
    gl.readPixels(x, y, width, height, gl.RGBA, gl.FLOAT, data);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    
    console.log(`[PM Debug] Readback ${width}x${height} force patch:`, data.slice(0, 16));
  }
}

/**
 * Get default metric checks for a stage
 * @param {import('./types.js').PMStageID} stage 
 * @returns {import('./types.js').PMCheckSpec}
 */
function getDefaultChecksForStage(stage) {
  switch (stage) {
    case 'pm_deposit':
      return { checkMassConservation: true };
    case 'pm_poisson':
      return { checkDCZero: true };
    case 'pm_fft_forward':
    case 'pm_fft_inverse':
      return { checkFFTInverseIdentity: true };
    default:
      return {};
  }
}

/**
 * Dispose a snapshot
 * @param {WebGL2RenderingContext} gl 
 * @param {import('./types.js').PMSnapshot} snapshot 
 */
function disposeSnapshot(gl, snapshot) {
  if (snapshot.pmMassGrid) gl.deleteTexture(snapshot.pmMassGrid);
  if (snapshot.rhoSpectrum) gl.deleteTexture(snapshot.rhoSpectrum);
  if (snapshot.phiSpectrum) gl.deleteTexture(snapshot.phiSpectrum);
  if (snapshot.accelSpectrumXYZ) {
    gl.deleteTexture(snapshot.accelSpectrumXYZ.x);
    gl.deleteTexture(snapshot.accelSpectrumXYZ.y);
    gl.deleteTexture(snapshot.accelSpectrumXYZ.z);
  }
  if (snapshot.pmAccelXYZ) {
    gl.deleteTexture(snapshot.pmAccelXYZ.x);
    gl.deleteTexture(snapshot.pmAccelXYZ.y);
    gl.deleteTexture(snapshot.pmAccelXYZ.z);
  }
  if (snapshot.sampledForces) gl.deleteTexture(snapshot.sampledForces);
}

/**
 * Store a snapshot
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {string} key 
 * @param {import('./types.js').PMStageID} atStage 
 */
export function pmSnapshotStore(psys, key, atStage) {
  if (!psys._pmDebugState) return;

  console.log(`[PM Debug] Storing snapshot: ${key} at stage ${atStage}`);
  // Will capture current textures and store them
}

/**
 * Load a snapshot
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {string} key 
 * @param {import('./types.js').PMStageID} forStage 
 * @returns {import('./types.js').PMSourceSpec}
 */
export function pmSnapshotLoad(psys, key, forStage) {
  return { kind: 'snapshot', key };
}

/**
 * Dispose a snapshot
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {string} key 
 */
export function pmSnapshotDispose(psys, key) {
  if (!psys._pmDebugState) return;

  const snapshot = psys._pmDebugState.snapshots.get(key);
  if (snapshot) {
    disposeSnapshot(psys.gl, snapshot);
    psys._pmDebugState.snapshots.delete(key);
    console.log(`[PM Debug] Disposed snapshot: ${key}`);
  }
}
