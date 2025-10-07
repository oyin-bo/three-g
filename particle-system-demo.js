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

// Create spots (array-of-objects) in the mass-spot-mesh style
/**
 * Create an array of spot objects (mass-spot-mesh style)
 * @param {number} count
 * @param {{min:[number,number,number],max:[number,number,number]}} worldBounds
 */
function createSpots(count, worldBounds) {
  const spots = new Array(count);
  const center = [
    (worldBounds.min[0] + worldBounds.max[0]) / 2,
    (worldBounds.min[1] + worldBounds.max[1]) / 2,
    (worldBounds.min[2] + worldBounds.max[2]) / 2
  ];

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * 3 + Math.random() * 1;
    const height = (Math.random() - 0.5) * 2;

    spots[i] = {
      x: center[0] + Math.cos(angle) * radius,
      y: center[1] + Math.sin(angle) * radius,
      z: center[2] + height,
      mass: 0.5 + Math.random() * 1.5
    };
  }

  return spots;
}

// renderer.getContext() may return WebGLRenderingContext or WebGL2RenderingContext;
// we use WebGL2 APIs. Cast for ts-check.
const gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());
const particleCount = 50000;
const worldBounds = {
  min: /** @type {[number,number,number]} */ ([-4, -4, 0]),
  max: /** @type {[number,number,number]} */ ([4, 4, 2])
};

// Build spots array and pass to particleSystem using the array-of-spots API
const spots = createSpots(particleCount, worldBounds);

const physics = particleSystem({
  gl: gl,
  particles: spots,
  get: (spot, out) => {
    // map rgb similarly to the original color gradient
    const vx = Number(out.x || 0);
    const vy = Number(out.y || 0);
    const vz = Number(out.z || 0);
    const x = (vx - worldBounds.min[0]) / (worldBounds.max[0] - worldBounds.min[0]);
    const y = (vy - worldBounds.min[1]) / (worldBounds.max[1] - worldBounds.min[1]);
    const z = (vz - worldBounds.min[2]) / (worldBounds.max[2] - worldBounds.min[2]);
    out.rgb = ((Math.floor(x * 255) & 0xff) << 16) | ((Math.floor(y * 255) & 0xff) << 8) | (Math.floor(z * 255) & 0xff);
  },
  theta: 0.5,
  gravityStrength: 0.000006,
  softening: 0.2,
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
  },
  fog: { start: 0.3, gray: 20 }
});

scene.add(mesh);
// Expose for debugging (cast to any to satisfy ts-check)
/** @type {any} */ (window).mesh = mesh;
/** @type {any} */ (window).physics = physics;

// 4. Create TWO ExternalTexture wrappers for ping-pong buffers (after first render)
/** @type {Array<THREE.ExternalTexture>|null} */
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

