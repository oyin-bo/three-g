// @ts-check

/**
 * Grid texture helpers for PM/FFT methods
 */

/**
 * Create a 3D grid laid out as a 2D texture with grid slices arranged in rows
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize - Size of each dimension of the 3D grid (N)
 * @param {number} slicesPerRow - Number of slices per row (default: ceil(sqrt(N)))
 * @param {number} [internalFormat] - WebGL internal format (default: RGBA32F)
 * @param {number} [format] - WebGL format (default: RGBA)
 * @param {number} [type] - WebGL type (default: FLOAT)
 * @returns {WebGLTexture}
 */
export function createPMGrid(gl, gridSize, slicesPerRow, internalFormat, format, type) {
  const fmt = internalFormat || gl.RGBA32F;
  const f = format || gl.RGBA;
  const t = type || gl.FLOAT;

  const textureSize = gridSize * slicesPerRow;

  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, fmt, textureSize, textureSize, 0, f, t, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

/**
 * Create a framebuffer for a 3D grid texture
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} [attachmentIndex] - Color attachment index (default: 0)
 * @returns {WebGLFramebuffer}
 */
export function createPMGridFramebuffer(gl, texture, attachmentIndex) {
  const idx = attachmentIndex || 0;
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('Failed to create framebuffer');

  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + idx, gl.TEXTURE_2D, texture, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0 + idx]);

  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error(`Framebuffer incomplete: ${status}`);
  }

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return fbo;
}

