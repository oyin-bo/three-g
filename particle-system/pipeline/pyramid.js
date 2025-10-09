// Build the quadtree pyramid via 2x reduction passes with MRT
export function runReductionPass(ctx, sourceLevel, targetLevel) {
  const gl = ctx.gl;
  gl.useProgram(ctx.programs.reduction);
  // Avoid feedback
  ctx.unbindAllTextures();

  // Bind target framebuffer with MRT
  gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.levelFramebuffers[targetLevel]);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
  gl.viewport(0, 0, ctx.levelTargets[targetLevel].size, ctx.levelTargets[targetLevel].size);
  gl.disable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, ctx.levelTargets[targetLevel].size, ctx.levelTargets[targetLevel].size);
  
  // Bind source textures (A0, A1, A2)
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ctx.levelTargets[sourceLevel].a0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, ctx.levelTargets[sourceLevel].a1);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, ctx.levelTargets[sourceLevel].a2);
  
  const u_previousLevelA0 = gl.getUniformLocation(ctx.programs.reduction, 'u_previousLevelA0');
  const u_previousLevelA1 = gl.getUniformLocation(ctx.programs.reduction, 'u_previousLevelA1');
  const u_previousLevelA2 = gl.getUniformLocation(ctx.programs.reduction, 'u_previousLevelA2');
  const u_gridSize = gl.getUniformLocation(ctx.programs.reduction, 'u_gridSize');
  const u_slicesPerRow = gl.getUniformLocation(ctx.programs.reduction, 'u_slicesPerRow');
  
  gl.uniform1i(u_previousLevelA0, 0);
  gl.uniform1i(u_previousLevelA1, 1);
  gl.uniform1i(u_previousLevelA2, 2);
  gl.uniform1f(u_gridSize, ctx.levelTargets[targetLevel].gridSize);
  gl.uniform1f(u_slicesPerRow, ctx.levelTargets[targetLevel].slicesPerRow);
  
  // Render full-screen quad
  ctx.checkFBO(`reduction ${sourceLevel}->${targetLevel}`);
  gl.bindVertexArray(ctx.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  // Unbind source texture
  ctx.unbindAllTextures();
  ctx.checkGl(`runReductionPass ${sourceLevel}->${targetLevel}`);
  // Unbind FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
