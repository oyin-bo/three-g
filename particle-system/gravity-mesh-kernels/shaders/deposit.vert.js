// @ts-check

export default /* glsl */`#version 300 es
precision highp float;
precision highp int;

uniform sampler2D u_positionTexture;
uniform vec2 u_textureSize;
uniform float u_gridSize;
uniform float u_slicesPerRow;
uniform vec3 u_worldMin;
uniform vec3 u_worldMax;
uniform float u_particleSize;
uniform int u_assignment; // 0 = NGP, 1 = CIC
uniform vec3 u_offset;    // CIC corner offset

out float v_mass;
out vec3 v_worldPos;
out vec3 v_frac;

const float EPS = 1e-6;

vec3 wrapToDomain(vec3 pos, vec3 minBound, vec3 maxBound) {
  vec3 extent = max(maxBound - minBound, vec3(EPS));
  vec3 norm = (pos - minBound) / extent;
  norm = norm - floor(norm);
  return minBound + norm * extent;
}

float wrapIndex(float coord, float size) {
  float wrapped = mod(coord, size);
  return wrapped < 0.0 ? wrapped + size : wrapped;
}

void main() {
  int particleIndex = gl_VertexID;
  int texWidth = int(u_textureSize.x);
  int texX = particleIndex % texWidth;
  int texY = particleIndex / texWidth;
  vec2 texCoord = (vec2(texX, texY) + 0.5) / u_textureSize;

  vec4 posData = texture(u_positionTexture, texCoord);
  vec3 worldPos = wrapToDomain(posData.xyz, u_worldMin, u_worldMax);
  float mass = posData.w;

  vec3 extent = max(u_worldMax - u_worldMin, vec3(EPS));
  vec3 norm = (worldPos - u_worldMin) / extent;
  vec3 gridPos = norm * u_gridSize;
  vec3 baseVoxel = floor(gridPos);
  vec3 frac = gridPos - baseVoxel;

  vec3 targetVoxel = baseVoxel;
  if (u_assignment == 1) {
    targetVoxel += u_offset;
  }

  targetVoxel.x = wrapIndex(targetVoxel.x, u_gridSize);
  targetVoxel.y = wrapIndex(targetVoxel.y, u_gridSize);
  targetVoxel.z = wrapIndex(targetVoxel.z, u_gridSize);

  int sliceRow = int(targetVoxel.z) / int(u_slicesPerRow);
  int sliceCol = int(targetVoxel.z) - sliceRow * int(u_slicesPerRow);

  vec2 texel = vec2(
    float(sliceCol * int(u_gridSize) + int(targetVoxel.x)),
    float(sliceRow * int(u_gridSize) + int(targetVoxel.y))
  );

  float textureSize = u_gridSize * u_slicesPerRow;
  vec2 ndc = ((texel + 0.5) / textureSize) * 2.0 - 1.0;

  v_mass = mass;
  v_worldPos = worldPos;
  v_frac = frac;

  gl_Position = vec4(ndc, 0.0, 1.0);
  gl_PointSize = u_particleSize;
}
`;
