// @ts-check

import { upload } from './upload/index.js';

export var DEFAULT_GRAVITY = 9.81;

/**
 * @template {import('.').ParticleCore} TParticle
   * @param {{
   *  gl: WebGL2RenderingContext,
   *  clock?: { now(): number },
   *  gravity?: number,
   *  particles: TParticle[],
   *  get?: (spotFrom: TParticle, coordsTo: import('.').CoordsParam) => void,
   *  apply?: (spotTo: TParticle, coordsFrom: import('.').CoordsParam) => void
   * }} _ 
 */
export function particleSystem({ gl, clock: clockArg, gravity, particles, get, apply }) {

  const clock = clockArg || Date;

  let lastTick = clock.now();

  const system = {
    upload
  };

  const systemState = upload({ gl, particles, get });

  return system;
}
