export default /* glsl */`#version 300 es
precision highp float;

in vec3 v_particlePosition;
in float v_particleMass;

out vec4 outColor;

uniform sampler2D u_massGrid;
uniform float u_gridSize;
uniform float u_slicesPerRow;
uniform vec3 u_worldMin;
uniform vec3 u_worldMax;
uniform float u_softening;
uniform float u_gravityStrength;
uniform int u_nearFieldRadius;

const int MAX_RADIUS = 4;

float wrapIndex(float value, float size) {
  float wrapped = mod(value, size);
  return wrapped < 0.0 ? wrapped + size : wrapped;
}

int wrapIndexInt(int value, int size) {
  int m = value % size;
  return m < 0 ? m + size : m;
}

vec3 minimumImage(vec3 delta, vec3 extent) {
  return delta - extent * floor(delta / extent + 0.5);
}

a ivec2 voxelToTexel(ivec3 voxel, int gridSize, int slicesPerRow) {
  int sliceIndex = voxel.z;
  int sliceRow = sliceIndex / slicesPerRow;
  int sliceCol = sliceIndex - sliceRow * slicesPerRow;
  int texX = sliceCol * gridSize + voxel.x;
  int texY = sliceRow * gridSize + voxel.y;
  return ivec2(texX, texY);
}

void main() {
  vec3 extent = max(u_worldMax - u_worldMin, vec3(1e-6));

  if (u_nearFieldRadius <= 0) {
    outColor = vec4(0.0);
    return;
  }

  int gridSize = int(u_gridSize);
  int slicesPerRow = int(u_slicesPerRow);

  vec3 norm = (v_particlePosition - u_worldMin) / extent;
  norm = fract(norm);
  vec3 gridPos = norm * u_gridSize;
  ivec3 baseVoxel = ivec3(floor(gridPos));
  baseVoxel.x = wrapIndexInt(baseVoxel.x, gridSize);
  baseVoxel.y = wrapIndexInt(baseVoxel.y, gridSize);
  baseVoxel.z = wrapIndexInt(baseVoxel.z, gridSize);

  vec3 total = vec3(0.0);

  for (int dz = -MAX_RADIUS; dz <= MAX_RADIUS; ++dz) {
    if (abs(dz) > u_nearFieldRadius) continue;
    for (int dy = -MAX_RADIUS; dy <= MAX_RADIUS; ++dy) {
      if (abs(dy) > u_nearFieldRadius) continue;
      for (int dx = -MAX_RADIUS; dx <= MAX_RADIUS; ++dx) {
        if (abs(dx) > u_nearFieldRadius) continue;

        ivec3 neighbor = baseVoxel + ivec3(dx, dy, dz);
        neighbor.x = wrapIndexInt(neighbor.x, gridSize);
        neighbor.y = wrapIndexInt(neighbor.y, gridSize);
        neighbor.z = wrapIndexInt(neighbor.z, gridSize);

        ivec2 texel = voxelToTexel(neighbor, gridSize, slicesPerRow);
        vec4 cell = texelFetch(u_massGrid, texel, 0);
        float mass = cell.a;
        if (mass <= 0.0) {
          continue;
        }

        vec3 weighted = cell.rgb;
        if (neighbor == baseVoxel) {
          mass -= v_particleMass;
          weighted -= v_particlePosition * v_particleMass;
          if (mass <= 0.0) {
            continue;
          }
        }

        vec3 com = weighted / mass;
        vec3 delta = minimumImage(com - v_particlePosition, extent);
        float dist2 = dot(delta, delta);
        if (dist2 <= 0.0) {
          continue;
        }

        float softened = dist2 + u_softening * u_softening;
        float invDist = inversesqrt(softened);
        float invDist3 = invDist * invDist * invDist;
        vec3 accel = -u_gravityStrength * mass * delta * invDist3;
        total += accel;
      }
    }
  }

  outColor = vec4(total, 0.0);
}
`;
