// @ts-check

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
 * @param {number} i
 * @param {TParticle} particle
 * @param {{ index: any; x: any; y: any; z: any; vx: any; vy: any; vz: any; mass: any; rgb: any; }} coords
 */
export function initCoordsObj(i, particle, coords) {
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
