// @ts-check

import { computeCore } from './compute';
import { applyCore } from './compute/apply';
import { positionsBufferCore } from './compute/positions-buffer';
import { update } from './update';

export var DEFAULT_GRAVITY = 9.81;

/**
 * @template {import('.').ParticleCore} TParticle
 */
export class ParticleSystem {

    /** @type {WebGLBuffer} */ _cpuOriginalIndexBuffer;

    /** @type {WebGLBuffer} */ _positionsBufferPing;
    /** @type {WebGLBuffer} */ _positionsBufferPong;

    /** @type {WebGLBuffer} */ _velocitiesBufferPing;
    /** @type {WebGLBuffer} */ _velocitiesBufferPong;

    /** @type {WebGLBuffer} */_massBuffer;
  
    /** @type {WebGLBuffer} */_cellSpanOffsetBuffer;
    /** @type {WebGLBuffer} */_cellTotalMassBuffer;

  /**
   * @param {{
   *  gl: WebGL2RenderingContext,
   *  clock?: { now(): number },
   *  gravity?: number,
   *  particles: TParticle[],
   *  get?: (spotFrom: TParticle, coordsTo: import('.').CoordsParam) => void,
   *  apply?: (spotTo: TParticle, coordsFrom: import('.').CoordsParam) => void
   * }} _ 
   */
  constructor({ gl, clock, gravity, particles, get, apply }) {
    this._gl = gl;
    this._clock = clock || Date;
    this._gravity = gravity || DEFAULT_GRAVITY;
    this._particles = particles;

    this._get = get;
    this._apply = apply;

    /** @type {typeof update} */
    this.update = update.bind(this);

    this.compute = this.compute.bind(this);
    this._computeCore = computeCore.bind(this);

    this._applyCore = applyCore.bind(this);
    this._positionsBufferCore = positionsBufferCore.bind(this);

    this._gridDimensions = { x: 16, y: 16, z: 16 };

    this._lastTick = this._clock.now();

    this.update(particles);
  }

  /** @param {number} iterations */
  compute(iterations) {
    const computed = this._lastComputed = {
      positionsBuffer,
      apply,
    };

    for (let i = 0; i < iterations; i++) {
      this._computeCore();
    }

    return computed;

    function positionsBuffer() {
      if (computed !== this._lastComputed) throw new Error('Can only call positionsTexture before the next compute.');
      return this._positionsBufferCore();
    }

    function apply() {
      if (computed !== this._lastComputed) throw new Error('Can only call apply before the next compute.');
      this._applyCore();
    }
  }
}
