// @ts-check

import { createAndCompileShader } from '../../create-and-compile-shader.js';
import { glErrorString } from '../../gl-errors.js';

export function createUploadShaderProgram() {
  // @ts-ignore
  const gl = this._gl;

  const vertexShaderSource = `
    #version 300 es

    in vec4 position;
    in vec2 uv;

    out vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = position;
    }
  `;

  const fragmentShaderSource = `
    #version 300 es

    precision highp float;

    in vec2 vUv;

    out vec4 fragColor;

    void main() {
      fragColor = vec4(vUv, 0.0, 1.0);
    }
  `;

  const vertexShader = createAndCompileShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
  const fragmentShader = createAndCompileShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);

  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create WebGL program: ' + glErrorString(gl));

  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Failed to link WebGL program: ' + glErrorString(gl));

  return program;
}