import { test } from 'node:test';
import assert from 'node:assert';
import { LaplacianForceModuleKernels } from './laplacian-force-module-kernels.js';
import { ParticleSystemMonopoleKernels } from '../gravity-multipole/particle-system-monopole-kernels.js';
import { getGL } from '../test-utils.js';

test('LaplacianForceModuleKernels: high k value causes strong clustering', async () => {
  const gl = getGL();
  
  // Create 4 particles in a line, connected as: 0-1-2-3
  const particleCount = 4;
  const textureWidth = 2;
  const textureHeight = 2;
  
  // Initial positions: spread out along x-axis
  const positions = new Float32Array(16);
  positions.set([
    -1.5, 0, 0, 1.0,  // particle 0
     -0.5, 0, 0, 1.0,  // particle 1
      0.5, 0, 0, 1.0,  // particle 2
      1.5, 0, 0, 1.0   // particle 3
  ]);
  
  const velocities = new Float32Array(16); // all zeros
  
  // Create edges connecting them in a chain
  const edges = [
    { from: 0, to: 1, strength: 1.0 },
    { from: 1, to: 0, strength: 1.0 },
    { from: 1, to: 2, strength: 1.0 },
    { from: 2, to: 1, strength: 1.0 },
    { from: 2, to: 3, strength: 1.0 },
    { from: 3, to: 2, strength: 1.0 }
  ];
  
  // Test with LOW k
  const systemLowK = new ParticleSystemMonopoleKernels({
    gl,
    particleData: { positions: new Float32Array(positions), velocities: new Float32Array(velocities) },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    theta: 0.5,
    gravityStrength: 0.0, // NO GRAVITY - only spring forces
    dt: 0.1,
    softening: 0.1,
    damping: 0.0,
    maxSpeed: 100,
    maxAccel: 100
  });
  
  const hasFloatBlend = !!gl.getExtension('EXT_float_blend');
  
  const graphLowK = new LaplacianForceModuleKernels({
    gl,
    edges,
    particleCount,
    textureWidth,
    textureHeight,
    k: 0.01,  // LOW spring constant
    shardSize: 64,
    normalized: false,
    disableFloatBlend: !hasFloatBlend
  });
  
  // Run simulation with LOW k
  let accumulateCount = 0;
  for (let i = 0; i < 50; i++) {
    // IMPORTANT: Let gravity forces be computed first, THEN accumulate graph forces
    systemLowK._buildOctree();
    systemLowK._calculateForces();

    // DON'T clear - let graph forces accumulate on top of gravity forces via blending
    
    // Accumulate spring forces BEFORE step so they're integrated
    try {
      graphLowK.accumulate({
        positionTexture: systemLowK.positionTexture,
        targetForceTexture: systemLowK.traversalKernel.outForce,
        targetForceFramebuffer: systemLowK.traversalKernel.outFramebuffer
      });
      accumulateCount++;
      
      // Check GL errors and framebuffer status after accumulate
      if (i === 0) {
        const glError = gl.getError();
        console.log(`GL error after accumulate: ${glError} (0 = no error)`);
        
        // Check framebuffer completeness
        gl.bindFramebuffer(gl.FRAMEBUFFER, systemLowK.traversalKernel.outFramebuffer);
        const fbStatus = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    } catch (err) {
      console.error(`accumulate() threw error at iteration ${i}:`, err.message);
      throw err;
    }
    
    // Sample forces and intermediate textures on first iteration
    if (i === 0) {
      // Check if partials kernel produced output
      const partialsOutput = graphLowK.partialsKernel?.outPartials;
      const AxOutput = graphLowK.reduceKernel?.outAx;
            
      // Read Ax values
      if (AxOutput) {
        const axWidth = Math.ceil(Math.sqrt(particleCount));
        const axHeight = Math.ceil(particleCount / axWidth);
        const axData = new Float32Array(axWidth * axHeight * 4);
        const axFbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, axFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, AxOutput, 0);
        gl.readPixels(0, 0, axWidth, axHeight, gl.RGBA, gl.FLOAT, axData);
        gl.deleteFramebuffer(axFbo);
      }
      
      // IMPORTANT: Bind framebuffer before reading force texture!
      gl.bindFramebuffer(gl.FRAMEBUFFER, systemLowK.traversalKernel.outFramebuffer);
      const forces = new Float32Array(16);
      gl.readPixels(0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, forces);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    
    // Now integrate physics with combined forces
    systemLowK._integratePhysics();
    systemLowK.frameCount++;
  }
  
  
  // Read final positions with LOW k
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, systemLowK.positionTexture, 0);
  
  const positionsLowK = new Float32Array(16);
  gl.readPixels(0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, positionsLowK);
  
  // Also read velocities
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, systemLowK.velocityTexture, 0);
  const velocitiesLowK = new Float32Array(16);
  gl.readPixels(0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, velocitiesLowK);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Calculate spread with LOW k
  const spreadLowK = Math.abs(positionsLowK[0] - positionsLowK[12]); // distance between particle 0 and 3
  
  
  graphLowK.dispose();
  systemLowK.dispose();
  
  // Now test with HIGH k
  const systemHighK = new ParticleSystemMonopoleKernels({
    gl,
    particleData: { positions: new Float32Array(positions), velocities: new Float32Array(velocities) },
    worldBounds: { min: [-3, -3, -3], max: [3, 3, 3] },
    theta: 0.5,
    gravityStrength: 0.0, // NO GRAVITY - only spring forces
    dt: 0.1,
    softening: 0.1,
    damping: 0.0,
    maxSpeed: 100,
    maxAccel: 100
  });
  
  const graphHighK = new LaplacianForceModuleKernels({
    gl,
    edges,
    particleCount,
    textureWidth,
    textureHeight,
    k: 1.0,  // HIGH spring constant (100x)
    shardSize: 64,
    normalized: false,
    disableFloatBlend: !hasFloatBlend
  });

  
  // Run simulation with HIGH k
  accumulateCount = 0;
  for (let i = 0; i < 50; i++) {
    // IMPORTANT: Let gravity forces be computed first, THEN accumulate graph forces
    systemHighK._buildOctree();
    systemHighK._calculateForces();

   
    // Accumulate spring forces BEFORE step so they're integrated
    graphHighK.accumulate({
      positionTexture: systemHighK.positionTexture,
      targetForceTexture: systemHighK.traversalKernel.outForce,
      targetForceFramebuffer: systemHighK.traversalKernel.outFramebuffer
    });
    accumulateCount++;
    
    // Sample forces on first iteration
    if (i === 0) {
      // IMPORTANT: Bind framebuffer before reading force texture!
      gl.bindFramebuffer(gl.FRAMEBUFFER, systemHighK.traversalKernel.outFramebuffer);
      const forces = new Float32Array(16);
      gl.readPixels(0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, forces);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
    
    // Now integrate physics with combined forces
    systemHighK._integratePhysics();
    systemHighK.frameCount++;
  }
  
  
  // Read final positions with HIGH k
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, systemHighK.positionTexture, 0);
  
  const positionsHighK = new Float32Array(16);
  gl.readPixels(0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, positionsHighK);
  
  // Also read velocities
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, systemHighK.velocityTexture, 0);
  const velocitiesHighK = new Float32Array(16);
  gl.readPixels(0, 0, textureWidth, textureHeight, gl.RGBA, gl.FLOAT, velocitiesHighK);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  // Calculate spread with HIGH k
  const spreadHighK = Math.abs(positionsHighK[0] - positionsHighK[12]); // distance between particle 0 and 3
  
  
  graphHighK.dispose();
  systemHighK.dispose();
  
  // HIGH k should produce MORE clustering (smaller spread)
  // With 100x k difference, we expect significant but not extreme difference due to limited iterations
  assert.ok(spreadHighK < spreadLowK * 0.95, 
    `High k should cluster more: lowK=${spreadLowK.toFixed(3)}, highK=${spreadHighK.toFixed(3)}, ratio=${(spreadHighK/spreadLowK).toFixed(2)}`);
});

