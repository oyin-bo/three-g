// @ts-check

export { upload } from './upload.js';

/**
 * @template {import('..').ParticleCore} TParticle
 * @typedef {{
 *  particles: TParticle[],
 *  stride: number,
 *  dynamicBuffer: WebGLBuffer,
 *  dynamicBufferOut: WebGLBuffer,
 *  dynamicTexture: WebGLTexture,
 *  staticBuffer: WebGLBuffer,
 *  staticBufferOut: WebGLBuffer,
 *  staticTexture: WebGLTexture,
 *  ordersBuffer: WebGLBuffer,
 *  ordersBufferOut: WebGLBuffer,
 *  ordersTexture: WebGLTexture,
 *  uploadProgram: WebGLProgram,
 *  computeState: import('../compute/index.js').GLComputeState,
 * }} ParticleSystemState
 */