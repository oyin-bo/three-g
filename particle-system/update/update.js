// @ts-check

import { createOrUpdateGLBuffer } from './create-or-update-gl-buffer.js';
import { readParticleData } from './read-particle-data/index.js';
import { sortParticleData } from './sort-particle-data/index.js';

/**
 * @this {import('..').ParticleSystem}
 * @param {import('..').ParticleCore[]} newParticles
 */
export function update(newParticles) {
  this._particles = newParticles;

  const {
    positionData,
    velocityData,
    massData,
    cpuOriginalIndexData,
    bounds,
  } = readParticleData({ particles: this._particles, get: this._get });

  this._positionsBufferPing = createOrUpdateGLBuffer(this._gl, this._positionsBufferPing, positionData);
  this._positionsBufferArcPing = createOrUpdateGLBuffer(this._gl, this._positionsBufferArcPing, positionData);
  this._positionsBufferPong = createOrUpdateGLBuffer(this._gl, this._positionsBufferPong);

  this._velocitiesBufferPing = createOrUpdateGLBuffer(this._gl, this._velocitiesBufferPing, velocityData);
  this._velocitiesBufferArcPing = createOrUpdateGLBuffer(this._gl, this._velocitiesBufferArcPing, velocityData);
  this._velocitiesBufferPong = createOrUpdateGLBuffer(this._gl, this._velocitiesBufferPong);

  this._massBuffer = createOrUpdateGLBuffer(this._gl, this._massBuffer, massData);
  this._massArcBuffer = createOrUpdateGLBuffer(this._gl, this._massBuffer, massData);

  this._cpuOriginalIndexBuffer = createOrUpdateGLBuffer(this._gl, this._cpuOriginalIndexBuffer, cpuOriginalIndexData);
}
