// @ts-check

import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh } from './index.js';
import { particleSystem } from './particle-system/index.js';

// 1. Setup Scene using three-pop (matching texture-mode.js)
const outcome = createScene({
  renderer: { antialias: true },
  camera: { fov: 40, near: 0.0001 }
});

const { scene, camera, container, renderer } = outcome;

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

console.log('Initializing Barnes-Hut system with', particleCount, 'particles...');

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

// 3. Create particle mesh using raw WebGLTexture (will be wrapped internally)
const textureSize = physics.getTextureSize();
const mesh = massSpotMesh({
  textureMode: true,
  particleCount: particleCount,
  textures: {
    position: physics.getPositionTexture(),  // Raw WebGLTexture
    color: physics.getColorTexture(),         // Raw WebGLTexture  
    size: [textureSize.width, textureSize.height]
  }
});

scene.add(mesh);
console.log('Particle mesh created with', particleCount, 'particles');

// 4. Set up animation callback for physics compute
outcome.animate = () => {
  // TEST: Comment out physics compute to see if cube centers
  // physics.compute();
  
  // Update texture reference after ping-pong swap
  // const newPosTexture = physics.getPositionTexture();
  // const posUniform = mesh.material.uniforms.u_positionTexture;
  
  // Check if texture changed (ping-pong swap)
  // if (posUniform.value && posUniform.value.image !== newPosTexture) {
  //   // Texture swapped - update the ExternalTexture's image reference
  //   posUniform.value.image = newPosTexture;
  //   posUniform.value.needsUpdate = true;
  // }
};

console.log('Animation callback set up - PHYSICS COMPUTE DISABLED FOR TEST');

