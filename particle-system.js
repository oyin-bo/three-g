// @ts-check

export var DEFAULT_GRAVITY = 9.81;

/**
 * @template {{
 *  x?: number,
 *  y?: number,
 *  z?: number,
 *  vx?: number,
 *  vy?: number,
 *  vz?: number,
 *  mass?: number,
 *  rgb?: number
 * }} TParticle
 *
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  clock?: { now(): number },
 *  gravity?: number,
 *  particles: TParticle[],
 *  get?: (spot: TParticle, coords: {
 *    index: number,
 *    x: number, y: number, z: number,
 *    vx: number, vy: number, vz: number,
 *    mass: number,
 *    rgb: number
 *  }) => void,
 *  apply?: (spot: TParticle, coords: {
 *    index: number,
 *    x: number, y: number, z: number,
 *    vx: number, vy: number, vz: number,
 *    mass: number,
 *    rgb: number
 *  }) => void
 * }} _ 
 */
export function particleSystem({ gl, clock, gravity, particles, get, apply }) {

  const outcome = {
    update,
    compute
  };

  var
    /** @type {WebGLBuffer} */ indexBuffer,

    /** @type {WebGLBuffer} */ positionsBufferPing,
    /** @type {WebGLBuffer} */ positionsBufferPong,

    /** @type {WebGLBuffer} */ velocitiesBufferPing,
    /** @type {WebGLBuffer} */ velocitiesBufferPong,

    /** @type {WebGLBuffer} */massBuffer;

  update(particles);

  /** @param {TParticle[]} newParticles */
  function update(newParticles) {
    particles = newParticles;

    const positionData = new Float32Array(particles.length * 3);
    const velocityData = new Float32Array(particles.length * 3);
    const massData = new Float32Array(particles.length);

    const indexData = new Int32Array(particles.length);

    const coords = {
      index: 0,
      x: 0, y: 0, z: 0,
      vx: 0, vy: 0, vz: 0,
      mass: 0,
      rgb: 0
    };

    let minX = NaN, minY = NaN, minZ = NaN;
    let maxX = NaN, maxY = NaN, maxZ = NaN;

    for (let i = 0; i < particles.length; i++) {
      const particle = particles[i];
      indexData[i] = i;

      initCoords(i, particle);

      if (typeof get === 'function') get(particle, coords);

      storeInBuffers(i);
    }

    positionsBufferPing = createOrUpdateBuffer(gl, positionsBufferPing, positionData);
    positionsBufferPong = createOrUpdateBuffer(gl, positionsBufferPong, positionData);

    velocitiesBufferPing = createOrUpdateBuffer(gl, velocitiesBufferPing, velocityData);
    velocitiesBufferPong = createOrUpdateBuffer(gl, velocitiesBufferPong, velocityData);

    massBuffer = createOrUpdateBuffer(gl, massBuffer, massData);

    indexBuffer = createOrUpdateBuffer(gl, indexBuffer, indexData);

    function initCoords(i, particle) {
      coords.index = i;
      coords.x = particle.x || 0;
      coords.y = particle.y || 0;
      coords.z = particle.z || 0;
      coords.vx = particle.vx || 0;
      coords.vy = particle.vy || 0;
      coords.vz = particle.vz || 0;
      coords.mass = particle.mass || 0;
      coords.rgb = particle.rgb || 0;
    }

    /** @param {number} i */
    function storeInBuffers(i) {
      positionData[i * 3 + 0] = coords.x;
      positionData[i * 3 + 1] = coords.y;
      positionData[i * 3 + 2] = coords.z;

      if (Number.isFinite(coords.x)) {
        if (isNaN(maxX) || coords.x > maxX) maxX = coords.x;
        if (isNaN(minX) || coords.x < minX) minX = coords.x;
      }
      if (Number.isFinite(coords.y)) {
        if (isNaN(maxY) || coords.y > maxY) maxY = coords.y;
        if (isNaN(minY) || coords.y < minY) minY = coords.y;
      }
      if (Number.isFinite(coords.z)) {
        if (isNaN(maxZ) || coords.z > maxZ) maxZ = coords.z;
        if (isNaN(minZ) || coords.z < minZ) minZ = coords.z;
      }

      velocityData[i * 3 + 0] = coords.vx;
      velocityData[i * 3 + 1] = coords.vy;
      velocityData[i * 3 + 2] = coords.vz;

      massData[i] = coords.mass;
    }
  }

  var lastComputed;
  /** @param {number} iterations */
  function compute(iterations) {
    const computed = lastComputed = {
      positionsBuffer,
      apply,
    };

    computeCore();

    function positionsBuffer() {
      if (computed !== lastComputed) throw new Error('Can only call positionsTexture before the next compute.');
      return positionsBufferCore();
    }

    function apply() {
      if (computed !== lastComputed) throw new Error('Can only call apply before the next compute.');
      applyCore();
    }
  }

  function computeCore() {
  }

  function applyCore() {
  }

  function positionsBufferCore() {
  }
}


/**
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLBuffer} buffer
 * @param {ArrayBufferView} data
 */
function createOrUpdateBuffer(gl, buffer, data) {
  if (!buffer) {
    buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_COPY); // Use DYNAMIC_COPY for frequent updates
  } else {
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data); // Update existing buffer data
  }
  return buffer;
}
