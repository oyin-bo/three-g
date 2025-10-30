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
uniform ivec3 u_gridSize;
uniform float u_slicesPerRow;
uniform vec2 u_textureSize;
uniform float u_gravitationalConstant;  // 4πG
uniform float u_worldVolume;            // Physical volume of simulation box
uniform vec3 u_worldSize;              // Physical size per axis of simulation box
uniform int u_splitMode;               // 0 = none, 1 = hard cutoff, 2 = Gaussian
uniform float u_kCut;                  // Cutoff wavenumber (rad / unit length)
uniform float u_gaussianSigma;         // Sigma for Gaussian split (length)
uniform int u_deconvolveOrder;         // 0 = none, 1 = NGP, 2 = CIC, 3 = TSC
uniform int u_useDiscrete;             // 1 = use discrete Laplacian eigenvalue

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

// Convert 2D texture coords to 3D voxel coords
ivec3 texCoordToVoxel(vec2 uv, ivec3 gridSize, float slicesPerRow) {
  // Map uv -> texel coordinates using actual texture dimensions, then subtract 0.5
  vec2 texel = uv * u_textureSize - 0.5;
  int sliceIndex = int(texel.y / float(gridSize.y)) * int(slicesPerRow) + int(texel.x / float(gridSize.x));
  int iz = sliceIndex;
  int ix = int(mod(texel.x, float(gridSize.x)));
  int iy = int(mod(texel.y, float(gridSize.y)));
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
  ivec3 N = u_gridSize;
  vec3 L = u_worldSize;
  vec3 d = L / vec3(N);

  // Read density spectrum
  vec2 rho_k = texture(u_densitySpectrum, v_uv).rg;

  // Wave indices on [-N/2, N/2)
  vec3 kg;
  kg.x = float(voxel.x <= N.x/2 ? voxel.x : voxel.x - N.x);
  kg.y = float(voxel.y <= N.y/2 ? voxel.y : voxel.y - N.y);
  kg.z = float(voxel.z <= N.z/2 ? voxel.z : voxel.z - N.z);

  // 1. Deconvolution of assignment window (NGP/CIC/TSC)
  // This corrects for the smearing effect of the mass assignment scheme.
  if (u_deconvolveOrder > 0) {
    float wx = pow(max(sinc(kg.x * PI / float(N.x)), 1e-4), float(u_deconvolveOrder));
    float wy = pow(max(sinc(kg.y * PI / float(N.y)), 1e-4), float(u_deconvolveOrder));
    float wz = pow(max(sinc(kg.z * PI / float(N.z)), 1e-4), float(u_deconvolveOrder));
    float window = max(wx * wy * wz, 1e-4);
    rho_k /= window;
  }

  // 2. Compute k^2 (squared wavenumber)
  float k2;
  if (u_useDiscrete == 1) {
    // Discrete Laplacian eigenvalue on the grid: k_eff^2 = sum_i (2/Δx_i * sin(π*k_i/N_i))^2
    float sx = sin(PI * kg.x / float(N.x));
    float sy = sin(PI * kg.y / float(N.y));
    float sz = sin(PI * kg.z / float(N.z));
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
  // Optionally apply spectral split/filtering
  float k_mag = sqrt(k2);
  if (u_splitMode == 1) {
    // Hard cutoff
    if (u_kCut > 0.0 && k_mag > u_kCut) {
      rho_k = vec2(0.0);
    }
  } else if (u_splitMode == 2) {
    // Gaussian low-pass: multiply by exp(-0.5 * (k*sigma)^2)
    if (u_gaussianSigma > 0.0) {
      float factor = exp(-0.5 * (k_mag * u_gaussianSigma) * (k_mag * u_gaussianSigma));
      rho_k *= factor;
    }
  }

  vec2 phi_k = vec2(0.0);
  if (k2 >= 1e-10) { // Avoid division by zero at DC (k=0)
    // The mass spectrum needs to be converted to a density spectrum.
    // The N^3 from the density conversion and 1/N^3 from IFFT cancel.
    // The remaining factor is 1/worldVolume.
    float green = -u_gravitationalConstant / (k2 * u_worldVolume);
    phi_k = rho_k * green;
  } else {
    // DC mode (k=0): set to zero (mean field should be zero in periodic box)
    phi_k = vec2(0.0);
  }

  outColor = vec4(phi_k, 0.0, 0.0);
}
`;
