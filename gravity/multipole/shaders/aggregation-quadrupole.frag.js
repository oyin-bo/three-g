export default `#version 300 es
precision highp float;

// Accumulate weighted 3D positions, mass, second moments, AND occupancy
in vec4 v_particleA0;
in vec4 v_particleA1;
in vec4 v_particleA2;

layout(location = 0) out vec4 fragA0;
layout(location = 1) out vec4 fragA1;
layout(location = 2) out vec4 fragA2;
layout(location = 3) out vec4 fragOccupancy;

void main() {
  fragA0 = v_particleA0;
  fragA1 = v_particleA1;
  fragA2 = v_particleA2;
  
  // Occupancy: write 1.0 if this cell has any mass
  float mass = v_particleA0.w;
  fragOccupancy = vec4(mass > 0.0 ? 1.0 : 0.0);
}
`;


