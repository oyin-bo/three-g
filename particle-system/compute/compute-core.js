// @ts-check

import { computePositionsVelocities } from './1-positions-velocities/compute-positions-velocities.js';
import { gl_init } from './gl-0-init.js';

/**
 * @typedef {{
 * program: WebGLProgram,
 * deltaTimeLocation: WebGLUniformLocation,
 * gravityConstantLocation: WebGLUniformLocation,
 * gridDimensionsLocation: WebGLUniformLocation,
 * transformFeedback: WebGLTransformFeedback,
 * vao: WebGLVertexArrayObject
 * }} GLComputeState
 */

/**
 * @this {import('..').ParticleSystem & { _computeState?: GLComputeState}}
 */
export function computeCore() {
  if (!this._computeState)
    this._computeState = gl_init(this._gl);

  computePositionsVelocities(
    /** @type {Parameters<typeof computePositionsVelocities>[0]} */(this));
}