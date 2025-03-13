export const gl_sorting = /* glsl */`
#version 300 es

precision highp float;

// Output Attributes
flat out vec3 positionOut;
flat out vec3 velocityOut;
flat out float massOut;
flat out float massArcOut;
flat out vec3 positionArcOut;
flat out vec3 velocityArcOut;
flat out uint cpuIndexOut;
flat out uint cpuIndexArcOut;
flat out uint sourceIdxHilbertOut;
flat out uint sourceIdxHilbertArcOut;

// Uniforms
uniform int bufferSize;
uniform int sortStage;
uniform int sortPhase;

// Static Buffer Layout
layout(std140) buffer StaticBuffer {
    float masses[];
    float massesArc[];
    vec3 positionsArc[];
    vec3 velocitiesArc[];
    uint cpuIndices[];
    uint cpuIndicesArc[];
};

// Dynamic Buffer Layout
layout(std140) buffer DynamicBuffer {
    vec3 positions[];
    vec3 velocities[];
};

// Orders Buffer Layout
layout(std140) buffer OrdersBuffer {
    uint sourceIdx[];
    uint hilbert[];
    uint sourceIdxArc[];
    uint hilbertArc[];
};

void main() {
    uint index = uint(gl_VertexID);
    uint compareIndex;

    // Calculate comparison index based on sortStage and sortPhase
    uint stageMask = uint(1 << sortStage);
    uint phaseMask = uint(sortPhase);

    if ((index & stageMask) == phaseMask) {
        compareIndex = index ^ stageMask;
    } else {
        compareIndex = index;
    }

    // Boundary check
    if (compareIndex >= uint(bufferSize)) {
        compareIndex = index; // Keep original index if out of bounds
    }

    // Read comparison keys
    uint key1 = OrdersBuffer.hilbert[index];
    uint key2;

    if (compareIndex != index) {
        key2 = OrdersBuffer.hilbertArc[compareIndex];
    } else {
        key2 = key1;
    }

    // Compare and swap
    if (key1 > key2 && compareIndex != index) { // Swap if needed
        // Read comparison particle data
        vec3 comparePosition = DynamicBuffer.positions[compareIndex];
        vec3 compareVelocity = DynamicBuffer.velocities[compareIndex];
        float compareMass = StaticBuffer.masses[compareIndex];
        float compareMassArc = StaticBuffer.massesArc[compareIndex];
        vec3 comparePositionArc = StaticBuffer.positionsArc[compareIndex];
        vec3 compareVelocityArc = StaticBuffer.velocitiesArc[compareIndex];
        uint compareCpuIndex = StaticBuffer.cpuIndices[compareIndex];
        uint compareCpuIndexArc = StaticBuffer.cpuIndicesArc[compareIndex];
        uint compareSourceIdxHilbert = OrdersBuffer.hilbertArc[index];
        uint compareSourceIdxHilbertArc = OrdersBuffer.hilbert[index];

        // Write comparison particle data to current index
        positionOut = comparePosition;
        velocityOut = compareVelocity;
        massOut = compareMass;
        massArcOut = compareMassArc;
        positionArcOut = comparePositionArc;
        velocityArcOut = compareVelocityArc;
        cpuIndexOut = StaticBuffer.cpuIndices[compareIndex];
        cpuIndexArcOut = StaticBuffer.cpuIndicesArc[compareIndex];
        sourceIdxHilbertOut = compareSourceIdxHilbert;
        sourceIdxHilbertArcOut = compareSourceIdxHilbertArc;
    } else { // No swap needed
        positionOut = DynamicBuffer.positions[index];
        velocityOut = DynamicBuffer.velocities[index];
        massOut = StaticBuffer.masses[index];
        massArcOut = StaticBuffer.massesArc[index];
        positionArcOut = StaticBuffer.positionsArc[index];
        velocityArcOut = StaticBuffer.velocitiesArc[index];
        cpuIndexOut = StaticBuffer.cpuIndices[index];
        cpuIndexArcOut = StaticBuffer.cpuIndicesArc[index];
        sourceIdxHilbertOut = OrdersBuffer.hilbert[index];
        sourceIdxHilbertArcOut = OrdersBuffer.hilbertArc[index];
    }
}
`;
