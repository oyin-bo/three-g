import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh, ParticleSystem } from 'three-g';
import { glsl_Hilbert, hilbert3D, glsl_hilbert3D_Dual } from 'three-g/particle-system/compute/2-hilbert/glsl-hilbert.js';

const { scene, camera, container } = createScene({
  renderer: { antialias: true },
  camera: { fov: 40, near: 0.0001 }
});

scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ff80, wireframe: true })
));

const colors = [...Array(4000)].map(() =>
  new THREE.Color().setHSL(Math.random(), 1, 0.5).getHex());

const loadHilbert = /hilbert/i.test(location + '');

const m = massSpotMesh({
  spots: createSpots(40000),
  get: (_spot, coords) => {
    coords.rgb = colors[coords.index % colors.length];
    // if (loadHilbert) {
    //   coords.rgb =
    //     hilbert3D(coords.x, coords.y, coords.z);
    //   // moore3D(coords.x, coords.y, coords.z);
    // }
  },
  fog: 200,
  glsl: !loadHilbert ? undefined : {
    definitions: glsl_hilbert3D_Dual,
    vertex:
  /* glsl */`
  ivec2 derivedColor_Dual = hilbert3D_Dual(offset);

  uint dRInt = (uint(derivedColor_Dual.y) / uint(256)) % uint(256);
  uint dGInt = (uint(derivedColor_Dual.y)) % uint(256);
  uint dBInt = uint(derivedColor_Dual.x) % uint(256);

  vColor.r = float(dRInt) / 255.0f;
  vColor.g = float(dGInt) / 255.0f;
  vColor.b = float(dBInt) / 255.0f;

  `
  }
});
scene.add(m);

container.style.cssText =
  'position: absolute; top: 0; left: 0; inset: 0;';

camera.position.y = 2;

document.body.appendChild(container);

const input = document.createElement('input');
input.style.cssText = 'position: absolute; top: 0.5em; right: 1em; background: transparent; color: #5ec15e; font-size: 200%; text-align: right; backdrop-filter: blur(2px);';
input.value = 40 * 1000;
document.body.appendChild(input);

input.oninput = () => {
  clearTimeout(input.timeout);
  input.timeout = setTimeout(() => {
    const count = parseInt(input.value);
    if (Number.isFinite(count) && count > 0) {
      m.updateSpots(createSpots(count))
    }
  }, 600);
};

function createSpots(count) {
  return [...Array(count)].map(() => ({
    x: Math.random() * 2 * Math.sign(Math.random() - 0.5),
    y: Math.random() * 2 * Math.sign(Math.random() - 0.5),
    z: Math.random() * Math.sign(Math.random() - 0.5),
    mass: Math.random() * 0.02,
  }));
}
