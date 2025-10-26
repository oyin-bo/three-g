/**
 * Generate traversal shader with optional occupancy masking
 * @param {boolean} useOccupancyMasks - Whether to include occupancy masking code
 * @returns {string} GLSL shader source
 */
export default function generateTraversalShader(useOccupancyMasks = false) {
  return /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2DArray;

// 3D isotropic octree traversal with Barnes-Hut + Quadrupoles (Plan C)
// Implements improved MAC and quadrupole force evaluation
// Occupancy masking: ${useOccupancyMasks ? "ENABLED" : "DISABLED"}

uniform sampler2D u_particlePositions;

// Texture arrays for MRT pyramid (Plan C refactor to reduce texture unit usage)
// Each array has 8 layers corresponding to pyramid levels 0-7
// This reduces from 24 individual samplers (exceeding limit) to 3 arrays
uniform sampler2DArray u_levelsA0;  // A0: monopole moments [Σ(m·x), Σ(m·y), Σ(m·z), Σm]
uniform sampler2DArray u_levelsA1;  // A1: second moments [Σ(m·x²), Σ(m·y²), Σ(m·z²), Σ(m·xy)]
uniform sampler2DArray u_levelsA2;  // A2: second moments [Σ(m·xz), Σ(m·yz), 0, 0]

${
  useOccupancyMasks
    ? `
// Occupancy mask textures (binary masks indicating which voxels contain mass)
// Packed: 32 voxels per texel (RGBA8 = 4 channels × 8 bits = 32 bits)
uniform sampler2DArray u_occupancyMasks;  // One mask per level
`
    : ""
}

uniform float u_theta;
uniform int u_numLevels;
uniform float u_cellSizes[8];
uniform float u_gridSizes[8];
uniform float u_slicesPerRow[8];
${
  useOccupancyMasks
    ? `uniform int u_maskWidths[8];  // Occupancy mask texture width per level
`
    : ""
}uniform vec2 u_texSize;
uniform int u_particleCount;
uniform vec3 u_worldMin;
uniform vec3 u_worldMax;
uniform float u_softening;
uniform float u_G;
uniform bool u_enableQuadrupoles;  // Toggle for A/B testing

out vec4 fragColor;

// Sample A0 from specific level (using texture array)
vec4 sampleLevelA0(int level, ivec2 coord) {
  return texelFetch(u_levelsA0, ivec3(coord, level), 0);
}

// Sample A1 from specific level (using texture array)
vec4 sampleLevelA1(int level, ivec2 coord) {
  return texelFetch(u_levelsA1, ivec3(coord, level), 0);
}

// Sample A2 from specific level (using texture array)
vec4 sampleLevelA2(int level, ivec2 coord) {
  return texelFetch(u_levelsA2, ivec3(coord, level), 0);
}

${
  useOccupancyMasks
    ? `
// Check if voxel contains mass using occupancy mask
// Returns true if the voxel is occupied, false if empty
bool isVoxelOccupied(int level, ivec3 voxelCoord) {
  int gridSize = int(u_gridSizes[level]);
  int maskWidth = u_maskWidths[level];
  
  // Calculate voxel index in 3D grid
  int voxelIndex = voxelCoord.z * gridSize * gridSize + voxelCoord.y * gridSize + voxelCoord.x;
  
  // Calculate texel position (32 voxels per texel)
  int texelIndex = voxelIndex / 32;
  int bitInTexel = voxelIndex % 32;
  
  int maskX = texelIndex % maskWidth;
  int maskY = texelIndex / maskWidth;
  
  // Fetch packed mask data
  vec4 maskData = texelFetch(u_occupancyMasks, ivec3(maskX, maskY, level), 0);
  
  // Unpack bit from appropriate channel
  int channelIndex = bitInTexel / 8;  // 0-3 (R, G, B, A)
  int bitInChannel = bitInTexel % 8;   // 0-7
  
  // Extract byte value (0-255)
  float channelValue = maskData[channelIndex] * 255.0;
  int byteValue = int(channelValue + 0.5);
  
  // Check if bit is set
  int bitMask = 1 << bitInChannel;
  return (byteValue & bitMask) != 0;
}
`
    : ""
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
    int parentLevel = level + 1;
    bool hasParent = (parentLevel < u_numLevels);
    ivec3 parentVoxel = myVoxel / 2;
    vec4 acceptedSiblingA0Sum = vec4(0.0);
    vec4 acceptedSiblingA1Sum = vec4(0.0);
    vec4 acceptedSiblingA2Sum = vec4(0.0);
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
          
${
  useOccupancyMasks
    ? `          // Occupancy mask check (skip empty voxels)
          if (!isVoxelOccupied(level, neighborVoxel)) {
            continue;
          }
          
`
    : ""
}          ivec2 texCoord = voxelToTexel(neighborVoxel, gridSize, slicesPerRow);
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
            if (u_enableQuadrupoles) {
              vec4 A1 = sampleLevelA1(level, texCoord);
              vec4 A2 = sampleLevelA2(level, texCoord);
              vec3 M1 = A0.rgb;
              totalForce += computeQuadrupoleAcceleration(r, M0, M1, A1, A2, eps);
              if (hasParent) {
                ivec3 neighborParent = neighborVoxel / 2;
                if (all(equal(neighborParent, parentVoxel))) {
                  acceptedSiblingA0Sum += A0;
                  acceptedSiblingA1Sum += A1;
                  acceptedSiblingA2Sum += A2;
                }
              }
            } else {
              float r2 = dot(r, r) + eps * eps;
              float invR3 = pow(r2, -1.5);
              totalForce += M0 * r * invR3;
              if (hasParent) {
                ivec3 neighborParent = neighborVoxel / 2;
                if (all(equal(neighborParent, parentVoxel))) {
                  acceptedSiblingA0Sum += A0;
                }
              }
            }
          }
          // If not accepted, rely on finer levels or L0 near-field
        }
      }
    }

    if (hasParent) {
      float parentGridSize = u_gridSizes[parentLevel];
      float parentSlicesPerRow = u_slicesPerRow[parentLevel];
      float parentCellSize = u_cellSizes[parentLevel];
      ivec2 parentTex = voxelToTexel(parentVoxel, parentGridSize, parentSlicesPerRow);
      ivec2 myTex = voxelToTexel(myVoxel, gridSize, slicesPerRow);

      vec4 A0_parent = sampleLevelA0(parentLevel, parentTex);
      vec4 A0_child  = sampleLevelA0(level, myTex);

      vec4 A0_res = A0_parent - A0_child - acceptedSiblingA0Sum;
      if (A0_res.a > 0.0) {
        vec3 comRes = A0_res.rgb / max(A0_res.a, 1e-6);
        vec3 rRes = comRes - myPos;
        float dRes = length(rRes);
        vec3 cParent = cellCenter(parentLevel, parentVoxel, parentGridSize);
        float deltaRes = length(comRes - cParent);
        if (dRes > parentCellSize / u_theta + deltaRes) {
          if (u_enableQuadrupoles) {
            vec4 A1_parent = sampleLevelA1(parentLevel, parentTex);
            vec4 A2_parent = sampleLevelA2(parentLevel, parentTex);
            vec4 A1_child  = sampleLevelA1(level, myTex);
            vec4 A2_child  = sampleLevelA2(level, myTex);
            vec4 A1_res = A1_parent - A1_child - acceptedSiblingA1Sum;
            vec4 A2_res = A2_parent - A2_child - acceptedSiblingA2Sum;
            vec3 M1_res = A0_res.rgb;
            totalForce += computeQuadrupoleAcceleration(rRes, A0_res.a, M1_res, A1_res, A2_res, eps);
          } else {
            float r2Res = dot(rRes, rRes) + eps * eps;
            float invR3Res = pow(r2Res, -1.5);
            totalForce += A0_res.a * rRes * invR3Res;
          }
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
    
    // Sample 3×3×3 neighborhood at L0 (optimized for performance)
    const int R0 = 1;
    for (int dz = -R0; dz <= R0; dz++) {
      for (int dy = -R0; dy <= R0; dy++) {
        for (int dx = -R0; dx <= R0; dx++) {
          if (dx == 0 && dy == 0 && dz == 0) { continue; }
          
          ivec3 neighborVoxel = myL0Voxel + ivec3(dx, dy, dz);
          if (neighborVoxel.x < 0 || neighborVoxel.y < 0 || neighborVoxel.z < 0 ||
              neighborVoxel.x >= int(gridSize) || neighborVoxel.y >= int(gridSize) || neighborVoxel.z >= int(gridSize)) {
            continue;
          }
          
${
  useOccupancyMasks
    ? `          // Occupancy mask check for L0
          if (!isVoxelOccupied(0, neighborVoxel)) {
            continue;
          }
          
`
    : ""
}          ivec2 texCoord = voxelToTexel(neighborVoxel, gridSize, slicesPerRow);
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
}
