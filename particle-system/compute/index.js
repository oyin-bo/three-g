// @ts-check

import { createPhysicsState } from './1-physics/index.js';
import { createHilbertState } from './2-hilbert/create-hilbert-state.js';

/**
 * @typedef {{
 *  physics: import('./1-physics').GLPhysicsState,
 *  hilbert: import('./2-hilbert').GLHilbertState
 * }} GLComputeState
 */

/**
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  dynamicBuffer: WebGLBuffer,
 *  staticBuffer: WebGLBuffer
 * }} _
 */
export function createComputeState({ gl, dynamicBuffer, staticBuffer }) {
  const computeState = {
    physics: createPhysicsState(gl),
    hilbert: createHilbertState(gl),
    destroy: destroyComputeState
  };

  return computeState;

  function destroyComputeState() {
    computeState.physics.destroy(); 
  }
}
