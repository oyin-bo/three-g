export const gl_PositionsAndVelocities = `
#version 300 es

in vec3 a_position;
in vec3 a_velocity;
in float a_mass;
in float a_cellSpanOffset;
in float a_cellTotalMass;

uniform float u_deltaTime;
uniform float u_gravityConstant;
uniform vec3 u_gridDimensions;

out vec3 v_position;
out vec3 v_velocity;

void main() {
    // Calculate cell index
    ivec3 gridDimensions = ivec3(u_gridDimensions);
    vec3 cellWidth = vec3(1.0) / u_gridDimensions;
    ivec3 cellIndex = ivec3(floor(a_position / cellWidth));
    int cellIndex1D = cellIndex.z * gridDimensions.y * gridDimensions.x + cellIndex.y * gridDimensions.x + cellIndex.x;

    // Get cell span offset
    int cellSpanOffset = int(a_cellSpanOffset); // Directly use the attribute

    // Get cell total mass.
    float cellTotalMass = a_cellTotalMass; // Directly use the attribute

    // Compute gravitational force (example)
    vec3 force = vec3(0.0);

    //Example of looping through the particles in the current cell.
    int particleIndex = cellSpanOffset;
    if(particleIndex >= 0 && particleIndex < gl_VertexID){
        //The problem is that we no longer have a_positionBuffer, and a_massBuffer.
        //We would have to loop through all particles again, and check if they are in the same cell.

        //Example of a simple force.
        force = vec3(0.0, -9.8 * a_mass, 0.0);
    }

    // Update velocity and position
    v_velocity = a_velocity + force * u_deltaTime;
    v_position = a_position + v_velocity * u_deltaTime;

    gl_Position = vec4(v_position, 1.0); // Pass position to transform feedback
}
`;