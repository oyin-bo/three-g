export const glsl_hilbert3D_Dual = `
const mat3 rotationMatrix = mat3(
  0.8660254, -0.25,      0.4330127,
  0.4330127,  0.8660254, -0.25,
  -0.25,      0.4330127,  0.8660254
);

ivec2 hilbert3D_Dual(vec3 pos) {
  const float ratioPrecision = 150.0;

  vec3 pos1 = abs(round((pos + vec3(1.0)) * ratioPrecision));
  vec3 pos2 = abs(round((rotationMatrix * pos + vec3(1.0)) * ratioPrecision));

  int x1 = int(pos1.x); int y1 = int(pos1.y); int z1 = int(pos1.z);
  int x2 = int(pos2.x); int y2 = int(pos2.y); int z2 = int(pos2.z);

  int h1 = 0;
  int h2 = 0;
  int mask = 1;
  int t1, t2;

  for (int i = 0; i < 10; i++) {
    int rx1 = (x1 & mask) >> i;
    int ry1 = (y1 & mask) >> i;
    int rz1 = (z1 & mask) >> i;

    int rx2 = (x2 & mask) >> i;
    int ry2 = (y2 & mask) >> i;
    int rz2 = (z2 & mask) >> i;

    t1 = rz1 * 3 + ry1 * (1 - rz1) * 2 + rx1 * (1 - rz1) * (1 - ry1);
    h1 = (h1 << 2) | t1;

    t2 = rz2 * 3 + ry2 * (1 - rz2) * 2 + rx2 * (1 - rz2) * (1 - ry2);
    h2 = (h2 << 2) | t2;

    int temp1;
    temp1 = x1 ^ y1;
    x1 ^= z1 * (1 - rz1);
    y1 ^= z1 * (1 - rz1);
    z1 ^= temp1 * (1 - rz1);

    z1 ^= mask * ry1 * (1 - rx1) * (1 - rz1);

    temp1 = x1 ^ y1;
    x1 ^= z1 * (1 - ry1);
    y1 ^= z1 * (1 - ry1);
    z1 ^= temp1 * (1 - ry1);

    x1 ^= mask;
    y1 ^= mask;

    int temp2;
    temp2 = x2 ^ y2;
    x2 ^= z2 * (1 - rz2);
    y2 ^= z2 * (1 - rz2);
    z2 ^= temp2 * (1 - rz2);

    z2 ^= mask * ry2 * (1 - rx2) * (1 - rz2);

    temp2 = x2 ^ y2;
    x2 ^= z2 * (1 - ry2);
    y2 ^= z2 * (1 - ry2);
    z2 ^= temp2 * (1 - ry2);

    x2 ^= mask;
    y2 ^= mask;

    mask <<= 1;
  }
  return ivec2(h1, h2);
}

`;

export const glsl_Hilbert = `
int hilbert3D(vec3 pos) {
  const float ratioPrecision = 150.0;

  int x = int(abs(round((pos.x + 1.0) * ratioPrecision)));
  int y = int(abs(round((pos.y + 1.0) * ratioPrecision)));
  int z = int(abs(round((pos.z + 1.0) * ratioPrecision)));

  int h = 0;
  int mask = 1;
  int t;
  for (int i = 0; i < 10; i++) {
    int rx = (x & mask) >> i;
    int ry = (y & mask) >> i;
    int rz = (z & mask) >> i;

    t = rz * 3 + ry * (1 - rz) * 2 + rx * (1 - rz) * (1 - ry);
    h = (h << 2) | t;

    int temp;
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

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 */
export function hilbert3D(x, y, z) {
  const ratioPrecision = 200.0;

  x = Math.abs(Math.round((x + 1) * ratioPrecision));
  y = Math.abs(Math.round((y + 1) * ratioPrecision));
  z = Math.abs(Math.round((z + 1) * ratioPrecision));

  let h = 0;
  let mask = 1;
  let t;
  for (let i = 0; i < 10; i++) {
    const rx = (x & mask) >> i;
    const ry = (y & mask) >> i;
    const rz = (z & mask) >> i;

    t = rz * 3 + ry * (1 - rz) * 2 + rx * (1 - rz) * (1 - ry);
    h = (h << 2) | t;

    let temp;
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
