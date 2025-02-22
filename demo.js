import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh } from 'three-g';

const { scene, container } = createScene({
  renderer: { antialias: true },
  camera: { fov: 40 }
});

scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ff80, wireframe: true })
));

const colors = [...Array(4000)].map(() =>
  new THREE.Color().setHSL(Math.random(), 1, 0.5).getHex());

const m = massSpotMesh({
  spots: createSpots(40000),
  get: (_spot, dummy) => {
    dummy.rgb = colors[dummy.index % colors.length];
  }
});
scene.add(m);

document.body.appendChild(container);

const input = document.createElement('input');
input.value = 40000;
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
    x: Math.sqrt(Math.random()) * Math.sign(Math.random() - 0.5),
    y: Math.sqrt(Math.random()) * Math.sign(Math.random() - 0.5),
    z: Math.sqrt(Math.random()) * Math.sign(Math.random() - 0.5),
    mass: Math.random() * 0.003,
  }));
}
