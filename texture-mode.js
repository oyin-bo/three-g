import * as THREE from 'three';
import { massSpotMesh } from './index.js';

// 1. Setup Scene (manual setup to match demo.js DOM structure)
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);

// Create container matching demo.js
const container = document.createElement('div');
container.style.cssText = 'position: absolute; top: 0; left: 0; inset: 0;';
container.appendChild(renderer.domElement);
document.body.appendChild(container);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.0001, 1000);
camera.position.set(0, 2, 15); // Match demo.js camera position with proper z distance

// Add cube anchor (matching demo.js)
scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ff80, wireframe: true })
));

// Handle window resize
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// 2. Generate Static Particle Data
const particleCount = 50000;
const textureSize = Math.ceil(Math.sqrt(particleCount));
const actualParticleCount = textureSize * textureSize;

const posMassData = new Float32Array(actualParticleCount * 4);
const colorData = new Uint8Array(actualParticleCount * 4);

for (let i = 0; i < actualParticleCount; i++) {
  const i4 = i * 4;

  // Random position matching demo.js distribution (±2 for x/y, ±0.5 for z)
  posMassData[i4 + 0] = Math.random() * 2 * Math.sign(Math.random() - 0.5); // x
  posMassData[i4 + 1] = Math.random() * 2 * Math.sign(Math.random() - 0.5); // y
  posMassData[i4 + 2] = Math.random() * Math.sign(Math.random() - 0.5);     // z
  posMassData[i4 + 3] = 0.5 + Math.random() * 1.5;                           // mass

  // Random color
  const color = new THREE.Color().setHSL(Math.random(), 0.7, 0.6);
  colorData[i4 + 0] = color.r * 255;
  colorData[i4 + 1] = color.g * 255;
  colorData[i4 + 2] = color.b * 255;
  colorData[i4 + 3] = 255; // alpha
}

// 3. Create raw WebGLTexture objects (GPU-resident, no THREE.js management)
const gl = renderer.getContext();

// Position texture (RGBA32F)
const positionTexture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, positionTexture);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, textureSize, textureSize, 0, gl.RGBA, gl.FLOAT, posMassData);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

// Color texture (RGBA8)
const colorTexture = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, colorTexture);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, textureSize, textureSize, 0, gl.RGBA, gl.UNSIGNED_BYTE, colorData);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

gl.bindTexture(gl.TEXTURE_2D, null);

console.log('Created raw WebGLTexture objects (external to THREE.js):', { 
  positionTexture, 
  colorTexture, 
  textureSize 
});

// 4. Create Mesh with textureMode
const mesh = massSpotMesh({
  textureMode: true,
  particleCount: actualParticleCount,
  textures: {
    position: positionTexture,
    color: colorTexture,
    size: [textureSize, textureSize]
  },
  fog: { start: 15, gray: 40 }
});

scene.add(mesh);

console.log('Smoke test running with static textures.');

// 5. Render Loop with camera rotation to verify continuous rendering
let time = 0;
renderer.setAnimationLoop(() => {
  time += 0.01;
  camera.position.x = Math.sin(time) * 15;
  camera.position.z = Math.cos(time) * 15;
  camera.lookAt(0, 0, 0);
  renderer.render(scene, camera);
});
