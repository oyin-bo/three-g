// @ts-check

/**
 * Poisson Solver in Fourier Space
 * 
 * Solves: ∇²φ = 4πGρ
 * In Fourier space: φ(k) = -4πGρ(k) / k²
 * 
 * Input: Mass density spectrum ρ(k) (complex RG)
 * Output: Potential spectrum φ(k) (complex RG)
 */

export default /* glsl */`#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_densitySpectrum;
uniform float u_gridSize;
uniform float u_slicesPerRow;
uniform float u_gravitationalConstant;  // 4πG
uniform float u_boxSize;               // Physical size of simulation box
uniform int u_splitMode;               // 0 = none, 1 = hard cutoff, 2 = Gaussian
uniform float u_kCut;                  // Cutoff wavenumber (rad / unit length)
uniform float u_gaussianSigma;         // Sigma for Gaussian split (length)
uniform int u_deconvolveOrder;         // 0 = none, 1 = NGP, 2 = CIC, 3 = TSC
uniform int u_useDiscrete;             // 1 = use discrete Laplacian eigenvalue

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

// Safe sinc(x) = sin(x)/x (with series fallback)
float sinc(float x) {
  float ax = abs(x);
  if (ax < 1e-5) {
    float x2 = x * x;
    return 1.0 - x2 / 6.0 + (x2 * x2) / 120.0;
  }
  return sin(x) / x;
}

void main() {
  ivec3 voxel = texCoordToVoxel(v_uv, u_gridSize, u_slicesPerRow);
  int N = int(u_gridSize);
  float L = u_boxSize;
  float d = L / u_gridSize; // grid spacing
  
  // Read density spectrum (complex)
  vec2 rho_k = texture(u_densitySpectrum, v_uv).rg;

  // Wave indices on [-N/2, N/2)
  vec3 kg;
  kg.x = float(voxel.x <= N/2 ? voxel.x : voxel.x - N);
  kg.y = float(voxel.y <= N/2 ? voxel.y : voxel.y - N);
  kg.z = float(voxel.z <= N/2 ? voxel.z : voxel.z - N);

  vec2 rhoCorrected = rho_k;

  // Optional deconvolution of assignment window (NGP/CIC/TSC)
  if (u_deconvolveOrder > 0) {
    float halfCell = 0.5 * d;
    float wx = pow(max(sinc(kg.x * PI / u_gridSize), 1e-4), float(u_deconvolveOrder));
    float wy = pow(max(sinc(kg.y * PI / u_gridSize), 1e-4), float(u_deconvolveOrder));
    float wz = pow(max(sinc(kg.z * PI / u_gridSize), 1e-4), float(u_deconvolveOrder));
    float window = max(wx * wy * wz, 1e-4);
    rhoCorrected /= window;
  }

  // Compute k^2
  float k2;
  if (u_useDiscrete == 1) {
    // Discrete Laplacian eigenvalue: k_eff^2 = sum_i (2/Δ sin(π k_i/N))^2
    float sx = sin(PI * kg.x / u_gridSize);
    float sy = sin(PI * kg.y / u_gridSize);
    float sz = sin(PI * kg.z / u_gridSize);
    float c = 2.0 / d;
    k2 = (c*c) * (sx*sx + sy*sy + sz*sz);
  } else {
    // Continuous
    vec3 kphys = kg * (TWO_PI / L);
    k2 = dot(kphys, kphys);
  }

  vec2 phi_k = vec2(0.0);
  if (k2 >= 1e-10) {
    float factor = -u_gravitationalConstant / k2;

    float splitWeight = 1.0;
    if (u_splitMode == 1 && u_kCut > 0.0) {
      float kCutSq = u_kCut * u_kCut;
      splitWeight = k2 <= kCutSq ? 1.0 : 0.0;
    } else if (u_splitMode == 2 && u_gaussianSigma > 0.0) {
      float sigma = u_gaussianSigma;
      splitWeight = exp(-k2 * sigma * sigma);
    }

    phi_k = rhoCorrected * factor * splitWeight;
  }

  if (u_gaussianSigma > 0.0) {
    float k2_cont = dot(kg * (TWO_PI / L), kg * (TWO_PI / L));
    float g = exp(-0.5 * k2_cont * (u_gaussianSigma * u_gaussianSigma));
    phi_k *= g;
  }

  outColor = vec4(phi_k, 0.0, 0.0);
}
`;
