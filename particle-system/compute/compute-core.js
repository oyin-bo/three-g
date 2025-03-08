// @ts-check

import { glCode } from '../gl-errors';
import { gl_init } from './gl-0-init';

/**
 * @typedef {{
 * program: WebGLProgram,
 * positionLocation: number,
 * velocityLocation: number,
 * massLocation: number,
 * deltaTimeLocation: WebGLUniformLocation,
 * gravityConstantLocation: WebGLUniformLocation,
 * gridDimensionsLocation: WebGLUniformLocation,
 * cellSpanOffsetLocation: number,
 * cellTotalMassLocation: number,
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

  // Bind Ping Buffers
  gl.bindBuffer(gl.ARRAY_BUFFER, this._positionsBufferPing);
  gl.vertexAttribPointer(computeState.positionLocation, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, this._velocitiesBufferPing);
  gl.vertexAttribPointer(computeState.velocityLocation, 3, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, this._massBuffer);
  gl.vertexAttribPointer(computeState.massLocation, 1, gl.FLOAT, false, 0, 0);

  // Bind Cell Span and Total Mass Buffers
  gl.bindBuffer(gl.ARRAY_BUFFER, this._cellSpanOffsetBuffer);
  gl.vertexAttribPointer(computeState.cellSpanOffsetLocation, 1, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, this._cellTotalMassBuffer);
  gl.vertexAttribPointer(computeState.cellTotalMassLocation, 1, gl.FLOAT, false, 0, 0);

  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, computeState.transformFeedback);

  gl.beginTransformFeedback(gl.POINTS);

  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, this._positionsBufferPong);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, this._velocitiesBufferPong);

  // 3. Attribute and Uniform Setup
  gl.uniform1f(computeState.deltaTimeLocation, this._clock.now() - this._lastTick);
  gl.uniform1f(computeState.gravityConstantLocation, this._gravity);
  gl.uniform3f(computeState.gridDimensionsLocation, this._gridDimensions.x, this._gridDimensions.y, this._gridDimensions.z);

  // 4. Draw Call
  gl.drawArrays(gl.POINTS, 0, this._particles.length);

  // 5. End Transform Feedback
  gl.endTransformFeedback();
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

  gl.bindVertexArray(null);

  // 6. Buffer Swap
  const tempPositions = this._positionsBufferPing;
  this._positionsBufferPing = this._positionsBufferPong;
  this._positionsBufferPong = tempPositions;

  const tempVelocities = this._velocitiesBufferPing;
  this._velocitiesBufferPing = this._velocitiesBufferPong;
  this._velocitiesBufferPong = tempVelocities;
}
