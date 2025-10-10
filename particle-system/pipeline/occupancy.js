// @ts-check

/**
 * Occupancy Masking for Traversal Optimization
 * 
 * Generates binary masks indicating which voxels contain particles.
 * This allows the traversal shader to skip empty regions, reducing
 * texture fetches and MAC calculations.
 * 
 * Packing: 32 voxels per texel (RGBA8 = 4 channels × 8 bits = 32 bits)
 */

/**
 * Create occupancy mask textures for all pyramid levels
 * @param {WebGL2RenderingContext} gl
 * @param {number} numLevels
 * @param {Array<{gridSize: number, size: number}>} levelTargets
 * @returns {WebGLTexture[]} Array of mask textures (one per level)
 */
export function createOccupancyMaskTextures(gl, numLevels, levelTargets) {
  const maskTextures = [];
  
  for (let level = 0; level < numLevels; level++) {
    const gridSize = levelTargets[level].gridSize;
    const totalVoxels = gridSize * gridSize * gridSize;
    
    // Pack 32 voxels per texel (RGBA8 = 32 bits)
    const texelsNeeded = Math.ceil(totalVoxels / 32);
    const maskWidth = Math.ceil(Math.sqrt(texelsNeeded));
    const maskHeight = Math.ceil(texelsNeeded / maskWidth);
    
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    // Initialize with zeros (all empty)
    const maskData = new Uint8Array(maskWidth * maskHeight * 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, maskWidth, maskHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, maskData);
    
    maskTextures.push(texture);
  }
  
  gl.bindTexture(gl.TEXTURE_2D, null);
  return maskTextures;
}

/**
 * Create a 2D texture array for occupancy masks (Plan C compatible)
 * @param {WebGL2RenderingContext} gl
 * @param {number} numLevels
 * @param {Array<{gridSize: number, size: number}>} levelTargets
 * @returns {WebGLTexture} Texture array with one layer per level
 */
export function createOccupancyMaskArray(gl, numLevels, levelTargets) {
  // Find the maximum dimensions needed across all levels
  let maxWidth = 0;
  let maxHeight = 0;
  
  for (let level = 0; level < numLevels; level++) {
    const gridSize = levelTargets[level].gridSize;
    const totalVoxels = gridSize * gridSize * gridSize;
    const texelsNeeded = Math.ceil(totalVoxels / 32);
    const maskWidth = Math.ceil(Math.sqrt(texelsNeeded));
    const maskHeight = Math.ceil(texelsNeeded / maskWidth);
    maxWidth = Math.max(maxWidth, maskWidth);
    maxHeight = Math.max(maxHeight, maskHeight);
  }
  
  // Create texture array with uniform dimensions
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, texture);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  
  // Allocate storage for all levels
  gl.texImage3D(
    gl.TEXTURE_2D_ARRAY,
    0,                    // mipmap level
    gl.RGBA8,            // internal format
    maxWidth,            // width
    maxHeight,           // height
    numLevels,           // depth (number of layers)
    0,                   // border
    gl.RGBA,             // format
    gl.UNSIGNED_BYTE,    // type
    null                 // data (allocate empty)
  );
  
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  return texture;
}

/**
 * Update occupancy masks after pyramid reduction
 * Reads back mass channel from A0 texture and generates packed binary masks
 * 
 * @param {WebGL2RenderingContext} gl
 * @param {any} ctx - ParticleSystem context
 */
export function updateOccupancyMasks(gl, ctx) {
  if (!ctx.occupancyMasks) return;
  
  const tempFB = gl.createFramebuffer();
  
  for (let level = 0; level < ctx.numLevels; level++) {
    const gridSize = ctx.levelTargets[level].gridSize;
    const textureSize = ctx.levelTargets[level].size;
    const slicesPerRow = ctx.levelTargets[level].slicesPerRow;
    
    // Read back A0 texture (contains mass in alpha channel)
    const pixels = new Float32Array(textureSize * textureSize * 4);
    
    if (ctx.options.planC) {
      // Plan C: Read from texture array
      gl.bindFramebuffer(gl.FRAMEBUFFER, tempFB);
      gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, ctx.levelTextureArrayA0, 0, level);
      gl.readPixels(0, 0, textureSize, textureSize, gl.RGBA, gl.FLOAT, pixels);
    } else {
      // Original: Read from individual texture
      gl.bindFramebuffer(gl.FRAMEBUFFER, tempFB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ctx.levelTargets[level].a0, 0);
      gl.readPixels(0, 0, textureSize, textureSize, gl.RGBA, gl.FLOAT, pixels);
    }
    
    // Generate binary mask
    const totalVoxels = gridSize * gridSize * gridSize;
    const texelsNeeded = Math.ceil(totalVoxels / 32);
    const maskWidth = Math.ceil(Math.sqrt(texelsNeeded));
    const maskHeight = Math.ceil(texelsNeeded / maskWidth);
    const maskData = new Uint8Array(maskWidth * maskHeight * 4);
    
    // For each voxel, check if mass > threshold
    const massThreshold = 1e-6;
    let occupiedCount = 0;
    
    for (let vz = 0; vz < gridSize; vz++) {
      for (let vy = 0; vy < gridSize; vy++) {
        for (let vx = 0; vx < gridSize; vx++) {
          // Convert 3D voxel coord to 2D texture coord
          const sliceIndex = vz;
          const sliceRow = Math.floor(sliceIndex / slicesPerRow);
          const sliceCol = sliceIndex % slicesPerRow;
          const texelX = sliceCol * gridSize + vx;
          const texelY = sliceRow * gridSize + vy;
          const pixelIndex = (texelY * textureSize + texelX) * 4;
          
          // Read mass from alpha channel
          const mass = pixels[pixelIndex + 3];
          const occupied = mass > massThreshold;
          
          if (occupied) {
            occupiedCount++;
            // Set bit in packed mask
            const voxelIndex = vz * gridSize * gridSize + vy * gridSize + vx;
            const texelIndex = Math.floor(voxelIndex / 32);
            const bitIndex = voxelIndex % 32;
            const channelIndex = Math.floor(bitIndex / 8);
            const bitInChannel = bitIndex % 8;
            
            const maskTexelX = texelIndex % maskWidth;
            const maskTexelY = Math.floor(texelIndex / maskWidth);
            const maskPixelIndex = (maskTexelY * maskWidth + maskTexelX) * 4 + channelIndex;
            
            maskData[maskPixelIndex] |= (1 << bitInChannel);
          }
        }
      }
    }
    
    // Upload mask to GPU
    if (ctx.occupancyMaskArray) {
      // Upload to texture array (Plan C)
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.occupancyMaskArray);
      gl.texSubImage3D(
        gl.TEXTURE_2D_ARRAY,
        0,              // mip level
        0,              // xoffset
        0,              // yoffset
        level,          // zoffset (layer)
        maskWidth,      // width
        maskHeight,     // height
        1,              // depth (one layer)
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        maskData
      );
    } else {
      // Upload to individual texture (fallback)
      gl.bindTexture(gl.TEXTURE_2D, ctx.occupancyMasks[level]);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, maskWidth, maskHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, maskData);
    }
  }
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  gl.deleteFramebuffer(tempFB);
}

/**
 * Get mask texture dimensions for a given level
 * @param {number} gridSize
 * @returns {{width: number, height: number}}
 */
export function getOccupancyMaskDimensions(gridSize) {
  const totalVoxels = gridSize * gridSize * gridSize;
  const texelsNeeded = Math.ceil(totalVoxels / 32);
  const width = Math.ceil(Math.sqrt(texelsNeeded));
  const height = Math.ceil(texelsNeeded / width);
  return { width, height };
}
