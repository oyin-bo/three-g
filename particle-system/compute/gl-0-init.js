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

  // Setup attributes (Dummy buffers, the real ones will be binded in computeCore)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); // Dummy buffer for a_position
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(positionLocation);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); // Dummy buffer for a_velocity
  const velocityLocation = gl.getAttribLocation(program, 'a_velocity');
  gl.vertexAttribPointer(velocityLocation, 3, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(velocityLocation);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); // Dummy buffer for a_mass
  const massLocation = gl.getAttribLocation(program, 'a_mass');
  gl.vertexAttribPointer(massLocation, 1, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(massLocation);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); // Dummy buffer for a_cellSpanOffset
  const cellSpanOffsetLocation = gl.getAttribLocation(program, 'a_cellSpanOffset');
  gl.vertexAttribPointer(cellSpanOffsetLocation, 1, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(cellSpanOffsetLocation);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer()); // Dummy buffer for a_cellTotalMass
  const cellTotalMassLocation = gl.getAttribLocation(program, 'a_cellTotalMass');
  gl.vertexAttribPointer(cellTotalMassLocation, 1, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(cellTotalMassLocation);

  gl.bindVertexArray(null); // Unbind the VAO

  // Get Uniform Locations
  const deltaTimeLocation = getUniformLocationOrThrow('u_deltaTime');
  const gravityConstantLocation = getUniformLocationOrThrow('u_gravityConstant');
  const gridDimensionsLocation = getUniformLocationOrThrow('u_gridDimensions');

  return {
    program,
    positionLocation,
    velocityLocation,
    massLocation,
    deltaTimeLocation,
    gravityConstantLocation,
    gridDimensionsLocation,
    cellSpanOffsetLocation,
    cellTotalMassLocation,
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