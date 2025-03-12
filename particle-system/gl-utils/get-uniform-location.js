// @ts-check

/**
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLProgram} program
 * @param {string} name
 * @returns {WebGLUniformLocation}
 */
export function getUniformLocationVerified(gl, program, name) {
  const loc = gl.getUniformLocation(program, name);
  if (!loc) throw new Error('Uniform location not found: ' + name);
  return loc;
}