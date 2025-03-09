export const gl_Hilbert = `
uint hilbert3D(uint x, uint y, uint z) {
  uint h = 0;
  uint mask = 1;
  uint t;
  for (int i = 0; i < 10; i++) {
    uint rx = (x & mask) >> i; // 0 or 1
    uint ry = (y & mask) >> i; // 0 or 1
    uint rz = (z & mask) >> i; // 0 or 1

    t = rz * 3 + ry * (1 - rz) * 2 + rx * (1 - rz) * (1 - ry);
    h = (h << 2) | t;

    uint temp;
    temp = x ^ y;
    x ^= z * (1 - rz);
    y ^= z * (1 - rz);
    z ^= temp * (1 - rz);

    z ^= mask * ry * (1 - rx) * (1 - rz);

    temp = x ^ y;
    x ^= z * (1 - ry);
    y ^= z * (1 - ry);
    z ^= temp * (1 - ry);

    x ^= mask;
    y ^= mask;
    mask <<= 1;
  }
  return h;
}
`;