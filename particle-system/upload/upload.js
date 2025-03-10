// @ts-check

import { createGLBuffer } from './create-gl-buffer.js';
import { readParticleData } from './read-particle-data/index.js';

/**
 * @template {import('..').ParticleCore} TParticle
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  state?: import('./index.js').ParticleSystemState<TParticle>,
 *  get?: (particle: TParticle, coords: import('..').CoordsParam) => void,
 *  particles: import('..').ParticleCore[]
 * }} _
 * @returns {import('./index.js').ParticleSystemState<TParticle>}
 */
export function upload({ gl, state, get, particles }) {

  const {
    dynamicData,
    massData,
    cpuOriginalIndexData,
    bounds,
  } = readParticleData({ particles, get });

  const dynamicBuffer = createGLBuffer(gl, state?.dynamicBuffer, dynamicData);
  const dynamicBufferOut = createGLBuffer(gl, state?.dynamicBufferOut);

  const staticBuffer = createGLBuffer(gl, state?.staticBuffer);
  const staticBufferOut = createGLBuffer(gl, state?.staticBufferOut);

  const ordersBuffer = createGLBuffer(gl, state?.ordersBuffer);
  const ordersBufferOut = createGLBuffer(gl, state?.ordersBufferOut);

  const massUploadBuffer = createGLBuffer(gl, undefined, massData);

  // TODO: reuse or create all the programs
  const uploadProgram = state?.uploadProgram || {};
  const physicsProgram = state?.physicsProgram || {};
  const hilbertProgram = state?.hilbertProgram || {};
  const sortingProgram = state?.sortingProgram || {};

  // TODO: run uploadProgram to propagate data to staticBuffer

  gl.deleteBuffer(massUploadBuffer);

  return {
    dynamicBuffer,
    dynamicBufferOut,
    staticBuffer,
    staticBufferOut,
    ordersBuffer,
    ordersBufferOut,
    uploadProgram,
    physicsProgram,
    hilbertProgram,
    sortingProgram
  };
}
