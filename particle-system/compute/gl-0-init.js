// @ts-check

import { createAndCompileShader } from '../create-and-compile-shader';
import { glErrorProgramLinkingString, glErrorString } from '../gl-errors';
import { gl_PositionsAndVelocities } from './gl-1-positions-and-velocities';

/**
 * @param {WebGL2RenderingContext} gl
 * @returns {import('./compute-core').GLComputeState}
 */
export function gl_init(gl) {
  const vertexShader = createAndCompileShader(gl, gl.VERTEX_SHADER, gl_PositionsAndVelocities);

  const fragmentShader = createAndCompileShader(gl, gl.FRAGMENT_SHADER, `
    #version 300 es
    void main() {}`);

  const program = gl.createProgram();
  if (!program) throw new Error('Program creation failed ' + glErrorString(gl));

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);

  // Transform Feedback Varyings
  const varyings = ['v_position', 'v_velocity'];
  gl.transformFeedbackVaryings(program, varyings, gl.INTERLEAVED_ATTRIBS);

  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const errorString = glErrorProgramLinkingString({ gl, program });
    gl.deleteProgram(program);
    throw new Error(errorString);
  }

  const transformFeedback = gl.createTransformFeedback();
  if (!transformFeedback) throw new Error('Failed to create transform feedback ' + glErrorString(gl));

  // Get Attribute and Uniform Locations
  return {
    program,
    positionLocation: gl.getAttribLocation(program, 'a_position'),
    velocityLocation: gl.getAttribLocation(program, 'a_velocity'),
    massLocation: gl.getAttribLocation(program, 'a_mass'),
    deltaTimeLocation: getUniformLocationOrThrow('u_deltaTime'),
    gravityConstantLocation: getUniformLocationOrThrow('u_gravityConstant'),
    gridDimensionsLocation: getUniformLocationOrThrow('u_gridDimensions'),
    cellSpanOffsetLocation: gl.getAttribLocation(program, 'a_cellSpanOffset'),
    cellTotalMassLocation: gl.getAttribLocation(program, 'a_cellTotalMass'),
    transformFeedback
  };

  /** @param {string} name */
  function getUniformLocationOrThrow(name) {
    const loc = gl.getUniformLocation(program, name);
    if (!Number.isFinite(loc)) throw new Error('Unform location not found: ' + name);
    return /** @type {number} */(loc);
  }
}