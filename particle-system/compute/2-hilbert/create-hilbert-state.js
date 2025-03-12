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
  // 1. Shader Compilation and Program Linking
  const vertexShader = createAndCompileShader(gl, gl.VERTEX_SHADER,
    '#version 300 es\n\n' +
    glsl_hilbert3D_Dual + '\n\n' +
    /* glsl */`

layout (location = 0) in vec3 position;
layout (location = 1) in vec3 velocity;

out uint sourceIdx;
out uint hilbert;
out uint sourceIdx_arc;
out uint hilbert_arc;

void main() {
  ivec2 hilbertIndices = hilbert3D_Dual(position);

  sourceIdx = uint(gl_VertexID);
  hilbert = uint(hilbertIndices.x);
  sourceIdx_arc = uint(gl_VertexID);
  hilbert_arc = uint(hilbertIndices.y);
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
  gl.transformFeedbackVaryings(program, ['hilbertIndex1', 'hilbertIndex2', 'particleIndex', 'position', 'velocity'], gl.INTERLEAVED_ATTRIBS);

  linkValidateProgram(gl, program);

  // 2. Uniform Location Retrieval
  const quantizationMinLocation = getUniformLocationVerified(gl, program, 'quantizationMin');
  const quantizationMaxLocation = getUniformLocationVerified(gl, program, 'quantizationMax');

  // 3. Transform Feedback Object Creation
  const transformFeedback = gl.createTransformFeedback();
  if (!transformFeedback) throw new Error('Failed to create transform feedback ' + glErrorString(gl));

  // 4. State Object Construction
  return {
    program,
    quantizationMinLocation,
    quantizationMaxLocation,
    transformFeedback,
    destroy
  };

  // 5. Resource Cleanup Function
  function destroy() {
    gl.deleteProgram(program);
    gl.deleteTransformFeedback(transformFeedback);
  }
}
