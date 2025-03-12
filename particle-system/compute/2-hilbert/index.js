// @ts-check

export { createHilbertState } from './create-hilbert-state.js';

/**
 * @typedef {{
 *  program: WebGLProgram,
 *  quantizationMinLocation: WebGLUniformLocation,
 *  quantizationMaxLocation: WebGLUniformLocation,
 *  transformFeedback: WebGLTransformFeedback,
 *  destroy(): void
 * }} GLHilbertState
 */