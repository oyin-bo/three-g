// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemMonopoleKernels } from './particle-system-monopole-kernels.js';

/**
 * Create offscreen canvas with WebGL2 context
 */
function createTestCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const gl = canvas.getContext('webgl2');
  
  if (!gl) {
    throw new Error('WebGL2 not supported');
  }
  
  const ext = gl.getExtension('EXT_color_buffer_float');
  if (!ext) {
    throw new Error('EXT_color_buffer_float not supported');
  }
  
  return { canvas, gl };
}

/**
 * Debug: Two particles should attract each other
 */
test('monopole-kernels DEBUG: two-particle forces and motion', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const positions = new Float32Array([
    -1, 0, 0, 1,   // Particle 0 at left, mass 1
     1, 0, 0, 1    // Particle 1 at right, mass 1
  ]);
  const velocities = new Float32Array(positions.length).fill(0);
  
  const system = new ParticleSystemMonopoleKernels({
    gl,
    particleData: { positions, velocities },
    worldBounds: { min: [-2, -2, -2], max: [2, 2, 2] },
    theta: 0.5,
    gravityStrength: 0.001,
    softening: 0.01,
    dt: 0.01
  });
  
  // Step 0: Check initial aggregation
  console.log('\n=== INITIAL STATE ===');
  console.log('Particle 0: pos=(-1,0,0), mass=1');
  console.log('Particle 1: pos=(1,0,0), mass=1');
  console.log('worldBounds:', system.options.worldBounds);
  console.log('gravityStrength:', system.options.gravityStrength);
  console.log('softening:', system.options.softening);
  console.log('numLevels:', system.numLevels);
  console.log('theta:', system.options.theta);
  
  // Manually run octree build
  system._buildOctree();
  
  // Check aggregator output
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  
  const aggData = new Float32Array(8);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.aggregatorKernel.outA0, 0);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, aggData);
  
  console.log('\n=== AFTER AGGREGATION (L0) ===');
  console.log('Voxel @ (0,0): rgba=', [aggData[0], aggData[1], aggData[2], aggData[3]]);
  console.log('Voxel @ (1,0): rgba=', [aggData[4], aggData[5], aggData[6], aggData[7]]);
  
  // Count non-zero voxels in L0
  const octreeSize = system.aggregatorKernel.octreeSize;
  const fullOctree = new Float32Array(octreeSize * octreeSize * 4);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.aggregatorKernel.outA0, 0);
  gl.readPixels(0, 0, octreeSize, octreeSize, gl.RGBA, gl.FLOAT, fullOctree);
  
  let nonZeroVoxels = 0, totalMass = 0;
  for (let i = 0; i < octreeSize * octreeSize; i++) {
    const a = fullOctree[i * 4 + 3];
    if (a > 0) {
      nonZeroVoxels++;
      totalMass += a;
    }
  }
  console.log('Non-zero voxels in L0:', nonZeroVoxels, ', total mass:', totalMass);
  
  // Manually run force calculation
  system._calculateForces();
  
  const forceData = new Float32Array(8);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.traversalKernel.outForce, 0);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, forceData);
  
  console.log('\n=== AFTER TRAVERSAL (FORCE) ===');
  console.log('Force on particle 0:', [forceData[0], forceData[1], forceData[2]]);
  console.log('Force on particle 1:', [forceData[4], forceData[5], forceData[6]]);
  
  if (forceData[0] === 0 && forceData[4] === 0) {
    console.log('\n!!! ZERO FORCES - Investigating traversal inputs ===');
    
    // Check if inLevelA0 textures are properly wired
    console.log('inLevelA0 length:', system.traversalKernel.inLevelA0 ? system.traversalKernel.inLevelA0.length : 0);
    if (system.traversalKernel.inLevelA0) {
      for (let L = 0; L < system.traversalKernel.inLevelA0.length; L++) {
        const tex = system.traversalKernel.inLevelA0[L];
        if (tex) {
          const sample = new Float32Array(4);
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, sample);
          console.log(`Level ${L} sample @ (0,0):`, Array.from(sample));
        } else {
          console.log(`Level ${L}: null texture`);
        }
      }
    }
  }
  
  // Integrate physics
  system._integratePhysics();
  
  const finalPos = new Float32Array(8);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, system.positionTexture, 0);
  gl.readPixels(0, 0, 2, 1, gl.RGBA, gl.FLOAT, finalPos);
  
  console.log('\n=== AFTER INTEGRATION ===');
  console.log('Final particle 0 pos:', [finalPos[0], finalPos[1], finalPos[2]]);
  console.log('Final particle 1 pos:', [finalPos[4], finalPos[5], finalPos[6]]);
  console.log('Delta particle 0:', [finalPos[0] - positions[0], finalPos[1] - positions[1], finalPos[2] - positions[2]]);
  console.log('Delta particle 1:', [finalPos[4] - positions[4], finalPos[5] - positions[5], finalPos[6] - positions[6]]);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  system.dispose();
  canvas.remove();
  
  // Assertion: particles should have moved toward each other
  assert.ok(
    finalPos[0] > positions[0] || finalPos[4] < positions[4],
    'At least one particle should move toward the other'
  );
});
