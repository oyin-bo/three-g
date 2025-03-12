// @ts-check

import { glErrorProgramLinkingString } from './gl-errors.js';

/**
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 */
export function linkValidateProgram(gl, program) {
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
}