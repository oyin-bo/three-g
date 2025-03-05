// @ts-check

export var DEFAULT_GRAVITY = 9.81;

/**
 * @template {{
 *  x?: number,
 *  y?: number,
 *  z?: number,
 *  vx?: number,
 *  vy?: number,
 *  vz?: number,
 *  mass?: number,
 *  rgb?: number
 * }} TParticle
 *
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  clock?: { now(): number },
 *  gravity?: number,
 *  particles: TParticle[],
 *  get?: (spot: TParticle, coords: {
 *    index: number,
 *    x: number, y: number, z: number,
 *    vx: number, vy: number, vz: number,
 *    mass: number,
 *    rgb: number
 *  }) => void,
 *  apply?: (spot: TParticle, coords: {
 *    index: number,
 *    x: number, y: number, z: number,
 *    vx: number, vy: number, vz: number,
 *    mass: number,
 *    rgb: number
 *  }) => void
 * }} _ 
 */
export function particleSystem({ gl, clock, gravity, particles, get, apply }) {

  /** @param {TParticle[]} particles */
  function loadUpdates(particles) {
  }

  /** @param {number} iterations */
  function compute(iterations) {
  }

  function unloadComputed() {
  }
}