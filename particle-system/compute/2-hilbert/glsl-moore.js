export const gl_Moore = `
// Injected lookup table data from JavaScript:
/* INSERT generateMoore3DLookupTableString() OUTPUT HERE */

uint moore3D(uint x, uint y, uint z) {
  uint m = 0;
  uint mask = 1;
  uint dir;

  // Direction matrix (3x8)
  const mat3x8 directionMatrix = mat3x8(
    0, 1, 1, 0, 0, 1, 1, 0, // rz
    0, 0, 1, 1, 1, 1, 0, 0, // ry
    0, 0, 0, 0, 1, 1, 1, 1  // rx
  );

  // Fixed iteration count
  for (int i = 0; i < 10; i++) {
    uint rx = (x & mask) >> i;
    uint ry = (y & mask) >> i;
    uint rz = (z & mask) >> i;

    // Input bit vector
    vec3 inputBits = vec3(rz, ry, rx);

    // Matrix multiplication
    vec8 dotProducts = directionMatrix * inputBits;

    // Bitwise operations to extract direction index
    dir = uint(dotProducts.x) * 0 +
          uint(dotProducts.y) * 1 +
          uint(dotProducts.z) * 2 +
          uint(dotProducts.w) * 3 +
          uint(dotProducts.v) * 4 +
          uint(dotProducts.u) * 5 +
          uint(dotProducts.t) * 6 +
          uint(dotProducts.s) * 7;

    m = (m << 3) | dir;

    // Apply transformation using matrix multiplication
    vec4 coordinates = vec4(x, y, z, 1.0); // Homogeneous coordinates
    vec4 transformedCoordinates = transformationMatrices[dir] * coordinates;

    x = uint(transformedCoordinates.x);
    y = uint(transformedCoordinates.y);
    z = uint(transformedCoordinates.z);

    mask <<= 1;
  }
  return m;
}
`;