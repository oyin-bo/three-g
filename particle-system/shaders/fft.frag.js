// @ts-check

/**
 * FFT shader for 3D Fourier transforms
 * 
 * Implements Cooley-Tukey radix-2 FFT for WebGL
 * Operates on complex data stored as RG (real, imaginary)
 */

export default /* glsl */`#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_inputTexture;
uniform int u_axis;          // 0=X, 1=Y, 2=Z
uniform int u_stage;         // FFT stage (0 to log2(N)-1)
uniform int u_inverse;       // 0=forward, 1=inverse
uniform float u_gridSize;    // Grid dimension (e.g., 64)
uniform float u_slicesPerRow;

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

// Convert 2D texture coords to 3D voxel coords
ivec3 texCoordToVoxel(vec2 uv, float gridSize, float slicesPerRow) {
  vec2 texel = uv * gridSize * slicesPerRow;
  int sliceIndex = int(texel.y / gridSize) * int(slicesPerRow) + int(texel.x / gridSize);
  int iz = sliceIndex;
  int ix = int(mod(texel.x, gridSize));
  int iy = int(mod(texel.y, gridSize));
  return ivec3(ix, iy, iz);
}

// Convert 3D voxel to 2D texture coords
vec2 voxelToTexCoord(ivec3 voxel, float gridSize, float slicesPerRow) {
  int sliceRow = voxel.z / int(slicesPerRow);
  int sliceCol = voxel.z - sliceRow * int(slicesPerRow);
  
  float texX = float(sliceCol * int(gridSize) + voxel.x) + 0.5;
  float texY = float(sliceRow * int(gridSize) + voxel.y) + 0.5;
  
  return vec2(texX, texY) / (gridSize * slicesPerRow);
}

// Complex multiplication: (a + bi) * (c + di) = (ac - bd) + (ad + bc)i
vec2 complexMul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

// Complex addition
vec2 complexAdd(vec2 a, vec2 b) {
  return a + b;
}

// Complex subtraction
vec2 complexSub(vec2 a, vec2 b) {
  return a - b;
}

// Twiddle factor: exp(-2πi * k / N) = cos(-2πk/N) + i*sin(-2πk/N)
vec2 twiddle(float k, float N, float sign) {
  float angle = sign * TWO_PI * k / N;
  return vec2(cos(angle), sin(angle));
}

void main() {
  ivec3 voxel = texCoordToVoxel(v_uv, u_gridSize, u_slicesPerRow);
  int N = int(u_gridSize);
  
  // Get the index along the FFT axis
  int idx = (u_axis == 0) ? voxel.x : ((u_axis == 1) ? voxel.y : voxel.z);
  
  // FFT parameters
  int stageSize = 1 << (u_stage + 1);  // 2^(stage+1)
  int halfStage = stageSize >> 1;      // 2^stage
  int blockIndex = idx / stageSize;
  int indexInBlock = idx - blockIndex * stageSize;
  
  // Determine if this is the even or odd element
  int pairIndex = indexInBlock % halfStage;
  bool isOdd = indexInBlock >= halfStage;
  
  // Find the paired element
  int partnerOffset = isOdd ? -halfStage : halfStage;
  int partnerIdx = idx + partnerOffset;
  
  // Build the 3D coordinate for the partner
  ivec3 partnerVoxel = voxel;
  if (u_axis == 0) partnerVoxel.x = partnerIdx;
  else if (u_axis == 1) partnerVoxel.y = partnerIdx;
  else partnerVoxel.z = partnerIdx;
  
  // Read current value and partner value
  vec2 currentUV = v_uv;
  vec2 partnerUV = voxelToTexCoord(partnerVoxel, u_gridSize, u_slicesPerRow);
  
  vec4 current = texture(u_inputTexture, currentUV);
  vec4 partner = texture(u_inputTexture, partnerUV);
  
  vec2 currentComplex = current.rg;
  vec2 partnerComplex = partner.rg;
  
  // Compute twiddle factor
  float twiddleSign = (u_inverse == 1) ? 1.0 : -1.0;
  vec2 w = twiddle(float(pairIndex), float(stageSize), twiddleSign);
  
  // Butterfly operation
  vec2 result;
  if (!isOdd) {
    // Even: result = current + w * partner
    result = complexAdd(currentComplex, complexMul(w, partnerComplex));
  } else {
    // Odd: result = current - w * partner
    result = complexSub(currentComplex, complexMul(w, partnerComplex));
  }
  
  // Normalize if inverse FFT and final stage of each axis
  // For 3D FFT, we normalize by N once per axis (total N³)
  if (u_inverse == 1 && u_stage == int(log2(u_gridSize)) - 1) {
    result /= u_gridSize;
  }
  
  outColor = vec4(result, 0.0, 0.0);
}
`;
