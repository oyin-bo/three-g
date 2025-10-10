// @ts-check

/**
 * PM Deposit Vertex Shader
 * 
 * Deposits particle mass onto PM grid using point sprites.
 * Each particle is rendered as a point, and the fragment shader
 * distributes mass to nearby grid cells (CIC or NGP scheme).
 */

export default /* glsl */`#version 300 es
precision highp float;

// Particle data from texture
uniform sampler2D u_positionTexture;
uniform vec2 u_textureSize;

// Grid parameters
uniform float u_gridSize;        // Grid resolution (N)
uniform float u_slicesPerRow;    // Z-slices per row
uniform vec3 u_worldMin;         // World space bounds
uniform vec3 u_worldMax;
uniform float u_particleSize;    // Point size for deposition kernel

// Outputs to fragment shader
out float v_mass;
out vec3 v_gridPos;  // Position in grid space [0, N]

void main() {
  // Get particle index from gl_VertexID
  int particleIndex = gl_VertexID;
  
  // Convert to texture coordinates
  int texWidth = int(u_textureSize.x);
  int texX = particleIndex % texWidth;
  int texY = particleIndex / texWidth;
  vec2 texCoord = (vec2(texX, texY) + 0.5) / u_textureSize;
  
  // Read particle position and mass
  vec4 posData = texture(u_positionTexture, texCoord);
  vec3 worldPos = posData.xyz;
  float mass = posData.w;
  
  v_mass = mass;
  
  // Convert world position to grid coordinates [0, N]
  vec3 gridPos = (worldPos - u_worldMin) / (u_worldMax - u_worldMin) * u_gridSize;
  v_gridPos = gridPos;
  
  // Get voxel index
  ivec3 voxel = ivec3(floor(gridPos));
  voxel = clamp(voxel, ivec3(0), ivec3(int(u_gridSize) - 1));
  
  // Convert voxel to 2D texture coordinates
  int sliceRow = voxel.z / int(u_slicesPerRow);
  int sliceCol = voxel.z - sliceRow * int(u_slicesPerRow);
  
  vec2 texel = vec2(
    float(sliceCol * int(u_gridSize) + voxel.x),
    float(sliceRow * int(u_gridSize) + voxel.y)
  );
  
  // Convert to NDC [-1, 1]
  float textureSize = u_gridSize * u_slicesPerRow;
  vec2 ndc = (texel / textureSize) * 2.0 - 1.0;
  
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = u_particleSize;
}
`;
