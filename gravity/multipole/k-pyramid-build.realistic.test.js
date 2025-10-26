// @ts-check

import assert from 'node:assert';
import { test } from 'node:test';

import { assertClose, createTestTexture, disposeKernel, getGL, readTexture, resetGL } from '../test-utils.js';
import { KPyramidBuild } from './k-pyramid-build.js';

/**
 * @param {number} gridSize
 * @param {number} slicesPerRow
 */
function textureDimensions(gridSize, slicesPerRow) {
  const width = gridSize * slicesPerRow;
  const sliceRows = Math.ceil(gridSize / slicesPerRow);
  const height = gridSize * sliceRows;
  return { width, height };
}

/**
 * Helper: fill a 3D voxel texture laid out in 2D slices
 * @param {WebGL2RenderingContext} gl
 * @param {number} gridSize
 * @param {number} slicesPerRow
 * @param {(x: number, y: number, z: number) => [number, number, number, number]} valueFunc
 */
function fillVoxelTexture(gl, gridSize, slicesPerRow, valueFunc) {
  const { width, height } = textureDimensions(gridSize, slicesPerRow);
  const data = new Float32Array(width * height * 4);

  for (let vz = 0; vz < gridSize; vz++) {
    const sliceRow = Math.floor(vz / slicesPerRow);
    const sliceCol = vz % slicesPerRow;

    for (let vy = 0; vy < gridSize; vy++) {
      for (let vx = 0; vx < gridSize; vx++) {
        const texelX = sliceCol * gridSize + vx;
        const texelY = sliceRow * gridSize + vy;
        const idx = (texelY * width + texelX) * 4;

        const [r, g, b, a] = valueFunc(vx, vy, vz);
        data[idx + 0] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = a;
      }
    }
  }

  return createTestTexture(gl, width, height, data);
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
  const { width, height } = textureDimensions(gridSize, slicesPerRow);
  const sliceRow = Math.floor(vz / slicesPerRow);
  const sliceCol = vz % slicesPerRow;
  const texelX = sliceCol * gridSize + vx;
  const texelY = sliceRow * gridSize + vy;
  const idx = (texelY * width + texelX) * 4;

  return [
    textureData[idx + 0],
    textureData[idx + 1],
    textureData[idx + 2],
    textureData[idx + 3]
  ];
}

/**
 * Test: Full 64→32→16→8 pyramid chain matching convergence test configuration
 */
test('KPyramidBuild.realistic: 64→32→16→8 pyramid chain with two particles', async () => {
  const gl = getGL();

  // Level 0: 64×64×64 grid with 8 slices per row
  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0Width, height: l0Height } = textureDimensions(l0GridSize, l0SlicesPerRow);

  // Level 1: 32×32×32 grid with 4 slices per row
  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1Width, height: l1Height } = textureDimensions(l1GridSize, l1SlicesPerRow);

  // Level 2: 16×16×16 grid with 4 slices per row
  const l2GridSize = 16;
  const l2SlicesPerRow = 4;
  const { width: l2Width, height: l2Height } = textureDimensions(l2GridSize, l2SlicesPerRow);

  // Level 3: 8×8×8 grid with 2 slices per row
  const l3GridSize = 8;
  const l3SlicesPerRow = 2;
  const { width: l3Width, height: l3Height } = textureDimensions(l3GridSize, l3SlicesPerRow);

  // Create L0 with two particles matching convergence test:
  // P0 at voxel [44, 32, 32] with mass 1.0
  // P1 at voxel [32, 32, 32] with mass 10.0
  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    if (x === 44 && y === 32 && z === 32) return [0, 0, 0, 1.0];   // P0
    if (x === 32 && y === 32 && z === 32) return [0, 0, 0, 10.0];  // P1
    return [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);

  // Build L0→L1
  const kernel1 = new KPyramidBuild({
    gl,
    outSize: l1Width,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel1.run();

  // Check L1: P0 maps to [22,16,16], P1 maps to [16,16,16]
  if (!kernel1.outA0) throw new Error('kernel1.outA0 should exist');
  const l1Result = readTexture(gl, kernel1.outA0, l1Width, l1Height);
  const l1P0Mass = readVoxel(l1Result, 22, 16, 16, l1GridSize, l1SlicesPerRow)[3];
  const l1P1Mass = readVoxel(l1Result, 16, 16, 16, l1GridSize, l1SlicesPerRow)[3];

  // Diagnostic: total mass in L1
  let l1TotalDiag = 0;
  const l1NonZeroVoxels = [];
  for (let i = 3; i < l1Result.length; i += 4) {
    if (l1Result[i] > 0) {
      l1TotalDiag += l1Result[i];
      const idx = (i - 3) / 4;
      l1NonZeroVoxels.push({ idx, mass: l1Result[i].toFixed(4) });
    }
  }

  const diagL1 = `\n  L0→L1 TRANSITION DETAILS:\n` +
    `    Input: L0 texture ${l0Width}×${l0Height} (gridSize=${l0GridSize}, slicesPerRow=${l0SlicesPerRow})\n` +
    `    Output: L1 texture ${l1Width}×${l1Height} (gridSize=${l1GridSize}, slicesPerRow=${l1SlicesPerRow})\n` +
    `    Coordinate mapping: gridSize halves ${l0GridSize}→${l1GridSize}, slicesPerRow halves ${l0SlicesPerRow}→${l1SlicesPerRow}\n` +
    `    P0: L0[44,32,32] → L1[${Math.floor(44 / 2)},${Math.floor(32 / 2)},${Math.floor(32 / 2)}] = [22,16,16] mass=${l1P0Mass.toFixed(4)} (expected 1.0)\n` +
    `    P1: L0[32,32,32] → L1[${Math.floor(32 / 2)},${Math.floor(32 / 2)},${Math.floor(32 / 2)}] = [16,16,16] mass=${l1P1Mass.toFixed(4)} (expected 10.0)\n` +
    `    L1 Total mass: ${l1TotalDiag.toFixed(4)} (expected 11.0)\n` +
    `    L1 Non-zero voxels: ${l1NonZeroVoxels.length}\n` +
    `    First 20 non-zero voxels: ${JSON.stringify(l1NonZeroVoxels.slice(0, 20))}\n`;

  assertClose(l1P0Mass, 1.0, 1e-4, `L1 P0 voxel should have mass 1.0${diagL1}`);
  assertClose(l1P1Mass, 10.0, 1e-4, `L1 P1 voxel should have mass 10.0${diagL1}`);

  // Build L1→L2
  const kernel2 = new KPyramidBuild({
    gl,
    outSize: l2Width,
    outGridSize: l2GridSize,
    outSlicesPerRow: l2SlicesPerRow,
    inGridSize: l1GridSize,
    inSlicesPerRow: l1SlicesPerRow,
    inA0: kernel1.outA0,
    inA1: kernel1.outA1,
    inA2: kernel1.outA2
  });
  kernel2.run();

  // Check L2: P0 maps to [11,8,8], P1 maps to [8,8,8]
  if (!kernel2.outA0) throw new Error('kernel2.outA0 should exist');
  const l2Result = readTexture(gl, kernel2.outA0, l2Width, l2Height);
  const l2P0Mass = readVoxel(l2Result, 11, 8, 8, l2GridSize, l2SlicesPerRow)[3];
  const l2P1Mass = readVoxel(l2Result, 8, 8, 8, l2GridSize, l2SlicesPerRow)[3];

  // Diagnostic: total mass in L2 and voxel distribution
  let l2TotalDiag = 0;
  const l2NonZeroVoxels = [];
  for (let i = 3; i < l2Result.length; i += 4) {
    if (l2Result[i] > 0) {
      l2TotalDiag += l2Result[i];
      const idx = (i - 3) / 4;
      l2NonZeroVoxels.push({ idx, mass: l2Result[i].toFixed(4) });
    }
  }

  const diagL2 = `\n  L1→L2 TRANSITION DETAILS (CRITICAL: BOTH HAVE slicesPerRow=4!):\n` +
    `    Input: L1 texture ${l1Width}×${l1Height} (gridSize=${l1GridSize}, slicesPerRow=${l1SlicesPerRow})\n` +
    `    Output: L2 texture ${l2Width}×${l2Height} (gridSize=${l2GridSize}, slicesPerRow=${l2SlicesPerRow})\n` +
    `    Coordinate mapping: gridSize halves ${l1GridSize}→${l2GridSize}, slicesPerRow SAME ${l1SlicesPerRow}→${l2SlicesPerRow}\n` +
    `    Shader assumption: childSlicesPerRow = parentSlicesPerRow * 2 = ${l1SlicesPerRow} * 2 = ${l1SlicesPerRow * 2}\n` +
    `    But L1 input only HAS ${l1SlicesPerRow} slices per row! This causes out-of-bounds texture reads.\n` +
    `    P0: L1[22,16,16] → L2[${Math.floor(22 / 2)},${Math.floor(16 / 2)},${Math.floor(16 / 2)}] = [11,8,8] mass=${l2P0Mass.toFixed(4)} (expected 1.0)\n` +
    `    P1: L1[16,16,16] → L2[${Math.floor(16 / 2)},${Math.floor(16 / 2)},${Math.floor(16 / 2)}] = [8,8,8] mass=${l2P1Mass.toFixed(4)} (expected 10.0)\n` +
    `    L2 Total mass: ${l2TotalDiag.toFixed(4)} (expected 11.0)\n` +
    `    L2 Non-zero voxels: ${l2NonZeroVoxels.length}\n` +
    `    First 20 non-zero voxels: ${JSON.stringify(l2NonZeroVoxels.slice(0, 20))}\n` +
    `    L1 texture slice layout: slicesPerRow=${l1SlicesPerRow} means ${l1SlicesPerRow} slices per row\n` +
    `      - Total L1 slices: ${Math.ceil(l1GridSize / l1SlicesPerRow)} rows\n` +
    `      - Texture size: ${l1Width}×${l1Height}\n` +
    `    If shader calculates childSlicesPerRow=${l1SlicesPerRow * 2}, then voxel coordinates will wrap incorrectly.\n`;

  assertClose(l2P0Mass, 1.0, 1e-4, `L2 P0 voxel should have mass 1.0${diagL2}`);
  assertClose(l2P1Mass, 10.0, 1e-4, `L2 P1 voxel should have mass 10.0${diagL2}`);

  // Build L2→L3
  const kernel3 = new KPyramidBuild({
    gl,
    outSize: l3Width,
    outGridSize: l3GridSize,
    outSlicesPerRow: l3SlicesPerRow,
    inGridSize: l2GridSize,
    inSlicesPerRow: l2SlicesPerRow,
    inA0: kernel2.outA0,
    inA1: kernel2.outA1,
    inA2: kernel2.outA2
  });
  kernel3.run();

  // Check L3: P0 maps to [5,4,4], P1 maps to [4,4,4]
  if (!kernel3.outA0) throw new Error('kernel3.outA0 should exist');
  const l3Result = readTexture(gl, kernel3.outA0, l3Width, l3Height);
  const l3P0Mass = readVoxel(l3Result, 5, 4, 4, l3GridSize, l3SlicesPerRow)[3];
  const l3P1Mass = readVoxel(l3Result, 4, 4, 4, l3GridSize, l3SlicesPerRow)[3];

  // Diagnostic: total mass in L3 and voxel distribution
  let l3TotalDiag = 0;
  const l3NonZeroVoxels = [];
  for (let i = 3; i < l3Result.length; i += 4) {
    if (l3Result[i] > 0) {
      l3TotalDiag += l3Result[i];
      const idx = (i - 3) / 4;
      l3NonZeroVoxels.push({ idx, mass: l3Result[i].toFixed(4) });
    }
  }

  const diagL3 = `\n  L2→L3 TRANSITION DETAILS:\n` +
    `    Input: L2 texture ${l2Width}×${l2Height} (gridSize=${l2GridSize}, slicesPerRow=${l2SlicesPerRow})\n` +
    `    Output: L3 texture ${l3Width}×${l3Height} (gridSize=${l3GridSize}, slicesPerRow=${l3SlicesPerRow})\n` +
    `    Coordinate mapping: gridSize halves ${l2GridSize}→${l3GridSize}, slicesPerRow halves ${l2SlicesPerRow}→${l3SlicesPerRow}\n` +
    `    Shader assumption: childSlicesPerRow = parentSlicesPerRow * 2 = ${l2SlicesPerRow} * 2 = ${l2SlicesPerRow * 2}\n` +
    `    L2 input HAS ${l2SlicesPerRow} slices per row, so this is ALSO potentially out-of-bounds!\n` +
    `    P0: L2[11,8,8] → L3[${Math.floor(11 / 2)},${Math.floor(8 / 2)},${Math.floor(8 / 2)}] = [5,4,4] mass=${l3P0Mass.toFixed(4)} (expected 1.0)\n` +
    `    P1: L2[8,8,8] → L3[${Math.floor(8 / 2)},${Math.floor(8 / 2)},${Math.floor(8 / 2)}] = [4,4,4] mass=${l3P1Mass.toFixed(4)} (expected 10.0)\n` +
    `    L3 Total mass: ${l3TotalDiag.toFixed(4)} (expected 11.0)\n` +
    `    L3 Non-zero voxels: ${l3NonZeroVoxels.length}\n` +
    `    First 20 non-zero voxels: ${JSON.stringify(l3NonZeroVoxels.slice(0, 20))}\n` +
    `    L2 texture slice layout: slicesPerRow=${l2SlicesPerRow} means ${l2SlicesPerRow} slices per row\n` +
    `      - Total L2 slices: ${Math.ceil(l2GridSize / l2SlicesPerRow)} rows\n` +
    `      - Texture size: ${l2Width}×${l2Height}\n` +
    `    If L2 is empty (mass=0), then L2→L3 has nothing to aggregate and L3 will also be empty.\n`;

  assertClose(l3P0Mass, 1.0, 1e-4, `L3 P0 voxel should have mass 1.0${diagL3}`);
  assertClose(l3P1Mass, 10.0, 1e-4, `L3 P1 voxel should have mass 10.0${diagL3}`);

  // Verify total mass conservation at each level
  let l1TotalMass = 0;
  for (let i = 3; i < l1Result.length; i += 4) l1TotalMass += l1Result[i];
  assertClose(l1TotalMass, 11.0, 1e-3, `L1 total mass conservation: ${l1TotalMass.toFixed(4)} (L0→L1 transition: SUCCESS)`);

  let l2TotalMass = 0;
  for (let i = 3; i < l2Result.length; i += 4) l2TotalMass += l2Result[i];
  const l2DiagConservation = l2TotalMass > 0
    ? `L2→L3 transition: HEALTHY (${l2TotalMass.toFixed(4)}/11.0)`
    : `L2→L3 transition: BROKEN! Mass lost at L1→L2 transition.`;
  assertClose(l2TotalMass, 11.0, 1e-3, `L2 total mass conservation: ${l2TotalMass.toFixed(4)} (${l2DiagConservation})`);

  let l3TotalMass = 0;
  for (let i = 3; i < l3Result.length; i += 4) l3TotalMass += l3Result[i];
  const l3DiagConservation = l3TotalMass > 0
    ? `L3→L4 transition: HEALTHY (${l3TotalMass.toFixed(4)}/11.0)`
    : `L3→L4 transition: BROKEN! Mass lost at L2→L3 transition (cascading failure).`;
  assertClose(l3TotalMass, 11.0, 1e-3, `L3 total mass conservation: ${l3TotalMass.toFixed(4)} (${l3DiagConservation})`);

  disposeKernel(kernel1);
  disposeKernel(kernel2);
  disposeKernel(kernel3);
  resetGL();
});

/**
 * Test: Verify shader receives correct child parameters
 * Diagnose whether uniform parameters are being passed correctly to the shader.
 */
test('KPyramidBuild.realistic: shader receives correct child grid parameters', async () => {
  const gl = getGL();

  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0Width, height: l0Height } = textureDimensions(l0GridSize, l0SlicesPerRow);

  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1Width, height: l1Height } = textureDimensions(l1GridSize, l1SlicesPerRow);

  const l2GridSize = 16;
  const l2SlicesPerRow = 4;
  const { width: l2Width, height: l2Height } = textureDimensions(l2GridSize, l2SlicesPerRow);

  // L0: single particle at [44, 32, 32]
  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    if (x === 44 && y === 32 && z === 32) return [0, 0, 0, 1.0];
    return [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);

  // L0→L1
  const kernel1 = new KPyramidBuild({
    gl,
    outSize: l1Width,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel1.run();

  if (!kernel1.outA0) throw new Error('kernel1.outA0 should exist');
  const l1Result = readTexture(gl, kernel1.outA0, l1Width, l1Height);
  const l1Mass = readVoxel(l1Result, 22, 16, 16, l1GridSize, l1SlicesPerRow)[3];

  const diagL0L1 = `\n  L0→L1 Shader Diagnostics:\n` +
    `    Input texture dims: ${l0Width}×${l0Height} (gridSize=${l0GridSize}, slicesPerRow=${l0SlicesPerRow})\n` +
    `    Output texture dims: ${l1Width}×${l1Height} (gridSize=${l1GridSize}, slicesPerRow=${l1SlicesPerRow})\n` +
    `    Particle L0[44,32,32] → L1[22,16,16] mass: ${l1Mass.toFixed(4)} (expected 1.0)\n` +
    `    Total L1 mass: ${Array.from({ length: l1Width * l1Height }, (_, i) => i).reduce((sum, i) => sum + (l1Result[i * 4 + 3] || 0), 0).toFixed(4)}\n`;

  assertClose(l1Mass, 1.0, 1e-4, `L0→L1 should propagate mass${diagL0L1}`);

  // L1→L2: This is where it fails (slicesPerRow stays at 4)
  const kernel2 = new KPyramidBuild({
    gl,
    outSize: l2Width,
    outGridSize: l2GridSize,
    outSlicesPerRow: l2SlicesPerRow,
    inGridSize: l1GridSize,
    inSlicesPerRow: l1SlicesPerRow,
    inA0: kernel1.outA0,
    inA1: kernel1.outA1,
    inA2: kernel1.outA2
  });
  kernel2.run();

  if (!kernel2.outA0) throw new Error('kernel2.outA0 should exist');
  const l2Result = readTexture(gl, kernel2.outA0, l2Width, l2Height);
  const l2Mass = readVoxel(l2Result, 11, 8, 8, l2GridSize, l2SlicesPerRow)[3];

  // Detailed diagnostic: show voxel coordinate calculation
  const diagL1L2 = `\n  L1→L2 Shader Diagnostics (CRITICAL - both have slicesPerRow=4!):\n` +
    `    Input L1 texture dims: ${l1Width}×${l1Height} (gridSize=${l1GridSize}, slicesPerRow=${l1SlicesPerRow})\n` +
    `    Output L2 texture dims: ${l2Width}×${l2Height} (gridSize=${l2GridSize}, slicesPerRow=${l2SlicesPerRow})\n` +
    `    Particle L1[22,16,16] → L2[11,8,8] mass: ${l2Mass.toFixed(4)} (expected 1.0)\n` +
    `    Total L2 mass: ${Array.from({ length: l2Width * l2Height }, (_, i) => i).reduce((sum, i) => sum + (l2Result[i * 4 + 3] || 0), 0).toFixed(4)}\n` +
    `    L1 texture layout: slicesPerRow=4 → slices arranged as 4-per-row\n` +
    `    When kernel computes child params, it does: childSlicesPerRow = 4 * 2 = 8\n` +
    `    But L1 only HAS 4 slices per row! This is the coordinate mapping failure.\n`;

  assertClose(l2Mass, 1.0, 1e-4, `L1→L2 should propagate mass${diagL1L2}`);

  disposeKernel(kernel1);
  disposeKernel(kernel2);
  resetGL();
});

/**
 * Test: Particle at voxel boundary edge cases
 */
test('KPyramidBuild.realistic: particles at grid boundaries propagate correctly', async () => {
  const gl = getGL();

  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0Width, height: l0Height } = textureDimensions(l0GridSize, l0SlicesPerRow);

  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1Width, height: l1Height } = textureDimensions(l1GridSize, l1SlicesPerRow);

  // Test corners and edges
  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    // Corner: [0,0,0]
    if (x === 0 && y === 0 && z === 0) return [0, 0, 0, 1.0];
    // Edge: [63,0,0]
    if (x === 63 && y === 0 && z === 0) return [0, 0, 0, 2.0];
    // Center-ish: [31,31,31]
    if (x === 31 && y === 31 && z === 31) return [0, 0, 0, 3.0];
    // Max corner: [63,63,63]
    if (x === 63 && y === 63 && z === 63) return [0, 0, 0, 4.0];
    return [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);

  const kernel = new KPyramidBuild({
    gl,
    outSize: l1Width,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel.run();

  if (!kernel.outA0) throw new Error('kernel.outA0 should exist');
  if (!kernel.outA0) throw new Error('kernel.outA0 should exist');
  const l1Result = readTexture(gl, kernel.outA0, l1Width, l1Height);

  // Diagnostic: show all non-zero voxels for debugging boundary cases
  const boundaryNonZeroVoxels = [];
  for (let i = 3; i < l1Result.length; i += 4) {
    if (l1Result[i] > 0) {
      const idx = (i - 3) / 4;
      boundaryNonZeroVoxels.push({ idx, mass: l1Result[i].toFixed(4) });
    }
  }

  const diagBoundary = `\n  Boundary Test Diagnostics:\n` +
    `    Non-zero voxels found: ${boundaryNonZeroVoxels.length}\n` +
    `    Non-zero voxels: ${JSON.stringify(boundaryNonZeroVoxels)}\n` +
    `    L0 grid: 64×64×64, L1 grid: 32×32×32, slicesPerRow L0=8→L1=4\n`;

  // Check each particle's expected L1 voxel
  const corner0_0_0 = readVoxel(l1Result, 0, 0, 0, l1GridSize, l1SlicesPerRow)[3];
  const edge63_0_0 = readVoxel(l1Result, 31, 0, 0, l1GridSize, l1SlicesPerRow)[3];
  const center31_31_31 = readVoxel(l1Result, 15, 15, 15, l1GridSize, l1SlicesPerRow)[3];
  const corner63_63_63 = readVoxel(l1Result, 31, 31, 31, l1GridSize, l1SlicesPerRow)[3];

  assertClose(corner0_0_0, 1.0, 1e-4, `[0,0,0]→L1[0,0,0] mass=${corner0_0_0.toFixed(4)}${diagBoundary}`);
  assertClose(edge63_0_0, 2.0, 1e-4, `[63,0,0]→L1[31,0,0] mass=${edge63_0_0.toFixed(4)}${diagBoundary}`);
  assertClose(center31_31_31, 3.0, 1e-4, `[31,31,31]→L1[15,15,15] mass=${center31_31_31.toFixed(4)}${diagBoundary}`);
  assertClose(corner63_63_63, 4.0, 1e-4, `[63,63,63]→L1[31,31,31] mass=${corner63_63_63.toFixed(4)}${diagBoundary}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test: Clustered particles in same parent voxel accumulate
 */
test('KPyramidBuild.realistic: clustered particles accumulate in parent voxel', async () => {
  const gl = getGL();

  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0Width, height: l0Height } = textureDimensions(l0GridSize, l0SlicesPerRow);

  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1Width, height: l1Height } = textureDimensions(l1GridSize, l1SlicesPerRow);

  // Put 8 particles in child voxels that all map to same parent [16,16,16]
  // Parent [16,16,16] aggregates children [32,32,32] through [33,33,33]
  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    // All 8 children of parent [16,16,16]
    if (x >= 32 && x <= 33 && y >= 32 && y <= 33 && z >= 32 && z <= 33) {
      return [0, 0, 0, 1.5]; // Each has mass 1.5
    }
    return [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);

  const kernel = new KPyramidBuild({
    gl,
    outSize: l1Width,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel.run();

  if (!kernel.outA0) throw new Error('kernel.outA0 should exist');
  const l1Result = readTexture(gl, kernel.outA0, l1Width, l1Height);
  const parentMass = readVoxel(l1Result, 16, 16, 16, l1GridSize, l1SlicesPerRow)[3];

  // Should have 8 children × 1.5 = 12.0
  assertClose(parentMass, 12.0, 1e-4, 'Parent voxel should accumulate all 8 children');

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test: Sparse distribution across entire grid
 */
test('KPyramidBuild.realistic: sparse particles across large grid preserve positions', async () => {
  const gl = getGL();

  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0Width, height: l0Height } = textureDimensions(l0GridSize, l0SlicesPerRow);

  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1Width, height: l1Height } = textureDimensions(l1GridSize, l1SlicesPerRow);

  // Scatter 10 particles across grid at known positions
  const particles = [
    { voxel: [5, 10, 15], mass: 1.0 },
    { voxel: [20, 25, 30], mass: 2.0 },
    { voxel: [40, 45, 50], mass: 3.0 },
    { voxel: [60, 55, 48], mass: 4.0 },
    { voxel: [12, 8, 4], mass: 5.0 },
    { voxel: [33, 33, 33], mass: 6.0 },
    { voxel: [48, 16, 32], mass: 7.0 },
    { voxel: [8, 56, 24], mass: 8.0 },
    { voxel: [52, 4, 60], mass: 9.0 },
    { voxel: [28, 40, 12], mass: 10.0 }
  ];

  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    const p = particles.find(p => p.voxel[0] === x && p.voxel[1] === y && p.voxel[2] === z);
    return p ? [0, 0, 0, p.mass] : [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);

  const kernel = new KPyramidBuild({
    gl,
    outSize: l1Width,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel.run();

  if (!kernel.outA0) throw new Error('kernel.outA0 should exist');
  const l1Result = readTexture(gl, kernel.outA0, l1Width, l1Height);

  // Verify each particle ended up in correct L1 voxel
  for (const p of particles) {
    const l1Voxel = p.voxel.map(v => Math.floor(v / 2));
    const mass = readVoxel(l1Result, l1Voxel[0], l1Voxel[1], l1Voxel[2], l1GridSize, l1SlicesPerRow)[3];
    assert.ok(mass >= p.mass, `Particle at L0 ${p.voxel} should contribute ${p.mass} to L1 ${l1Voxel}, got ${mass.toFixed(3)}`);
  }

  // Verify total mass conservation
  let totalMass = 0;
  for (let i = 3; i < l1Result.length; i += 4) totalMass += l1Result[i];
  const expectedTotal = particles.reduce((sum, p) => sum + p.mass, 0);
  assertClose(totalMass, expectedTotal, 1e-3, 'Total mass should be conserved');

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test: Z-slice layout correctness with 8 slicesPerRow
 */
test('KPyramidBuild.realistic: Z-slice layout with slicesPerRow=8', async () => {
  const gl = getGL();

  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0Width, height: l0Height } = textureDimensions(l0GridSize, l0SlicesPerRow);

  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1Width, height: l1Height } = textureDimensions(l1GridSize, l1SlicesPerRow);

  // Mark one voxel in each Z-slice
  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    // One voxel per Z-slice at [32, 32, z]
    if (x === 32 && y === 32) {
      return [0, 0, 0, z + 1]; // Mass = z+1 for identification
    }
    return [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);

  const kernel = new KPyramidBuild({
    gl,
    outSize: l1Width,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel.run();

  if (!kernel.outA0) throw new Error('kernel.outA0 should exist');
  const l1Result = readTexture(gl, kernel.outA0, l1Width, l1Height);

  // Check that each Z-slice pair contributed correctly
  // L0 z=0,1 → L1 z=0; L0 z=2,3 → L1 z=1, etc.
  for (let z1 = 0; z1 < l1GridSize; z1++) {
    const mass = readVoxel(l1Result, 16, 16, z1, l1GridSize, l1SlicesPerRow)[3];
    // Each L1 voxel aggregates 8 L0 voxels, but only 2 have mass (the z-slice markers)
    const z0_1 = z1 * 2;
    const z0_2 = z1 * 2 + 1;
    const expectedMass = (z0_1 + 1) + (z0_2 + 1);
    assertClose(mass, expectedMass, 1e-4, `L1 z=${z1} should aggregate L0 z=${z0_1},${z0_2}`);
  }

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test: Coordinate mapping edge case - L0→L1 when particles are at odd coordinates
 * Detailed diagnostic to show exactly how voxel coordinates transform.
 */
test('KPyramidBuild.realistic: L0→L1 odd coordinate mapping with texture layout analysis', async () => {
  const gl = getGL();

  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0Width, height: l0Height } = textureDimensions(l0GridSize, l0SlicesPerRow);

  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1Width, height: l1Height } = textureDimensions(l1GridSize, l1SlicesPerRow);

  // Two particles at specific coordinates
  const particle1 = { voxel: [45, 33, 21], mass: 7.0, name: 'odd' };
  const particle2 = { voxel: [44, 32, 20], mass: 11.0, name: 'even' };

  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    if (x === 45 && y === 33 && z === 21) return [0, 0, 0, 7.0];
    if (x === 44 && y === 32 && z === 20) return [0, 0, 0, 11.0];
    return [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);

  const kernel = new KPyramidBuild({
    gl,
    outSize: l1Width,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel.run();

  if (!kernel.outA0) throw new Error('kernel.outA0 should exist');
  const l1Result = readTexture(gl, kernel.outA0, l1Width, l1Height);

  // Calculate expected L1 voxel coordinates
  const p1_l1_voxel = [Math.floor(45 / 2), Math.floor(33 / 2), Math.floor(21 / 2)]; // [22, 16, 10]
  const p2_l1_voxel = [Math.floor(44 / 2), Math.floor(32 / 2), Math.floor(20 / 2)]; // [22, 16, 10]

  const mass1 = readVoxel(l1Result, p1_l1_voxel[0], p1_l1_voxel[1], p1_l1_voxel[2], l1GridSize, l1SlicesPerRow)[3];
  const mass2_check = readVoxel(l1Result, p2_l1_voxel[0], p2_l1_voxel[1], p2_l1_voxel[2], l1GridSize, l1SlicesPerRow)[3];

  const coordDiag = `\n  Coordinate Mapping Diagnostics:\n` +
    `    L0 voxel [45,33,21] (odd) → L1 voxel [22,16,10]\n` +
    `    L0 voxel [44,32,20] (even) → L1 voxel [22,16,10] (SAME PARENT!)\n` +
    `    Expected: L1[22,16,10] mass = 7.0 + 11.0 = 18.0\n` +
    `    Actual: L1[22,16,10] mass = ${mass1.toFixed(4)}\n` +
    `    L0→L1 texture dims: ${l0Width}×${l0Height} → ${l1Width}×${l1Height}\n` +
    `    Particle 1 (odd) mass contribution: ${mass1.toFixed(4)} (expected 7.0 + 11.0 = 18.0)\n` +
    `    Verification: same voxel check mass = ${mass2_check.toFixed(4)}\n` +
    `    Non-zero voxels in L1: ${Array.from({ length: l1Result.length / 4 }, (_, i) => l1Result[i * 4 + 3]).filter(m => m > 0).length}\n`;

  // This test expects both particles to accumulate in the same parent voxel
  assertClose(mass1, 18.0, 1e-4, `Both particles should accumulate in parent voxel [22,16,10]${coordDiag}`);

  disposeKernel(kernel);
  resetGL();
});

/**
 * Test: Non-power-of-2 voxel coordinates
 */
test('KPyramidBuild.realistic: odd voxel coordinates map correctly', async () => {
  const gl = getGL();

  const l0GridSize = 64;
  const l0SlicesPerRow = 8;
  const { width: l0Width, height: l0Height } = textureDimensions(l0GridSize, l0SlicesPerRow);

  const l1GridSize = 32;
  const l1SlicesPerRow = 4;
  const { width: l1Width, height: l1Height } = textureDimensions(l1GridSize, l1SlicesPerRow);

  // Test odd/even coordinate pairs
  const l0A0 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, (x, y, z) => {
    // Odd coordinates: [45, 33, 21]
    if (x === 45 && y === 33 && z === 21) return [0, 0, 0, 7.0];
    // Even coordinates: [44, 32, 20]
    if (x === 44 && y === 32 && z === 20) return [0, 0, 0, 11.0];
    return [0, 0, 0, 0];
  });
  const l0A1 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);
  const l0A2 = fillVoxelTexture(gl, l0GridSize, l0SlicesPerRow, () => [0, 0, 0, 0]);

  const kernel = new KPyramidBuild({
    gl,
    outSize: l1Width,
    outGridSize: l1GridSize,
    outSlicesPerRow: l1SlicesPerRow,
    inGridSize: l0GridSize,
    inSlicesPerRow: l0SlicesPerRow,
    inA0: l0A0,
    inA1: l0A1,
    inA2: l0A2
  });
  kernel.run();

  if (!kernel.outA0) throw new Error('kernel.outA0 should exist');
  const l1Result = readTexture(gl, kernel.outA0, l1Width, l1Height);

  // Both particles map to same parent voxel [22,16,10]
  // L0 [45,33,21] (mass 7.0) → L1 [22,16,10]
  // L0 [44,32,20] (mass 11.0) → L1 [22,16,10]
  // So this parent should have accumulated both masses
  const oddMass = readVoxel(l1Result, 22, 16, 10, l1GridSize, l1SlicesPerRow)[3];
  assertClose(oddMass, 7.0 + 11.0, 1e-4, 'Both particles should accumulate in same parent voxel');

  disposeKernel(kernel);
  resetGL();
});
