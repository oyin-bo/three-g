// Barnes–Hut traversal to compute force texture
export function calculateForces(ctx) {
  const gl = ctx.gl;
  
  // Use quadrupole shader if Plan C enabled, otherwise use standard monopole shader
  const useQuadrupoles = ctx.options.planC && ctx.programs.traversalQuadrupole;
  const program = useQuadrupoles ? ctx.programs.traversalQuadrupole : ctx.programs.traversal;
  
  gl.useProgram(program);
  // Avoid feedback
  ctx.unbindAllTextures();

  // Bind force framebuffer
  gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.forceTexture.framebuffer);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.viewport(0, 0, ctx.textureWidth, ctx.textureHeight);
  gl.disable(gl.SCISSOR_TEST);
  gl.scissor(0, 0, ctx.textureWidth, ctx.textureHeight);

  // Bind particle positions
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, ctx.positionTextures.getCurrentTexture());
  gl.uniform1i(gl.getUniformLocation(program, 'u_particlePositions'), 0);

  if (useQuadrupoles) {
    // Bind texture arrays for Plan C (3 texture arrays instead of 24 individual textures)
    // This reduces texture unit usage from 25 (exceeds limit) to 4 (within limit)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_levelsA0'), 1);
    
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA1);
    gl.uniform1i(gl.getUniformLocation(program, 'u_levelsA1'), 2);
    
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, ctx.levelTextureArrayA2);
    gl.uniform1i(gl.getUniformLocation(program, 'u_levelsA2'), 3);
    
    // Enable/disable quadrupole evaluation (for A/B testing)
    const enableQuadrupoles = ctx.debugFlags.enableQuadrupoles !== false;
    gl.uniform1i(gl.getUniformLocation(program, 'u_enableQuadrupoles'), enableQuadrupoles ? 1 : 0);
  } else {
    // Bind monopole-only levels (standard)
    for (let i = 0; i < Math.min(8, ctx.numLevels); i++) {
      gl.activeTexture(gl.TEXTURE1 + i);
      gl.bindTexture(gl.TEXTURE_2D, ctx.levelTextures[i].texture);
      const loc = gl.getUniformLocation(program, `u_quadtreeLevel${i}`);
      if (loc) gl.uniform1i(loc, 1 + i);
    }
  }

  // Uniforms (use active program, not ctx.programs.traversal)
  gl.uniform1f(gl.getUniformLocation(program, 'u_theta'), ctx.options.theta);
  gl.uniform1i(gl.getUniformLocation(program, 'u_numLevels'), ctx.numLevels);
  gl.uniform2f(gl.getUniformLocation(program, 'u_texSize'), ctx.textureWidth, ctx.textureHeight);
  gl.uniform1i(gl.getUniformLocation(program, 'u_particleCount'), ctx.options.particleCount);
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMin'), 
    ctx.options.worldBounds.min[0], 
    ctx.options.worldBounds.min[1],
    ctx.options.worldBounds.min[2]);
  gl.uniform3f(gl.getUniformLocation(program, 'u_worldMax'), 
    ctx.options.worldBounds.max[0], 
    ctx.options.worldBounds.max[1],
    ctx.options.worldBounds.max[2]);
  gl.uniform1f(gl.getUniformLocation(program, 'u_softening'), ctx.options.softening);
  gl.uniform1f(gl.getUniformLocation(program, 'u_G'), ctx.options.gravityStrength);

  // Cell sizes, grid sizes, and slices per row per level
  const cellSizes = new Float32Array(8);
  const gridSizes = new Float32Array(8);
  const slicesPerRow = new Float32Array(8);
  
  // World extent (use max dimension for isotropic cell size)
  const worldExtent = [
    ctx.options.worldBounds.max[0] - ctx.options.worldBounds.min[0],
    ctx.options.worldBounds.max[1] - ctx.options.worldBounds.min[1],
    ctx.options.worldBounds.max[2] - ctx.options.worldBounds.min[2]
  ];
  const worldSize = Math.max(...worldExtent);
  
  // Calculate per-level parameters
  let currentGridSize = ctx.octreeGridSize;
  let currentSlicesPerRow = ctx.octreeSlicesPerRow;
  let cellSize = worldSize / currentGridSize;
  
  for (let i = 0; i < 8; i++) {
    cellSizes[i] = cellSize;
    gridSizes[i] = currentGridSize;
    slicesPerRow[i] = currentSlicesPerRow;
    
    // Next level: halve grid dimensions
    currentGridSize = Math.max(1, Math.floor(currentGridSize / 2));
    currentSlicesPerRow = Math.max(1, Math.floor(currentSlicesPerRow / 2));
    cellSize *= 2.0;
  }
  
  gl.uniform1fv(gl.getUniformLocation(program, 'u_cellSizes'), cellSizes);
  gl.uniform1fv(gl.getUniformLocation(program, 'u_gridSizes'), gridSizes);
  gl.uniform1fv(gl.getUniformLocation(program, 'u_slicesPerRow'), slicesPerRow);

  // Draw quad
  ctx.checkFBO('calculateForces');
  gl.bindVertexArray(ctx.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);

  // Unbind textures
  ctx.unbindAllTextures();
  ctx.checkGl('calculateForces');
  // Unbind FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}
