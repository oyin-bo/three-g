// @ts-check

import { test } from 'node:test';
import assert from 'node:assert';
import { ParticleSystemMonopole } from './particle-system-monopole.js';

/**
 * Create offscreen canvas with WebGL2 context
 * @returns {{canvas: HTMLCanvasElement, gl: WebGL2RenderingContext}}
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
 * Test 1: Disposal cleanup verification
 */
test('monopole.resource-mgmt: dispose cleans up all GPU resources', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 100;
  const positions = new Float32Array(particleCount * 4);
  const velocities = new Float32Array(particleCount * 4);
  
  let seed = 999;
  function random() {
    seed = (seed * 1664525 + 1013904223) | 0;
    return (seed >>> 0) / 4294967296;
  }
  
  for (let i = 0; i < particleCount; i++) {
    positions[i * 4 + 0] = (random() - 0.5) * 4;
    positions[i * 4 + 1] = (random() - 0.5) * 4;
    positions[i * 4 + 2] = (random() - 0.5) * 4;
    positions[i * 4 + 3] = 1.0;
    
    velocities[i * 4 + 0] = 0;
    velocities[i * 4 + 1] = 0;
    velocities[i * 4 + 2] = 0;
    velocities[i * 4 + 3] = 0;
  }
  
  const system = new ParticleSystemMonopole(gl, {
    particleData: { positions, velocities },
    worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
    dt: 0.01,
    gravityStrength: 0.0003,
    softening: 0.2
  });
  
  // Run a few steps to ensure system is fully initialized
  for (let i = 0; i < 5; i++) {
    system.step();
  }
  
  // Collect references to GPU resources before disposal
  const posTextures = system.getPositionTextures();
  const velTextures = system.velocityTextures?.textures || [];
  const forceTexture = system.forceTexture?.texture || null;
  const levelTextures = system.levelTextures.map(lt => lt.texture);
  
  // Dispose system
  system.dispose();
  
  // Verify textures are deleted
  // Note: After deleteTexture, isTexture returns false
  for (const tex of posTextures) {
    if (tex) {
      assert.ok(!gl.isTexture(tex), `Position texture should be deleted: isTexture=${gl.isTexture(tex)}`);
    }
  }
  
  for (const tex of velTextures) {
    if (tex) {
      assert.ok(!gl.isTexture(tex), `Velocity texture should be deleted: isTexture=${gl.isTexture(tex)}`);
    }
  }
  
  if (forceTexture) {
    assert.ok(!gl.isTexture(forceTexture), `Force texture should be deleted: isTexture=${gl.isTexture(forceTexture)}`);
  }
  
  for (const tex of levelTextures) {
    if (tex) {
      assert.ok(!gl.isTexture(tex), `Level texture should be deleted: isTexture=${gl.isTexture(tex)}`);
    }
  }
  
  // Verify no GL errors after disposal
  const glError = gl.getError();
  assert.strictEqual(glError, gl.NO_ERROR, `No GL errors after disposal: got ${glError}`);
  
  canvas.remove();
});

/**
 * Test 2: Texture reuse (externally managed textures)
 */
test('monopole.resource-mgmt: system can be recreated with same context', async () => {
  const { canvas, gl } = createTestCanvas();
  
  const particleCount = 50;
  
  function createParticleData() {
    const positions = new Float32Array(particleCount * 4);
    const velocities = new Float32Array(particleCount * 4);
    
    let seed = 111 + Math.random() * 1000;
    function random() {
      seed = (seed * 1664525 + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    }
    
    for (let i = 0; i < particleCount; i++) {
      positions[i * 4 + 0] = (random() - 0.5) * 4;
      positions[i * 4 + 1] = (random() - 0.5) * 4;
      positions[i * 4 + 2] = (random() - 0.5) * 4;
      positions[i * 4 + 3] = 1.0;
      
      velocities[i * 4 + 0] = 0;
      velocities[i * 4 + 1] = 0;
      velocities[i * 4 + 2] = 0;
      velocities[i * 4 + 3] = 0;
    }
    
    return { positions, velocities };
  }
  
  // Create and dispose first system
  {
    const data = createParticleData();
    const system1 = new ParticleSystemMonopole(gl, {
      particleData: data,
      worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.2
    });
    
    for (let i = 0; i < 5; i++) {
      system1.step();
    }
    
    system1.dispose();
    
    // Check no GL errors
    let glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `No GL errors after first system disposal: ${glError}`);
  }
  
  // Create second system with same context
  {
    const data = createParticleData();
    const system2 = new ParticleSystemMonopole(gl, {
      particleData: data,
      worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.2
    });
    
    // Should work without issues
    for (let i = 0; i < 5; i++) {
      system2.step();
    }
    
    // Read data to verify it's working
    const texWidth = system2.textureWidth;
    const texHeight = system2.textureHeight;
    const posTex = system2.getPositionTexture();
    
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, posTex, 0);
    
    const positions = new Float32Array(texWidth * texHeight * 4);
    gl.readPixels(0, 0, texWidth, texHeight, gl.RGBA, gl.FLOAT, positions);
    
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fbo);
    
    // Verify data is finite
    let allFinite = true;
    for (let i = 0; i < particleCount * 4; i++) {
      if (!isFinite(positions[i])) {
        allFinite = false;
        break;
      }
    }
    
    assert.ok(allFinite, 'Second system should produce finite results');
    
    system2.dispose();
    
    // Check no GL errors
    let glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `No GL errors after second system disposal: ${glError}`);
  }
  
  // Create third system to verify context is still usable
  {
    const data = createParticleData();
    const system3 = new ParticleSystemMonopole(gl, {
      particleData: data,
      worldBounds: { min: [-5, -5, -5], max: [5, 5, 5] },
      dt: 0.01,
      gravityStrength: 0.0003,
      softening: 0.2
    });
    
    system3.step();
    
    const glError = gl.getError();
    assert.strictEqual(glError, gl.NO_ERROR, `Third system should work: ${glError}`);
    
    system3.dispose();
  }
  
  canvas.remove();
});
