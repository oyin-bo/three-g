// @ts-check

/**
 * PM Grid Management
 * 
 * Allocates and manages the 3D mass grid for Particle-Mesh force calculation.
 * Uses 3D texture slicing (Z-slices packed into 2D texture).
 */

/**
 * Create PM mass grid texture
 * 
 * @param {WebGL2RenderingContext} gl 
 * @param {number} gridSize - Grid resolution (N×N×N)
 * @returns {{texture: WebGLTexture, size: number, slicesPerRow: number, gridSize: number}}
 */
export function createPMGrid(gl, gridSize = 64) {
  // Pack 3D grid into 2D texture using Z-slice layout
  const slicesPerRow = Math.ceil(Math.sqrt(gridSize));
  const textureSize = slicesPerRow * gridSize;
  
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  
  // Single-channel R32F for mass (we only store scalar mass per voxel).
  // This reduces memory and avoids channel-mismatches when copying into
  // RG32F FFT working buffers. Use gl.RED / gl.R32F with float type.
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32F,
    textureSize,
    textureSize,
    0,
    gl.RED,
    gl.FLOAT,
    null
  );
  
  // Nearest neighbor - we don't want interpolation for discrete grid
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  console.log(`[PM Grid] Created ${gridSize}³ grid in ${textureSize}×${textureSize} texture (${slicesPerRow}×${slicesPerRow} slices)`);
  
  return {
    texture,
    size: textureSize,
    slicesPerRow,
    gridSize
  };
}

/**
 * Create framebuffer for PM grid
 * 
 * @param {WebGL2RenderingContext} gl 
 * @param {WebGLTexture} texture 
 * @returns {WebGLFramebuffer}
 */
export function createPMGridFramebuffer(gl, texture) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0
  );
  
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('[PM Grid] Framebuffer incomplete:', status);
  }
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  return fbo;
}

/**
 * Convert 3D voxel coordinates to 2D texture coordinates
 * 
 * @param {number} ix - X voxel index [0, gridSize)
 * @param {number} iy - Y voxel index [0, gridSize)
 * @param {number} iz - Z voxel index (slice) [0, gridSize)
 * @param {number} gridSize - Grid resolution
 * @param {number} slicesPerRow - Number of Z-slices per row
 * @returns {{x: number, y: number}} - Texture pixel coordinates
 */
export function voxelToTexCoord(ix, iy, iz, gridSize, slicesPerRow) {
  const sliceRow = Math.floor(iz / slicesPerRow);
  const sliceCol = iz % slicesPerRow;
  
  const x = sliceCol * gridSize + ix;
  const y = sliceRow * gridSize + iy;
  
  return { x, y };
}

/**
 * Convert 2D texture coordinates to 3D voxel coordinates
 * 
 * @param {number} texX - Texture X coordinate
 * @param {number} texY - Texture Y coordinate
 * @param {number} gridSize - Grid resolution
 * @param {number} slicesPerRow - Number of Z-slices per row
 * @returns {{ix: number, iy: number, iz: number}} - Voxel indices
 */
export function texCoordToVoxel(texX, texY, gridSize, slicesPerRow) {
  const sliceCol = Math.floor(texX / gridSize);
  const sliceRow = Math.floor(texY / gridSize);
  const iz = sliceRow * slicesPerRow + sliceCol;
  
  const ix = texX % gridSize;
  const iy = texY % gridSize;
  
  return { ix, iy, iz };
}

/**
 * Clear PM grid to zero
 * 
 * @param {WebGL2RenderingContext} gl 
 * @param {WebGLFramebuffer} fbo 
 * @param {number} size - Texture size
 */
export function clearPMGrid(gl, fbo, size) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, size, size);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
