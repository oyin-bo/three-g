// @ts-check

/**
 * Force Sampling Fragment Shader
 * 
 * Samples force field from PM grid at particle positions
 * Uses trilinear interpolation for smooth force field
 */

export default /* glsl */`#version 300 es
precision highp float;

in vec3 v_particlePosition;
in float v_particleMass;

out vec4 outForce;

uniform sampler2D u_forceGridX;  // X-component of force field
uniform sampler2D u_forceGridY;  // Y-component
uniform sampler2D u_forceGridZ;  // Z-component

uniform float u_gridSize;        // Grid resolution (N)
uniform float u_slicesPerRow;    // Z-slices per row
uniform vec3 u_worldMin;         // World bounds
uniform vec3 u_worldMax;
uniform vec2 u_textureSize; // packed 3D grid texture size (width, height)
uniform vec2 u_particleTextureSize; // particle sheet size (width, height)

/**
 * Convert 3D voxel coordinates to 2D texture coordinates
 */
vec2 voxelToTexCoord(vec3 voxel, float gridSize, float slicesPerRow) {
  int iz = int(voxel.z);
  int sliceRow = iz / int(slicesPerRow);
  int sliceCol = iz - sliceRow * int(slicesPerRow);
  
  float texX = float(sliceCol * int(gridSize)) + voxel.x + 0.5;
  float texY = float(sliceRow * int(gridSize)) + voxel.y + 0.5;
  
  // Normalize by the actual 2D texture width/height
  return vec2(texX / u_textureSize.x, texY / u_textureSize.y);
}

/**
 * Trilinear interpolation
 * Sample value from 3D grid stored as 2D texture
 */
float sampleGrid3D(sampler2D gridTexture, vec3 gridPos, float gridSize, float slicesPerRow) {
  // Get integer cell coordinates (floor)
  vec3 cell = floor(gridPos);
  
  // Get fractional position within cell
  vec3 frac = gridPos - cell;
  
  // Clamp to grid bounds
  cell = clamp(cell, vec3(0.0), vec3(gridSize - 1.0));
  
  // Sample 8 corners of the cube
  vec3 corners[8];
  corners[0] = cell + vec3(0.0, 0.0, 0.0);
  corners[1] = cell + vec3(1.0, 0.0, 0.0);
  corners[2] = cell + vec3(0.0, 1.0, 0.0);
  corners[3] = cell + vec3(1.0, 1.0, 0.0);
  corners[4] = cell + vec3(0.0, 0.0, 1.0);
  corners[5] = cell + vec3(1.0, 0.0, 1.0);
  corners[6] = cell + vec3(0.0, 1.0, 1.0);
  corners[7] = cell + vec3(1.0, 1.0, 1.0);
  
  // Clamp corners to grid bounds
  for (int i = 0; i < 8; i++) {
    corners[i] = clamp(corners[i], vec3(0.0), vec3(gridSize - 1.0));
  }
  
  // Sample values at 8 corners
  float values[8];
  for (int i = 0; i < 8; i++) {
    vec2 uv = voxelToTexCoord(corners[i], gridSize, slicesPerRow);
    // Force is stored in R channel (extracted from inverse FFT)
    values[i] = texture(gridTexture, uv).r;
  }
  
  // Trilinear interpolation
  // Interpolate along X
  float c00 = mix(values[0], values[1], frac.x);
  float c01 = mix(values[2], values[3], frac.x);
  float c10 = mix(values[4], values[5], frac.x);
  float c11 = mix(values[6], values[7], frac.x);
  
  // Interpolate along Y
  float c0 = mix(c00, c01, frac.y);
  float c1 = mix(c10, c11, frac.y);
  
  // Interpolate along Z
  return mix(c0, c1, frac.z);
}

void main() {
  // Convert world position to grid coordinates [0, N]
  vec3 worldSize = u_worldMax - u_worldMin;
  vec3 gridPos = (v_particlePosition - u_worldMin) / worldSize * u_gridSize;
  
  // Clamp to valid range
  gridPos = clamp(gridPos, vec3(0.0), vec3(u_gridSize - 1.0));
  
  // Sample force components using trilinear interpolation
  float fx = sampleGrid3D(u_forceGridX, gridPos, u_gridSize, u_slicesPerRow);
  float fy = sampleGrid3D(u_forceGridY, gridPos, u_gridSize, u_slicesPerRow);
  float fz = sampleGrid3D(u_forceGridZ, gridPos, u_gridSize, u_slicesPerRow);
  
  // Output force (will be added to particle velocity)
  // Store in RGB, mass in A for reference
  outForce = vec4(fx, fy, fz, v_particleMass);
}
`;
