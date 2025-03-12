// @ts-check

export { createSortState } from './create-sort-state.js';

/**
 * @typedef {{
 *  program: WebGLProgram,
 *  bufferSizeLocation: WebGLUniformLocation,
 *  sortStageLocation: WebGLUniformLocation,
 *  sortPhaseLocation: WebGLUniformLocation,
 *  transformFeedback: WebGLTransformFeedback,
 *  destroy: () => void
 * }} GLSortState
 */