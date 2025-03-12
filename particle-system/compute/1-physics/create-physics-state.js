// @ts-check

import { createAndCompileShader } from '../../gl-utils/create-and-compile-shader.js';
import { getUniformLocationVerified } from '../../gl-utils/get-uniform-location.js';
import { glErrorProgramLinkingString, glErrorString } from '../../gl-utils/gl-errors.js';
import { gl_PositionsAndVelocities } from './glsl-positions-velocities.js';

/**
 * @param {WebGL2RenderingContext} gl
 * @returns {import('.').GLPhysicsState}
 */
export function createPhysicsState(gl) {
  const vertexShader = createAndCompileShader(gl, gl.VERTEX_SHADER, gl_PositionsAndVelocities);

  const fragmentShader = createAndCompileShader(gl, gl.FRAGMENT_SHADER, `
        #version 300 es
        void main() {}`);

  const program = gl.createProgram();
  if (!program) throw new Error('Program creation failed ' + glErrorString(gl));

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);

  // Transform Feedback Varyings
  gl.transformFeedbackVaryings(program, ['v_position', 'v_velocity'], gl.INTERLEAVED_ATTRIBS);

  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const errorString = glErrorProgramLinkingString({ gl, program });
    gl.deleteProgram(program);
    throw new Error(errorString);
  }

  gl.validateProgram(program);

  if (!gl.getProgramParameter(program, gl.VALIDATE_STATUS)) {
    const errorString = glErrorProgramLinkingString({ gl, program });
    gl.deleteProgram(program);
    throw new Error(errorString);
  }

  const transformFeedback = gl.createTransformFeedback();
  if (!transformFeedback) throw new Error('Failed to create transform feedback ' + glErrorString(gl));

  // Get Uniform Locations
  const deltaTimeLocation = getUniformLocationVerified(gl, program, 'u_deltaTime');
  const gravityConstantLocation = getUniformLocationVerified(gl, program, 'u_gravityConstant');
  const gridDimensionsLocation = getUniformLocationVerified(gl, program, 'u_gridDimensions');

  return {
    program,
    deltaTimeLocation,
    gravityConstantLocation,
    gridDimensionsLocation,
    transformFeedback,
    destroy
  };

  function destroy() {
    gl.deleteProgram(program);
    gl.deleteTransformFeedback(transformFeedback);
  }
}