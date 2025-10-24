// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { KDeposit } from './k-deposit.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: read a specific voxel from a 3D texture laid out in 2D slices
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
 * Test 1: Single particle NGP deposit
 * One particle at known position should deposit correctly into one voxel.
 */
test('KDeposit: single particle NGP deposit', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle at (0, 0, 0) in world space with mass 1.0
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]); // x, y, z, mass
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow; // 8×8
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    assignment: 'ngp'
  });
  
  kernel.run();
  
  if (!kernel.outGrid) throw new Error('kernel.outGrid is null');
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // Particle at (0,0,0) should map to center voxel (2,2,2) in 4³ grid
  // Grid spans [-2,2] in each dimension, so 0 is at center
  const centerVoxel = readVoxel(outData, 2, 2, 2, gridSize, slicesPerRow);
  
  assertClose(centerVoxel[3], 1.0, 0.01, 'Mass deposited to center voxel');
  
  // Check that only one voxel has mass
  let totalMass = 0;
  for (let vz = 0; vz < gridSize; vz++) {
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
        totalMass += voxel[3];
      }
    }
  }
  
  assertClose(totalMass, 1.0, 0.01, 'Total mass conserved');
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL();
});

/**
 * Test 2: Multiple particles NGP deposit
 */
test('KDeposit: multiple particles NGP deposit', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Three particles at different positions
  const posData = new Float32Array([
    -1.0, -1.0, -1.0, 0.5,  // Particle 0
    0.0, 0.0, 0.0, 1.0,     // Particle 1
    1.0, 1.0, 1.0, 0.8,     // Particle 2
    0.0, 0.0, 0.0, 0.0      // Padding
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    assignment: 'ngp'
  });
  
  kernel.run();
  
  if (!kernel.outGrid) throw new Error('kernel.outGrid is null');
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // Check total mass conservation
  let totalMass = 0;
  for (let vz = 0; vz < gridSize; vz++) {
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
        totalMass += voxel[3];
      }
    }
  }
  
  const expectedMass = 0.5 + 1.0 + 0.8;
  assertClose(totalMass, expectedMass, 0.01, 'Total mass conserved');
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL();
});

/**
 * Test 3: CIC deposit with single particle
 */
test('KDeposit: single particle CIC deposit', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle slightly off-center to test CIC interpolation
  const posData = new Float32Array([0.25, 0.25, 0.25, 1.0]); // x, y, z, mass
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const worldBounds = /** @type {{min: [number, number, number], max: [number, number, number]}} */ ({
    min: [-2, -2, -2],
    max: [2, 2, 2]
  });
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds,
    assignment: 'cic'
  });
  
  kernel.run();
  
  if (!kernel.outGrid) throw new Error('kernel.outGrid is null');
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // CIC should distribute mass to 8 neighboring voxels
  // Check that total mass is conserved
  let totalMass = 0;
  for (let vz = 0; vz < gridSize; vz++) {
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
        totalMass += voxel[3];
      }
    }
  }
  
  assertClose(totalMass, 1.0, 0.01, 'Total mass conserved with CIC');
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL();
});

/**
 * Test 4: Output texture creation
 */
test('KDeposit: creates output texture when not provided', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize: 4,
    slicesPerRow: 2,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    assignment: 'ngp'
  });
  
  assert.ok(kernel.outGrid, 'Output texture created (textureSize=' + 8 + '×' + 8 + ')');
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outGrid, 8, 8);
  assertAllFinite(outData, 'Output data is finite');
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL();
});

/**
 * DIAGNOSTIC: Test 5 - Kernel state interrogation
 * Examine internal kernel structure and shader compilation
 */
test('KDeposit.diagnostic: kernel properties and shader compilation', async () => {
  const gl = getGL();
  
  const kernel = new KDeposit({
    gl,
    inPosition: null,
    particleCount: 10,
    particleTexWidth: 4,
    particleTexHeight: 3,
    gridSize: 8,
    slicesPerRow: 3,
    worldBounds: { min: [-4, -4, -4], max: [4, 4, 4] },
    assignment: 'ngp'
  });
  
  // Verify kernel has compiled program
  assert.ok(kernel.program, `Shader program compiled: ${kernel.program ? 'YES' : 'NO'}`);
  assert.ok(gl.getProgramParameter(kernel.program, gl.LINK_STATUS), 
    `Program linked successfully: ${gl.getProgramParameter(kernel.program, gl.LINK_STATUS) ? 'YES' : 'NO'}`);
  
  // Verify configuration storage
  assert.strictEqual(kernel.gridSize, 8, 'gridSize stored correctly');
  assert.strictEqual(kernel.slicesPerRow, 3, 'slicesPerRow stored correctly');
  assert.strictEqual(kernel.particleCount, 10, 'particleCount stored correctly');
  assert.strictEqual(kernel.assignment, 'ngp', 'assignment method stored correctly');
  
  // Verify world bounds
  assert.ok(kernel.worldBounds, 'worldBounds property exists');
  assert.strictEqual(kernel.worldBounds.min[0], -4, 'worldBounds.min[0] correct');
  assert.strictEqual(kernel.worldBounds.max[0], 4, 'worldBounds.max[0] correct');
  
  // Verify output grid was created
  assert.ok(kernel.outGrid, 'Output grid texture created');
  
  disposeKernel(kernel);
  resetGL();
});

/**
 * DIAGNOSTIC: Test 6 - Voxel coordinate mapping verification
 * Ensure particles map to correct voxel indices
 */
test('KDeposit.diagnostic: voxel coordinate mapping', async () => {
  const gl = getGL();
  
  const particleCount = 5;
  const particleTexWidth = 2;
  const particleTexHeight = 3;
  
  // Test positions at grid corners and center
  // Grid bounds: [-2, 2] in each dimension, 4³ cells (size 1.0 each)
  // Need to ensure particles are strictly inside world bounds
  const positions = new Float32Array([
    -1.9, -1.9, -1.9, 1.0,  // Near corner 0
     1.9,  1.9,  1.9, 1.0,  // Near corner 7
     0.0,  0.0,  0.0, 1.0,  // Center
    -0.5,  0.5, -0.5, 1.0,  // Offset 1
     0.5, -0.5,  0.5, 1.0,  // Offset 2
    // Padding
     0.0,  0.0,  0.0, 0.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, positions);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    assignment: 'ngp'
  });
  
  kernel.run();
  
  if (!kernel.outGrid) throw new Error('kernel.outGrid is null');
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // Count number of non-zero voxels
  let nonZeroVoxels = 0;
  let totalMass = 0;
  const voxelMap = new Map();
  
  for (let vz = 0; vz < gridSize; vz++) {
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
        const mass = voxel[3];
        if (mass > 0) {
          nonZeroVoxels++;
          totalMass += mass;
          voxelMap.set(`${vx},${vy},${vz}`, mass);
        }
      }
    }
  }
  
  // Should have exactly 5 non-zero voxels (one per particle with NGP)
  assert.strictEqual(nonZeroVoxels, particleCount, 
    `NGP deposit should have ${particleCount} non-zero voxels, got ${nonZeroVoxels}, voxels=${Array.from(voxelMap.keys()).join(';')}, masses=${Array.from(voxelMap.values()).map(m => m.toFixed(3)).join(',')}`);
  
  assertClose(totalMass, 5.0, 0.01, `Total mass should be 5.0, got ${totalMass}`);
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL();
});

/**
 * DIAGNOSTIC: Test 7 - Mass distribution verification (CIC detail)
 * For CIC, verify that mass is distributed across 8 neighbors correctly
 */
test('KDeposit.diagnostic: CIC mass distribution pattern', async () => {
  const gl = getGL();
  
  const particleCount = 1;
  const particleTexWidth = 1;
  const particleTexHeight = 1;
  
  // Place particle at a known fractional position
  // (0.5, 0.5, 0.5) should split mass equally to 8 neighbors
  const posData = new Float32Array([0.5, 0.5, 0.5, 1.0]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    assignment: 'cic'
  });
  
  kernel.run();
  
  if (!kernel.outGrid) throw new Error('kernel.outGrid is null');
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // Collect all non-zero voxels
  const deposited = [];
  let totalMass = 0;
  
  for (let vz = 0; vz < gridSize; vz++) {
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
        if (voxel[3] > 0) {
          deposited.push({ vx, vy, vz, mass: voxel[3] });
          totalMass += voxel[3];
        }
      }
    }
  }
  
  // CIC should distribute to 8 voxels (at most)
  assert.ok(deposited.length <= 8, 
    `CIC should deposit to at most 8 voxels, got ${deposited.length}`);
  
  assertClose(totalMass, 1.0, 0.01, 
    `Total mass should be 1.0, got ${totalMass}`);
  
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL();
});

/**
 * DIAGNOSTIC: Test 8 - Grid resolution scaling
 * Test that kernel works correctly with different grid sizes
 */
test('KDeposit.diagnostic: grid resolution scaling', async () => {
  const gl = getGL();
  
  const gridSizes = [4, 8, 16];
  
  for (const gridSize of gridSizes) {
    const particleCount = 1;
    const particleTexWidth = 1;
    const particleTexHeight = 1;
    
    const posData = new Float32Array([0.0, 0.0, 0.0, 1.0]);
    const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
    
    const slicesPerRow = Math.ceil(Math.sqrt(gridSize));
    const textureSize = gridSize * slicesPerRow;
    
    const kernel = new KDeposit({
      gl,
      inPosition: posTex,
      particleCount,
      particleTexWidth,
      particleTexHeight,
      gridSize,
      slicesPerRow,
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      assignment: 'ngp'
    });
    
    kernel.run();
    
    if (!kernel.outGrid) throw new Error('kernel.outGrid is null');
    const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
    
    // Verify total mass is conserved
    let totalMass = 0;
    for (let vz = 0; vz < gridSize; vz++) {
      for (let vy = 0; vy < gridSize; vy++) {
        for (let vx = 0; vx < gridSize; vx++) {
          const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
          totalMass += voxel[3];
        }
      }
    }
    
    assertClose(totalMass, 1.0, 0.01, 
      `Grid ${gridSize}³: Total mass should be 1.0, got ${totalMass}`);
    
    // Verify output is finite
    assertAllFinite(outData, `Grid ${gridSize}³: Output data should be finite`);
    
    disposeKernel(kernel);
    gl.deleteTexture(posTex);
  }
  
  resetGL();
});

/**
 * DIAGNOSTIC: Test 9 - World bounds normalization
 * Verify that particles are correctly normalized to grid coordinates
 */
test('KDeposit.diagnostic: world bounds normalization', async () => {
  const gl = getGL();
  
  const boundsPairs = [
    { min: [-1, -1, -1], max: [1, 1, 1] },
    { min: [-4, -4, -4], max: [4, 4, 4] },
    { min: [0, 0, 0], max: [1, 1, 1] },
    { min: [-10, -10, -10], max: [10, 10, 10] }
  ];
  
  for (const bounds of boundsPairs) {
    const particleCount = 1;
    const particleTexWidth = 1;
    const particleTexHeight = 1;
    
    // Place particle at center of world bounds
    const centerX = (bounds.min[0] + bounds.max[0]) / 2;
    const centerY = (bounds.min[1] + bounds.max[1]) / 2;
    const centerZ = (bounds.min[2] + bounds.max[2]) / 2;
    
    const posData = new Float32Array([centerX, centerY, centerZ, 1.0]);
    const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
    
    const gridSize = 4;
    const slicesPerRow = 2;
    const textureSize = gridSize * slicesPerRow;
    
    const kernel = new KDeposit({
      gl,
      inPosition: posTex,
      particleCount,
      particleTexWidth,
      particleTexHeight,
      gridSize,
      slicesPerRow,
      // @ts-ignore - bounds types match at runtime
      worldBounds: bounds,
      assignment: 'ngp'
    });
    
    kernel.run();
    
    if (!kernel.outGrid) throw new Error('kernel.outGrid is null');
    const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
    
    // Check total mass
    let totalMass = 0;
    for (let vz = 0; vz < gridSize; vz++) {
      for (let vy = 0; vy < gridSize; vy++) {
        for (let vx = 0; vx < gridSize; vx++) {
          const voxel = readVoxel(outData, vx, vy, vz, gridSize, slicesPerRow);
          totalMass += voxel[3];
        }
      }
    }
    
    assertClose(totalMass, 1.0, 0.01,
      `Bounds [${bounds.min}..${bounds.max}]: Total mass should be 1.0, got ${totalMass}`);
    
    disposeKernel(kernel);
    gl.deleteTexture(posTex);
  }
  
  resetGL();
});

/**
 * DIAGNOSTIC: Test 10 - Particle out-of-bounds handling
 * Verify that particles outside world bounds are handled safely
 */
test('KDeposit.diagnostic: out-of-bounds particle handling', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Mix of in-bounds and out-of-bounds particles
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,      // In-bounds at center
    10.0, 10.0, 10.0, 1.0,   // Far out-of-bounds
    -10.0, -10.0, -10.0, 1.0, // Far out-of-bounds
    0.0, 0.0, 0.0, 0.0       // Padding
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const textureSize = gridSize * slicesPerRow;
  
  const kernel = new KDeposit({
    gl,
    inPosition: posTex,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    assignment: 'ngp'
  });
  
  // Should not crash
  kernel.run();
  
  if (!kernel.outGrid) throw new Error('kernel.outGrid is null');
  const outData = readTexture(gl, kernel.outGrid, textureSize, textureSize);
  
  // Output should remain finite (no NaNs)
  assertAllFinite(outData, 'Output should be finite even with out-of-bounds particles');
  
  // At minimum, in-bounds particle should be deposited
  let totalMass = 0;
  for (let i = 0; i < outData.length; i += 4) {
    totalMass += outData[i + 3];
  }
  
  assert.ok(totalMass > 0, `Should have at least one in-bounds particle deposited, got mass=${totalMass}`);
  
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  resetGL();
});
