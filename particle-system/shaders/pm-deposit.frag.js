// @ts-check

/**
 * PM Deposit Fragment Shader
 * 
 * Deposits particle mass into grid cell using additive blending.
 * Supports NGP (Nearest Grid Point) and CIC (Cloud-In-Cell) schemes.
 */

export default /* glsl */`#version 300 es
precision highp float;

// From vertex shader
in float v_mass;
in vec3 v_gridPos;

// Output: mass in alpha channel
out vec4 outColor;

// Deposition scheme: 0=NGP, 1=CIC
uniform int u_depositionScheme;

void main() {
  if (u_depositionScheme == 0) {
    // NGP (Nearest Grid Point) - simple delta function
    // Mass goes entirely to nearest grid cell
    // Point sprite ensures we're at the right cell
    outColor = vec4(0.0, 0.0, 0.0, v_mass);
  } 
  else if (u_depositionScheme == 1) {
    // CIC (Cloud-In-Cell) - trilinear interpolation
    // Distribute mass to 8 neighboring cells based on distance
    
    // Get fractional position within cell [0, 1]
    vec3 frac = fract(v_gridPos);
    
    // Distance from center of point sprite
    vec2 pointCoord = gl_PointCoord * 2.0 - 1.0; // [-1, 1]
    float dist = length(pointCoord);
    
    // Weight by distance (simple linear falloff)
    // For CIC, we'd need to render to 8 cells, but for now
    // we'll use NGP with soft falloff
    float weight = max(0.0, 1.0 - dist);
    
    outColor = vec4(0.0, 0.0, 0.0, v_mass * weight);
  }
  else {
    // NGP fallback
    outColor = vec4(0.0, 0.0, 0.0, v_mass);
  }
}
`;
