export const hilbertShader = /* glsl */`
 #version 300 es

layout (location = 0) in vec3 a_position;
layout (location = 1) in vec3 a_velocity;

uniform int u_hilbertOrder;
uniform vec3 u_gridDimensions;

out uint v_hilbertIndex;
out uint v_particleIndex;
out vec3 v_position;
out vec3 v_velocity;

uint hilbertIndex(vec3 position, int order, vec3 grid) {
    // Implement Hilbert curve calculation here
    // ... (using position, order, and grid) ...
    // This is a placeholder, you'll need to implement the actual logic
    return uint(0);
}

void main() {
    v_hilbertIndex = hilbertIndex(a_position, u_hilbertOrder, u_gridDimensions);
    v_particleIndex = uint(gl_VertexID);
    v_position = a_position;
    v_velocity = a_velocity;
}
`;