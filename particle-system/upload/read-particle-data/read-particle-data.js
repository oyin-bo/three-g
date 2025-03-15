// @ts-check

import { initCoordsObj } from './init-coords-obj.js';
import { storeInWebGLBuffers } from './store-in-gl-buffers.js';

/**
 * @template {import('../..').ParticleCore} TParticle
 * @param {Pick<Parameters<typeof import('..').upload<TParticle>>[0], 'particles' | 'get'> & {
 *  stride: number
 * }} _
 */
export function readParticleData({ particles, get, stride }) {
  let rowCount = (particles.length / stride) | 0;
  if (rowCount * stride < particles.length) rowCount++;

  const dynamicData = new Float32Array(stride * rowCount * 3 * 2);
  const massData = new Float32Array(stride * rowCount);

  const coords = {
    index: 0,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    mass: 0,
    rgb: 0,
  };

  const bounds = {
    x: { min: NaN, max: NaN },
    y: { min: NaN, max: NaN },
    z: { min: NaN, max: NaN },
  };

  const bufState = {
    offset: 0,
    coords,
    dynamicData,
    massData,
    bounds,
  };

  for (let i = 0; i < particles.length; i++) {
    const particle = particles[i];

    initCoordsObj(i, particle, coords);

    if (typeof get === 'function') get(particle, coords);

    bufState.offset = i;
    storeInWebGLBuffers(bufState);
  }

  return {
    dynamicData,
    massData,
    bounds
  };
}
