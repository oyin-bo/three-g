// @ts-check

// @ts-check

import { createAndCompileShader } from '../../gl-utils/create-and-compile-shader.js';
import { getUniformLocationVerified } from '../../gl-utils/get-uniform-location.js';
import { glErrorString } from '../../gl-utils/gl-errors.js';
import { linkValidateProgram } from '../../gl-utils/link-validate-program.js';
import { glsl_hilbert3D_Dual } from './glsl-hilbert3d.js';

/**
 * @param {WebGL2RenderingContext} gl
 * @returns {import('.').GLHilbertState}
 */
export function createHilbertState(gl) {
  const vertexShader = createAndCompileShader(gl, gl.VERTEX_SHADER,
    '#version 300 es\n\n' + 
    glsl_hilbert3D_Dual + '\n\n' +
    /* glsl */`

    void main() {
    }
  `);

  const fragmentShader = createAndCompileShader(gl, gl.FRAGMENT_SHADER, `
        #version 300 es
        void main() {}`);

  const program = gl.createProgram();
  if (!program) throw new Error('Program creation failed ' + glErrorString(gl));

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);

  // Transform Feedback Varyings
  gl.transformFeedbackVaryings(program, ['v_hilbertIndex'], gl.INTERLEAVED_ATTRIBS);

  linkValidateProgram(gl, program);

  const transformFeedback = gl.createTransformFeedback();
  if (!transformFeedback) throw new Error('Failed to create transform feedback ' + glErrorString(gl));

  // Get Uniform Locations
  const hilbertOrderLocation = getUniformLocationVerified(gl, program, 'u_hilbertOrder');
  const gridDimensionsLocation = getUniformLocationVerified(gl, program, 'u_gridDimensions');

  return {
    program,
    hilbertOrderLocation,
    gridDimensionsLocation,
    transformFeedback,
    destroy
  };

  function destroy() {
    gl.deleteProgram(program);
    gl.deleteTransformFeedback(transformFeedback);
  }
}