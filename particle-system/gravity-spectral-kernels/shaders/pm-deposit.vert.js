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
uniform sampler2D u_positions;
uniform vec2 u_particleTextureSize;

// Grid parameters
uniform float u_gridSize;        // Grid resolution (N)
uniform float u_slicesPerRow;    // Z-slices per row
uniform vec3 u_worldMin;         // World space bounds
uniform vec3 u_worldMax;
uniform float u_particleSize;    // Point size for deposition kernel
uniform int u_assignment;        // 0 = NGP, 1 = CIC
uniform vec3 u_cellOffset;       // Offset applied for CIC (0 or 1 per axis)
uniform vec2 u_textureSize;      // 2D packed texture size (width, height)

// Outputs to fragment shader
out float v_mass;
out vec3 v_gridPos;  // Position in grid space [0, N]
out float v_weight;  // CIC weight per offset

void main() {
  // Get particle index from gl_VertexID
  int particleIndex = gl_VertexID;
  
  // Convert to texture coordinates
  int texWidth = int(u_particleTextureSize.x);
  int texX = particleIndex % texWidth;
  int texY = particleIndex / texWidth;
  vec2 texCoord = (vec2(texX, texY) + 0.5) / u_particleTextureSize;
  
  // Read particle position and mass
  vec4 posData = texture(u_positions, texCoord);
  vec3 worldPos = posData.xyz;
  float mass = posData.w;
  
  v_mass = mass;
  
  // Convert world position to grid coordinates [0, N]
  vec3 gridPos = (worldPos - u_worldMin) / (u_worldMax - u_worldMin) * u_gridSize;
  v_gridPos = gridPos;
  
  vec3 baseVoxelF = floor(gridPos);
  ivec3 baseVoxel = ivec3(baseVoxelF);
  vec3 frac = gridPos - baseVoxelF;

  // If CIC, apply offset and compute weight; otherwise use base cell
  ivec3 voxel = baseVoxel;
  float weight = 1.0;
  if (u_assignment == 1) {
    // CIC uses offsets 0 or 1 on each axis
    vec3 offset = u_cellOffset;
    voxel += ivec3(offset);

    // clamp inside grid
    voxel = clamp(voxel, ivec3(0), ivec3(int(u_gridSize) - 1));

    vec3 w = mix(1.0 - frac, frac, offset);
    weight = w.x * w.y * w.z;
  } else {
    voxel = clamp(voxel, ivec3(0), ivec3(int(u_gridSize) - 1));
  }
  v_weight = weight;
  
  // Convert voxel to 2D texture coordinates
  int sliceRow = voxel.z / int(u_slicesPerRow);
  int sliceCol = voxel.z % int(u_slicesPerRow);

  
  vec2 texel = vec2(
    float(sliceCol * int(u_gridSize) + voxel.x) + 0.5,
    float(sliceRow * int(u_gridSize) + voxel.y) + 0.5
  );
  
  // Convert to NDC [-1, 1]
  // Normalize texel coordinates by the actual texture dimensions
  vec2 ndc = vec2(texel.x / u_textureSize.x, texel.y / u_textureSize.y) * 2.0 - 1.0;
  
  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = u_particleSize;
}
`;
