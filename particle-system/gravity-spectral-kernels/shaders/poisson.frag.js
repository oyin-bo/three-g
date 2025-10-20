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
uniform vec3 u_worldSize;              // Physical size per axis of simulation box
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
  vec3 L = u_worldSize;
  vec3 d = L / u_gridSize;

  // Read density spectrum
  vec2 rho_k = texture(u_densitySpectrum, v_uv).rg;

  // Wave indices on [-N/2, N/2)
  vec3 kg;
  kg.x = float(voxel.x <= N/2 ? voxel.x : voxel.x - N);
  kg.y = float(voxel.y <= N/2 ? voxel.y : voxel.y - N);
  kg.z = float(voxel.z <= N/2 ? voxel.z : voxel.z - N);

  // 1. Deconvolution of assignment window (NGP/CIC/TSC)
  // This corrects for the smearing effect of the mass assignment scheme.
  if (u_deconvolveOrder > 0) {
    float wx = pow(max(sinc(kg.x * PI / u_gridSize), 1e-4), float(u_deconvolveOrder));
    float wy = pow(max(sinc(kg.y * PI / u_gridSize), 1e-4), float(u_deconvolveOrder));
    float wz = pow(max(sinc(kg.z * PI / u_gridSize), 1e-4), float(u_deconvolveOrder));
    float window = max(wx * wy * wz, 1e-4);
    rho_k /= window;
  }

  // 2. Compute k^2 (squared wavenumber)
  float k2;
  if (u_useDiscrete == 1) {
    // Discrete Laplacian eigenvalue on the grid: k_eff^2 = sum_i (2/Δx_i * sin(π*k_i/N))^2
    float sx = sin(PI * kg.x / u_gridSize);
    float sy = sin(PI * kg.y / u_gridSize);
    float sz = sin(PI * kg.z / u_gridSize);
    vec3 inv_d = 2.0 / d;
    vec3 k_eff = inv_d * vec3(sx, sy, sz);
    k2 = dot(k_eff, k_eff);
  } else {
    // Continuous wavenumber: k_phys^2 = sum_i (2π*k_i/L_i)^2
    vec3 invL = TWO_PI / L;
    vec3 k_phys = kg * invL;
    k2 = dot(k_phys, k_phys);
  }

  // 3. Solve for potential spectrum: φ(k) = -4πG * ρ(k) / k^2
  vec2 phi_k = vec2(0.0);
  if (k2 >= 1e-10) { // Avoid division by zero at DC (k=0)
    float green = -u_gravitationalConstant / k2;
    phi_k = rho_k * green;
  }

  outColor = vec4(phi_k, 0.0, 0.0);
}
`;
