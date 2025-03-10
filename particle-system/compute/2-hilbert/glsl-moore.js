import { generateMoore3DLookupTableString, calculateMoore3DTransformations } from '../../moore-lookups.js';

export const glsl_Moore = /* glsl */`
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

var transformationMatrices;

export function moore3D(x, y, z) {
  if (!transformationMatrices) transformationMatrices = calculateMoore3DTransformations();

  let m = 0;
  let mask = 1;
  let dir;

  // Direction matrix (3x8) - represented as a flat array in JavaScript
  const directionMatrix = [
    0, 1, 1, 0, 0, 1, 1, 0, // rz
    0, 0, 1, 1, 1, 1, 0, 0, // ry
    0, 0, 0, 0, 1, 1, 1, 1  // rx
  ];

  // Fixed iteration count
  for (let i = 0; i < 10; i++) {
    const rx = (x & mask) >> i;
    const ry = (y & mask) >> i;
    const rz = (z & mask) >> i;

    // Calculate dot products manually
    let dotProducts = [0, 0, 0, 0, 0, 0, 0, 0];
    for (let j = 0; j < 8; j++) {
      dotProducts[j] = rz * directionMatrix[j] +
        ry * directionMatrix[j + 8] +
        rx * directionMatrix[j + 16];
    }

    // Bitwise operations to extract direction index
    dir = (dotProducts[1] * 1 +
      dotProducts[2] * 2 +
      dotProducts[3] * 3 +
      dotProducts[4] * 4 +
      dotProducts[5] * 5 +
      dotProducts[6] * 6 +
      dotProducts[7] * 7) % 8; // Clamp dir to [0, 7]

    m = (m << 3) | dir;

    // Apply transformation using matrix multiplication (lookup table)
    const matrixIndex = dir * 3; // Calculate the starting index for the current matrix
    const transformedX = transformationMatrices[matrixIndex + 0] * x + transformationMatrices[matrixIndex + 1] * y + transformationMatrices[matrixIndex + 2] * z + transformationMatrices[matrixIndex + 3];
    const transformedY = transformationMatrices[matrixIndex + 4] * x + transformationMatrices[matrixIndex + 5] * y + transformationMatrices[matrixIndex + 6] * z + transformationMatrices[matrixIndex + 7];
    const transformedZ = transformationMatrices[matrixIndex + 8] * x + transformationMatrices[matrixIndex + 9] * y + transformationMatrices[matrixIndex + 10] * z + transformationMatrices[matrixIndex + 11];

    x = transformedX;
    y = transformedY;
    z = transformedZ;

    mask <<= 1;
  }
  return m;
}