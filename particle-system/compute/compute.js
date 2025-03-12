// @ts-check

import { computePositionsVelocities } from './1-physics/compute-positions-velocities.js';
import { createPhysicsState } from './1-physics/create-physics-state.js';

/**
 * @template {import('..').ParticleCore} TParticle
 * @param {import('../upload').ParticleSystemState<TParticle>} state
 */
export function compute(state) {
  if (!this._computeState)
    this._computeState = createPhysicsState(this._gl);

  computePositionsVelocities(
    /** @type {Parameters<typeof computePositionsVelocities>[0]} */(this));
}