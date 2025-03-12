// @ts-check

import { compute } from './compute/compute.js';
import { upload } from './upload/index.js';

export var DEFAULT_GRAVITY = 9.81;

/**
 * @template {import('.').ParticleCore} TParticle
   * @param {{
   *  gl: WebGL2RenderingContext,
   *  clock?: { now(): number },
   *  gravity?: number,
   *  space?: { x?: { min: number, max: number }, y?: { min: number, max: number }, z?: { min: number, max: number } },
   *  particles: TParticle[],
   *  get?: (spotFrom: TParticle, coordsTo: import('.').CoordsParam) => void,
   *  apply?: (spotTo: TParticle, coordsFrom: import('.').CoordsParam) => void
   * }} _ 
 */
export function particleSystem({ gl, clock: clockArg, gravity, space, particles, get, apply }) {

  const clock = clockArg || Date;

  let lastTick = clock.now();

  const system = {
    upload,
    compute
  };

  const systemState = upload({ gl, particles, get });

  return system;

}
