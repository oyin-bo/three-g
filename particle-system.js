// @ts-check

/**
 * @typedef {{
 *  positionMassTexture: WebGLTexture,
 *  velocityColorTexture: WebGLTexture,
 *  step(): void
 * }} ForceComputation
 */

export class ParticleSystem {
  /**
   * @param {{
   *  gl: WebGL2RenderingContext,
   *  forces: ForceComputation[],
   *  positionMassTexture?: WebGLTexture,
   *  velocityColorTexture?: WebGLTexture
   * }} _
   */
  constructor({
    gl,
    forces
  }) {
  }

  step() {
    // TODO: possibly trigger world bounds update
    // TODO: kick each force computation
    // TODO: integrate positions and velocities
    // TODO: swap buffers for next frame
  }

  dispose() {
  }
}

export function writeTextureRgba({
  gl,
  particles,
  get,
  texture,
  textureWidth, textureHeight,
  textureIndex
}) {
  // TODO: write particles array data into RGBA texture
}

export function readTextureRgba(
  gl,
  particles,
  set,
  texture,
  textureWidth, textureHeight,
  textureIndex
}) {
  // TODO: read back RGBA texture data into particles array
}