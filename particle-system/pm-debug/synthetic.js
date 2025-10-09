// @ts-check

/**
 * PM Debug Synthetic Sources
 * 
 * Generate synthetic test patterns for stage isolation:
 * - Grid impulse: delta function at a voxel
 * - Two point masses: pair of masses at specific locations
 * - Plane wave density: sinusoidal density pattern
 * - Spectrum delta: single k-mode in Fourier space
 * - Spectrum white noise: random spectrum for testing
 */

/**
 * Generate synthetic grid impulse
 * Writes a delta function (single voxel with mass) to the mass grid
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {[number, number, number]} centerVoxel - Voxel coordinates (ix, iy, iz)
 * @param {number} mass - Mass value
 * @param {WebGLTexture} targetTexture - Target mass grid texture
 */
export function generateGridImpulse(psys, centerVoxel, mass, targetTexture) {
  const gl = psys.gl;
  
  // Clear target first
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTexture, 0);
  
  const gridSize = psys.pmGrid?.gridSize || 64;
  const slicesPerRow = psys.pmGrid?.slicesPerRow || 8;
  const textureSize = psys.pmGrid?.size || 512;
  
  gl.viewport(0, 0, textureSize, textureSize);
  
  // Set GL state for clean rendering
  gl.disable(gl.BLEND);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.STENCIL_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);
  gl.colorMask(true, true, true, true);
  
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  // Use synthetic program to write impulse
  const program = getOrCreateSyntheticProgram(psys);
  gl.useProgram(program);
  
  // Set uniforms
  gl.uniform1i(gl.getUniformLocation(program, 'u_synthType'), 0); // grid impulse
  gl.uniform3f(gl.getUniformLocation(program, 'u_centerVoxel'), 
    centerVoxel[0], centerVoxel[1], centerVoxel[2]);
  gl.uniform1f(gl.getUniformLocation(program, 'u_mass'), mass);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), slicesPerRow);
  
  // Draw fullscreen quad
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  gl.finish(); // Ensure draw completes
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
}

/**
 * Generate two point masses
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {[number, number, number]} a - First voxel
 * @param {[number, number, number]} b - Second voxel
 * @param {number} ma - Mass at a
 * @param {number} mb - Mass at b
 * @param {WebGLTexture} targetTexture 
 */
export function generateTwoPointMasses(psys, a, b, ma, mb, targetTexture) {
  const gl = psys.gl;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTexture, 0);
  
  const gridSize = psys.pmGrid?.gridSize || 64;
  const slicesPerRow = psys.pmGrid?.slicesPerRow || 8;
  const textureSize = psys.pmGrid?.size || 512;
  
  gl.viewport(0, 0, textureSize, textureSize);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  const program = getOrCreateSyntheticProgram(psys);
  gl.useProgram(program);
  
  gl.uniform1i(gl.getUniformLocation(program, 'u_synthType'), 1); // two point masses
  gl.uniform3f(gl.getUniformLocation(program, 'u_pointA'), a[0], a[1], a[2]);
  gl.uniform3f(gl.getUniformLocation(program, 'u_pointB'), b[0], b[1], b[2]);
  gl.uniform1f(gl.getUniformLocation(program, 'u_massA'), ma);
  gl.uniform1f(gl.getUniformLocation(program, 'u_massB'), mb);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), slicesPerRow);
  
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
}

/**
 * Generate plane wave density pattern
 * ρ(x) = amplitude * cos(2π k·x / N)
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {[number, number, number]} k - Wave vector (kx, ky, kz)
 * @param {number} amplitude 
 * @param {WebGLTexture} targetTexture 
 */
export function generatePlaneWaveDensity(psys, k, amplitude, targetTexture) {
  const gl = psys.gl;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTexture, 0);
  
  const gridSize = psys.pmGrid?.gridSize || 64;
  const slicesPerRow = psys.pmGrid?.slicesPerRow || 8;
  const textureSize = psys.pmGrid?.size || 512;
  
  gl.viewport(0, 0, textureSize, textureSize);
  
  const program = getOrCreateSyntheticProgram(psys);
  gl.useProgram(program);
  
  gl.uniform1i(gl.getUniformLocation(program, 'u_synthType'), 2); // plane wave
  gl.uniform3f(gl.getUniformLocation(program, 'u_waveVector'), k[0], k[1], k[2]);
  gl.uniform1f(gl.getUniformLocation(program, 'u_amplitude'), amplitude);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), gridSize);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), slicesPerRow);
  
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
}

/**
 * Generate spectrum delta (single k-mode)
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {[number, number, number]} k - Wave vector
 * @param {number} amplitude 
 * @param {WebGLTexture} targetTexture - RG32F complex spectrum
 */
export function generateSpectrumDelta(psys, k, amplitude, targetTexture) {
  const gl = psys.gl;
  
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, targetTexture, 0);
  
  const size = psys.L0Size || 512;
  gl.viewport(0, 0, size, size);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  
  const program = getOrCreateSyntheticProgram(psys);
  gl.useProgram(program);
  
  gl.uniform1i(gl.getUniformLocation(program, 'u_synthType'), 3); // spectrum delta
  gl.uniform3f(gl.getUniformLocation(program, 'u_waveVector'), k[0], k[1], k[2]);
  gl.uniform1f(gl.getUniformLocation(program, 'u_amplitude'), amplitude);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), psys.octreeGridSize || 64);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), psys.octreeSlicesPerRow || 8);
  
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
}

/**
 * Get or create synthetic shader program
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @returns {WebGLProgram}
 */
function getOrCreateSyntheticProgram(psys) {
  if (psys._pmDebugState?.programs?.synthetic) {
    return psys._pmDebugState.programs.synthetic;
  }
  
  const gl = psys.gl;
  
  // Vertex shader (fullscreen quad)
  const vertSrc = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;
    
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;
  
  // Fragment shader
  const fragSrc = `#version 300 es
    precision highp float;
    
    in vec2 v_uv;
    out vec4 outColor;
    
    uniform int u_synthType;
    uniform vec3 u_centerVoxel;
    uniform vec3 u_pointA;
    uniform vec3 u_pointB;
    uniform vec3 u_waveVector;
    uniform float u_mass;
    uniform float u_massA;
    uniform float u_massB;
    uniform float u_amplitude;
    uniform float u_gridSize;
    uniform float u_slicesPerRow;
    
    const float PI = 3.14159265359;
    
    // Convert 2D texture coords to 3D voxel coords
    ivec3 texCoordToVoxel(vec2 uv, float gridSize, float slicesPerRow) {
      vec2 texel = uv * gridSize * slicesPerRow;
      int sliceIndex = int(texel.y / gridSize) * int(slicesPerRow) + int(texel.x / gridSize);
      int iz = sliceIndex;
      int ix = int(mod(texel.x, gridSize));
      int iy = int(mod(texel.y, gridSize));
      return ivec3(ix, iy, iz);
    }
    
    void main() {
      ivec3 voxel = texCoordToVoxel(v_uv, u_gridSize, u_slicesPerRow);
      
      if (u_synthType == 0) {
        // Grid impulse (mass in ALPHA channel to match PM deposit)
        ivec3 center = ivec3(u_centerVoxel);
        if (voxel == center) {
          outColor = vec4(0.0, 0.0, 0.0, u_mass);
        } else {
          outColor = vec4(0.0);
        }
      } 
      else if (u_synthType == 1) {
        // Two point masses (mass in ALPHA channel)
        ivec3 a = ivec3(u_pointA);
        ivec3 b = ivec3(u_pointB);
        float mass = 0.0;
        if (voxel == a) mass += u_massA;
        if (voxel == b) mass += u_massB;
        outColor = vec4(0.0, 0.0, 0.0, mass);
      }
      else if (u_synthType == 2) {
        // Plane wave density (mass in ALPHA channel)
        vec3 pos = vec3(voxel) / u_gridSize;
        float phase = 2.0 * PI * dot(u_waveVector, pos);
        float density = u_amplitude * cos(phase);
        outColor = vec4(0.0, 0.0, 0.0, density);
      }
      else if (u_synthType == 3) {
        // Spectrum delta (single k-mode)
        ivec3 k = ivec3(u_waveVector);
        // Handle negative frequencies with wrapping
        ivec3 kWrapped = k;
        int N = int(u_gridSize);
        if (k.x < 0) kWrapped.x += N;
        if (k.y < 0) kWrapped.y += N;
        if (k.z < 0) kWrapped.z += N;
        
        if (voxel == kWrapped) {
          // RG32F: R=real, G=imag
          outColor = vec4(u_amplitude, 0.0, 0.0, 0.0);
        } else {
          outColor = vec4(0.0);
        }
      }
      else {
        outColor = vec4(0.0);
      }
    }
  `;
  
  const program = psys.createProgram(vertSrc, fragSrc);
  
  if (!psys._pmDebugState) {
    psys._pmDebugState = {
      config: { enabled: false },
      snapshots: new Map(),
      programs: {},
      metricsResults: new Map()
    };
  }
  
  psys._pmDebugState.programs.synthetic = program;
  return program;
}
