// Build the quadtree pyramid via 2x reduction passes with MRT
export function runReductionPass(ctx, sourceLevel, targetLevel) {
  const gl = ctx.gl;
  
  // Use Plan C texture array shader if available, otherwise use standard shader
  const usePlanC = ctx.options.planC && ctx.programs.reductionArray;
  const program = usePlanC ? ctx.programs.reductionArray : ctx.programs.reduction;
  
  gl.useProgram(program);
  // Avoid feedback
  ctx.unbindAllTextures();

  // Bind target framebuffer with MRT
  gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.levelFramebuffers[targetLevel]);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
  gl.viewport(0, 0, ctx.levelTargets[targetLevel].size, ctx.levelTargets[targetLevel].size);
  gl.disable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, ctx.levelTargets[targetLevel].size, ctx.levelTargets[targetLevel].size);
  
  // Bind source textures (A0, A1, A2)
  if (usePlanC) {
    // For Plan C: bind texture arrays and specify source level
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA2);
    
    gl.uniform1i(gl.getUniformLocation(program, 'u_levelsA0'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_levelsA1'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'u_levelsA2'), 2);
    gl.uniform1i(gl.getUniformLocation(program, 'u_sourceLevel'), sourceLevel);
  } else {
    // Original path: individual textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, ctx.levelTargets[sourceLevel].a0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, ctx.levelTargets[sourceLevel].a1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ctx.levelTargets[sourceLevel].a2);
    
    gl.uniform1i(gl.getUniformLocation(program, 'u_previousLevelA0'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_previousLevelA1'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'u_previousLevelA2'), 2);
  }
  
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), ctx.levelTargets[targetLevel].gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), ctx.levelTargets[targetLevel].slicesPerRow);
  
  // Render full-screen quad
  ctx.checkFBO(`reduction ${sourceLevel}->${targetLevel}`);
  gl.bindVertexArray(ctx.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  // If using Plan C, copy the rendered 2D MRT attachments into the corresponding
  // layers of the large texture arrays to keep the sampler arrays up-to-date while
  // avoiding sampling from the currently bound draw framebuffer (feedback loop).
  if (usePlanC) {
    const size = ctx.levelTargets[targetLevel].size;

    // Copy COLOR_ATTACHMENT0 -> levelTextureArrayA0 layer
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA0);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, targetLevel, 0, 0, size, size);

    // Copy COLOR_ATTACHMENT1 -> levelTextureArrayA1 layer
    gl.readBuffer(gl.COLOR_ATTACHMENT1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA1);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, targetLevel, 0, 0, size, size);

    // Copy COLOR_ATTACHMENT2 -> levelTextureArrayA2 layer
    gl.readBuffer(gl.COLOR_ATTACHMENT2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA2);
    gl.copyTexSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, targetLevel, 0, 0, size, size);

    // Reset read buffer and unbind array texture
    gl.readBuffer(gl.COLOR_ATTACHMENT0);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, null);
  }

  // Unbind source texture
  ctx.unbindAllTextures();
  ctx.checkGl(`runReductionPass ${sourceLevel}->${targetLevel}`);
  // Unbind FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
