// @ts-check

import { test } from 'node:test';
import assert, { AssertionError } from 'node:assert';
import { KForceSample } from './k-force-sample.js';
import { getGL, createTestTexture, readTexture, assertClose, assertAllFinite, disposeKernel, resetGL } from '../test-utils.js';

/**
 * Helper: create force grid texture with known values
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number) => number} valueFunc
 */
function createForceGrid(gl, gridSize, slicesPerRow, valueFunc) {
  const textureSize = gridSize * slicesPerRow;
  const data = new Float32Array(textureSize * textureSize * 4);
  const worldMin = -2, worldMax = 2;
  const worldExtent = worldMax - worldMin;
  
  for (let vz = 0; vz < gridSize; vz++) {
    const sliceRow = Math.floor(vz / slicesPerRow);
    const sliceCol = vz % slicesPerRow;
    
    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const texelX = sliceCol * gridSize + vx;
        const texelY = sliceRow * gridSize + vy;
        const idx = (texelY * textureSize + texelX) * 4;
        
        // Convert voxel coordinates to world coordinates at voxel center
        const wx = worldMin + (vx + 0.5) * worldExtent / gridSize;
        const wy = worldMin + (vy + 0.5) * worldExtent / gridSize;
        const wz = worldMin + (vz + 0.5) * worldExtent / gridSize;
        const value = valueFunc(wx, wy, wz);
        // Store force component in alpha channel
        data[idx + 0] = value;
        data[idx + 1] = value;
        data[idx + 2] = value;
        data[idx + 3] = value;
      }
    }
  }
  
  return createTestTexture(gl, textureSize, textureSize, data);
}

/**
 * Test 1: Output texture creation
 */
test('KForceSample: creates output texture when not provided', async () => {
  const gl = getGL();
  
  const particleCount = 4;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    1.0, 1.0, 1.0, 1.0,
    -1.0, -1.0, -1.0, 1.0,
    0.5, 0.5, 0.5, 1.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 2.0);
  const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 3.0);
  
  const kernel = new KForceSample({
    gl,
    inPosition: posTex,
    inForceGridX: forceGridX,
    inForceGridY: forceGridY,
    inForceGridZ: forceGridZ,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  assert.ok(kernel.outForce, 'Output force texture created (w=' + particleTexWidth + ', h=' + particleTexHeight + ')');
  assert.ok(kernel.ownsOutForce, 'Kernel owns output texture (ownsOutForce=' + kernel.ownsOutForce + ')');
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outForce, particleTexWidth, particleTexHeight);
  assertAllFinite(outData, 'Output force data is finite');
  
  kernel.inPosition = null;
  kernel.inForceGridX = null;
  kernel.inForceGridY = null;
  kernel.inForceGridZ = null;
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  gl.deleteTexture(forceGridX);
  gl.deleteTexture(forceGridY);
  gl.deleteTexture(forceGridZ);
  resetGL();
});

/**
 * Test 2: Uniform force field produces uniform particle forces
 */
test('KForceSample: uniform force field produces expected forces', async () => {
  const gl = getGL();
  
  const particleCount = 4;
  const particleTexWidth = 2;
  const particleTexHeight = 2;

  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    0.5, 0.5, 0.5, 1.0,
    -0.5, -0.5, -0.5, 1.0,
    0.0, 0.0, 0.0, 0.0  // Padding
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  // Create uniform force grids
  const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.5);
  const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 2.5);
  const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 3.5);
  const snapshots = [];
  const recordSnapshot = (phase, kernel) => {
    snapshots.push({
      phase,
      entries: [
        { label: 'inPosition', texture: posTex, isTexture: posTex ? gl.isTexture(posTex) : false },
        { label: 'forceGridX', texture: forceGridX, isTexture: forceGridX ? gl.isTexture(forceGridX) : false },
        { label: 'forceGridY', texture: forceGridY, isTexture: forceGridY ? gl.isTexture(forceGridY) : false },
        { label: 'forceGridZ', texture: forceGridZ, isTexture: forceGridZ ? gl.isTexture(forceGridZ) : false },
        { label: 'outForce', texture: kernel?.outForce ?? null, isTexture: kernel?.outForce ? gl.isTexture(kernel.outForce) : false },
      ],
    });
  };

  let kernel = null;
  let error = null;
  let outData = null;

  try {
    kernel = new KForceSample({
      gl,
      inPosition: posTex,
      inForceGridX: forceGridX,
      inForceGridY: forceGridY,
      inForceGridZ: forceGridZ,
      particleCount,
      particleTexWidth,
      particleTexHeight,
      gridSize,
      slicesPerRow,
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      accumulate: false
    });

    recordSnapshot('created', kernel);
    recordSnapshot('pre-run', kernel);

    kernel.run();

    recordSnapshot('post-run', kernel);

    outData = readTexture(gl, kernel.outForce, particleTexWidth, particleTexHeight);

    assertClose(outData[0], 1.5, 0.1, 'Particle 0 force X');
    assertClose(outData[1], 2.5, 0.1, 'Particle 0 force Y');
    assertClose(outData[2], 3.5, 0.1, 'Particle 0 force Z');

    assertClose(outData[4], 1.5, 0.1, 'Particle 1 force X');
    assertClose(outData[5], 2.5, 0.1, 'Particle 1 force Y');
    assertClose(outData[6], 3.5, 0.1, 'Particle 1 force Z');
  } catch (err) {
    error = err;
  } finally {
    const invalidEntries = [];
    for (const snap of snapshots) {
      for (const entry of snap.entries) {
        if (entry.texture && !entry.isTexture) {
          invalidEntries.push({ phase: snap.phase, label: entry.label });
        }
      }
    }

    if (invalidEntries.length > 0) {
      const report = JSON.stringify(snapshots.map((snap) => ({
        phase: snap.phase,
        entries: snap.entries.map((entry) => ({
          label: entry.label,
          hasTexture: !!entry.texture,
          isTexture: entry.isTexture,
        })),
      })), null, 2);
      const message = 'WebGL texture lifecycle invalidation detected:\n' + report;
      if (error) {
        error.message += '\n' + message;
      } else {
        error = new AssertionError({ message });
      }
    }

    if (kernel) {
      kernel.inPosition = null;
      kernel.inForceGridX = null;
      kernel.inForceGridY = null;
      kernel.inForceGridZ = null;
      disposeKernel(kernel);
    }
    gl.deleteTexture(posTex);
    gl.deleteTexture(forceGridX);
    gl.deleteTexture(forceGridY);
    gl.deleteTexture(forceGridZ);
    resetGL();
  }

  if (error) {
    throw error;
  }
});

/**
 * Test 3: Accumulate mode adds to existing forces
 */
test('KForceSample: accumulate mode adds forces', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    0.0, 0.0, 0.0, 1.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  
  // First pass: replace mode
  const kernel1 = new KForceSample({
    gl,
    inPosition: posTex,
    inForceGridX: forceGridX,
    inForceGridY: forceGridY,
    inForceGridZ: forceGridZ,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    accumulate: false
  });
  
  kernel1.run();
  const outData1 = readTexture(gl, kernel1.outForce, particleTexWidth, particleTexHeight);
  const force1X = outData1[0];
  
  // Second pass: accumulate mode on same texture
  const kernel2 = new KForceSample({
    gl,
    inPosition: posTex,
    inForceGridX: forceGridX,
    inForceGridY: forceGridY,
    inForceGridZ: forceGridZ,
    outForce: kernel1.outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    accumulate: true
  });
  
  kernel2.run();
  const outData2 = readTexture(gl, kernel1.outForce, particleTexWidth, particleTexHeight);
  const force2X = outData2[0];
  
  // Force should be approximately doubled
  assertClose(force2X, force1X * 2, 0.2, 'Accumulated force is doubled');
  
  kernel1.inPosition = null;
  kernel1.inForceGridX = null;
  kernel1.inForceGridY = null;
  kernel1.inForceGridZ = null;
  disposeKernel(kernel1);
  kernel2.inPosition = null;
  kernel2.inForceGridX = null;
  kernel2.inForceGridY = null;
  kernel2.inForceGridZ = null;
  kernel2.dispose(); // Note: kernel2 doesn't own outForce
  gl.deleteTexture(posTex);
  gl.deleteTexture(forceGridX);
  gl.deleteTexture(forceGridY);
  gl.deleteTexture(forceGridZ);
  resetGL();
});

/**
 * Test 4: Spatial variation in force grid
 */
test('KForceSample: samples spatially varying force field', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Particles at different positions
  const posData = new Float32Array([
    -1.5, 0.0, 0.0, 1.0,  // Left side
    1.5, 0.0, 0.0, 1.0,   // Right side
    0.0, 0.0, 0.0, 1.0,   // Center
    0.0, 0.0, 0.0, 0.0    // Padding
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  // Create force grid with X-dependent force
  const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => x * 2.0);
  const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 0.0);
  const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 0.0);
  
  const kernel = new KForceSample({
    gl,
    inPosition: posTex,
    inForceGridX: forceGridX,
    inForceGridY: forceGridY,
    inForceGridZ: forceGridZ,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outForce, particleTexWidth, particleTexHeight);
  
  const force0X = outData[0];
  const force1X = outData[4];
  const force2X = outData[8];
  
  // Left particle should have negative force, right positive, center near zero
  assert.ok(force0X < 0, 'Left particle has negative X force: Fx0=' + force0X);
  assert.ok(force1X > 0, 'Right particle has positive X force: Fx1=' + force1X);
  assert.ok(Math.abs(force2X) < Math.abs(force0X), 'Center particle has smaller |Fx|: |Fx_center|=' + Math.abs(force2X) + ' vs |Fx_left|=' + Math.abs(force0X));
  
  kernel.inPosition = null;
  kernel.inForceGridX = null;
  kernel.inForceGridY = null;
  kernel.inForceGridZ = null;
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  gl.deleteTexture(forceGridX);
  gl.deleteTexture(forceGridY);
  gl.deleteTexture(forceGridZ);
  resetGL();
});

/**
 * Test 5: Particles outside bounds
 */
test('KForceSample: handles particles near boundaries', async () => {
  const gl = getGL();
  
  const particleCount = 4;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // Particles at/near boundaries
  const posData = new Float32Array([
    -1.99, -1.99, -1.99, 1.0,  // Near min bound
    1.99, 1.99, 1.99, 1.0,     // Near max bound
    0.0, 0.0, 0.0, 1.0,        // Center
    -2.1, 0.0, 0.0, 1.0        // Slightly outside (should wrap)
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  
  const kernel = new KForceSample({
    gl,
    inPosition: posTex,
    inForceGridX: forceGridX,
    inForceGridY: forceGridY,
    inForceGridZ: forceGridZ,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outForce, particleTexWidth, particleTexHeight);
  
  // All particles should get finite forces
  assertAllFinite(outData, 'Forces are finite at boundaries');
  
  kernel.inPosition = null;
  kernel.inForceGridX = null;
  kernel.inForceGridY = null;
  kernel.inForceGridZ = null;
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  gl.deleteTexture(forceGridX);
  gl.deleteTexture(forceGridY);
  gl.deleteTexture(forceGridZ);
  resetGL();
});

/**
 * Test 6: Different grid sizes
 */
test('KForceSample: works with different grid sizes', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    0.5, 0.5, 0.5, 1.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  for (const gridSize of [4, 8, 16]) {
    const slicesPerRow = Math.ceil(Math.sqrt(gridSize));
    
    const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
    const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
    const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
    
    const kernel = new KForceSample({
      gl,
      inPosition: posTex,
      inForceGridX: forceGridX,
      inForceGridY: forceGridY,
      inForceGridZ: forceGridZ,
      particleCount,
      particleTexWidth,
      particleTexHeight,
      gridSize,
      slicesPerRow,
      worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
    });
    
    kernel.run();
    
    const outData = readTexture(gl, kernel.outForce, particleTexWidth, particleTexHeight);
    assertAllFinite(outData, `Forces finite for gridSize=${gridSize}`);
    
    kernel.inPosition = null;
    kernel.inForceGridX = null;
    kernel.inForceGridY = null;
    kernel.inForceGridZ = null;
    disposeKernel(kernel);
    gl.deleteTexture(forceGridX);
    gl.deleteTexture(forceGridY);
    gl.deleteTexture(forceGridZ);
  }
  
  gl.deleteTexture(posTex);
  resetGL();
});

/**
 * Test 7: External texture provision
 */
test('KForceSample: uses provided output texture', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    0.0, 0.0, 0.0, 1.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  
  // Create external output texture
  const outForce = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, outForce);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, particleTexWidth, particleTexHeight, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  const kernel = new KForceSample({
    gl,
    inPosition: posTex,
    inForceGridX: forceGridX,
    inForceGridY: forceGridY,
    inForceGridZ: forceGridZ,
    outForce,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  assert.strictEqual(kernel.outForce, outForce, 'Uses provided output texture');
  assert.ok(!kernel.ownsOutForce, 'Kernel does not own provided texture (ownsOutForce=' + kernel.ownsOutForce + ')');
  
  kernel.run();
  
  const outData = readTexture(gl, outForce, particleTexWidth, particleTexHeight);
  assertAllFinite(outData, 'External texture written successfully');
  
  kernel.inPosition = null;
  kernel.inForceGridX = null;
  kernel.inForceGridY = null;
  kernel.inForceGridZ = null;
  kernel.dispose();
  gl.deleteTexture(posTex);
  gl.deleteTexture(forceGridX);
  gl.deleteTexture(forceGridY);
  gl.deleteTexture(forceGridZ);
  gl.deleteTexture(outForce);
  resetGL();
});

/**
 * Test 8: Error handling - missing inputs
 */
test('KForceSample: throws error when inputs not set', async () => {
  const gl = getGL();
  
  const kernel = new KForceSample({
    gl,
    inPosition: null,
    inForceGridX: null,
    inForceGridY: null,
    inForceGridZ: null,
    particleCount: 4,
    particleTexWidth: 2,
    particleTexHeight: 2,
    gridSize: 4,
    slicesPerRow: 2,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  assert.throws(() => {
    kernel.run();
  }, /texture not set/, 'Throws error when inputs not set');
  
  kernel.inPosition = null;
  kernel.inForceGridX = null;
  kernel.inForceGridY = null;
  kernel.inForceGridZ = null;
  disposeKernel(kernel);
  resetGL();
});

/**
 * Test 9: Multiple particles at same location
 */
test('KForceSample: handles multiple particles at same location', async () => {
  const gl = getGL();
  
  const particleCount = 3;
  const particleTexWidth = 2;
  const particleTexHeight = 2;
  
  // All particles at same location
  const posData = new Float32Array([
    0.5, 0.5, 0.5, 1.0,
    0.5, 0.5, 0.5, 1.0,
    0.5, 0.5, 0.5, 1.0,
    0.0, 0.0, 0.0, 0.0  // Padding
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => x * 1.0);
  const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => y * 1.0);
  const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => z * 1.0);
  
  const kernel = new KForceSample({
    gl,
    inPosition: posTex,
    inForceGridX: forceGridX,
    inForceGridY: forceGridY,
    inForceGridZ: forceGridZ,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  kernel.run();
  
  const outData = readTexture(gl, kernel.outForce, particleTexWidth, particleTexHeight);
  
  // All particles should get similar forces
  const force0 = [outData[0], outData[1], outData[2]];
  const force1 = [outData[4], outData[5], outData[6]];
  const force2 = [outData[8], outData[9], outData[10]];
  
  assertClose(force0[0], force1[0], 0.01, 'Particles at same location get same X force');
  assertClose(force0[1], force1[1], 0.01, 'Particles at same location get same Y force');
  assertClose(force0[2], force1[2], 0.01, 'Particles at same location get same Z force');
  assertClose(force1[0], force2[0], 0.01, 'All particles get consistent forces');
  
  kernel.inPosition = null;
  kernel.inForceGridX = null;
  kernel.inForceGridY = null;
  kernel.inForceGridZ = null;
  disposeKernel(kernel);
  gl.deleteTexture(posTex);
  gl.deleteTexture(forceGridX);
  gl.deleteTexture(forceGridY);
  gl.deleteTexture(forceGridZ);
  resetGL();
});

/**
 * Test 10: Disposal cleans up resources
 */
test('KForceSample: dispose cleans up owned resources', async () => {
  const gl = getGL();
  
  const particleCount = 2;
  const particleTexWidth = 2;
  const particleTexHeight = 1;
  
  const posData = new Float32Array([
    0.0, 0.0, 0.0, 1.0,
    0.0, 0.0, 0.0, 1.0
  ]);
  const posTex = createTestTexture(gl, particleTexWidth, particleTexHeight, posData);
  
  const gridSize = 4;
  const slicesPerRow = 2;
  
  const forceGridX = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridY = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  const forceGridZ = createForceGrid(gl, gridSize, slicesPerRow, (x, y, z) => 1.0);
  
  const kernel = new KForceSample({
    gl,
    inPosition: posTex,
    inForceGridX: forceGridX,
    inForceGridY: forceGridY,
    inForceGridZ: forceGridZ,
    particleCount,
    particleTexWidth,
    particleTexHeight,
    gridSize,
    slicesPerRow,
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] }
  });
  
  kernel.run();
  
  const outForce = kernel.outForce;
  
  kernel.dispose();
  
  // Texture should be deleted
  assert.ok(!gl.isTexture(outForce), 'Output force texture disposed (isTexture=' + gl.isTexture(outForce) + ')');
  
  gl.deleteTexture(posTex);
  gl.deleteTexture(forceGridX);
  gl.deleteTexture(forceGridY);
  gl.deleteTexture(forceGridZ);
  resetGL(gl);
});
