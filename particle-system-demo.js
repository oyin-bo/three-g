// @ts-check

import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh } from './mass-spot-mesh.js';
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
  new THREE.MeshBasicMaterial({ color: 0x00ff80, wireframe: true, visible: true })  // Visible to verify rendering
));

container.style.cssText =
  'position: absolute; top: 0; left: 0; inset: 0;';

camera.position.y = 2;

document.body.appendChild(container);

// 2. Initialize Barnes-Hut GPU Physics
const gl = renderer.getContext();
const particleCount = 50000;  // Increased 10x from 50000

console.log('TEST: Initializing physics but NOT calling compute...');

const physics = particleSystem({
  gl: gl,
  particleCount: particleCount,
  worldBounds: {
    min: [-4, -4, 0],
    max: [4, 4, 2]
  },
  theta: 0.5,
  gravityStrength: 0.000006,  // Increased from 0.0003
  softening: 0.2,
  initialSpeed: 0.000005,
  dt: 10 / 60  // Increased 10x from 1/60 for faster motion
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

scene.add(mesh);
window.mesh = mesh;  // Expose for debugging
window.physics = physics;  // Expose for debugging
console.log('Particle mesh created with', particleCount, 'particles');

// 4. Create TWO ExternalTexture wrappers for ping-pong buffers (after first render)
let positionTextureWrappers = null;
let isInitialized = false;

// Set up animation callback - swap between the two ExternalTexture wrappers
outcome.animate = () => {
  // Initialize wrappers AFTER first render so shaders compile properly
  if (!isInitialized) {
    const positionTextures = physics.getPositionTextures();
    const positionTexture0 = new THREE.ExternalTexture(positionTextures[0]);
    const positionTexture1 = new THREE.ExternalTexture(positionTextures[1]);
    positionTextureWrappers = [positionTexture0, positionTexture1];
    
    const colorTexture = new THREE.ExternalTexture(physics.getColorTexture());
    mesh.material.uniforms.u_colorTexture.value = colorTexture;
    
    isInitialized = true;
    console.log('Texture wrappers initialized after first render');
    return;  // Skip physics compute on first frame
  }
  
  physics.compute();
  
  // Restore THREE.js WebGL state after physics compute
  renderer.resetState();
  
  // Just swap which wrapper we use - no recreation, no copying
  const currentIndex = physics.getCurrentIndex();
  const wrapper = positionTextureWrappers[currentIndex];
  mesh.material.uniforms.u_positionTexture.value = wrapper;
  wrapper.needsUpdate = true;  // Tell THREE.js the GPU texture has new data
};

console.log('Animation callback set up - PHYSICS COMPUTE ENABLED');

