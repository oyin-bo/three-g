// @ts-check

export default /* glsl */`#version 300 es
precision highp float;

in float v_mass;
in vec3 v_worldPos;
in vec3 v_frac;

out vec4 outColor;

uniform int u_assignment; // 0 = NGP, 1 = CIC
uniform vec3 u_offset;    // CIC corner offset

void main() {
  float weight = 1.0;

  if (u_assignment == 1) {
    vec3 w = mix(1.0 - v_frac, v_frac, u_offset);
    weight = w.x * w.y * w.z;
  }

  float contribution = v_mass * weight;
  vec3 weightedPos = v_worldPos * contribution;
  outColor = vec4(weightedPos, contribution);
}
`;
