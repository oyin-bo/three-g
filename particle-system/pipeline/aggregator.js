// Aggregate particles into L0 using additive blending.
// Each particle contributes: (sum_x, sum_y, mass, count)
export function aggregateParticlesIntoL0(ctx) {
  const gl = ctx.gl;
  
  // Clear any pending GL errors from previous operations (e.g., Three.js)
  while (gl.getError() !== gl.NO_ERROR) {}
  
  gl.useProgram(ctx.programs.aggregation);

  // Avoid feedback: ensure no textures are bound except the ones we set below
  ctx.unbindAllTextures();

  // Bind L0 framebuffer and set viewport with MRT
  gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.levelFramebuffers[0]);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
  const L0 = ctx.levelTargets[0].size;
  gl.viewport(0, 0, L0, L0);
  gl.disable(gl.SCISSOR_TEST);  // Don't use scissor
  ctx.checkFBO('aggregate L0 (after bind)');
  ctx.checkGl('aggregate L0 (after bind)');

  // Enable additive blending for accumulation
  gl.disable(gl.DEPTH_TEST);
  gl.depthMask(false);  // Don't try to write depth
  gl.colorMask(true, true, true, true);  // CRITICAL: Enable color writes!
  gl.disable(gl.CULL_FACE);  // Disable face culling
  gl.disable(gl.SCISSOR_TEST);  // CRITICAL: Disable scissor test!
  
  if (!ctx._disableFloatBlend) {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
  } else {
    gl.disable(gl.BLEND);
  }
  ctx.checkGl('aggregate L0 (after blend setup)');

  // Bind positions texture
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ctx.positionTextures.getCurrentTexture());
  const u_positions = gl.getUniformLocation(ctx.programs.aggregation, 'u_positions');
  gl.uniform1i(u_positions, 0);
  ctx.checkGl('aggregate L0 (after bind positions)');
  
  // Set uniforms
  const u_texSize = gl.getUniformLocation(ctx.programs.aggregation, 'u_texSize');
  const u_worldMin = gl.getUniformLocation(ctx.programs.aggregation, 'u_worldMin');
  const u_worldMax = gl.getUniformLocation(ctx.programs.aggregation, 'u_worldMax');
  const u_gridSize = gl.getUniformLocation(ctx.programs.aggregation, 'u_gridSize');
  const u_slicesPerRow = gl.getUniformLocation(ctx.programs.aggregation, 'u_slicesPerRow');
  
  gl.uniform2f(u_texSize, ctx.textureWidth, ctx.textureHeight);
  gl.uniform3f(u_worldMin, 
    ctx.options.worldBounds.min[0], 
    ctx.options.worldBounds.min[1],
    ctx.options.worldBounds.min[2]);
  gl.uniform3f(u_worldMax, 
    ctx.options.worldBounds.max[0], 
    ctx.options.worldBounds.max[1],
    ctx.options.worldBounds.max[2]);
  gl.uniform1f(u_gridSize, ctx.octreeGridSize);
  gl.uniform1f(u_slicesPerRow, ctx.octreeSlicesPerRow);
  ctx.checkGl('aggregate L0 (after set uniforms)');

  // Draw particles as points using gl_VertexID
  ctx.checkFBO('aggregate L0');
  ctx.checkGl('aggregate L0 (before draw)');
  gl.bindVertexArray(ctx.particleVAO);
  
  gl.drawArrays(gl.POINTS, 0, ctx.options.particleCount);
  gl.bindVertexArray(null);
  ctx.checkGl('aggregate L0 (after draw)');

  gl.disable(gl.BLEND);
  
  // For Plan C: copy L0 MRT attachments to texture array layer 0
  // This ensures the reduction shader can read from the texture arrays
  if (ctx.options.planC && ctx.levelTextureArrayA0) {
    const size = ctx.levelTargets[0].size;
    
    // Copy COLOR_ATTACHMENT0 -> levelTextureArrayA0 layer 0
    // copyTexSubImage3D(target, level, xoffset, yoffset, zoffset(layer), x, y, width, height)
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA0);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 0, 0, size, size);
    
    // Copy COLOR_ATTACHMENT1 -> levelTextureArrayA1 layer 0
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA1);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 0, 0, size, size);
    
    // Copy COLOR_ATTACHMENT2 -> levelTextureArrayA2 layer 0
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA2);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, 0, 0, 0, size, size);
    
    // Reset read buffer
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }
  
  ctx.unbindAllTextures();
  const err = ctx.checkGl('aggregateParticlesIntoL0');
  if (err !== gl.NO_ERROR) {
    if (!ctx._disableFloatBlend) {
      console.warn('Plan M: Disabling float blending for L0 accumulation due to GL error. Falling back to non-blended writes (reduced accuracy).');
      ctx._disableFloatBlend = true;
    } else {
      console.warn('Plan M: Disabling quadtree due to persistent GL errors in aggregation. Forces will be cleared each frame.');
      ctx._quadtreeDisabled = true;
    }
  }
  // Unbind FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
