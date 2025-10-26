export default /* glsl */`#version 300 es
precision highp float;

uniform sampler2D u_previousLevelA0;
uniform sampler2D u_previousLevelA1;
uniform sampler2D u_previousLevelA2;
uniform float u_gridSize;           // current level grid size (e.g., 32 for L1)
uniform float u_slicesPerRow;       // slices per row for current level (e.g., 4 for L1)
uniform float u_childGridSize;      // child (previous) level grid size (e.g., 64)
uniform float u_childSlicesPerRow;  // child (previous) level slices per row (e.g., 8)

layout(location = 0) out vec4 fragA0;
layout(location = 1) out vec4 fragA1;
layout(location = 2) out vec4 fragA2;

// Convert 3D voxel coordinate to 2D texture coordinate
ivec2 voxelToTexel(ivec3 voxelCoord, float gridSize, float slicesPerRow) {
  int vx = voxelCoord.x;
  int vy = voxelCoord.y;
  int vz = voxelCoord.z;
  
  // Which Z-slice?
  int sliceIndex = vz;
  int sliceRow = sliceIndex / int(slicesPerRow);
  int sliceCol = sliceIndex - sliceRow * int(slicesPerRow);  // mod without float conversion
  
  // Texel position
  int texelX = sliceCol * int(gridSize) + vx;
  int texelY = sliceRow * int(gridSize) + vy;
  
  return ivec2(texelX, texelY);
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  
  // Reverse the voxelToTexel mapping to get parent voxel coordinate
  int gridSizeInt = int(u_gridSize);
  int slicesPerRowInt = int(u_slicesPerRow);
  
  int sliceCol = coord.x / gridSizeInt;
  int sliceRow = coord.y / gridSizeInt;
  int sliceIndex = sliceRow * slicesPerRowInt + sliceCol;
  
  int vx = coord.x - sliceCol * gridSizeInt;
  int vy = coord.y - sliceRow * gridSizeInt;
  int vz = sliceIndex;
  
  ivec3 parentVoxel = ivec3(vx, vy, vz);
  
  // 8 children: 2x2x2 cube
  ivec3 childBase = parentVoxel * 2;
  
  // Fetch A0 (mass-weighted positions and mass) from all 8 children
  vec4 a0_000 = texelFetch(u_previousLevelA0, voxelToTexel(childBase + ivec3(0,0,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a0_001 = texelFetch(u_previousLevelA0, voxelToTexel(childBase + ivec3(0,0,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a0_010 = texelFetch(u_previousLevelA0, voxelToTexel(childBase + ivec3(0,1,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a0_011 = texelFetch(u_previousLevelA0, voxelToTexel(childBase + ivec3(0,1,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a0_100 = texelFetch(u_previousLevelA0, voxelToTexel(childBase + ivec3(1,0,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a0_101 = texelFetch(u_previousLevelA0, voxelToTexel(childBase + ivec3(1,0,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a0_110 = texelFetch(u_previousLevelA0, voxelToTexel(childBase + ivec3(1,1,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a0_111 = texelFetch(u_previousLevelA0, voxelToTexel(childBase + ivec3(1,1,1), u_childGridSize, u_childSlicesPerRow), 0);
  
  // Fetch A1 (second moments: x², y², z², xy) from all 8 children
  vec4 a1_000 = texelFetch(u_previousLevelA1, voxelToTexel(childBase + ivec3(0,0,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a1_001 = texelFetch(u_previousLevelA1, voxelToTexel(childBase + ivec3(0,0,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a1_010 = texelFetch(u_previousLevelA1, voxelToTexel(childBase + ivec3(0,1,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a1_011 = texelFetch(u_previousLevelA1, voxelToTexel(childBase + ivec3(0,1,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a1_100 = texelFetch(u_previousLevelA1, voxelToTexel(childBase + ivec3(1,0,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a1_101 = texelFetch(u_previousLevelA1, voxelToTexel(childBase + ivec3(1,0,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a1_110 = texelFetch(u_previousLevelA1, voxelToTexel(childBase + ivec3(1,1,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a1_111 = texelFetch(u_previousLevelA1, voxelToTexel(childBase + ivec3(1,1,1), u_childGridSize, u_childSlicesPerRow), 0);
  
  // Fetch A2 (second moments: xz, yz) from all 8 children
  vec4 a2_000 = texelFetch(u_previousLevelA2, voxelToTexel(childBase + ivec3(0,0,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a2_001 = texelFetch(u_previousLevelA2, voxelToTexel(childBase + ivec3(0,0,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a2_010 = texelFetch(u_previousLevelA2, voxelToTexel(childBase + ivec3(0,1,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a2_011 = texelFetch(u_previousLevelA2, voxelToTexel(childBase + ivec3(0,1,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a2_100 = texelFetch(u_previousLevelA2, voxelToTexel(childBase + ivec3(1,0,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a2_101 = texelFetch(u_previousLevelA2, voxelToTexel(childBase + ivec3(1,0,1), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a2_110 = texelFetch(u_previousLevelA2, voxelToTexel(childBase + ivec3(1,1,0), u_childGridSize, u_childSlicesPerRow), 0);
  vec4 a2_111 = texelFetch(u_previousLevelA2, voxelToTexel(childBase + ivec3(1,1,1), u_childGridSize, u_childSlicesPerRow), 0);
  
  // Aggregate: sum all 8 children for each attachment
  fragA0 = a0_000 + a0_001 + a0_010 + a0_011 + a0_100 + a0_101 + a0_110 + a0_111;
  fragA1 = a1_000 + a1_001 + a1_010 + a1_011 + a1_100 + a1_101 + a1_110 + a1_111;
  fragA2 = a2_000 + a2_001 + a2_010 + a2_011 + a2_100 + a2_101 + a2_110 + a2_111;
}`;
