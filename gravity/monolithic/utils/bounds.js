// Approximate min/max XY from current position texture via sparse GPU readback
export function updateWorldBoundsFromTexture(ctx, sampleCount = 16) {
  const gl = ctx.gl;
  if (!gl || !ctx.positionTextures) return;

  const fbos = ctx.positionTextures.framebuffers;
  const idx = ctx.positionTextures.currentIndex;
  const fbo = fbos[idx];
  if (!fbo) return;

  // Bind the current position FBO once
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  // Some drivers require readBuffer to be set explicitly
  gl.readBuffer(gl.COLOR_ATTACHMENT0);

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  // Coarse row-based sampling to reduce the number of blocking readPixels calls.
  // Instead of calling readPixels per texel (~N calls), read a full row few times and sample
  // within the returned row buffer. This reduces driver round-trips dramatically.
  const w = ctx.textureWidth;
  const h = ctx.textureHeight;

  // Number of rows to sample: roughly sqrt(sampleCount)
  const rows = Math.max(1, Math.floor(Math.sqrt(sampleCount)));
  const stepY = Math.max(1, Math.floor(h / rows));

  // Pre-allocate a row buffer to read one full row at a time (RGBA floats)
  const rowBuf = new Float32Array(w * 4);
  let count = 0;

  for (let r = 0, y = 0; r < rows && y < h; r++, y += stepY) {
    // Read entire row once
    gl.readPixels(0, y, w, 1, gl.RGBA, gl.FLOAT, rowBuf);

    // Sample across the row at intervals to reach ~sampleCount total samples
    const samplesPerRow = Math.max(1, Math.floor(sampleCount / rows));
    const stepX = Math.max(1, Math.floor(w / samplesPerRow));

    for (let x = 0; x < w && count < sampleCount; x += stepX) {
      const i = x * 4;
      const a = rowBuf[i + 3];
      if (a > 0.0) { // mass filter
        const X = rowBuf[i + 0];
        const Y = rowBuf[i + 1];
        const Z = rowBuf[i + 2];
        if (X < minX) minX = X;
        if (Y < minY) minY = Y;
        if (Z < minZ) minZ = Z;
        if (X > maxX) maxX = X;
        if (Y > maxY) maxY = Y;
        if (Z > maxZ) maxZ = Z;
        count++;
      }
    }
  }

  // Unbind FBO
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  if (count > 0 && isFinite(minX) && isFinite(minY) && isFinite(minZ) && isFinite(maxX) && isFinite(maxY) && isFinite(maxZ)) {
    const padX = Math.max(0.5, 0.1 * Math.max(1e-6, (maxX - minX)));
    const padY = Math.max(0.5, 0.1 * Math.max(1e-6, (maxY - minY)));
    const padZ = Math.max(0.5, 0.1 * Math.max(1e-6, (maxZ - minZ)));
    ctx.options.worldBounds = {
      min: [minX - padX, minY - padY, minZ - padZ],
      max: [maxX + padX, maxY + padY, maxZ + padZ]
    };
  }
}
