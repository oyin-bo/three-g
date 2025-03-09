// @ts-check

import { glCode } from '../gl-errors';
import { gl_init } from './gl-0-init';

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
  const gl = this._gl;

  const computeState = this._computeState || (this._computeState = gl_init(gl));

  gl.useProgram(computeState.program);
  let err = gl.getError();
  if (err) throw new Error(glCode(err, gl) + ' gl.useProgram.');

  gl.bindVertexArray(computeState.vao);

  // Bind Uniform Buffers
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, this._cellSpanOffsetBuffer);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, this._cellTotalMassBuffer);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, this._positionsBufferPing);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 3, this._massBuffer);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 4, this._velocitiesBufferPing);

  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, computeState.transformFeedback);

  gl.beginTransformFeedback(gl.POINTS);

  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this._positionsBufferPong);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this._velocitiesBufferPong);

  // Uniform Setup
  gl.uniform1f(computeState.deltaTimeLocation, this._clock.now() - this._lastTick);
  gl.uniform1f(computeState.gravityConstantLocation, this._gravity);
  gl.uniform3f(computeState.gridDimensionsLocation, this._gridDimensions.x, this._gridDimensions.y, this._gridDimensions.z);

  // Draw Call
  gl.drawArrays(gl.POINTS, 0, this._particles.length);

  // End Transform Feedback
  gl.endTransformFeedback();
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

  gl.bindVertexArray(null);

  // Buffer Swap
  [this._positionsBufferPing, this._positionsBufferPong] = [this._positionsBufferPong, this._positionsBufferPing];
  [this._velocitiesBufferPing, this._velocitiesBufferPong] = [this._velocitiesBufferPong, this._velocitiesBufferPing];
}