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
in float v_weight;

// Output: mass in red channel
out vec4 outColor;

void main() {
  outColor = vec4(v_mass * v_weight, 0.0, 0.0, 1.0);
}
`;
