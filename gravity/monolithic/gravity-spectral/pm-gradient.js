// @ts-check

/**
 * PM/FFT Pipeline - Gradient Computation
 * 
 * Computes force field from gravitational potential:
 * F = -∇φ  →  F(k) = -i·k·φ(k)
 * 
 * Generates three force spectrum textures (Fx, Fy, Fz)
 */

import gradientFrag from './shaders/gradient.frag.js';
import fsQuadVert from '../shaders/fullscreen.vert.js';

/**
 * Initialize gradient/force resources
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectralMonolithic} psys
 */
export function initGradient(psys) {
  const gl = psys.gl;
  
  // Create gradient program
  if (!psys.pmGradientProgram) {
    psys.pmGradientProgram = psys.createProgram(fsQuadVert, gradientFrag);
    console.log('[PM Gradient] Program created');
  }
  
  // Create three force spectrum textures (one per axis)
  if (!psys.pmForceSpectrum) {
    const textureSize = psys.pmGrid.size;
    
    const createForceTexture = () => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, textureSize, textureSize, 0, gl.RG, gl.FLOAT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.bindTexture(gl.TEXTURE_2D, null);
      return tex;
    };
    
    const fxTex = createForceTexture();
    const fyTex = createForceTexture();
    const fzTex = createForceTexture();
    
    const fxFBO = gl.createFramebuffer();
    const fyFBO = gl.createFramebuffer();
    const fzFBO = gl.createFramebuffer();
    
    psys.pmForceSpectrum = {
      x: { texture: fxTex, framebuffer: fxFBO },
      y: { texture: fyTex, framebuffer: fyFBO },
      z: { texture: fzTex, framebuffer: fzFBO },
      gridSize: psys.pmGrid.gridSize,
      textureSize: textureSize
    };
    
    console.log(`[PM Gradient] Force spectrum textures created (${textureSize}x${textureSize} x 3)`);
  }
}

/**
 * Compute gradient (force field) from potential spectrum
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectralMonolithic} psys
 * @param {number} boxSize - Physical size of simulation box
 */
export function computeGradient(psys, boxSize = null) {
  initGradient(psys);
  
  const gl = psys.gl;
  const program = psys.pmGradientProgram;
  const textureSize = psys.pmGrid.size;
  const gridSize = psys.pmGrid.gridSize;
  const slicesPerRow = psys.pmGrid.slicesPerRow;
  
  // Calculate box size from world bounds if not provided
  const bounds = psys.options?.worldBounds;
  let worldSize = [100.0, 100.0, 100.0];
  if (bounds) {
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    worldSize = [dx, dy, dz];
  } else if (boxSize != null) {
    worldSize = [boxSize, boxSize, boxSize];
  }
  
  gl.viewport(0, 0, textureSize, textureSize);
  
  // Set GL state
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.colorMask(true, true, true, true);
  
  gl.useProgram(program);
  
  // Bind input (potential spectrum)
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, psys.pmPotentialSpectrum.texture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_potentialSpectrum'), 0);
  
  // Set common uniforms
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), slicesPerRow);
  gl.uniform3f(
    gl.getUniformLocation(program, 'u_worldSize'),
    worldSize[0], worldSize[1], worldSize[2]
  );
  
  // Compute gradient for each axis
  const axes = [
    { name: 'X', index: 0, target: psys.pmForceSpectrum.x },
    { name: 'Y', index: 1, target: psys.pmForceSpectrum.y },
    { name: 'Z', index: 2, target: psys.pmForceSpectrum.z }
  ];
  
  for (const axis of axes) {
    // Bind output framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, axis.target.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      axis.target.texture,
      0
    );
    
    // Set axis uniform
    gl.uniform1i(gl.getUniformLocation(program, 'u_axis'), axis.index);
    
    // Draw fullscreen quad
    gl.bindVertexArray(psys.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
  
  gl.finish(); // Ensure completion
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  console.log(`[PM Gradient] Computed force field gradients (3 axes)`);
}

/**
 * Read force spectrum for debugging
 * @param {import('./particle-system-spectral.js').ParticleSystemSpectralMonolithic} psys
 * @param {number} axis - 0=X, 1=Y, 2=Z
 * @param {number} x - Texture x coordinate
 * @param {number} y - Texture y coordinate
 * @returns {{real: number, imag: number, magnitude: number}}
 */
export function readForceSpectrum(psys, axis, x, y) {
  const gl = psys.gl;
  
  const target = axis === 0 ? psys.pmForceSpectrum.x :
                 axis === 1 ? psys.pmForceSpectrum.y :
                 psys.pmForceSpectrum.z;
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    target.texture,
    0
  );
  
  const data = new Float32Array(2);
  gl.readPixels(x, y, 1, 1, gl.RG, gl.FLOAT, data);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  return {
    real: data[0],
    imag: data[1],
    magnitude: Math.sqrt(data[0] * data[0] + data[1] * data[1])
  };
}
