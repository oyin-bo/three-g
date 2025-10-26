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
uniform vec2 u_textureSize;
uniform vec3 u_worldSize;

const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;

// Convert 2D texture coords to 3D voxel coords
ivec3 texCoordToVoxel(vec2 uv, float gridSize, float slicesPerRow) {
  // Map uv -> texel coords using actual texture dimensions, then subtract 0.5
  vec2 texel = uv * u_textureSize - 0.5;
  int ix = int(mod(texel.x, gridSize));
  int iy = int(mod(texel.y, gridSize));
  int sliceRow = int(texel.y / gridSize);
  int iz = sliceRow * int(slicesPerRow) + int(texel.x / gridSize);
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
  
  // Compute integer wave vector
  vec3 kg;
  kg.x = float(voxel.x <= N/2 ? voxel.x : voxel.x - N);
  kg.y = float(voxel.y <= N/2 ? voxel.y : voxel.y - N);
  kg.z = float(voxel.z <= N/2 ? voxel.z : voxel.z - N);
  
  // Scale to physical wave vector: k_phys = 2π * k_grid / L
  vec3 k_phys = kg * (TWO_PI / u_worldSize);
  
  // Select component for this axis
  float k_component = (u_axis == 0) ? k_phys.x : ((u_axis == 1) ? k_phys.y : k_phys.z);
  
  // Compute gradient: F(k) = -i·k·φ(k)
  // For attractive gravity: F = -∇φ
  // In Fourier space: ∇φ(k) = i·k·φ(k), so F(k) = -i·k·φ(k)
  // Multiplication by -i is a rotation: (a + bi) * (-i) = b - ai
  // So we are calculating -i*k_component, the complex number is (0, -k_component)
  // F_k = (phi_re, phi_im) * (0, -k_component)
  // F_k.re = phi_re * 0 - phi_im * (-k_component) = phi_im * k_component
  // F_k.im = phi_re * (-k_component) + phi_im * 0 = -phi_re * k_component
  vec2 F_k = vec2(phi_k.y * k_component, -phi_k.x * k_component);
  
  // Output force spectrum for this axis (complex)
  outColor = vec4(F_k, 0.0, 0.0);
}

`;
