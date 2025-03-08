// @ts-check

import { createOrUpdateGlBuffer } from './create-or-update-gl-buffer';
import { initCoordsObj } from './init-coords-obj';
import { storeInGlBuffers } from './store-in-gl-buffers';

const CELL_COUNT_X = 16;
const CELL_COUNT_Y = 16;
const CELL_COUNT_Z = 16;

/**
 * @this {import('../').ParticleSystem}
 * @param {import('../').ParticleCore[]} newParticles
 */
export function update(newParticles) {
  this._particles = newParticles;

  const rawPositionData = new Float32Array(this._particles.length * 3);
  const rawVelocityData = new Float32Array(this._particles.length * 3);
  const rawMassData = new Float32Array(this._particles.length);

  const cpuOriginalIndexData = new Int32Array(this._particles.length);

  const coords = {
    index: 0,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    mass: 0,
    rgb: 0
  };

  const bounds = {
    x: { min: NaN, max: NaN },
    y: { min: NaN, max: NaN },
    z: { min: NaN, max: NaN }
  };

  const bufState = {
    offset: 0,
    coords,
    positionData: rawPositionData,
    velocityData: rawVelocityData,
    massData: rawMassData,
    bounds
  };

  for (let i = 0; i < this._particles.length; i++) {
    const particle = this._particles[i];
    cpuOriginalIndexData[i] = i;

    initCoordsObj(i, particle, coords);

    if (typeof this._get === 'function') this._get(particle, coords);

    bufState.offset = i;
    storeInGlBuffers(bufState);
  }

  // sorting of the data

  const cellWidth = (bounds.x.max - bounds.x.min) / CELL_COUNT_X;
  const cellHeight = (bounds.y.max - bounds.y.min) / CELL_COUNT_Y;
  const cellDepth = (bounds.z.max - bounds.z.min) / CELL_COUNT_Z;

  const getCellIndex = (particle) => {
    const cellX = Math.floor((particle.x - bounds.x.min) / cellWidth);
    const cellY = Math.floor((particle.y - bounds.y.min) / cellHeight);
    const cellZ = Math.floor((particle.z - bounds.z.min) / cellDepth);
    return cellZ * CELL_COUNT_Y * CELL_COUNT_X + cellY * CELL_COUNT_X + cellX;
  };

  cpuOriginalIndexData.sort((indexA, indexB) => {
    const particleA = this._particles[indexA];
    const particleB = this._particles[indexB];
    return getCellIndex(particleA) - getCellIndex(particleB);
  });

  // the sorting order is now in cpuOriginalIndexData
  // we need to rearrange the data in positionData, velocityData, massData, and cpuOriginalIndexData

  const positionData = new Float32Array(this._particles.length * 3);
  const velocityData = new Float32Array(this._particles.length * 3);
  const massData = new Float32Array(this._particles.length);
  for (let i = 0; i < cpuOriginalIndexData.length; i++) {
    const originalIndex = cpuOriginalIndexData[i];
    positionData[i * 3 + 0] = rawPositionData[originalIndex * 3 + 0];
    positionData[i * 3 + 1] = rawPositionData[originalIndex * 3 + 1];
    positionData[i * 3 + 2] = rawPositionData[originalIndex * 3 + 2];

    velocityData[i * 3 + 0] = rawVelocityData[originalIndex * 3 + 0];
    velocityData[i * 3 + 1] = rawVelocityData[originalIndex * 3 + 1];
    velocityData[i * 3 + 2] = rawVelocityData[originalIndex * 3 + 2];

    massData[i] = rawMassData[originalIndex];
  }

  // tesselation

  const cellCount = CELL_COUNT_X * CELL_COUNT_Y * CELL_COUNT_Z;

  const cellSpanOffsetData = new Int32Array(cellCount);
  const cellTotalMassData = new Float32Array(cellCount);
  cellSpanOffsetData.fill(-1); // Or another appropriate initial value, -1 as a sentinel.
  cellTotalMassData.fill(0);

  // Populate the span offset data and cell total mass data
  for (let i = 0; i < this._particles.length; i++) {
    const particle = this._particles[i];
    const cellIndex = getCellIndex(particle);

    // Update span offset data
    if (cellSpanOffsetData[cellIndex] === -1) {
      cellSpanOffsetData[cellIndex] = i;
    }

    // Update cell total mass data
    cellTotalMassData[cellIndex] += particle.mass;
  }


  this._positionsBufferPing = createOrUpdateGlBuffer(this._gl, this._positionsBufferPing, positionData);
  this._positionsBufferPong = createOrUpdateGlBuffer(this._gl, this._positionsBufferPong);

  this._velocitiesBufferPing = createOrUpdateGlBuffer(this._gl, this._velocitiesBufferPing, velocityData);
  this._velocitiesBufferPong = createOrUpdateGlBuffer(this._gl, this._velocitiesBufferPong);

  this._massBuffer = createOrUpdateGlBuffer(this._gl, this._massBuffer, massData);

  this._cpuOriginalIndexBuffer = createOrUpdateGlBuffer(this._gl, this._cpuOriginalIndexBuffer, cpuOriginalIndexData);

  this._cellSpanOffsetBuffer = createOrUpdateGlBuffer(this._gl, this._cellSpanOffsetBuffer, cellSpanOffsetData);
  this._cellTotalMassBuffer = createOrUpdateGlBuffer(this._gl, this._cellTotalMassBuffer, cellTotalMassData);
}
