export default `#version 300 es
precision highp float;

// Accumulate weighted 3D positions, mass, and second moments
in vec4 v_particleA0;
in vec4 v_particleA1;
in vec4 v_particleA2;

layout(location = 0) out vec4 fragA0;
layout(location = 1) out vec4 fragA1;
layout(location = 2) out vec4 fragA2;

void main() {
  fragA0 = v_particleA0;
  fragA1 = v_particleA1;
  fragA2 = v_particleA2;
}
`;
