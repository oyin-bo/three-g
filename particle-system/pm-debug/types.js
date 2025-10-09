// @ts-check

/**
 * PM Debug Types - Type definitions for stage-isolated debugging
 * 
 * This module defines all types for the Plan A debugging system:
 * - Stage identifiers
 * - Source specifications (synthetic, snapshot, live)
 * - Sink specifications (overlay, metrics, readback, snapshot)
 * - Configuration structures
 */

/**
 * @typedef {'pm_deposit' | 'pm_fft_forward' | 'pm_poisson' | 'pm_gradient' | 'pm_fft_inverse' | 'pm_sample' | 'pm_nearfield'} PMStageID
 */

/**
 * @typedef {{
 *   type: 'gridImpulse',
 *   centerVoxel: [number, number, number],
 *   mass: number
 * } | {
 *   type: 'twoPointMasses',
 *   a: [number, number, number],
 *   b: [number, number, number],
 *   ma: number,
 *   mb: number
 * } | {
 *   type: 'planeWaveDensity',
 *   k: [number, number, number],
 *   amplitude: number
 * } | {
 *   type: 'spectrumDelta',
 *   k: [number, number, number],
 *   amplitude: number
 * } | {
 *   type: 'spectrumWhiteNoise',
 *   seed: number,
 *   power: number
 * }} PMSyntheticSpec
 */

/**
 * @typedef {{
 *   kind: 'live'
 * } | {
 *   kind: 'snapshot',
 *   key: string
 * } | {
 *   kind: 'synthetic',
 *   synth: PMSyntheticSpec
 * }} PMSourceSpec
 */

/**
 * @typedef {{
 *   type: 'gridSlice',
 *   axis: 'x' | 'y' | 'z',
 *   index: number
 * } | {
 *   type: 'spectrumMagnitude',
 *   logScale: boolean
 * } | {
 *   type: 'vectorGlyphs',
 *   stride: number
 * }} PMOverlaySpec
 */

/**
 * @typedef {{
 *   checkMassConservation?: boolean,
 *   checkDCZero?: boolean,
 *   checkFFTInverseIdentity?: boolean,
 *   checkPoissonOnPlaneWave?: boolean,
 *   reportLinfL2?: boolean
 * }} PMCheckSpec
 */

/**
 * @typedef {{
 *   forcePatch?: { x: number, y: number, width: number, height: number }
 * }} PMReadbackSpec
 */

/**
 * @typedef {{
 *   kind: 'noop'
 * } | {
 *   kind: 'snapshot',
 *   key: string
 * } | {
 *   kind: 'overlay',
 *   view: PMOverlaySpec
 * } | {
 *   kind: 'metrics',
 *   checks: PMCheckSpec
 * } | {
 *   kind: 'readback',
 *   buffers: PMReadbackSpec
 * }} PMSinkSpec
 */

/**
 * @typedef {{
 *   pmMassGrid?: WebGLTexture,
 *   rhoSpectrum?: WebGLTexture,
 *   phiSpectrum?: WebGLTexture,
 *   accelSpectrumXYZ?: { x: WebGLTexture, y: WebGLTexture, z: WebGLTexture },
 *   pmAccelXYZ?: { x: WebGLTexture, y: WebGLTexture, z: WebGLTexture },
 *   sampledForces?: WebGLTexture
 * }} PMSnapshot
 */

/**
 * @typedef {{
 *   enabled: boolean,
 *   singleStageRun?: {
 *     stage: PMStageID,
 *     source?: PMSourceSpec,
 *     sink?: PMSinkSpec
 *   },
 *   recordAfterStage?: PMStageID,
 *   replayBeforeStage?: PMStageID,
 *   assertInvariants?: boolean,
 *   drawOverlays?: boolean
 * }} DebugPMConfig
 */

/**
 * @typedef {{
 *   config: DebugPMConfig,
 *   snapshots: Map<string, PMSnapshot>,
 *   programs: {
 *     synthetic?: WebGLProgram,
 *     overlay?: WebGLProgram,
 *     metrics?: WebGLProgram
 *   },
 *   metricsResults: Map<string, any>
 * }} PMDebugState
 */

// Export types for use in other modules
export const PM_STAGE_IDS = [
  'pm_deposit',
  'pm_fft_forward',
  'pm_poisson',
  'pm_gradient',
  'pm_fft_inverse',
  'pm_sample',
  'pm_nearfield'
];
