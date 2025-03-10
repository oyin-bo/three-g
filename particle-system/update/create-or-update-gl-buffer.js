// @ts-check

/**
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLBuffer} buffer
 * @param {ArrayBufferView} [data]
 */
export function createOrUpdateGLBuffer(gl, buffer, data) {
  if (!buffer) {
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (data)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY); // Use DYNAMIC_COPY for frequent updates
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (data)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data); // Update existing buffer data
  }
  return buffer;
}