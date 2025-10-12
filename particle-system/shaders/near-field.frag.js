export default /* glsl */`#version 300 es
precision highp float;
precision highp int;

out vec4 outColor;

uniform sampler2D u_massGrid;
uniform float u_gridSize;
uniform float u_slicesPerRow;
uniform vec3 u_worldMin;
uniform vec3 u_worldMax;
uniform float u_softening;
uniform float u_gravityStrength;
uniform int u_nearFieldRadius;
uniform int u_component;

const int MAX_RADIUS = 4;

int wrapIndexInt(int value, int size) {
  int m = value % size;
  return m < 0 ? m + size : m;
}

vec3 minimumImage(vec3 delta, vec3 extent) {
  return delta - extent * floor(delta / extent + 0.5);
}

ivec2 voxelToTexel(ivec3 voxel, int gridSize, int slicesPerRow) {
  int sliceRow = voxel.z / slicesPerRow;
  int sliceCol = voxel.z - sliceRow * slicesPerRow;
  int texX = sliceCol * gridSize + voxel.x;
  int texY = sliceRow * gridSize + voxel.y;
  return ivec2(texX, texY);
}

vec3 voxelCenterWorld(ivec3 voxel, vec3 worldMin, vec3 worldMax, float gridSize) {
  vec3 extent = max(worldMax - worldMin, vec3(1e-6));
  return worldMin + (vec3(voxel) + vec3(0.5)) / gridSize * extent;
}

void main() {
  int gridSize = int(u_gridSize + 0.5);
  int slicesPerRow = int(u_slicesPerRow + 0.5);

  if (gridSize <= 0 || slicesPerRow <= 0) {
    outColor = vec4(0.0);
    return;
  }

  int radius = u_nearFieldRadius;
  if (radius <= 0) {
    outColor = vec4(0.0);
    return;
  }
  if (radius > MAX_RADIUS) {
    radius = MAX_RADIUS;
  }

  ivec2 texel = ivec2(floor(gl_FragCoord.xy - vec2(0.5)));

  if (texel.x < 0 || texel.y < 0) {
    outColor = vec4(0.0);
    return;
  }

  int sliceCol = texel.x / gridSize;
  int sliceRow = texel.y / gridSize;
  int iz = sliceRow * slicesPerRow + sliceCol;
  if (iz < 0 || iz >= gridSize) {
    outColor = vec4(0.0);
    return;
  }

  int ix = texel.x - sliceCol * gridSize;
  int iy = texel.y - sliceRow * gridSize;
  if (ix < 0 || ix >= gridSize || iy < 0 || iy >= gridSize) {
    outColor = vec4(0.0);
    return;
  }

  ivec3 baseVoxel = ivec3(ix, iy, iz);

  ivec2 baseTexel = voxelToTexel(baseVoxel, gridSize, slicesPerRow);
  vec4 baseCell = texelFetch(u_massGrid, baseTexel, 0);
  float baseMass = baseCell.a;
  vec3 baseCOM = baseMass > 0.0 ? baseCell.rgb / baseMass : voxelCenterWorld(baseVoxel, u_worldMin, u_worldMax, u_gridSize);

  vec3 extent = max(u_worldMax - u_worldMin, vec3(1e-6));
  vec3 total = vec3(0.0);

  for (int dz = -MAX_RADIUS; dz <= MAX_RADIUS; ++dz) {
    if (abs(dz) > radius) continue;
    for (int dy = -MAX_RADIUS; dy <= MAX_RADIUS; ++dy) {
      if (abs(dy) > radius) continue;
      for (int dx = -MAX_RADIUS; dx <= MAX_RADIUS; ++dx) {
        if (abs(dx) > radius) continue;

        ivec3 neighbor = baseVoxel + ivec3(dx, dy, dz);
        neighbor.x = wrapIndexInt(neighbor.x, gridSize);
        neighbor.y = wrapIndexInt(neighbor.y, gridSize);
        neighbor.z = wrapIndexInt(neighbor.z, gridSize);

        ivec2 neighborTexel = voxelToTexel(neighbor, gridSize, slicesPerRow);
        vec4 cell = texelFetch(u_massGrid, neighborTexel, 0);
        float mass = cell.a;
        if (mass <= 0.0) {
          continue;
        }

        vec3 neighborCOM = cell.rgb / mass;
        vec3 delta = minimumImage(neighborCOM - baseCOM, extent);
        float dist2 = dot(delta, delta);
        if (dist2 <= 1e-12) {
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

  float componentValue = 0.0;
  if (u_component == 0) {
    componentValue = total.x;
  } else if (u_component == 1) {
    componentValue = total.y;
  } else {
    componentValue = total.z;
  }

  outColor = vec4(componentValue, 0.0, 0.0, 0.0);
}
`;
