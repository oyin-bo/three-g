// @ts-check

import { glCode, glErrorShaderCompilationString, glErrorString } from '../gl-utils/gl-errors.js';

/**
 * Creates and compiles a WebGL shader.
 *
 * @param {WebGLRenderingContext} gl - The WebGL rendering context.
 * @param {number} type - The shader type (gl.VERTEX_SHADER or gl.FRAGMENT_SHADER).
 * @param {string} source - The shader source code.
 */
export function createAndCompileShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('Failed to create ' + glCode(type, gl) + ': ' + glErrorString(gl));

  gl.shaderSource(shader, source.trimStart());
  gl.compileShader(shader);

  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(glErrorShaderCompilationString({
    gl,
    shader,
    type,
    source: source.trimStart()
  }));

  return shader;
}
