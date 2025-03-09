// @ts-check

import { createOrUpdateGlBuffer } from './create-or-update-gl-buffer.js';
import { readParticleData } from './read-particle-data/index.js';
import { sortParticleData } from './sort-particle-data/index.js';

/**
 * @this {import('..').ParticleSystem}
 * @param {import('..').ParticleCore[]} newParticles
 */
export function update(newParticles) {
  this._particles = newParticles;

  const {
    rawPositionData,
    rawVelocityData,
    rawMassData,
    cpuOriginalIndexData,
    bounds,
  } = readParticleData({ particles: this._particles, get: this._get });

  const {
    positionData,
    velocityData,
    massData,
    cellSpanOffsetData,
    cellTotalMassData
  } = sortParticleData({
    particleCount: this._particles.length,
    gridDimensions: this._gridDimensions,
    rawPositionData,
    rawVelocityData,
    rawMassData,
    cpuOriginalIndexData,
    bounds
  });

  this._positionsBufferPing = createOrUpdateGlBuffer(this._gl, this._positionsBufferPing, positionData);
  this._positionsBufferPong = createOrUpdateGlBuffer(this._gl, this._positionsBufferPong);

  this._velocitiesBufferPing = createOrUpdateGlBuffer(this._gl, this._velocitiesBufferPing, velocityData);
  this._velocitiesBufferPong = createOrUpdateGlBuffer(this._gl, this._velocitiesBufferPong);

  this._massBuffer = createOrUpdateGlBuffer(this._gl, this._massBuffer, massData);

  this._cpuOriginalIndexBuffer = createOrUpdateGlBuffer(this._gl, this._cpuOriginalIndexBuffer, cpuOriginalIndexData);

  this._cellSpanOffsetBuffer = createOrUpdateGlBuffer(this._gl, this._cellSpanOffsetBuffer, cellSpanOffsetData);
  this._cellTotalMassBuffer = createOrUpdateGlBuffer(this._gl, this._cellTotalMassBuffer, cellTotalMassData);
}
