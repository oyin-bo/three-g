// @ts-check

import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh } from './index.js';
import { particleSystem } from './particle-system/index.js';

// 1. Setup Scene using three-pop (matching texture-mode.js)
const outcome = createScene({
  renderer: { antialias: true },
  camera: { fov: 40, near: 0.0001 },
  controls: { autoRotate: false }  // Disable auto-rotation
});

const { scene, camera, container, renderer } = outcome;

// Expose to window for debugging
window.outcome = outcome;
window.scene = scene;

// Debug cube to verify scene rendering
scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ff80, wireframe: true })
));

container.style.cssText =
  'position: absolute; top: 0; left: 0; inset: 0;';

camera.position.y = 2;

document.body.appendChild(container);

// 2. Initialize Barnes-Hut GPU Physics
const gl = renderer.getContext();
const particleCount = 50000;

console.log('TEST: Initializing physics but NOT calling compute...');

const physics = particleSystem({
  gl: gl,
  particleCount: particleCount,
  worldBounds: {
    min: [-4, -4, 0],
    max: [4, 4, 2]
  },
  theta: 0.5,
  gravityStrength: 0.0003,
  softening: 0.2,
  initialSpeed: 0.05,
  dt: 10 / 60
});

// Get texture info
const textureSize = physics.getTextureSize();

// 3. Create particle mesh using raw WebGLTexture (will be wrapped internally)
const mesh = massSpotMesh({
  textureMode: true,
  particleCount: particleCount,
  textures: {
    position: physics.getPositionTexture(),  // Raw WebGLTexture
    color: physics.getColorTexture(),         // Raw WebGLTexture  
    size: [textureSize.width, textureSize.height]
  }
});

// Update texture references before each render (after physics.compute() has run)
mesh.onBeforeRender = () => {
  // After swap(), getCurrentTexture() points to the JUST-WRITTEN buffer with new positions
  const newPosTexture = physics.getPositionTexture();
  const newColorTexture = physics.getColorTexture();
  
  // CRITICAL: Recreate ExternalTexture wrappers each frame
  // Simply setting .image doesn't trigger proper rebinding
  mesh.material.uniforms.u_positionTexture.value = new THREE.ExternalTexture(newPosTexture);
  mesh.material.uniforms.u_colorTexture.value = new THREE.ExternalTexture(newColorTexture);
};

scene.add(mesh);
window.mesh = mesh;  // Expose for debugging
window.physics = physics;  // Expose for debugging
console.log('Particle mesh created with', particleCount, 'particles');

// 4. Set up animation callback for physics compute
outcome.animate = () => {
  // Compute physics (swaps ping-pong buffers)
  // Texture refs will be updated in mesh.onBeforeRender() before next render
  physics.compute();
};

console.log('Animation callback set up - PHYSICS COMPUTE ENABLED');

