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
  gl.transformFeedbackVaryings(program, ['v_position', 'v_velocity'], gl.INTERLEAVED_ATTRIBS);

  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const errorString = glErrorProgramLinkingString({ gl, program });
    gl.deleteProgram(program);
    throw new Error(errorString);
  }

  const transformFeedback = gl.createTransformFeedback();
  if (!transformFeedback) throw new Error('Failed to create transform feedback ' + glErrorString(gl));

  const vao = gl.createVertexArray();
  if (!vao) throw new Error('Failed to create VAO ' + glErrorString(gl));

  gl.bindVertexArray(vao);

  // Get Uniform Buffer Binding Points
  const cellSpanOffsetBindingPoint = gl.getUniformBlockIndex(program, 'CellSpanOffsetBuffer');
  gl.uniformBlockBinding(program, cellSpanOffsetBindingPoint, 0);

  const cellTotalMassBindingPoint = gl.getUniformBlockIndex(program, 'CellTotalMassBuffer');
  gl.uniformBlockBinding(program, cellTotalMassBindingPoint, 1);

  const particlePositionsBindingPoint = gl.getUniformBlockIndex(program, 'ParticlePositionsBuffer');
  gl.uniformBlockBinding(program, particlePositionsBindingPoint, 2);

  const particleMassesBindingPoint = gl.getUniformBlockIndex(program, 'ParticleMassesBuffer');
  gl.uniformBlockBinding(program, particleMassesBindingPoint, 3);

  const particleVelocitiesBindingPoint = gl.getUniformBlockIndex(program, 'ParticleVelocitiesBuffer');
  gl.uniformBlockBinding(program, particleVelocitiesBindingPoint, 4);

  gl.bindVertexArray(null);

  // Get Uniform Locations
  const deltaTimeLocation = getUniformLocationOrThrow('u_deltaTime');
  const gravityConstantLocation = getUniformLocationOrThrow('u_gravityConstant');
  const gridDimensionsLocation = getUniformLocationOrThrow('u_gridDimensions');

  return {
    program,
    deltaTimeLocation,
    gravityConstantLocation,
    gridDimensionsLocation,
    transformFeedback,
    vao
  };

  /** @param {string} name */
  function getUniformLocationOrThrow(name) {
    const loc = gl.getUniformLocation(program, name);
    if (!Number.isFinite(loc)) throw new Error('Unform location not found: ' + name);
    return /** @type {number} */(loc);
  }
}