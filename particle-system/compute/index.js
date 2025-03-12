// @ts-check

import { createPhysicsState } from './1-physics/index.js';

/**
 * @typedef {{
 * physics: import('./1-physics/index.js').GLPhysicsState
 * }} GLComputeState
 */

/**
 * @param {{
 * gl: WebGL2RenderingContext,
 * dynamicBuffer: WebGLBuffer,
 * staticBuffer: WebGLBuffer
 * }} _
 */
export function createComputeState({ gl, dynamicBuffer, staticBuffer }) {
  const computeState = {
    physics: createPhysicsState(gl),
    destroy: destroyComputeState
  };

  return computeState;

  function destroyComputeState() {
    computeState.physics.destroy(); 
  }
}
