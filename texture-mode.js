import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh } from './index.js';

const { scene, camera, container, renderer } = createScene({
  renderer: { antialias: true },
  camera: { fov: 40, near: 0.0001 }
});

scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ff80, wireframe: true })
));

container.style.cssText =
  'position: absolute; top: 0; left: 0; inset: 0;';

camera.position.y = 2;

document.body.appendChild(container);

// Generate Static Particle Data
const particleCount = 50000;
const textureSize = Math.ceil(Math.sqrt(particleCount));
const actualParticleCount = textureSize * textureSize;

const posMassData = new Float32Array(actualParticleCount * 4);
const colorData = new Uint8Array(actualParticleCount * 4);

for (let i = 0; i < actualParticleCount; i++) {
  const i4 = i * 4;

  // Random position matching demo.js distribution (±2 for x/y, ±1 for z)
  posMassData[i4 + 0] = Math.random() * 2 * Math.sign(Math.random() - 0.5);
  posMassData[i4 + 1] = Math.random() * 2 * Math.sign(Math.random() - 0.5);
  posMassData[i4 + 2] = Math.random() * Math.sign(Math.random() - 0.5);
  posMassData[i4 + 3] = 0.5 + Math.random() * 1.5;

  // Random color
  const color = new THREE.Color().setHSL(Math.random(), 0.7, 0.6);
  colorData[i4 + 0] = color.r * 255;
  colorData[i4 + 1] = color.g * 255;
  colorData[i4 + 2] = color.b * 255;
  colorData[i4 + 3] = 255;
}

// Create raw WebGLTexture objects
const gl = renderer.getContext();

const positionTexture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, positionTexture);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, textureSize, textureSize, 0, gl.RGBA, gl.FLOAT, posMassData);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

const colorTexture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, colorTexture);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, textureSize, textureSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, colorData);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

gl.bindTexture(gl.TEXTURE_2D, null);

const mesh = massSpotMesh({
  textureMode: true,
  particleCount: actualParticleCount,
  textures: {
    position: positionTexture,
    color: colorTexture,
    size: [textureSize, textureSize]
  },
  fog: 200
});

scene.add(mesh);
