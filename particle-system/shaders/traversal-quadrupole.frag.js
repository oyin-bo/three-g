export default `#version 300 es
precision highp float;

// 3D isotropic octree traversal with Barnes-Hut + Quadrupoles (Plan C)
// Implements improved MAC and quadrupole force evaluation

uniform sampler2D u_particlePositions;

// A0 attachments (monopole moments)
uniform sampler2D u_level0_A0;
uniform sampler2D u_level1_A0;
uniform sampler2D u_level2_A0;
uniform sampler2D u_level3_A0;
uniform sampler2D u_level4_A0;
uniform sampler2D u_level5_A0;
uniform sampler2D u_level6_A0;
uniform sampler2D u_level7_A0;

// A1 attachments (second moments: x², y², z², xy)
uniform sampler2D u_level0_A1;
uniform sampler2D u_level1_A1;
uniform sampler2D u_level2_A1;
uniform sampler2D u_level3_A1;
uniform sampler2D u_level4_A1;
uniform sampler2D u_level5_A1;
uniform sampler2D u_level6_A1;
uniform sampler2D u_level7_A1;

// A2 attachments (second moments: xz, yz)
uniform sampler2D u_level0_A2;
uniform sampler2D u_level1_A2;
uniform sampler2D u_level2_A2;
uniform sampler2D u_level3_A2;
uniform sampler2D u_level4_A2;
uniform sampler2D u_level5_A2;
uniform sampler2D u_level6_A2;
uniform sampler2D u_level7_A2;

uniform float u_theta;
uniform int u_numLevels;
uniform float u_cellSizes[8];
uniform float u_gridSizes[8];
uniform float u_slicesPerRow[8];
uniform vec2 u_texSize;
uniform int u_particleCount;
uniform vec3 u_worldMin;
uniform vec3 u_worldMax;
uniform float u_softening;
uniform float u_G;
uniform bool u_enableQuadrupoles;  // Toggle for A/B testing

out vec4 fragColor;

// Sample A0 from specific level
vec4 sampleLevelA0(int level, ivec2 coord) {
  if (level == 0) { return texelFetch(u_level0_A0, coord, 0); }
  else if (level == 1) { return texelFetch(u_level1_A0, coord, 0); }
  else if (level == 2) { return texelFetch(u_level2_A0, coord, 0); }
  else if (level == 3) { return texelFetch(u_level3_A0, coord, 0); }
  else if (level == 4) { return texelFetch(u_level4_A0, coord, 0); }
  else if (level == 5) { return texelFetch(u_level5_A0, coord, 0); }
  else if (level == 6) { return texelFetch(u_level6_A0, coord, 0); }
  else if (level == 7) { return texelFetch(u_level7_A0, coord, 0); }
  else { return vec4(0.0); }
}

// Sample A1 from specific level
vec4 sampleLevelA1(int level, ivec2 coord) {
  if (level == 0) { return texelFetch(u_level0_A1, coord, 0); }
  else if (level == 1) { return texelFetch(u_level1_A1, coord, 0); }
  else if (level == 2) { return texelFetch(u_level2_A1, coord, 0); }
  else if (level == 3) { return texelFetch(u_level3_A1, coord, 0); }
  else if (level == 4) { return texelFetch(u_level4_A1, coord, 0); }
  else if (level == 5) { return texelFetch(u_level5_A1, coord, 0); }
  else if (level == 6) { return texelFetch(u_level6_A1, coord, 0); }
  else if (level == 7) { return texelFetch(u_level7_A1, coord, 0); }
  else { return vec4(0.0); }
}

// Sample A2 from specific level
vec4 sampleLevelA2(int level, ivec2 coord) {
  if (level == 0) { return texelFetch(u_level0_A2, coord, 0); }
  else if (level == 1) { return texelFetch(u_level1_A2, coord, 0); }
  else if (level == 2) { return texelFetch(u_level2_A2, coord, 0); }
  else if (level == 3) { return texelFetch(u_level3_A2, coord, 0); }
  else if (level == 4) { return texelFetch(u_level4_A2, coord, 0); }
  else if (level == 5) { return texelFetch(u_level5_A2, coord, 0); }
  else if (level == 6) { return texelFetch(u_level6_A2, coord, 0); }
  else if (level == 7) { return texelFetch(u_level7_A2, coord, 0); }
  else { return vec4(0.0); }
}

// Convert 3D voxel coordinate to 2D texture coordinate
ivec2 voxelToTexel(ivec3 voxelCoord, float gridSize, float slicesPerRow) {
  int vx = voxelCoord.x;
  int vy = voxelCoord.y;
  int vz = voxelCoord.z;
  
  int sliceIndex = vz;
  int sliceRow = sliceIndex / int(slicesPerRow);
  int sliceCol = sliceIndex - sliceRow * int(slicesPerRow);
  
  int texelX = sliceCol * int(gridSize) + vx;
  int texelY = sliceRow * int(gridSize) + vy;
  
  return ivec2(texelX, texelY);
}

// Compute cell center in world coordinates
vec3 cellCenter(int level, ivec3 voxelCoord, float gridSize) {
  vec3 worldExtent = u_worldMax - u_worldMin;
  vec3 cellMin = u_worldMin + (vec3(voxelCoord) / gridSize) * worldExtent;
  vec3 cellMax = u_worldMin + (vec3(voxelCoord + ivec3(1)) / gridSize) * worldExtent;
  return (cellMin + cellMax) * 0.5;
}

// Assemble quadrupole tensor and compute acceleration
vec3 computeQuadrupoleAcceleration(
  vec3 r, 
  float M0, 
  vec3 M1,
  vec4 A1,
  vec4 A2,
  float eps
) {
  // Compute COM
  vec3 mu = M1 / max(M0, 1e-10);
  
  // Assemble raw second moment matrix M2
  // M2 = [[A1.x, A1.w, A2.x],
  //       [A1.w, A1.y, A2.y],
  //       [A2.x, A2.y, A1.z]]
  mat3 M2 = mat3(
    A1.x, A1.w, A2.x,
    A1.w, A1.y, A2.y,
    A2.x, A2.y, A1.z
  );
  
  // Compute central second moments S = M2 - M0 * outer(mu, mu)
  mat3 S = M2 - M0 * outerProduct(mu, mu);
  
  // Compute trace-free quadrupole Q = 3S - trace(S)*I
  float trS = S[0][0] + S[1][1] + S[2][2];
  mat3 Q = 3.0 * S - trS * mat3(1.0);
  
  // Compute monopole + quadrupole acceleration
  float r2 = dot(r, r) + eps * eps;
  float invR = inversesqrt(r2);
  float invR3 = invR * invR * invR;
  float invR5 = invR3 * invR * invR;
  float invR7 = invR5 * invR * invR;
  
  // Monopole contribution
  vec3 a = M0 * r * invR3;
  
  // Quadrupole contribution
  vec3 Qr = Q * r;
  float rQr = dot(r, Qr);
  a += Qr * invR5 - 2.5 * rQr * r * invR7;
  
  return a;
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

  // Far-field: Traverse from coarsest (top) down to L1
  // Use improved MAC and quadrupole forces
  for (int level = min(u_numLevels - 1, 7); level >= 1; level--) {
    float gridSize = u_gridSizes[level];
    float slicesPerRow = u_slicesPerRow[level];
    float cellSize = u_cellSizes[level];

    // Special case: root level (1×1×1 voxel)
    if (gridSize == 1.0) {
      vec4 A0 = sampleLevelA0(level, ivec2(0, 0));
      float M0 = A0.a;
      if (M0 > 0.0) {
        vec3 com = A0.rgb / max(M0, 1e-6);
        vec3 r = com - myPos;
        float d = length(r);
        
        // Improved MAC: d > s/theta + delta
        vec3 c = (u_worldMin + u_worldMax) * 0.5;  // Root cell center
        float delta = length(com - c);
        
        if (d > cellSize / u_theta + delta) {
          if (u_enableQuadrupoles) {
            vec4 A1 = sampleLevelA1(level, ivec2(0, 0));
            vec4 A2 = sampleLevelA2(level, ivec2(0, 0));
            vec3 M1 = A0.rgb;
            totalForce += computeQuadrupoleAcceleration(r, M0, M1, A1, A2, eps);
          } else {
            // Monopole only (fallback)
            float r2 = dot(r, r) + eps * eps;
            float invR3 = pow(r2, -1.5);
            totalForce += M0 * r * invR3;
          }
        }
        // If not accepted, rely on finer levels
      }
      continue;
    }

    // Find my voxel coordinate at this level
    vec3 norm = (myPos - u_worldMin) / worldExtent;
    norm = clamp(norm, vec3(0.0), vec3(1.0 - (1.0 / gridSize)));
    ivec3 myVoxel = ivec3(floor(norm * gridSize));

    // Sample 3D neighborhood (3×3×3 - 1 = 26 voxels)
    const int R = 1;
    for (int dz = -R; dz <= R; dz++) {
      for (int dy = -R; dy <= R; dy++) {
        for (int dx = -R; dx <= R; dx++) {
          if (dx == 0 && dy == 0 && dz == 0) { continue; }
          
          ivec3 neighborVoxel = myVoxel + ivec3(dx, dy, dz);
          
          // Bounds check
          if (neighborVoxel.x < 0 || neighborVoxel.y < 0 || neighborVoxel.z < 0 ||
              neighborVoxel.x >= int(gridSize) || neighborVoxel.y >= int(gridSize) || neighborVoxel.z >= int(gridSize)) {
            continue;
          }
          
          ivec2 texCoord = voxelToTexel(neighborVoxel, gridSize, slicesPerRow);
          vec4 A0 = sampleLevelA0(level, texCoord);
          float M0 = A0.a;
          if (M0 <= 0.0) { continue; }
          
          vec3 com = A0.rgb / max(M0, 1e-6);
          vec3 r = com - myPos;
          float d = length(r);
          
          // Improved MAC: d > s/theta + delta
          vec3 c = cellCenter(level, neighborVoxel, gridSize);
          float delta = length(com - c);
          
          if (d > cellSize / u_theta + delta) {
            // Accepted: use monopole + quadrupole
            if (u_enableQuadrupoles) {
              vec4 A1 = sampleLevelA1(level, texCoord);
              vec4 A2 = sampleLevelA2(level, texCoord);
              vec3 M1 = A0.rgb;
              totalForce += computeQuadrupoleAcceleration(r, M0, M1, A1, A2, eps);
            } else {
              // Monopole only (fallback)
              float r2 = dot(r, r) + eps * eps;
              float invR3 = pow(r2, -1.5);
              totalForce += M0 * r * invR3;
            }
          }
          // If not accepted, rely on finer levels or L0 near-field
        }
      }
    }
  }

  // Near-field: L0 direct sum (monopole only, no quadrupole needed)
  {
    float gridSize = u_gridSizes[0];
    float slicesPerRow = u_slicesPerRow[0];
    vec3 norm = (myPos - u_worldMin) / worldExtent;
    norm = clamp(norm, vec3(0.0), vec3(1.0 - (1.0 / gridSize)));
    ivec3 myL0Voxel = ivec3(floor(norm * gridSize));
    
    // Sample 5×5×5 neighborhood at L0 for smooth near-field
    const int R0 = 2;
    for (int dz = -R0; dz <= R0; dz++) {
      for (int dy = -R0; dy <= R0; dy++) {
        for (int dx = -R0; dx <= R0; dx++) {
          if (dx == 0 && dy == 0 && dz == 0) { continue; }
          
          // Skip far corners for isotropy
          int manhattan = abs(dx) + abs(dy) + abs(dz);
          if (manhattan > 4) { continue; }
          
          ivec3 neighborVoxel = myL0Voxel + ivec3(dx, dy, dz);
          if (neighborVoxel.x < 0 || neighborVoxel.y < 0 || neighborVoxel.z < 0 ||
              neighborVoxel.x >= int(gridSize) || neighborVoxel.y >= int(gridSize) || neighborVoxel.z >= int(gridSize)) {
            continue;
          }
          
          ivec2 texCoord = voxelToTexel(neighborVoxel, gridSize, slicesPerRow);
          vec4 A0 = sampleLevelA0(0, texCoord);
          float M0 = A0.a;
          if (M0 <= 0.0) { continue; }
          
          vec3 com = A0.rgb / max(M0, 1e-6);
          vec3 r = com - myPos;
          float r2 = dot(r, r) + eps * eps;
          float invR3 = pow(r2, -1.5);
          totalForce += M0 * r * invR3;
        }
      }
    }
  }

  fragColor = vec4(totalForce * u_G, 0.0);
}`;
