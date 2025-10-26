export default `#version 300 es
precision highp float;

// Octree 3D aggregation with Z-slice stacking
// Quadrupole version with GPU-resident bounds texture support

uniform sampler2D u_positions;   // RGBA: xyz + mass
uniform sampler2D u_bounds;       // 2×1 texture: texel 0 = min bounds, texel 1 = max bounds
uniform vec2 u_texSize;          // positions texture size
uniform vec3 u_worldMin;         // XYZ world min (fallback when no bounds texture)
uniform vec3 u_worldMax;         // XYZ world max (fallback when no bounds texture)
uniform float u_gridSize;        // octree grid size (e.g., 64)
uniform float u_slicesPerRow;    // slices per row (e.g., 8 for 8x8 grid)
uniform bool u_useBoundsTexture; // true if bounds texture available, false for uniform fallback

out vec4 v_particleA0;
out vec4 v_particleA1;
out vec4 v_particleA2;

ivec2 indexToCoord(int index, vec2 texSize) {
  int w = int(texSize.x);
  int ix = index % w;
  int iy = index / w;
  return ivec2(ix, iy);
}

// Convert 3D voxel coordinate to 2D texture coordinate
vec2 voxelToTexel(vec3 voxelCoord, float gridSize, float slicesPerRow) {
  float vx = voxelCoord.x;
  float vy = voxelCoord.y;
  float vz = voxelCoord.z;
  
  // Which Z-slice?
  float sliceIndex = vz;
  float sliceRow = floor(sliceIndex / slicesPerRow);
  float sliceCol = mod(sliceIndex, slicesPerRow);
  
  // Texel position
  float texelX = sliceCol * gridSize + vx;
  float texelY = sliceRow * gridSize + vy;
  
  return vec2(texelX, texelY);
}

void main() {
  int index = gl_VertexID;
  ivec2 coord = indexToCoord(index, u_texSize);
  vec4 pos = texelFetch(u_positions, coord, 0);
  float mass = pos.a;

  if (mass <= 0.0) {
    // Cull zero-mass entries
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    v_particleA0 = vec4(0.0);
    v_particleA1 = vec4(0.0);
    v_particleA2 = vec4(0.0);
    return;
  }

  // Get world bounds from texture or uniforms
  vec3 worldMin, worldMax;
  if (u_useBoundsTexture) {
    // Sample bounds texture: texel 0 = min, texel 1 = max
    vec4 minBounds = texelFetch(u_bounds, ivec2(0, 0), 0);
    vec4 maxBounds = texelFetch(u_bounds, ivec2(1, 0), 0);
    worldMin = minBounds.xyz - vec3(0.1); // Add small margin to prevent edge clamping
    worldMax = maxBounds.xyz + vec3(0.1);
  } else {
    // Fallback to uniform bounds (initial frames)
    worldMin = u_worldMin;
    worldMax = u_worldMax;
  }

  // Map particle XYZ to 3D voxel grid with isotropic boundaries
  vec3 worldExtent = worldMax - worldMin;
  vec3 norm = (pos.xyz - worldMin) / worldExtent;
  // Clamp to valid range, ensuring symmetric treatment of all axes
  norm = clamp(norm, vec3(0.0), vec3(0.9999));
  vec3 voxelCoord = floor(norm * u_gridSize);
  // Ensure voxel is within bounds (defensive)
  voxelCoord = clamp(voxelCoord, vec3(0.0), vec3(u_gridSize - 1.0));
  
  // Convert 3D voxel to 2D texture coordinate
  float textureSize = u_gridSize * u_slicesPerRow;
  vec2 texelPos = voxelToTexel(voxelCoord, u_gridSize, u_slicesPerRow);
  vec2 texelCenter = (texelPos + 0.5) / textureSize;
  vec2 clip = texelCenter * 2.0 - 1.0;

  gl_Position = vec4(clip, 0.0, 1.0);
  gl_PointSize = 1.0;

  // Weighted sum: store 3D weighted position and mass
  vec3 weightedPos = pos.xyz * mass;
  vec4 a0 = vec4(weightedPos, mass);
  vec4 a1 = vec4(pos.x * pos.x, pos.y * pos.y, pos.z * pos.z, pos.x * pos.y) * mass;
  vec4 a2 = vec4(pos.x * pos.z, pos.y * pos.z, 0.0, 0.0) * mass;

  v_particleA0 = a0;
  v_particleA1 = a1;
  v_particleA2 = a2;
}
`;
