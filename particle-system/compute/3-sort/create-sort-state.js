// @ts-check

import { createAndCompileShader } from '../../gl-utils/create-and-compile-shader.js';
import { getUniformLocationVerified } from '../../gl-utils/get-uniform-location.js';
import { linkValidateProgram } from '../../gl-utils/link-validate-program.js';
import { gl_sorting } from './gl-sorting.js';

/**
 * @param {WebGL2RenderingContext} gl
 * @returns {import('.').GLSortState}
 */
export function createSortState(gl) {

  // 1. Create Sorting Program
  const vertexShader = createAndCompileShader(gl, gl.VERTEX_SHADER, gl_sorting);
  const fragmentShader = createAndCompileShader(gl, gl.FRAGMENT_SHADER,
    /* glsl */`
#version 300 es

void main() {
    // Discard the fragment
    discard;
}
    `);

  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);

  // Transform feedback variables
  gl.transformFeedbackVaryings(
    program,
    [
      'positionOut',
      'velocityOut',
      'massOut',
      'massArcOut',
      'positionArcOut',
      'velocityArcOut',
      'cpuIndexOut',
      'cpuIndexArcOut',
      'sourceIdxHilbertOut',
      'sourceIdxHilbertArcOut'
    ],
    gl.INTERLEAVED_ATTRIBS
  );

  linkValidateProgram(gl, program);

  // 2. Get Uniform Locations
  const bufferSizeLocation = getUniformLocationVerified(gl, program, "bufferSize");
  const sortStageLocation = getUniformLocationVerified(gl, program, "sortStage");
  const sortPhaseLocation = getUniformLocationVerified(gl, program, "sortPhase");

  // 3. Create Transform Feedback Object
  const transformFeedback = gl.createTransformFeedback();

  // 4. Store State
  const sortState = {
    program: program,
    bufferSizeLocation,
    sortStageLocation,
    sortPhaseLocation,
    transformFeedback,
    destroy
  };

  return sortState;

  function destroy() {
    gl.deleteProgram(sortState.program);
    gl.deleteTransformFeedback(sortState.transformFeedback);
  }
}