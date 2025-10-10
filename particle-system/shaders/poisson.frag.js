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
uniform float u_boxSize;  // Physical size of simulation box

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

void main() {
  ivec3 voxel = texCoordToVoxel(v_uv, u_gridSize, u_slicesPerRow);
  int N = int(u_gridSize);
  
  // Read density spectrum (complex)
  vec2 rho_k = texture(u_densitySpectrum, v_uv).rg;
  
  // Compute wave vector k (in units of 2π/L where L is box size)
  // FFT convention: k ranges from 0 to N-1, interpret as 0 to N/2-1, then -N/2 to -1
  vec3 k;
  k.x = float(voxel.x <= N/2 ? voxel.x : voxel.x - N);
  k.y = float(voxel.y <= N/2 ? voxel.y : voxel.y - N);
  k.z = float(voxel.z <= N/2 ? voxel.z : voxel.z - N);
  
  // Scale to physical wave vector: k_phys = 2π * k_grid / L
  k *= TWO_PI / u_boxSize;
  
  // Compute k² (magnitude squared)
  float k_squared = dot(k, k);
  
  // Poisson equation in Fourier space: φ(k) = -4πG * ρ(k) / k²
  // Handle DC component (k=0) separately - set to zero (no monopole)
  vec2 phi_k;
  if (k_squared < 1e-10) {
    // DC component: set to zero (mean field subtraction)
    phi_k = vec2(0.0, 0.0);
  } else {
    // Solve Poisson equation
    float factor = -u_gravitationalConstant / k_squared;
    phi_k = rho_k * factor;
  }
  
  // Output potential spectrum (complex)
  outColor = vec4(phi_k, 0.0, 0.0);
}
`;
