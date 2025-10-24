// @ts-check

/**
 * Integration test utilities for particle systems.
 * Provides GL context management, particle data generation, physics calculations, and assertions.
 */

/**
 * Creates an offscreen canvas for testing.
 * @param {number} width - Canvas width
 * @param {number} height - Canvas height
 * @returns {HTMLCanvasElement}
 */
export function createTestCanvas(width = 256, height = 256) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Creates a WebGL2 context with required extensions.
 * @param {HTMLCanvasElement} canvas
 * @returns {WebGL2RenderingContext}
 * @throws {Error} If WebGL2 or required extensions are not supported
 */
export function createGLContext(canvas) {
  const gl = canvas.getContext('webgl2');
  if (!gl) {
    throw new Error('WebGL2 not supported');
  }
  
  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) {
    throw new Error('EXT_color_buffer_float not supported');
  }
  
  const floatBlend = gl.getExtension('EXT_float_blend');
  if (!floatBlend) {
    console.warn('EXT_float_blend not supported - blending on float textures may not work');
  }
  
  return gl;
}

/**
 * Cleans up GL context and canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {WebGL2RenderingContext} gl
 */
export function cleanupGL(canvas, gl) {
  if (gl && gl.getExtension('WEBGL_lose_context')) {
    gl.getExtension('WEBGL_lose_context').loseContext();
  }
  if (canvas.parentNode) {
    canvas.parentNode.removeChild(canvas);
  }
}

/**
 * Seeded random number generator for reproducible tests.
 * @param {number} seed
 * @returns {() => number} Random function returning [0, 1)
 */
function createSeededRandom(seed) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Generates uniform random particles.
 * @param {number} count - Number of particles
 * @param {{ min: number[], max: number[] }} bounds - Spatial bounds
 * @param {number} seed - Random seed
 * @returns {{ positions: Float32Array, velocities: Float32Array, masses: Float32Array }}
 */
export function generateUniformParticles(count, bounds, seed = 12345) {
  const random = createSeededRandom(seed);
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  const masses = new Float32Array(count);
  
  for (let i = 0; i < count; i++) {
    positions[i * 4 + 0] = bounds.min[0] + random() * (bounds.max[0] - bounds.min[0]);
    positions[i * 4 + 1] = bounds.min[1] + random() * (bounds.max[1] - bounds.min[1]);
    positions[i * 4 + 2] = bounds.min[2] + random() * (bounds.max[2] - bounds.min[2]);
    positions[i * 4 + 3] = 1.0; // mass
    
    velocities[i * 4 + 0] = 0.0;
    velocities[i * 4 + 1] = 0.0;
    velocities[i * 4 + 2] = 0.0;
    velocities[i * 4 + 3] = 0.0;
    
    masses[i] = 1.0;
  }
  
  return { positions, velocities, masses };
}

/**
 * Generates random particles with velocities.
 * @param {number} count
 * @param {{ min: number[], max: number[] }} bounds
 * @param {number} velocityScale
 * @param {number} seed
 * @returns {{ positions: Float32Array, velocities: Float32Array, masses: Float32Array }}
 */
export function generateRandomParticles(count, bounds, velocityScale = 1.0, seed = 12345) {
  const random = createSeededRandom(seed);
  const positions = new Float32Array(count * 4);
  const velocities = new Float32Array(count * 4);
  const masses = new Float32Array(count);
  
  for (let i = 0; i < count; i++) {
    positions[i * 4 + 0] = bounds.min[0] + random() * (bounds.max[0] - bounds.min[0]);
    positions[i * 4 + 1] = bounds.min[1] + random() * (bounds.max[1] - bounds.min[1]);
    positions[i * 4 + 2] = bounds.min[2] + random() * (bounds.max[2] - bounds.min[2]);
    positions[i * 4 + 3] = 1.0; // mass
    
    velocities[i * 4 + 0] = (random() - 0.5) * 2.0 * velocityScale;
    velocities[i * 4 + 1] = (random() - 0.5) * 2.0 * velocityScale;
    velocities[i * 4 + 2] = (random() - 0.5) * 2.0 * velocityScale;
    velocities[i * 4 + 3] = 0.0;
    
    masses[i] = 1.0;
  }
  
  return { positions, velocities, masses };
}

/**
 * Sets up initial conditions for a binary orbit.
 * @param {number} mass1
 * @param {number} mass2
 * @param {number} separation
 * @param {number} eccentricity
 * @param {number} gravityStrength
 * @returns {{ positions: Float32Array, velocities: Float32Array, masses: Float32Array }}
 */
export function setupBinaryOrbit(mass1, mass2, separation, eccentricity = 0.0, gravityStrength = 0.0003) {
  const positions = new Float32Array(8);
  const velocities = new Float32Array(8);
  const masses = new Float32Array(2);
  
  const totalMass = mass1 + mass2;
  const a = separation / 2.0; // semi-major axis for each particle from COM
  
  // Place particles along x-axis, symmetric about origin (COM)
  const x1 = -a * mass2 / totalMass;
  const x2 = a * mass1 / totalMass;
  
  positions[0] = x1;
  positions[1] = 0.0;
  positions[2] = 0.0;
  positions[3] = mass1;
  
  positions[4] = x2;
  positions[5] = 0.0;
  positions[6] = 0.0;
  positions[7] = mass2;
  
  // Circular orbit velocity: v = sqrt(G * M_total / separation)
  // For circular orbit with eccentricity = 0
  const r = separation;
  const v = Math.sqrt(gravityStrength * totalMass / r);
  
  // Velocities perpendicular to separation (y-direction)
  velocities[0] = 0.0;
  velocities[1] = v * mass2 / totalMass;
  velocities[2] = 0.0;
  velocities[3] = 0.0;
  
  velocities[4] = 0.0;
  velocities[5] = -v * mass1 / totalMass;
  velocities[6] = 0.0;
  velocities[7] = 0.0;
  
  masses[0] = mass1;
  masses[1] = mass2;
  
  return { positions, velocities, masses };
}

/**
 * Reads particle data from system textures.
 * @param {any} system - Particle system with position and velocity textures
 * @param {number} particleIndex
 * @returns {{ position: number[], velocity: number[] }}
 */
export function readParticleData(system, particleIndex) {
  const gl = system.gl;
  const texWidth = system.particleTexWidth || Math.ceil(Math.sqrt(system.options.particleCount));
  const texHeight = Math.ceil(system.options.particleCount / texWidth);
  
  const x = particleIndex % texWidth;
  const y = Math.floor(particleIndex / texWidth);
  
  // Read position
  const posFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.positionPingPong.a, 0);
  const posPixel = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, posPixel);
  gl.deleteFramebuffer(posFbo);
  
  // Read velocity
  const velFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, velFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityPingPong.a, 0);
  const velPixel = new Float32Array(4);
  gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, velPixel);
  gl.deleteFramebuffer(velFbo);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  return {
    position: [posPixel[0], posPixel[1], posPixel[2], posPixel[3]],
    velocity: [velPixel[0], velPixel[1], velPixel[2], velPixel[3]]
  };
}

/**
 * Reads all particle data from system.
 * @param {any} system
 * @returns {{ positions: Float32Array, velocities: Float32Array }}
 */
export function readAllParticleData(system) {
  const gl = system.gl;
  const texWidth = system.particleTexWidth || Math.ceil(Math.sqrt(system.options.particleCount));
  const texHeight = Math.ceil(system.options.particleCount / texWidth);
  
  // Read positions
  const posFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, posFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.positionPingPong.a, 0);
  const positions = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, positions);
  gl.deleteFramebuffer(posFbo);
  
  // Read velocities
  const velFbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, velFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.velocityPingPong.a, 0);
  const velocities = new Float32Array(texWidth * texHeight * 4);
  gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, velocities);
  gl.deleteFramebuffer(velFbo);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  return { positions, velocities };
}

/**
 * Computes center of mass.
 * @param {Float32Array} positions - Particle positions (x,y,z,m per particle)
 * @param {Float32Array} masses - Particle masses
 * @returns {number[]} Center of mass [x, y, z]
 */
export function computeCenterOfMass(positions, masses) {
  let cx = 0, cy = 0, cz = 0, totalMass = 0;
  
  const count = masses.length;
  for (let i = 0; i < count; i++) {
    const m = masses[i];
    cx += positions[i * 4 + 0] * m;
    cy += positions[i * 4 + 1] * m;
    cz += positions[i * 4 + 2] * m;
    totalMass += m;
  }
  
  if (totalMass > 0) {
    cx /= totalMass;
    cy /= totalMass;
    cz /= totalMass;
  }
  
  return [cx, cy, cz];
}

/**
 * Computes total momentum.
 * @param {Float32Array} velocities
 * @param {Float32Array} masses
 * @returns {number[]} Total momentum [px, py, pz]
 */
export function computeTotalMomentum(velocities, masses) {
  let px = 0, py = 0, pz = 0;
  
  const count = masses.length;
  for (let i = 0; i < count; i++) {
    const m = masses[i];
    px += velocities[i * 4 + 0] * m;
    py += velocities[i * 4 + 1] * m;
    pz += velocities[i * 4 + 2] * m;
  }
  
  return [px, py, pz];
}

/**
 * Computes angular momentum.
 * @param {Float32Array} positions
 * @param {Float32Array} velocities
 * @param {Float32Array} masses
 * @returns {number[]} Angular momentum [Lx, Ly, Lz]
 */
export function computeAngularMomentum(positions, velocities, masses) {
  let Lx = 0, Ly = 0, Lz = 0;
  
  const count = masses.length;
  for (let i = 0; i < count; i++) {
    const m = masses[i];
    const x = positions[i * 4 + 0];
    const y = positions[i * 4 + 1];
    const z = positions[i * 4 + 2];
    const vx = velocities[i * 4 + 0];
    const vy = velocities[i * 4 + 1];
    const vz = velocities[i * 4 + 2];
    
    // L = r × mv
    Lx += m * (y * vz - z * vy);
    Ly += m * (z * vx - x * vz);
    Lz += m * (x * vy - y * vx);
  }
  
  return [Lx, Ly, Lz];
}

/**
 * Computes kinetic energy.
 * @param {Float32Array} velocities
 * @param {Float32Array} masses
 * @returns {number}
 */
export function computeKineticEnergy(velocities, masses) {
  let ke = 0;
  
  const count = masses.length;
  for (let i = 0; i < count; i++) {
    const m = masses[i];
    const vx = velocities[i * 4 + 0];
    const vy = velocities[i * 4 + 1];
    const vz = velocities[i * 4 + 2];
    const v2 = vx * vx + vy * vy + vz * vz;
    ke += 0.5 * m * v2;
  }
  
  return ke;
}

/**
 * Computes potential energy.
 * @param {Float32Array} positions
 * @param {Float32Array} masses
 * @param {number} softening
 * @param {number} gravityStrength
 * @returns {number}
 */
export function computePotentialEnergy(positions, masses, softening = 0.2, gravityStrength = 0.0003) {
  let pe = 0;
  const count = masses.length;
  
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      const dx = positions[j * 4 + 0] - positions[i * 4 + 0];
      const dy = positions[j * 4 + 1] - positions[i * 4 + 1];
      const dz = positions[j * 4 + 2] - positions[i * 4 + 2];
      const r2 = dx * dx + dy * dy + dz * dz + softening * softening;
      const r = Math.sqrt(r2);
      
      pe -= gravityStrength * masses[i] * masses[j] / r;
    }
  }
  
  return pe;
}

/**
 * Asserts vector3 is near expected value.
 * @param {number[]} actual
 * @param {number[]} expected
 * @param {number} tolerance
 * @param {string} message
 * @throws {Error}
 */
export function assertVector3Near(actual, expected, tolerance = 1e-5, message = '') {
  for (let i = 0; i < 3; i++) {
    const diff = Math.abs(actual[i] - expected[i]);
    if (diff > tolerance) {
      throw new Error(
        `${message}\nComponent ${i}: expected ${expected[i]}, got ${actual[i]} (diff: ${diff}, tolerance: ${tolerance})`
      );
    }
  }
}

/**
 * Asserts all values are finite.
 * @param {Float32Array | number[]} array
 * @param {string} message
 * @throws {Error}
 */
export function assertAllFinite(array, message = 'Values must be finite') {
  for (let i = 0; i < array.length; i++) {
    if (!isFinite(array[i])) {
      throw new Error(`${message}: array[${i}] = ${array[i]}`);
    }
  }
}

/**
 * Asserts all values are bounded.
 * @param {Float32Array | number[]} array
 * @param {number} maxValue
 * @param {string} message
 * @throws {Error}
 */
export function assertBounded(array, maxValue, message = 'Values must be bounded') {
  for (let i = 0; i < array.length; i++) {
    if (Math.abs(array[i]) > maxValue) {
      throw new Error(`${message}: array[${i}] = ${array[i]} exceeds ${maxValue}`);
    }
  }
}

/**
 * Asserts values decrease monotonically.
 * @param {number[]} values
 * @param {string} message
 * @throws {Error}
 */
export function assertMonotonicDecrease(values, message = 'Values must decrease') {
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[i - 1]) {
      throw new Error(`${message}: values[${i - 1}] = ${values[i - 1]} >= values[${i}] = ${values[i]}`);
    }
  }
}

/**
 * Samples trajectory over time.
 * @param {any} system
 * @param {number} duration
 * @param {number} interval
 * @param {(time: number, data: any) => void} callback
 * @returns {any[]}
 */
export function sampleTrajectory(system, duration, interval, callback) {
  const samples = [];
  let time = 0;
  
  while (time < duration) {
    const data = readAllParticleData(system);
    callback(time, data);
    samples.push({ time, data });
    
    const steps = Math.ceil(interval / system.options.dt);
    for (let i = 0; i < steps; i++) {
      system.compute();
    }
    time += interval;
  }
  
  return samples;
}

/**
 * Dumps trajectory diagnostics for debugging.
 * @param {any[]} snapshots
 * @param {any} expected
 * @param {string} outputPath
 */
export function dumpTrajectoryDiagnostics(snapshots, expected, outputPath = null) {
  console.log('\n=== Trajectory Diagnostics ===');
  console.log(`Snapshots: ${snapshots.length}`);
  
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    console.log(`\nTime: ${snap.time.toFixed(3)}`);
    
    if (snap.data.positions) {
      const count = Math.min(10, snap.data.positions.length / 4);
      for (let j = 0; j < count; j++) {
        const x = snap.data.positions[j * 4 + 0];
        const y = snap.data.positions[j * 4 + 1];
        const z = snap.data.positions[j * 4 + 2];
        console.log(`  Particle ${j}: (${x.toFixed(4)}, ${y.toFixed(4)}, ${z.toFixed(4)})`);
      }
    }
  }
  
  if (expected) {
    console.log('\n=== Expected Values ===');
    console.log(JSON.stringify(expected, null, 2));
  }
  
  console.log('\n=== End Diagnostics ===\n');
}
