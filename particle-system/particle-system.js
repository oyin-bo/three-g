// @ts-check

import { DEFAULT_SPACE } from './compute/2-hilbert/run-hilbert.js';
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
export function particleSystem({ gl, clock: clockArg, gravity, space: spaceArg, particles, get, apply }) {

  const clock = clockArg || Date;

  let lastTick = clock.now();

  const system = {
    upload: callUpload,
    compute: callCompute
  };

  const space = {
    x: { min: spaceArg?.x?.min ?? DEFAULT_SPACE.x.min, max: spaceArg?.x?.max ?? DEFAULT_SPACE.x?.max },
    y: { min: spaceArg?.y?.min ?? DEFAULT_SPACE.y.min, max: spaceArg?.y?.max ?? DEFAULT_SPACE.y?.max },
    z: { min: spaceArg?.z?.min ?? DEFAULT_SPACE.z.min, max: spaceArg?.z?.max ?? DEFAULT_SPACE.z?.max }
  };

  let systemState = upload({ gl, particles, get });

  return system;

  /**
   * @param {TParticle[]} particles
   */
  function callUpload(particles) {
    systemState = upload({ gl, state: systemState, particles, get });
  }

  function callCompute() {
    const now = clock.now();
    const timeDelta = now - lastTick;
    lastTick = now;

    compute({
      gl,
      state: systemState,
      space,
      gravity: gravity ?? DEFAULT_GRAVITY,
      timeDelta
    });

    // TODO: return apply and buffer
  }
}
