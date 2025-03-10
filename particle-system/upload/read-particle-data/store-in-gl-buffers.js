// @ts-check

/**
 * @param {{
 *  offset: number,
 *  coords: {
 *    x: number,
 *    y: number,
 *    z: number,
 *    vx: number,
 *    vy: number,
 *    vz: number,
 *    mass: number
 *  },
 *  dynamicData: Float32Array,
 *  massData: Float32Array,
 *  bounds: {
 *    x: { min: number, max: number },
 *    y: { min: number, max: number },
 *    z: { min: number, max: number }
 *  }
 * }} _
 */
export function storeInWebGLBuffers({ offset, coords, dynamicData, massData, bounds }) {

  dynamicData[offset * 3 + 0] = coords.x;
  dynamicData[offset * 3 + 1] = coords.y;
  dynamicData[offset * 3 + 2] = coords.z;

  dynamicData[offset * 3 + 3] = coords.vx;
  dynamicData[offset * 3 + 4] = coords.vy;
  dynamicData[offset * 3 + 5] = coords.vz;

  massData[offset] = coords.mass;

  updateAxisBounds(coords.x, bounds.x);
  updateAxisBounds(coords.y, bounds.y);
  updateAxisBounds(coords.z, bounds.z);
}

/**
 * @param {number} value
 * @param {{ max: number, min: number}} bounds
 */
function updateAxisBounds(value, bounds) {
  if (Number.isFinite(value)) {
    if (!Number.isFinite(bounds.max) || value > bounds.max) bounds.max = value;
    if (!Number.isFinite(bounds.min) || value < bounds.min) bounds.min = value;
  }
}