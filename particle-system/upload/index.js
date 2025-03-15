// @ts-check

export { upload } from './upload.js';

/**
 * @template {import('..').ParticleCore} TParticle
 * @typedef {{
 *  particles: TParticle[],
 *  stride: number,
 *  textures: {
 *    dynamic: WebGLTexture, dynamicOut: WebGLTexture,
 *    static: WebGLTexture, staticOut: WebGLTexture,
 *    orders: WebGLTexture, ordersOut: WebGLTexture
 *  },
 *  uploadProgram: WebGLProgram,
 *  computeState: import('../compute/index.js').GLComputeState,
 * }} ParticleSystemState
 */