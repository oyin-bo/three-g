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

/**
 * @param {{
 *   gl: WebGL2RenderingContext,
 *   particles: any[],
 *   get: (particle: any, out: any) => void,
 *   texture: WebGLTexture,
 *   textureWidth: number,
 *   textureHeight: number,
 *   textureIndex: number
 * }} _
 */
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

/**
 * @param {{
 *   gl: WebGL2RenderingContext,
 *   particles: any[],
 *   set: (particle: any, data: any) => void,
 *   texture: WebGLTexture,
 *   textureWidth: number,
 *   textureHeight: number,
 *   textureIndex: number
 * }} _
 */
export function readTextureRgba({
  gl,
  particles,
  set,
  texture,
  textureWidth, textureHeight,
  textureIndex
}) {
  // TODO: read back RGBA texture data into particles array
}