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

/**
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  stride: number,
 *  rowCount: number,
 *  internalFormat: GLint,
 *  format: GLenum,
 *  type: GLenum,
 *  data?: ArrayBufferView
 * }} _
 */
export function createBuffersAndTextures({ gl, stride, rowCount, internalFormat, format, type, data }) {

  const [_in, _out] =[data, undefined].map(data => {
    const buffer = createGLBuffer(gl, undefined, data);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      stride, rowCount,
      0,
      format,
      type,
      data || null);

    return {
      buffer,
      texture
    };
  });

  return {
    buffer: { in: _in.buffer, out: _out.buffer },
    texture: { in: _in.texture, out: _out.texture }
  };
}
