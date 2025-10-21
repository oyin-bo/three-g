// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KAggregator } from './k-aggregator.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: fill a 3D voxel texture laid out in 2D slices (square texture)
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number) => [number, number, number, number]} valueFunc
 */
function fillVoxelTexture(gl, gridSize, slicesPerRow, valueFunc) {
  const textureSize = gridSize * slicesPerRow;
  const data = new Float32Array(textureSize * textureSize * 4);
  
  for (let vz = 0; vz < gridSize; vz++) {
    const sliceRow = Math.floor(vz / slicesPerRow);
    const sliceCol = vz % slicesPerRow;
    
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const texelX = sliceCol * gridSize + vx;
        const texelY = sliceRow * gridSize + vy;
        const idx = (texelY * textureSize + texelX) * 4;
        
        const [r, g, b, a] = valueFunc(vx, vy, vz);
        data[idx + 0] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = a;
      }
    }
  }
  
  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Helper: read a specific voxel from a texture
 * @param {Float32Array} textureData
 * @param {number} vx
 * @param {number} vy
 * @param {number} vz
 * @param {number} gridSize
 * @param {number} slicesPerRow
 */
function readVoxel(textureData, vx, vy, vz, gridSize, slicesPerRow) {
  const textureSize = gridSize * slicesPerRow;
  const sliceRow = Math.floor(vz / slicesPerRow);
  const sliceCol = vz % slicesPerRow;
  const texelX = sliceCol * gridSize + vx;
  const texelY = sliceRow * gridSize + vy;
  const idx = (texelY * textureSize + texelX) * 4;
  
  return [
    textureData[idx + 0],
    textureData[idx + 1],
    textureData[idx + 2],
    textureData[idx + 3]
  ];
}

/**
 * Test 1: Single particle aggregation
 * One particle at known position should deposit correctly into one voxel.
 */
test('KAggregator: single particle aggregation', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle at (0, 0, 0) in world space
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]); // x, y, z, mass
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow; // 8×8
  
  const outA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    outA0,
    outA1,
    outA2,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: true // Use for single particle test
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, outA0, octreeSize, octreeSize);
  const resultA1 = readTexture(gl, outA1, octreeSize, octreeSize);
  const resultA2 = readTexture(gl, outA2, octreeSize, octreeSize);
  
  assertAllFinite(resultA0, 'A0 must be finite');
  assertAllFinite(resultA1, 'A1 must be finite');
  assertAllFinite(resultA2, 'A2 must be finite');
  
  // Particle at (0,0,0) world → center voxel (2,2,2) in 4×4×4 grid
  const [a0_r, a0_g, a0_b, a0_a] = readVoxel(resultA0, 2, 2, 2, gridSize, slicesPerRow);
  
  // A0 should contain: (mass*x, mass*y, mass*z, mass)
  assertClose(a0_r, 0.0, 1e-5, 'A0.r (mass*x)');
  assertClose(a0_g, 0.0, 1e-5, 'A0.g (mass*y)');
  assertClose(a0_b, 0.0, 1e-5, 'A0.b (mass*z)');
  assertClose(a0_a, 1.0, 1e-5, 'A0.a (mass)');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 2: Multiple particles in same voxel
 * Particles that map to the same voxel should accumulate via blending.
 */
test('KAggregator: multiple particles same voxel with blending', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Three particles all in center voxel [2,2,2] (world range [0,1])
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,  // particle 0 at center
    0.1, 0.1, 0.1, 2.0,  // particle 1 slightly offset
    0.2, 0.2, 0.2, 1.5,  // particle 2 further offset (still in [0,1])
    0.0, 0.0, 0.0, 0.0   // unused
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const outA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    outA0, outA1, outA2,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: false // Enable blending
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, outA0, octreeSize, octreeSize);
  
  // Center voxel should accumulate all three particles
  const [a0_r, a0_g, a0_b, a0_a] = readVoxel(resultA0, 2, 2, 2, gridSize, slicesPerRow);
  
  // Total mass = 1.0 + 2.0 + 1.5 = 4.5
  // Total mass*x = 0*1 + 0.1*2 + 0.2*1.5 = 0 + 0.2 + 0.3 = 0.5
  
  // Add diagnostics if test fails
  if (Math.abs(a0_r - 0.5) > 1e-4) {
    // Check all voxels to see where data went
    let voxelsWithData = [];
    for (let z = 0; z < gridSize; z++) {
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const voxel = readVoxel(resultA0, x, y, z, gridSize, slicesPerRow);
          if (voxel[3] > 0) {
            voxelsWithData.push({
              coords: [x,y,z],
              mass: voxel[3],
              massX: voxel[0],
              massY: voxel[1],
              massZ: voxel[2]
            });
          }
        }
      }
    }
    
    const diagnostics = {
      centerVoxel: { r: a0_r, g: a0_g, b: a0_b, a: a0_a },
      voxelsWithData,
      expectedMassX: 0.5,
      expectedMass: 4.5
    };
    assert.ok(false, 'KAggregator blending failed - diagnostics: ' + JSON.stringify(diagnostics, null, 2));
  }
  
  assertClose(a0_r, 0.5, 1e-4, 'A0.r (sum mass*x)');
  assertClose(a0_a, 4.5, 1e-4, 'A0.a (sum mass)');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 3: Particles in different voxels
 * Particles at different positions should map to different voxels.
 */
test('KAggregator: particles in different voxels', async () => {
  const gl = getGL();
  
  const particleCount = 4;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Four particles at corners of world space
  const posData = new Float32Array([
    -1.5, -1.5, -1.5, 1.0,  // corner 0,0,0
    1.5, 1.5, 1.5, 1.0,     // corner 3,3,3
    -1.5, 1.5, -1.5, 1.0,   // corner 0,3,0
    1.5, -1.5, 1.5, 1.0     // corner 3,0,3
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const outA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    outA0, outA1, outA2,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: true
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, outA0, octreeSize, octreeSize);
  
  // Check corner voxels have mass
  const corner000 = readVoxel(resultA0, 0, 0, 0, gridSize, slicesPerRow);
  const corner333 = readVoxel(resultA0, 3, 3, 3, gridSize, slicesPerRow);
  const corner030 = readVoxel(resultA0, 0, 3, 0, gridSize, slicesPerRow);
  const corner303 = readVoxel(resultA0, 3, 0, 3, gridSize, slicesPerRow);
  
  // Add diagnostics if test would fail
  if (Math.abs(corner000[3] - 1.0) > 1e-4) {
    // Check which voxels have data
    let voxelsWithData = [];
    for (let z = 0; z < gridSize; z++) {
      for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
          const voxel = readVoxel(resultA0, x, y, z, gridSize, slicesPerRow);
          if (voxel[3] > 0) {
            voxelsWithData.push({ 
              coords: [x,y,z], 
              mass: voxel[3], 
              pos: [voxel[0]/voxel[3], voxel[1]/voxel[3], voxel[2]/voxel[3]]
            });
          }
        }
      }
    }
    
    // Calculate expected voxel coords for each particle
    const worldMin = [-2, -2, -2];
    const worldMax = [2, 2, 2];
    const expectedVoxels = [
      { particle: [-1.5, -1.5, -1.5], expected: [0,0,0] },
      { particle: [1.5, 1.5, 1.5], expected: [3,3,3] },
      { particle: [-1.5, 1.5, -1.5], expected: [0,3,0] },
      { particle: [1.5, -1.5, 1.5], expected: [3,0,3] }
    ].map(p => {
      const norm = [
        (p.particle[0] - worldMin[0]) / (worldMax[0] - worldMin[0]),
        (p.particle[1] - worldMin[1]) / (worldMax[1] - worldMin[1]),
        (p.particle[2] - worldMin[2]) / (worldMax[2] - worldMin[2])
      ];
      const voxel = norm.map(n => Math.floor(n * gridSize));
      return { ...p, norm, voxel };
    });
    
    const diagnostics = {
      corner000: corner000,
      corner333: corner333,
      corner030: corner030,
      corner303: corner303,
      voxelsWithData,
      expectedVoxels,
      gridSize,
      worldBounds: { min: worldMin, max: worldMax }
    };
    assert.ok(false, 'KAggregator failed - diagnostics:\n' + JSON.stringify(diagnostics, null, 2));
  }
  
  assertClose(corner000[3], 1.0, 1e-4, 'Corner (0,0,0) mass');
  assertClose(corner333[3], 1.0, 1e-4, 'Corner (3,3,3) mass');
  
  // Check center voxel is empty
  const center = readVoxel(resultA0, 2, 2, 2, gridSize, slicesPerRow);
  assertClose(center[3], 0.0, 1e-5, 'Center should be empty');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 4: Quadrupole moments (A1, A2)
 * Verify second moments are calculated correctly.
 */
test('KAggregator: quadrupole moments', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Particle at (1, 1, 1) with mass 2
  const posData = new Float32Array([1.0, 1.0, 1.0, 2.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const outA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    outA0, outA1, outA2,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: true
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, outA0, octreeSize, octreeSize);
  const resultA1 = readTexture(gl, outA1, octreeSize, octreeSize);
  const resultA2 = readTexture(gl, outA2, octreeSize, octreeSize);
  
  // Particle maps to voxel (3, 3, 3) since it's at positive coords
  const [a0_r, a0_g, a0_b, a0_a] = readVoxel(resultA0, 3, 3, 3, gridSize, slicesPerRow);
  const [a1_r, a1_g, a1_b, a1_a] = readVoxel(resultA1, 3, 3, 3, gridSize, slicesPerRow);
  const [a2_r, a2_g] = readVoxel(resultA2, 3, 3, 3, gridSize, slicesPerRow);
  
  // A0: (m*x, m*y, m*z, m) = (2, 2, 2, 2)
  assertClose(a0_r, 2.0, 1e-4, 'A0.r (m*x)');
  assertClose(a0_g, 2.0, 1e-4, 'A0.g (m*y)');
  assertClose(a0_b, 2.0, 1e-4, 'A0.b (m*z)');
  assertClose(a0_a, 2.0, 1e-4, 'A0.a (m)');
  
  // A1: (m*x², m*y², m*z², m*xy) = (2, 2, 2, 2)
  assertClose(a1_r, 2.0, 1e-4, 'A1.r (m*x²)');
  assertClose(a1_g, 2.0, 1e-4, 'A1.g (m*y²)');
  assertClose(a1_b, 2.0, 1e-4, 'A1.b (m*z²)');
  assertClose(a1_a, 2.0, 1e-4, 'A1.a (m*xy)');
  
  // A2: (m*xz, m*yz) = (2, 2)
  assertClose(a2_r, 2.0, 1e-4, 'A2.r (m*xz)');
  assertClose(a2_g, 2.0, 1e-4, 'A2.g (m*yz)');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 5: Out of bounds particles
 * Particles outside world bounds should be clamped or ignored.
 */
test('KAggregator: out of bounds particles', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  // One particle in bounds, one way out of bounds
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,    // in bounds
    100.0, 100.0, 100.0, 1.0 // far out of bounds
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const outA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    outA0, outA1, outA2,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: true
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, outA0, octreeSize, octreeSize);
  
  // Center voxel should have one particle
  const center = readVoxel(resultA0, 2, 2, 2, gridSize, slicesPerRow);
  assertClose(center[3], 1.0, 1e-4, 'Center voxel should have one particle');
  
  // Out-of-bounds particle should clamp to edge voxel (3,3,3)
  const edge = readVoxel(resultA0, 3, 3, 3, gridSize, slicesPerRow);
  assertClose(edge[3], 1.0, 1e-4, 'Edge voxel should have clamped particle');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 6: Zero mass particles
 * Particles with zero mass should not contribute.
 */
test('KAggregator: zero mass particles', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 0.0,   // zero mass
    1.0, 1.0, 1.0, 3.0    // normal mass
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const octreeSize = gridSize * slicesPerRow;
  
  const outA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    outA0, outA1, outA2,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: true
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, outA0, octreeSize, octreeSize);
  
  // Center voxel should be empty (zero mass particle doesn't contribute)
  const center = readVoxel(resultA0, 2, 2, 2, gridSize, slicesPerRow);
  assertClose(center[3], 0.0, 1e-5, 'Zero mass should not contribute');
  
  // Other voxel should have the normal particle
  const other = readVoxel(resultA0, 3, 3, 3, gridSize, slicesPerRow);
  assertClose(other[3], 3.0, 1e-4, 'Normal mass particle');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 7: Large particle count
 * Stress test with many particles.
 */
test('KAggregator: large particle count', async () => {
  const gl = getGL();
  
  const particleCount = 100;
  const particleTexWidth = 10;
  const particleTexHeight = 10;
  
  // Create 100 particles distributed in a grid pattern
  const posData = new Float32Array(particleTexWidth * particleTexHeight * 4);
  for (let i = 0; i < particleCount; i++) {
    const x = (i % 10) / 5 - 1; // -1 to 1
    const y = Math.floor(i / 10) / 5 - 1;
    const z = 0;
    posData[i * 4 + 0] = x;
    posData[i * 4 + 1] = y;
    posData[i * 4 + 2] = z;
    posData[i * 4 + 3] = 1.0; // unit mass
  }
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 8;
  const slicesPerRow = 4;
  const octreeSize = gridSize * slicesPerRow;
  
  const outA0 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA1 = createTestTexture(gl, octreeSize, octreeSize, null);
  const outA2 = createTestTexture(gl, octreeSize, octreeSize, null);
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({ min: [-2, -2, -2], max: [2, 2, 2] });
  
  const kernel = new KAggregator({
    gl,
    inPosition: posTex,
    outA0, outA1, outA2,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    octreeSize,
    gridSize,
    slicesPerRow,
    worldBounds,
    disableFloatBlend: false
  });
  
  kernel.run();
  
  const resultA0 = readTexture(gl, outA0, octreeSize, octreeSize);
  
  assertAllFinite(resultA0, 'Result must be finite');
  
  // Count total mass in all voxels
  let totalMass = 0;
  for (let i = 3; i < resultA0.length; i += 4) {
    totalMass += resultA0[i];
  }
  
  // Should equal particle count (each has mass 1)
  assertClose(totalMass, particleCount, 1e-2, 'Total mass should equal particle count');
  
  disposeKernel(kernel);
  resetGL();
});
