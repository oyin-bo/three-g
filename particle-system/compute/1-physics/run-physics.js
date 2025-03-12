// @ts-check

/**
 * @template {import('../..').ParticleCore} TParticle
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  state: import('../../upload').ParticleSystemState<TParticle>,
 *  gravity: number,
 *  timeDelta: number
 * }} _
 */
export function runPhysics({ gl, state, gravity, timeDelta }) {
  const {
    computeState: {
      physics: {
        program,
        gravityLocation,
        timeDeltaLocation,
        bufferSizeLocation,
      },
    },
    dynamicBuffer,
    staticBuffer,
    dynamicBufferOut,
    particles: { length: bufferSize },
  } = state;

  gl.useProgram(program);

  // Set uniform values
  gl.uniform1f(gravityLocation, gravity);
  gl.uniform1f(timeDeltaLocation, timeDelta);
  gl.uniform1i(bufferSizeLocation, bufferSize);

  // Bind input buffers
  gl.bindBuffer(gl.ARRAY_BUFFER, dynamicBuffer);

  // Setup vertex attribute pointers for positions and velocities
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

  // Bind static buffer
  gl.bindBuffer(gl.ARRAY_BUFFER, staticBuffer);

  // Setup vertex attribute pointers for masses
  const massLocation = 2;
  const massSize = 1;
  const staticStride = massSize * Float32Array.BYTES_PER_ELEMENT;
  const massOffset = 0;

  gl.vertexAttribPointer(massLocation, massSize, gl.FLOAT, false, staticStride, massOffset);

  // Bind output buffer for transform feedback
  gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, dynamicBufferOut);

  gl.beginTransformFeedback(gl.POINTS);
  gl.drawArrays(gl.POINTS, 0, bufferSize);
  gl.endTransformFeedback();

  // Disable vertex attribute arrays
  gl.disableVertexAttribArray(positionLocation);
  gl.disableVertexAttribArray(velocityLocation);
  gl.disableVertexAttribArray(massLocation);

  // Swap dynamic buffers
  const temp = dynamicBuffer;
  state.dynamicBuffer = dynamicBufferOut;
  state.dynamicBufferOut = temp;
}