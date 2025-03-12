// @ts-check

export var DEFAULT_SPACE = {
  x: { min: -10, max: 10 },
  y: { min: -10, max: 10 },
  z: { min: -10, max: 10 }
};

/**
 * @template {import('../..').ParticleCore} TParticle
 * @param {WebGL2RenderingContext} gl
 * @param {import('../../upload').ParticleSystemState<TParticle>} state
 * @param {Parameters<typeof import('../..').particleSystem>[0]['space']} space
 */
export function runHilbert(gl, state, space) {
  // 1. Program Activation
  gl.useProgram(state.computeState.hilbert.program);

  // 2. Input Buffer Binding
  gl.bindBuffer(gl.ARRAY_BUFFER, state.dynamicBuffer);

  // 3. Vertex Attribute Setup
  const positionLocation = 0;
  const velocityLocation = 1;

  gl.enableVertexAttribArray(positionLocation);
  gl.enableVertexAttribArray(velocityLocation);

  const positionSize = 3;
  const velocitySize = 3;
  const stride = (positionSize + velocitySize) * Float32Array.BYTES_PER_ELEMENT;
  const positionOffset = 0;
  const velocityOffset = positionSize * Float32Array.BYTES_PER_ELEMENT;

  gl.vertexAttribPointer(positionLocation, positionSize, gl.FLOAT, false, stride, positionOffset);
  gl.vertexAttribPointer(velocityLocation, velocitySize, gl.FLOAT, false, stride, velocityOffset);

  // 4. Uniform Setting
  gl.uniform3fv(
    state.computeState.hilbert.quantizationMinLocation,
    [
      space?.x?.min ?? DEFAULT_SPACE.x.min,
      space?.y?.min ?? DEFAULT_SPACE.y.min,
      space?.z?.min ?? DEFAULT_SPACE.z.min
    ]
  );
  gl.uniform3fv(
    state.computeState.hilbert.quantizationMaxLocation, 
    [
      space?.x?.max ?? DEFAULT_SPACE.x.max,
      space?.y?.max ?? DEFAULT_SPACE.y.max,
      space?.z?.max ?? DEFAULT_SPACE.z.max
    ]
  );

  // 5. Output Buffer Binding
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, state.ordersBuffer);

  // 6. Transform Feedback Execution
  gl.beginTransformFeedback(gl.POINTS);
  gl.drawArrays(gl.POINTS, 0, state.particles.length);
  gl.endTransformFeedback();

  // 7. Attribute Array Disabling
  gl.disableVertexAttribArray(positionLocation);
  gl.disableVertexAttribArray(velocityLocation);
}