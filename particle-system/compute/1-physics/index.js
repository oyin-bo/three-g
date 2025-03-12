// @ts-check

/**
 * @typedef {{
 * program: WebGLProgram,
 * deltaTimeLocation: WebGLUniformLocation,
 * gravityConstantLocation: WebGLUniformLocation,
 * gridDimensionsLocation: WebGLUniformLocation,
 * transformFeedback: WebGLTransformFeedback,
 * destroy(): void
 * }} GLPhysicsState
 */

export { createPhysicsState } from './create-physics-state.js';
export { runPhysics } from './run-physics.js';
