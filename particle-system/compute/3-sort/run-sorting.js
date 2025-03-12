// @ts-check

/**
 * @template {import('../..').ParticleCore} TParticle
 * @param {WebGL2RenderingContext} gl
 * @param {import('../../upload').ParticleSystemState<TParticle>} state
 */
export function runSorting(gl, state) {
  let {
    staticBuffer,
    dynamicBuffer,
    ordersBuffer,
    staticBufferOut,
    dynamicBufferOut,
    ordersBufferOut,
    computeState: {
      sort: {
        program,
        bufferSizeLocation,
        sortStageLocation,
        sortPhaseLocation,
        transformFeedback,
      },
    },
    particles: { length: bufferSize },
  } = state;

  gl.useProgram(program);

  // Set uniform values
  gl.uniform1i(bufferSizeLocation, bufferSize);

  // Bind uniform block indices
  const staticBlockIndex = gl.getUniformBlockIndex(program, "StaticBuffer");
  const dynamicBlockIndex = gl.getUniformBlockIndex(program, "DynamicBuffer");
  const ordersBlockIndex = gl.getUniformBlockIndex(program, "OrdersBuffer");

  // Calculate number of stages
  const numStages = Math.ceil(Math.log2(bufferSize));

  // Perform odd-even mergesort
  for (let stage = 0; stage < numStages; stage++) {
    for (let phase = 0; phase < 2; phase++) {
      gl.uniform1i(sortStageLocation, stage);
      gl.uniform1i(sortPhaseLocation, phase);

      // Bind uniform buffers
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 0, staticBuffer);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 1, dynamicBuffer);
      gl.bindBufferBase(gl.UNIFORM_BUFFER, 2, ordersBuffer);

      gl.uniformBlockBinding(program, staticBlockIndex, 0);
      gl.uniformBlockBinding(program, dynamicBlockIndex, 1);
      gl.uniformBlockBinding(program, ordersBlockIndex, 2);

      // Bind transform feedback buffers
      gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, transformFeedback);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, staticBufferOut);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 1, dynamicBufferOut);
      gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 2, ordersBufferOut);

      gl.beginTransformFeedback(gl.POINTS);
      gl.drawArrays(gl.POINTS, 0, bufferSize);
      gl.endTransformFeedback();

      // Swap buffers for the next stage
      [staticBuffer, staticBufferOut] = [staticBufferOut, staticBuffer];
      [dynamicBuffer, dynamicBufferOut] = [dynamicBufferOut, dynamicBuffer];
      [ordersBuffer, ordersBufferOut] = [ordersBufferOut, ordersBuffer];
    }
  }

  // Unbind
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
  gl.useProgram(null);

  // Update the state with the final buffers.
  state.staticBuffer = staticBuffer;
  state.dynamicBuffer = dynamicBuffer;
  state.ordersBuffer = ordersBuffer;
}
