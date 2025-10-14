// @ts-check

/**
 * Gradient Computation in Fourier Space
 * 
 * Computes force field from gravitational potential:
 * F(x) = -∇φ(x)
 * 
 * In Fourier space: F(k) = -i·k·φ(k)
 * Where i·k multiplication gives the gradient operator
 * 
 * This shader computes gradient for ONE axis at a time
 */

export default /* glsl */`#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_potentialSpectrum;
uniform int u_axis;  // 0=X, 1=Y, 2=Z
uniform float u_gridSize;
uniform float u_slicesPerRow;
uniform vec3 u_worldSize;

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

// Complex multiplication: (a + bi) * (c + di) = (ac - bd) + (ad + bc)i
vec2 complexMul(vec2 a, vec2 b) {
  return vec2(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

void main() {
  ivec3 voxel = texCoordToVoxel(v_uv, u_gridSize, u_slicesPerRow);
  int N = int(u_gridSize);
  
  // Read potential spectrum (complex)
  vec2 phi_k = texture(u_potentialSpectrum, v_uv).rg;
  
  // Compute wave vector component for selected axis
  vec3 k;
  k.x = float(voxel.x <= N/2 ? voxel.x : voxel.x - N);
  k.y = float(voxel.y <= N/2 ? voxel.y : voxel.y - N);
  k.z = float(voxel.z <= N/2 ? voxel.z : voxel.z - N);
  
  // Scale to physical wave vector: k_phys = 2π * k_grid / L
  k.x *= TWO_PI / u_worldSize.x;
  k.y *= TWO_PI / u_worldSize.y;
  k.z *= TWO_PI / u_worldSize.z;
  
  // Select component for this axis
  float k_component = (u_axis == 0) ? k.x : ((u_axis == 1) ? k.y : k.z);
  
  // Compute gradient: F(k) = -i·k·φ(k)
  // For attractive gravity: F = -∇φ
  // In Fourier space: ∇φ(k) = i·k·φ(k), so F(k) = -i·k·φ(k)
  // Multiplication by -i: (a + bi) * (-i) = b - ai
  vec2 ik = vec2(0.0, -k_component);  // -i·k as complex number
  vec2 F_k = complexMul(ik, phi_k);
  
  // Output force spectrum for this axis (complex)
  outColor = vec4(F_k, 0.0, 0.0);
}
`;
