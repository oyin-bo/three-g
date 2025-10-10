// @ts-check

/**
 * PM Debug Overlay System
 * 
 * Visual debugging of grids and spectra:
 * - Grid slice visualization (2D slice of 3D field)
 * - Spectrum magnitude heatmap
 * - Vector field glyphs (acceleration arrows)
 */

/**
 * Render a 2D slice of a 3D grid
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {WebGLTexture} gridTexture - 3D grid in sliced layout
 * @param {'x' | 'y' | 'z'} axis - Slice axis
 * @param {number} index - Slice index
 * @param {boolean} logScale - Use logarithmic color scale
 * @param {number} channel - Color channel (0=R, 1=G, 2=B, 3=A)
 */
export function renderGridSlice(psys, gridTexture, axis, index, logScale = false, channel = 0) {
  const gl = psys.gl;
  
  const program = getOrCreateOverlayProgram(psys);
  gl.useProgram(program);
  
  // Bind to default framebuffer (screen)
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Get canvas dimensions
  const canvas = gl.canvas;
  gl.viewport(0, 0, canvas.width, canvas.height);
  
  // Set uniforms
  gl.uniform1i(gl.getUniformLocation(program, 'u_overlayType'), 0); // grid slice
  gl.uniform1i(gl.getUniformLocation(program, 'u_axis'), axis === 'x' ? 0 : axis === 'y' ? 1 : 2);
  gl.uniform1i(gl.getUniformLocation(program, 'u_sliceIndex'), index);
  gl.uniform1i(gl.getUniformLocation(program, 'u_logScale'), logScale ? 1 : 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_channel'), channel);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), psys.octreeGridSize || 64);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), psys.octreeSlicesPerRow || 8);
  
  // Bind grid texture
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, gridTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_gridTexture'), 0);
  
  // Draw fullscreen quad
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  console.log(`[PM Overlay] Rendered grid slice: axis=${axis}, index=${index}`);
}

/**
 * Render spectrum magnitude as heatmap
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {WebGLTexture} spectrumTexture - Complex spectrum (RG32F)
 * @param {boolean} logScale 
 */
export function renderSpectrumMagnitude(psys, spectrumTexture, logScale = true) {
  const gl = psys.gl;
  
  const program = getOrCreateOverlayProgram(psys);
  gl.useProgram(program);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const canvas = gl.canvas;
  gl.viewport(0, 0, canvas.width, canvas.height);
  
  gl.uniform1i(gl.getUniformLocation(program, 'u_overlayType'), 1); // spectrum
  gl.uniform1i(gl.getUniformLocation(program, 'u_logScale'), logScale ? 1 : 0);
  gl.uniform1f(gl.getUniformLocation(program, 'u_gridSize'), psys.octreeGridSize || 64);
  gl.uniform1f(gl.getUniformLocation(program, 'u_slicesPerRow'), psys.octreeSlicesPerRow || 8);
  
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, spectrumTexture);
  gl.uniform1i(gl.getUniformLocation(program, 'u_gridTexture'), 0);
  
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.bindVertexArray(psys.quadVAO);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.bindVertexArray(null);
  
  console.log(`[PM Overlay] Rendered spectrum magnitude heatmap`);
}

/**
 * Render vector field glyphs
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @param {WebGLTexture} fieldX 
 * @param {WebGLTexture} fieldY 
 * @param {WebGLTexture} fieldZ 
 * @param {number} stride - Sampling stride
 */
export function renderVectorGlyphs(psys, fieldX, fieldY, fieldZ, stride = 4) {
  const gl = psys.gl;
  
  console.log(`[PM Overlay] Vector glyphs visualization (stride=${stride}) - not yet implemented`);
  // Would draw arrows/lines showing vector field direction and magnitude
  // Requires instanced rendering or point sprites with geometry shader
}

/**
 * Get or create overlay shader program
 * @param {import('../particle-system.js').ParticleSystem} psys 
 * @returns {WebGLProgram}
 */
function getOrCreateOverlayProgram(psys) {
  if (psys._pmDebugState?.programs?.overlay) {
    return psys._pmDebugState.programs.overlay;
  }
  
  const gl = psys.gl;
  
  const vertSrc = `#version 300 es
    in vec2 a_position;
    out vec2 v_uv;
    
    void main() {
      v_uv = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `;
  
  const fragSrc = `#version 300 es
    precision highp float;
    
    in vec2 v_uv;
    out vec4 outColor;
    
    uniform int u_overlayType;
    uniform int u_axis;
    uniform int u_sliceIndex;
    uniform int u_logScale;
    uniform int u_channel;
    uniform float u_gridSize;
    uniform float u_slicesPerRow;
    uniform sampler2D u_gridTexture;
    
    // Convert 3D voxel to 2D texture coords (sliced layout)
    vec2 voxelToTexCoord(ivec3 voxel, float gridSize, float slicesPerRow) {
      int sliceIndex = voxel.z;
      int sliceRow = int(float(sliceIndex) / slicesPerRow);
      int sliceCol = sliceIndex - sliceRow * int(slicesPerRow);
      
      vec2 sliceOrigin = vec2(float(sliceCol) * gridSize, float(sliceRow) * gridSize);
      vec2 texel = sliceOrigin + vec2(voxel.xy);
      
      float texSize = gridSize * slicesPerRow;
      return texel / texSize;
    }
    
    // Turbo colormap (perceptually uniform, better than jet)
    vec3 turbo(float t) {
      t = clamp(t, 0.0, 1.0);
      const vec3 c0 = vec3(0.1140, 0.0618, 0.2387);
      const vec3 c1 = vec3(6.7164, 6.1945, -1.8185);
      const vec3 c2 = vec3(-15.9324, -13.4729, 9.5373);
      const vec3 c3 = vec3(13.0959, 10.2043, -6.7338);
      const vec3 c4 = vec3(-4.6340, -3.7058, 2.7221);
      return c0 + t * (c1 + t * (c2 + t * (c3 + t * c4)));
    }
    
    void main() {
      if (u_overlayType == 0) {
        // Grid slice
        int N = int(u_gridSize);
        
        // Map UV to slice coordinates
        ivec2 sliceCoord = ivec2(v_uv * float(N));
        
        // Build 3D voxel coordinate based on axis
        ivec3 voxel;
        if (u_axis == 0) {
          // X slice: vary Y,Z
          voxel = ivec3(u_sliceIndex, sliceCoord.x, sliceCoord.y);
        } else if (u_axis == 1) {
          // Y slice: vary X,Z
          voxel = ivec3(sliceCoord.x, u_sliceIndex, sliceCoord.y);
        } else {
          // Z slice: vary X,Y
          voxel = ivec3(sliceCoord.x, sliceCoord.y, u_sliceIndex);
        }
        
        // Clamp to valid range
        voxel = clamp(voxel, ivec3(0), ivec3(N-1));
        
        // Get texture coordinate
        vec2 texCoord = voxelToTexCoord(voxel, u_gridSize, u_slicesPerRow);
        vec4 sample = texture(u_gridTexture, texCoord);
        
        // Extract channel
        float value;
        if (u_channel == 0) value = sample.r;
        else if (u_channel == 1) value = sample.g;
        else if (u_channel == 2) value = sample.b;
        else value = sample.a;
        
        // Apply log scale if requested
        if (u_logScale == 1) {
          value = log(abs(value) + 1e-8);
        }
        
        // Normalize to [0,1] for colormap (heuristic range)
        float vmin = u_logScale == 1 ? -10.0 : -1.0;
        float vmax = u_logScale == 1 ? 10.0 : 1.0;
        float t = (value - vmin) / (vmax - vmin);
        
        // Apply colormap
        vec3 color = turbo(t);
        outColor = vec4(color, 1.0);
      }
      else if (u_overlayType == 1) {
        // Spectrum magnitude heatmap
        // For now, just show a single Z-slice of the 3D spectrum
        vec4 spectrum = texture(u_gridTexture, v_uv);
        
        // Compute magnitude: |F| = sqrt(real² + imag²)
        float magnitude = sqrt(spectrum.r * spectrum.r + spectrum.g * spectrum.g);
        
        // Log scale
        if (u_logScale == 1) {
          magnitude = log(magnitude + 1e-10);
        }
        
        // Normalize and colormap
        float vmin = u_logScale == 1 ? -15.0 : 0.0;
        float vmax = u_logScale == 1 ? 5.0 : 10.0;
        float t = (magnitude - vmin) / (vmax - vmin);
        
        vec3 color = turbo(t);
        outColor = vec4(color, 1.0);
      }
      else {
        outColor = vec4(1.0, 0.0, 1.0, 1.0); // Magenta for unknown type
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
  
  psys._pmDebugState.programs.overlay = program;
  return program;
}
