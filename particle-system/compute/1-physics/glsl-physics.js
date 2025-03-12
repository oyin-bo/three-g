export const NEIGHBOR_WINDOW_SIZE = 100, gl_physics = /* glsl */`
#version 300 es

precision highp float;

// Static Buffer Layout:
// [ float mass, float mass_arc, vec3 position_arc, vec3 velocity_arc, uint cpu_idx ]
layout(std140) uniform StaticBuffer {
    float masses[];
    float masses_arc[];
    vec3 positions_arc[];
    vec3 velocities_arc[];
    uint cpuIndices[];
    uint cpuIndices_arc[]; // TODO: propagate in the JS buffer definitions and loading/sorting
};

// Dynamic Buffer Layout:
// [ vec3 positions, vec3 velocities ]
layout(std140) uniform DynamicBuffer {
    vec3 positions[];
    vec3 velocities[];
};

// Uniforms
uniform float gravity;
uniform float timeDelta;
uniform int bufferSize;

// Output Attributes (Dynamic Buffer)
out vec3 positionOut;
out vec3 velocityOut;

vec3 getPosition(int index) {
    return index >= 0 && index < bufferSize ? positions[index] : vec3(0.0);
}

vec3 getPosition_arc(int index) {
    return index >= 0 && index < bufferSize ? positions_arc[index] : vec3(0.0);
}

float getMass(int index) {
    return index >= 0 && index < bufferSize ? masses[index] : 0.0;
}

float getMass_arc(int index) {
    return index >= 0 && index < bufferSize ? masses_arc[index] : 0.0;
}

int getCpuIndex(int index) {
    return index >= 0 && index < bufferSize ? int(cpuIndices[index]) : -1;
}

int getCpuIndex_arc(int index) {
    return index >= 0 && index < bufferSize ? int(cpuIndices_arc[index]) : -1;
}

vec3 calcForce(vec3 position, float mass, vec3 neighborPosition, float neighborMass) {
    vec3 direction = neighborPosition - position;
    float distanceSquared = dot(direction, direction);
    vec3 neighborForce = distanceSquared > 0.0 ?
        gravity * mass * neighborMass * normalize(direction) / distanceSquared :
        vec3(0.0);
    return neighborForce;
}

void main() {
    vec3 force = vec3(0.0);

    vec3 position = positions[gl_VertexID];
    vec3 velocity = positions[gl_VertexID];
    float mass = masses[gl_VertexID];

    for (int separationOffset = 1; separationOffset <= ${NEIGHBOR_WINDOW_SIZE}; separationOffset++) {
        int indexMinus = gl_VertexID - separationOffset;
        int indexPlus = gl_VertexID + separationOffset;
        int indexMinus_arc = gl_VertexID - separationOffset;
        int indexPlus_arc = gl_VertexID + separationOffset;

        vec3 forceMinus = calcForce(position, mass, getPosition(indexMinus), getMass(indexMinus));
        vec3 forcePlus = calcForce(position, mass, getPosition(indexPlus), getMass(indexPlus));
        vec3 forceMinus_arc = calcForce_arc(position, mass, getPosition_arc(indexMinus_arc), getMass_arc(indexMinus_arc));
        vec3 forcePlus_arc = calcForce_arc(position, mass, getPosition_arc(indexPlus_arc), getMass_arc(indexPlus_arc));

        int cpuIndexMinus = getCpuIndex(indexMinus);
        int cpuIndexPlus = getCpuIndex(indexPlus);
        int cpuIndexMinus_arc = getCpuIndex_arc(indexMinus_arc);
        int cpuIndexPlus_arc = getCpuIndex_arc(indexPlus_arc);

        // duplicates in the same separationOffset
        if (cpuIndexMinus == cpuIndexPlus
            || cpuIndexMinus == cpuIndexMinus_arc
            || cpuIndexMinus == cpuIndexPlus_arc) {
            forceMinus = vec3(0.0);
        }

        if (cpuIndexPlus == cpuIndexMinus_arc
            || cpuIndexPlus == cpuIndexPlus_arc) {
            forcePlus = vec3(0.0);
        }

        if (cpuIndexMinus_arc == cpuIndexPlus_arc) {
            forceMinus_arc = vec3(0.0);
        }

        // duplicates in the enclosure of the separationOffset (previous values)
        for (int prevSeparationOffset = 0; prevSeparationOffset < ${NEIGHBOR_WINDOW_SIZE} && prevSeparationOffset < separationOffset; prevSeparationOffset++) {
            int prevCpuIndexMinus = getCpuIndex(gl_VertexID - prevSeparationOffset);
            int prevCpuIndexPlus = getCpuIndex(gl_VertexID + prevSeparationOffset);
            int prevCpuIndexMinus_arc = getCpuIndex_arc(gl_VertexID - prevSeparationOffset);
            int prevCpuIndexPlus_arc = getCpuIndex_arc(gl_VertexID + prevSeparationOffset);

            if (cpuIndexMinus == prevCpuIndexMinus
                || cpuIndexMinus == prevCpuIndexPlus
                || cpuIndexMinus == prevCpuIndexMinus_arc
                || cpuIndexMinus == prevCpuIndexPlus_arc) {
                forceMinus = vec3(0.0);
            }

            if (cpuIndexPlus == prevCpuIndexMinus
                || cpuIndexPlus == prevCpuIndexPlus
                || cpuIndexPlus == prevCpuIndexMinus_arc
                || cpuIndexPlus == prevCpuIndexPlus_arc) {
                forcePlus = vec3(0.0);
            }

            if (cpuIndexMinus_arc == prevCpuIndexMinus
                || cpuIndexMinus_arc == prevCpuIndexPlus
                || cpuIndexMinus_arc == prevCpuIndexMinus_arc
                || cpuIndexMinus_arc == prevCpuIndexPlus_arc) {
                forceMinus_arc = vec3(0.0);
            }

            if (cpuIndexPlus_arc == prevCpuIndexMinus
                || cpuIndexPlus_arc == prevCpuIndexPlus
                || cpuIndexPlus_arc == prevCpuIndexMinus_arc
                || cpuIndexPlus_arc == prevCpuIndexPlus_arc) {
                forcePlus_arc = vec3(0.0);
            }
        }

        // Aggregate forces
        force += forceMainMinus + force_arcMinus + forceMainPlus + force_arcPlus;
    }

    // Update velocity and position
    vec3 newVelocity = velocity + force * timeDelta;
    vec3 newPosition = position + newVelocity * timeDelta;

    // Output
    positionOut = newPosition;
    velocityOut = newVelocity;
}
`;