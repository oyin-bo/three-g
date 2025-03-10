// @ts-check

/**
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLBuffer | undefined} buffer
 * @param {ArrayBufferView} [data]
 */
export function createGLBuffer(gl, buffer, data) {
  if (buffer) {
    gl.deleteBuffer(buffer);
    buffer = undefined;
  }

  buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  if (data)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY); // Use DYNAMIC_COPY for frequent updates

  // } else {
  //   gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  //   if (data)
  //     gl.bufferSubData(gl.ARRAY_BUFFER, 0, data); // Update existing buffer data
  // }

  return buffer;
}