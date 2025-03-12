// @ts-check

/**
 * @typedef {{
 * program: WebGLProgram,
 * timeDeltaLocation: WebGLUniformLocation,
 * gravityLocation: WebGLUniformLocation,
 * bufferSizeLocation: WebGLUniformLocation,
 * transformFeedback: WebGLTransformFeedback,
 * destroy(): void
 * }} GLPhysicsState
 */

export { createPhysicsState } from './create-physics-state.js';
export { runPhysics } from './run-physics.js';
