export default `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_inputTexture;
uniform float u_gridSize;
uniform float u_slicesPerRow;
uniform int u_axis; // 0=X, 1=Y, 2=Z

// Convert 2D texture coords to 3D voxel coords
ivec3 texCoordToVoxel(vec2 uv, float gridSize, float slicesPerRow) {
  vec2 texel = uv * gridSize * slicesPerRow;
  int sliceIndex = int(texel.y / gridSize) * int(slicesPerRow) + int(texel.x / gridSize);
  int iz = sliceIndex;
  int ix = int(mod(texel.x, gridSize));
  int iy = int(mod(texel.y, gridSize));
  return ivec3(ix, iy, iz);
}

// Convert 3D voxel to 2D texture coords
vec2 voxelToTexCoord(ivec3 voxel, float gridSize, float slicesPerRow) {
  int sliceRow = voxel.z / int(slicesPerRow);
  int sliceCol = voxel.z % int(slicesPerRow);
  
  float texX = float(sliceCol * int(gridSize) + voxel.x) + 0.5;
  float texY = float(sliceRow * int(gridSize) + voxel.y) + 0.5;
  
  return vec2(texX, texY) / (gridSize * slicesPerRow);
}

// Bit-reverse an integer
int bitReverse(int x, int numBits) {
  int result = 0;
  for (int i = 0; i < numBits; i++) {
    result = (result << 1) | ((x >> i) & 1);
  }
  return result;
}

void main() {
  ivec3 voxel = texCoordToVoxel(v_uv, u_gridSize, u_slicesPerRow);
  int N = int(u_gridSize);
  int numBits = int(log2(u_gridSize));
  
  // Get the index along the FFT axis
  int idx = (u_axis == 0) ? voxel.x : ((u_axis == 1) ? voxel.y : voxel.z);
  
  // Compute bit-reversed index
  int reversedIdx = bitReverse(idx, numBits);
  
  // Read from bit-reversed position
  ivec3 sourceVoxel = voxel;
  if (u_axis == 0) sourceVoxel.x = reversedIdx;
  else if (u_axis == 1) sourceVoxel.y = reversedIdx;
  else sourceVoxel.z = reversedIdx;
  
  vec2 sourceUV = voxelToTexCoord(sourceVoxel, u_gridSize, u_slicesPerRow);
  outColor = texture(u_inputTexture, sourceUV);
}
`;
