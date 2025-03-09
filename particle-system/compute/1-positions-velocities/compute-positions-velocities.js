// @ts-check

import { glCode } from '../../gl-errors.js';

/**
 * @param {import('../..').ParticleSystem & { _computeState: import('../compute-core').GLComputeState}} self
 */
export function computePositionsVelocities(self) {
  const gl = self._gl;

  const computeState = self._computeState;

  gl.useProgram(computeState.program);
  let err = gl.getError();
  if (err) throw new Error(glCode(err, gl) + ' gl.useProgram.');

  gl.bindVertexArray(computeState.vao);

  // Bind Uniform Buffers
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, self._cellSpanOffsetBuffer);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, self._cellTotalMassBuffer);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, self._positionsBufferPing);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 3, self._massBuffer);
  gl.bindBufferBase(gl.UNIFORM_BUFFER, 4, self._velocitiesBufferPing);

  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, computeState.transformFeedback);

  gl.beginTransformFeedback(gl.POINTS);

  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, self._positionsBufferPong);
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, self._velocitiesBufferPong);

  // Uniform Setup
  gl.uniform1f(computeState.deltaTimeLocation, self._clock.now() - self._lastTick);
  gl.uniform1f(computeState.gravityConstantLocation, self._gravity);
  gl.uniform3f(computeState.gridDimensionsLocation, self._gridDimensions.x, self._gridDimensions.y, self._gridDimensions.z);

  // Draw Call
  gl.drawArrays(gl.POINTS, 0, self._particles.length);

  // End Transform Feedback
  gl.endTransformFeedback();
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);

  gl.bindVertexArray(null);

  // Buffer Swap
  [self._positionsBufferPing, self._positionsBufferPong] = [self._positionsBufferPong, self._positionsBufferPing];
  [self._velocitiesBufferPing, self._velocitiesBufferPong] = [self._velocitiesBufferPong, self._velocitiesBufferPing];
}