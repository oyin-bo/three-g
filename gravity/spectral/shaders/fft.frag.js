// @ts-check

/**
 * FFT shader generator for 3D Fourier transforms
 *
 * Implements Cooley-Tukey radix-2 FFT for WebGL
 * Generates specialized shader variants for real↔complex conversion and complex↔complex stages
 * 
 * @param {{ collapsed?: 'from' | 'to' }} [options]
 * @returns {string} GLSL shader source
 */
export default function fftShader(options) {
  const collapsed = options?.collapsed;
  
  return /* glsl */ `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

${collapsed === 'from' ? `
// Real-to-complex mode: read R32F, assume imaginary=0
uniform sampler2D u_realInput;
uniform float u_massToDensity;  // Convert mass per voxel to physical density
` : collapsed === 'to' ? `
// Complex-to-real mode: read RG32F, write R32F
uniform sampler2D u_spectrum;
` : `
// Complex-to-complex mode: standard FFT butterfly
uniform sampler2D u_spectrum;
`}
uniform int u_axis;          // 0=X, 1=Y, 2=Z
uniform int u_stage;         // FFT stage (0 to numStages-1)
uniform int u_inverse;       // 0=forward, 1=inverse
uniform ivec3 u_gridSize;    // Grid dimension (e.g., 64,64,64)
uniform float u_slicesPerRow;
uniform int u_debugMode;     // 0 = normal, 1 = current, 2 = partner
uniform vec2 u_textureSize;  // 2D packed texture size (width, height)

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

// Convert 2D texture coords to 3D voxel coords
ivec3 texCoordToVoxel(vec2 uv, ivec3 gridSize, float slicesPerRow) {
  // Map uv -> texel coordinates using full texture dimensions, then subtract 0.5
  vec2 texel = uv * u_textureSize - 0.5;
  int ix = int(mod(texel.x, float(gridSize.x)));
  int iy = int(mod(texel.y, float(gridSize.y)));
  int sliceRow = int(texel.y / float(gridSize.y));
  int iz = sliceRow * int(slicesPerRow) + int(texel.x / float(gridSize.x));
  return ivec3(ix, iy, iz);
}

// Convert 3D voxel to 2D texture coords
vec2 voxelToTexCoord(ivec3 voxel, ivec3 gridSize, float slicesPerRow) {
  int sliceRow = voxel.z / int(slicesPerRow);
  int sliceCol = voxel.z % int(slicesPerRow);
  
  float texX = float(sliceCol * gridSize.x + voxel.x) + 0.5;
  float texY = float(sliceRow * gridSize.y + voxel.y) + 0.5;
  
  // Normalize by actual texture width/height
  return vec2(texX / u_textureSize.x, texY / u_textureSize.y);
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
  // Common setup: determine voxel position and butterfly pairing
  ivec3 voxel = texCoordToVoxel(v_uv, u_gridSize, u_slicesPerRow);
  int N = (u_axis == 0) ? u_gridSize.x : ((u_axis == 1) ? u_gridSize.y : u_gridSize.z);
  
  // Get the index along the FFT axis
  int idx = (u_axis == 0) ? voxel.x : ((u_axis == 1) ? voxel.y : voxel.z);
  
  // FFT parameters
  int stageSize = 1 << (u_stage + 1);  // 2^(stage+1)
  int halfStage = stageSize >> 1;      // 2^stage
  int blockIndex = idx / stageSize;
  int indexInBlock = idx % stageSize;
  
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
  
  // Calculate UVs
  vec2 currentUV = v_uv;
  vec2 partnerUV = voxelToTexCoord(partnerVoxel, u_gridSize, u_slicesPerRow);
  
  // INPUT: Read values (format depends on collapsed flag)
  vec2 currentComplex;
  vec2 partnerComplex;
  
${collapsed === 'from' ? `
  // Real-to-complex: read R32F, treat as complex with imag=0, scale to density
  float currentReal = texture(u_realInput, currentUV).r * u_massToDensity;
  float partnerReal = texture(u_realInput, partnerUV).r * u_massToDensity;
  currentComplex = vec2(currentReal, 0.0);
  partnerComplex = vec2(partnerReal, 0.0);
` : `
  // Complex-to-complex or complex-to-real: read RG32F
  currentComplex = texture(u_spectrum, currentUV).rg;
  partnerComplex = texture(u_spectrum, partnerUV).rg;
`}

  // Debug modes
  if (u_debugMode == 1) {
    outColor = vec4(currentComplex, 0.0, 1.0);
    return;
  }
  if (u_debugMode == 2) {
    outColor = vec4(partnerComplex, 0.0, 1.0);
    return;
  }
  
  // BUTTERFLY: Compute (same for all variants)
  // Compute twiddle factor
  float twiddleSign = (u_inverse == 1) ? 1.0 : -1.0;
  // Correct twiddle exponent: for stage with block size stageSize the
  // twiddle exponent should be pairIndex * (N / stageSize).
  float twiddleK = float(pairIndex) * float(N) / float(stageSize);
  vec2 w = twiddle(twiddleK, float(N), twiddleSign);
  
  // Butterfly operation
  // Cooley-Tukey: X[k] = E[k] + W^k*O[k], X[k+N/2] = E[k] - W^k*O[k]
  vec2 result;
  if (!isOdd) {
    // Even output position: E + W * O
    result = complexAdd(currentComplex, complexMul(w, partnerComplex));
  } else {
    // Odd output position: E - W * O
    result = complexSub(partnerComplex, complexMul(w, currentComplex));
  }
  
  // OUTPUT: Write result (format depends on collapsed flag)
${collapsed === 'to' ? `
  // Complex-to-real: extract real part
  float realPart = result.r;
  outColor = vec4(realPart, 0.0, 0.0, 0.0);
` : `
  // Real-to-complex or complex-to-complex: output complex
  outColor = vec4(result, 0.0, 0.0);
`}
}
`;
}
