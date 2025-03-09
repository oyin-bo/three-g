export const gl_PositionsAndVelocities = `
#version 300 es

layout(std140) uniform CellSpanOffsetBuffer {
    int cellSpanOffset[];
};

layout(std140) uniform CellTotalMassBuffer {
    float cellTotalMass[];
};

layout(std140) uniform ParticlePositionsBuffer {
    vec3 positions[];
};

layout(std140) uniform ParticleMassesBuffer {
    float masses[];
};

layout(std140) uniform ParticleVelocitiesBuffer {
    vec3 velocities[];
};

uniform float u_deltaTime;
uniform float u_gravityConstant;
uniform vec3 u_gridDimensions;

out vec3 v_position;
out vec3 v_velocity;

void main() {
    // Lookup current particle's data
    vec3 currentPosition = positions[gl_VertexID];
    float currentMass = masses[gl_VertexID];
    vec3 currentVelocity = velocities[gl_VertexID];

    // Calculate cell index
    ivec3 gridDimensions = ivec3(u_gridDimensions);
    vec3 cellWidth = vec3(1.0) / u_gridDimensions;
    ivec3 cellIndex = ivec3(floor(currentPosition / cellWidth));
    int cellIndex1D = cellIndex.z * gridDimensions.y * gridDimensions.x + cellIndex.y * gridDimensions.x + cellIndex.x;

    // Get cell span
    int cellStart = cellSpanOffset[cellIndex1D];
    int cellEnd;
    if (cellIndex1D < u_gridDimensions.x * u_gridDimensions.y * u_gridDimensions.z - 1) { // Not the last cell
        cellEnd = cellSpanOffset[cellIndex1D + 1];
    } else { // Last cell
        cellEnd = positions.length(); // or masses.length() or velocities.length()
    }

    // cell mass
    float cellTotalMassValue = cellTotalMass[cellIndex1D];

    // Compute gravitational force
    vec3 force = vec3(0.0);

    for (int i = cellStart; i < cellEnd; i++) {
        if (i != gl_VertexID) {
            vec3 otherPosition = positions[i];
            float otherMass = masses[i];

            vec3 direction = otherPosition - currentPosition;
            float distanceSquared = dot(direction, direction);

            if (distanceSquared > 0.0) {
                force += u_gravityConstant * currentMass * otherMass * normalize(direction) / distanceSquared;
            }
        }
    }

    // Apply simple gravity
    force += vec3(0.0, -9.8 * currentMass, 0.0);

    // Update velocity and position
    v_velocity = currentVelocity + force * u_deltaTime;
    v_position = currentPosition + v_velocity * u_deltaTime;

    gl_Position = vec4(v_position, 1.0);
}
`;