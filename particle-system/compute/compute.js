// @ts-check

import { runPhysics } from './1-physics/run-physics.js';
import { runHilbert } from './2-hilbert/run-hilbert.js';

/**
 * @template {import('..').ParticleCore} TParticle
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  state: import('../upload').ParticleSystemState<TParticle>,
 *  space: Parameters<typeof import('..').particleSystem>[0]['space'],
 *  timeDelta: number
 * }} _
 */
export function compute({ gl, state, space, timeDelta }) {
  runPhysics(gl, state, timeDelta);
  runHilbert(gl, state, space);

  // TODO: run sorting stage, make sure the ping-pongs are settled in the right state (ping has the current data)
}
