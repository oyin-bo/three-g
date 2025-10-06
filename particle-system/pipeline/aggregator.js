// Aggregate particles into L0 using additive blending.
// Each particle contributes: (sum_x, sum_y, mass, count)
export function aggregateParticlesIntoL0(ctx) {
  const gl = ctx.gl;
  
  // Clear any pending GL errors from previous operations (e.g., Three.js)
  while (gl.getError() !== gl.NO_ERROR) {}
  
  gl.useProgram(ctx.programs.aggregation);

  // Avoid feedback: ensure no textures are bound except the ones we set below
  ctx.unbindAllTextures();

  // Bind L0 framebuffer and set viewport
  gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.levelFramebuffers[0]);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  const L0 = ctx.levelTextures[0].size;
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
  
  // Debug: read particle position data to verify input
  if (ctx.frameCount < 1) {
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, ctx.positionTextures.getCurrentTexture(), 0);
    const px = new Float32Array(20); // 5 particles
    gl.readPixels(0, 0, 5, 1, gl.RGBA, gl.FLOAT, px);
    console.log(`Aggregation input: First 5 particles:`, 
      `P0=(${px[0].toFixed(2)},${px[1].toFixed(2)},${px[2].toFixed(2)}) m=${px[3].toFixed(2)}`,
      `P1=(${px[4].toFixed(2)},${px[5].toFixed(2)},${px[6].toFixed(2)}) m=${px[7].toFixed(2)}`);
    gl.deleteFramebuffer(fb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.levelFramebuffers[0]); // Restore
  }

  // Set uniforms
  const u_texSize = gl.getUniformLocation(ctx.programs.aggregation, 'u_texSize');
  const u_worldMin = gl.getUniformLocation(ctx.programs.aggregation, 'u_worldMin');
  const u_worldMax = gl.getUniformLocation(ctx.programs.aggregation, 'u_worldMax');
  const u_gridSize = gl.getUniformLocation(ctx.programs.aggregation, 'u_gridSize');
  const u_slicesPerRow = gl.getUniformLocation(ctx.programs.aggregation, 'u_slicesPerRow');
  
  if (ctx.frameCount < 1) {
    const min = ctx.options.worldBounds.min;
    const max = ctx.options.worldBounds.max;
    console.log(`Aggregation uniforms: worldBounds=(${min[0]},${min[1]},${min[2]}) to (${max[0]},${max[1]},${max[2]}), gridSize=${ctx.octreeGridSize}, slicesPerRow=${ctx.octreeSlicesPerRow}`);
  }
  
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

  // Assert we're not simultaneously sampling and rendering into the same texture
  const attachedTex = gl.getFramebufferAttachmentParameter(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME);
  const posTex = ctx.positionTextures.getCurrentTexture();
  if (attachedTex === posTex) {
    console.error('Plan M: FEEDBACK DETECTED - L0 FBO is the same texture as positions being sampled.');
  }

  // Draw particles as points using gl_VertexID
  // console.log('Plan M draw: aggregateParticlesIntoL0');
  ctx.checkFBO('aggregate L0');
  ctx.checkGl('aggregate L0 (before draw)');
  gl.bindVertexArray(ctx.particleVAO);
  
  if (ctx.frameCount < 1) {
    console.log(`Aggregation: Drawing ${ctx.options.particleCount} particles, blend=${!ctx._disableFloatBlend}, L0 size=${L0}`);
  }
  
  gl.drawArrays(gl.POINTS, 0, ctx.options.particleCount);
  gl.bindVertexArray(null);
  ctx.checkGl('aggregate L0 (after draw)');

  gl.disable(gl.BLEND);
  
  // Debug: read back L0 to find any non-zero mass  
  if (ctx.frameCount < 1) {
    // Sample full texture row by row to find where particles landed
    const rowsToSample = 16; // Sample 16 rows across the 512-height texture
    const step = Math.floor(L0 / rowsToSample);
    let totalMass = 0;
    let totalCount = 0;
    
    for (let row = 0; row < rowsToSample; row++) {
      const px = new Float32Array(L0 * 4);
      gl.readPixels(0, row * step, L0, 1, gl.RGBA, gl.FLOAT, px);
      for (let i = 0; i < px.length; i += 4) {
        if (px[i+3] > 0) {
          totalMass += px[i+3];
          totalCount++;
        }
      }
    }
    
    console.log(`Frame ${ctx.frameCount}: L0 sampled ${rowsToSample} rows: totalMass=${totalMass.toFixed(2)}, voxelCount=${totalCount}, expected~500 particles`);
  }
  
  // Unbind input texture
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
