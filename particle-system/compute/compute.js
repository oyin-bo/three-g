// @ts-check

import { runPhysics } from './1-physics/run-physics.js';
import { runHilbert } from './2-hilbert/run-hilbert.js';
import { runSorting } from './3-sort/run-sorting.js';

/**
 * @template {import('..').ParticleCore} TParticle
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  state: import('../upload').ParticleSystemState<TParticle>,
 *  gravity: number,
 *  space: Parameters<typeof import('..').particleSystem>[0]['space'],
 *  timeDelta: number
 * }} _
 */
export function compute({ gl, state, gravity, space, timeDelta }) {
  runPhysics({ gl, state, gravity, timeDelta });
  runHilbert(gl, state, space);
  runSorting(gl, state);
}
