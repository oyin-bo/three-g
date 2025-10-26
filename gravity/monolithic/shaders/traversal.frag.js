export default `#version 300 es
precision highp float;

// 3D isotropic octree traversal with Barnes-Hut

uniform sampler2D u_particlePositions;
uniform sampler2D u_quadtreeLevel0;
uniform sampler2D u_quadtreeLevel1;
uniform sampler2D u_quadtreeLevel2;
uniform sampler2D u_quadtreeLevel3;
uniform sampler2D u_quadtreeLevel4;
uniform sampler2D u_quadtreeLevel5;
uniform sampler2D u_quadtreeLevel6;
uniform sampler2D u_quadtreeLevel7;
uniform float u_theta;
uniform int u_numLevels;
uniform float u_cellSizes[8];
uniform float u_gridSizes[8];         // voxel grid sizes per level
uniform float u_slicesPerRow[8];      // slices per row per level
uniform vec2 u_texSize;
uniform int u_particleCount;
uniform vec3 u_worldMin;
uniform vec3 u_worldMax;
uniform float u_softening;
uniform float u_G;

out vec4 fragColor;

vec4 sampleLevel(int level, ivec2 coord) {
  if (level == 0) { return texelFetch(u_quadtreeLevel0, coord, 0); }
  else if (level == 1) { return texelFetch(u_quadtreeLevel1, coord, 0); }
  else if (level == 2) { return texelFetch(u_quadtreeLevel2, coord, 0); }
  else if (level == 3) { return texelFetch(u_quadtreeLevel3, coord, 0); }
  else if (level == 4) { return texelFetch(u_quadtreeLevel4, coord, 0); }
  else if (level == 5) { return texelFetch(u_quadtreeLevel5, coord, 0); }
  else if (level == 6) { return texelFetch(u_quadtreeLevel6, coord, 0); }
  else if (level == 7) { return texelFetch(u_quadtreeLevel7, coord, 0); }
  else { return vec4(0.0); }
}

// Convert 3D voxel coordinate to 2D texture coordinate
ivec2 voxelToTexel(ivec3 voxelCoord, float gridSize, float slicesPerRow) {
  int vx = voxelCoord.x;
  int vy = voxelCoord.y;
  int vz = voxelCoord.z;
  
  // Which Z-slice?
  int sliceIndex = vz;
  int sliceRow = sliceIndex / int(slicesPerRow);
  int sliceCol = sliceIndex - sliceRow * int(slicesPerRow);
  
  // Texel position
  int texelX = sliceCol * int(gridSize) + vx;
  int texelY = sliceRow * int(gridSize) + vy;
  
  return ivec2(texelX, texelY);
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int myIndex = coord.y * int(u_texSize.x) + coord.x;
  if (myIndex >= u_particleCount) {
    fragColor = vec4(0.0);
    return;
  }

  vec2 myUV = (vec2(coord) + 0.5) / u_texSize;
  vec3 myPos = texture(u_particlePositions, myUV).xyz;
  vec3 totalForce = vec3(0.0);

  vec3 worldExtent = u_worldMax - u_worldMin;
  float eps = max(u_softening, 1e-6);

  // Traverse octree levels from coarsest to finest
  for (int level = min(u_numLevels - 1, 7); level >= 0; level--) {
    float gridSize = u_gridSizes[level];
    float slicesPerRow = u_slicesPerRow[level];
    float cellSize = u_cellSizes[level];

    // Special case: root level (1×1×1 voxel) - single cell containing all particles
    if (gridSize == 1.0) {
      vec4 root = sampleLevel(level, ivec2(0, 0));
      float massSum = root.a;
      if (massSum > 0.0) {
        vec3 com = root.rgb / max(massSum, 1e-6);
        vec3 delta = com - myPos;
        float d = length(delta);
        float s = cellSize;
        // Always use root-level approximation if any mass exists (no theta check needed for root)
        if (d > eps) {
          // Only apply force if distance is non-zero (avoid singularity at exact self)
          float dSq = d * d;
          float softSq = eps * eps;
          float denom = dSq + softSq;
          float inv = 1.0 / (denom * sqrt(denom)); // 1 / (d² + eps²)^1.5
          totalForce += delta * massSum * inv;
        }
      }
      continue;
    }

    // Find my voxel coordinate at this level
    vec3 norm = (myPos - u_worldMin) / worldExtent;
    norm = clamp(norm, vec3(0.0), vec3(1.0 - (1.0 / gridSize)));
    ivec3 myVoxel = ivec3(floor(norm * gridSize));

    // Sample voxels at this level
    // If this is the coarsest level, check ALL voxels (no parent to provide far-field approximation)
    // Otherwise, only check local neighborhood (far voxels handled by parent levels)
    bool isCoarsestLevel = (level == u_numLevels - 1);
    int R = isCoarsestLevel ? int(gridSize) : 1;
    
    int startDx = isCoarsestLevel ? 0 : -1;
    int startDy = isCoarsestLevel ? 0 : -1;
    int startDz = isCoarsestLevel ? 0 : -1;
    int endDx = isCoarsestLevel ? int(gridSize) - 1 : min(1, int(gridSize) - 1);
    int endDy = isCoarsestLevel ? int(gridSize) - 1 : min(1, int(gridSize) - 1);
    int endDz = isCoarsestLevel ? int(gridSize) - 1 : min(1, int(gridSize) - 1);
    
    for (int vz = startDz; vz <= endDz; vz++) {
      for (int vy = startDy; vy <= endDy; vy++) {
        for (int vx = startDx; vx <= endDx; vx++) {
          ivec3 neighborVoxel = isCoarsestLevel ? ivec3(vx, vy, vz) : (myVoxel + ivec3(vx, vy, vz));
          
          // Bounds check
          if (neighborVoxel.x < 0 || neighborVoxel.y < 0 || neighborVoxel.z < 0 ||
              neighborVoxel.x >= int(gridSize) || neighborVoxel.y >= int(gridSize) || neighborVoxel.z >= int(gridSize)) {
            continue;
          }
          
          ivec2 texCoord = voxelToTexel(neighborVoxel, gridSize, slicesPerRow);
          vec4 nodeData = sampleLevel(level, texCoord);
          float m = nodeData.a;
          if (m <= 0.0) { continue; }
          
          // Sub-voxel COM for smoother force field
          vec3 com = nodeData.rgb / max(m, 1e-6);
          vec3 delta = com - myPos;
          float d = length(delta);
          float s = cellSize;
          
          // If the node is too close to approximate, we must go to a finer level.
          // The force from this node's children will be accounted for at the next level down.
          if ((s / max(d, eps)) > u_theta) {
            continue;
          }
          
          // Optimization: if we accept a parent node, we don't need to visit its children
          // that are also accepted. We subtract the mass of already-visited children.
          // This is a simple form of the MAC, but here we just skip the parent.
          if (level > 0) {
            ivec3 childVoxel = ivec3(floor(((com - u_worldMin) / worldExtent) * u_gridSizes[level-1]));
            if (all(equal(childVoxel / 2, myVoxel / 2))) {
               // This node is a sibling of my own parent, skip it as it will be handled at a finer level.
               continue;
            }
          }

          float dSq = d * d;
          float softSq = eps * eps;
          float denom = dSq + softSq;
          float inv = 1.0 / (denom * sqrt(denom)); // 1 / (d² + eps²)^1.5
          totalForce += delta * m * inv;
        }
      }
    }
  }

  // The far-field forces have been accumulated. The near-field (direct particle-particle)
  // forces are handled by summing up all particles within the L0 neighborhood.
  // This is a simplification and can be replaced by a dedicated near-field kernel.
  {
    float gridSize = u_gridSizes[0];
    float slicesPerRow = u_slicesPerRow[0];
    vec3 norm = (myPos - u_worldMin) / worldExtent;
    norm = clamp(norm, vec3(0.0), vec3(1.0 - (1.0 / gridSize)));
    ivec3 myL0Voxel = ivec3(floor(norm * gridSize));
    
    const int R0 = 1; // 3x3x3 neighborhood
    for (int dz = -R0; dz <= R0; dz++) {
      for (int dy = -R0; dy <= R0; dy++) {
        for (int dx = -R0; dx <= R0; dx++) {
          ivec3 neighborVoxel = myL0Voxel + ivec3(dx, dy, dz);
          
          if (neighborVoxel.x < 0 || neighborVoxel.y < 0 || neighborVoxel.z < 0 ||
              neighborVoxel.x >= int(gridSize) || neighborVoxel.y >= int(gridSize) || neighborVoxel.z >= int(gridSize)) {
            continue;
          }
          
          ivec2 texCoord = voxelToTexel(neighborVoxel, gridSize, slicesPerRow);
          vec4 nodeData = sampleLevel(0, texCoord); // Always sample L0 for near field
          float m = nodeData.a;
          if (m <= 0.0) { continue; }

          vec3 com = nodeData.rgb / max(m, 1e-6);
          vec3 delta = com - myPos;
          float d = length(delta);

          // No theta check for near-field, always compute force directly.
          float dSq = d * d;
          float softSq = eps * eps;
          float denom = dSq + softSq;
          float inv = 1.0 / (denom * sqrt(denom));
          totalForce += delta * m * inv;
        }
      }
    }
  }

  float hasForce = length(totalForce) > 0.0 ? 1.0 : 0.0;
  fragColor = vec4(u_G * totalForce, hasForce);
}
`;
