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

// for debugging
/** @type {*} */(window).outcome = outcome;
/** @type {*} */(window).scene = scene;

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

// renderer.getContext() may return WebGLRenderingContext or WebGL2RenderingContext;
// we use WebGL2 APIs. Cast for ts-check.
const gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());

// Build spots array and pass to particleSystem using the array-of-spots API
let particleCount = 50000;
const worldBounds = /** @type {const} */({
  min: [-4, -4, -2],
  max: [4, 4, 2]
});

const input = document.createElement('input');
input.style.cssText = 'position: absolute; top: 0.5em; right: 1em; background: transparent; color: #5ec15e; font-size: 200%; text-align: right; backdrop-filter: blur(2px);';
input.value = particleCount.toLocaleString();
document.body.appendChild(input);

let { physics, particles } = recreatePhysics();

/** @type {*} */
let inputTimeout;
input.oninput = () => {
  clearTimeout(inputTimeout);
  inputTimeout = setTimeout(() => {
    const count = parseInt(input.value.replace(/,|\./g, ''));
    if (Number.isFinite(count) && count > 0) {
      physics.dispose();
      isInitialized = false;
      particleCount = count;

      [{ physics, particles }] = [recreatePhysics()];
    }
  }, 600);
};

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

// for debugging
/** @type {any} */ (window).mesh = mesh;
/** @type {any} */ (window).physics = physics;

// 4. Create TWO ExternalTexture wrappers for ping-pong buffers (after first render)
/** @type {THREE.ExternalTexture[]} */
let positionTextureWrappers = [];
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
  
  // swap which wrapper we use - no recreation, no copying
  const currentIndex = physics.getCurrentIndex();
  mesh.material.uniforms.u_positionTexture.value = positionTextureWrappers[currentIndex];
};


function recreatePhysics() {
  let particles = createSpots(
    particleCount,
    worldBounds);

  // Use THREE.js Color to create vibrant hue transitions
  const color1 = new THREE.Color().setHSL(0.0, 1.0, 0.6); // Red
  const color2 = new THREE.Color().setHSL(0.33, 1.0, 0.6); // Green
  const color3 = new THREE.Color().setHSL(0.66, 1.0, 0.6); // Blue


  // Blend between the three colors based on position
  const finalColor = new THREE.Color();

  let physics = particleSystem({
    gl,
    particles,
    get: (spot, out) => {
      // map rgb similarly to the original color gradient
      const vx = Number(out.x || 0);
      const vy = Number(out.y || 0);
      const vz = Number(out.z || 0);
      const x = (vx - worldBounds.min[0]) / (worldBounds.max[0] - worldBounds.min[0]);
      const y = (vy - worldBounds.min[1]) / (worldBounds.max[1] - worldBounds.min[1]);
      const z = (vz - worldBounds.min[2]) / (worldBounds.max[2] - worldBounds.min[2]);

      finalColor.r = color1.r * x + color2.r * y + color3.r * z;
      finalColor.g = color1.g * x + color2.g * y + color3.g * z;
      finalColor.b = color1.b * x + color2.b * y + color3.b * z;

      // Normalize to maintain saturation
      const factor = 1 / (x + y + z || 1);
      finalColor.r *= factor;
      finalColor.g *= factor;
      finalColor.b *= factor;

      out.rgb =
        ((Math.floor(x * 255) & 0xff) << 16) |
        ((Math.floor(y * 255) & 0xff) << 8) |
        (Math.floor(z * 255) & 0xff);
    },
    theta: 0.5,
    gravityStrength: 0.6,
    softening: 0.2,
    dt: 10 / 60
  });
  return { physics, particles };
}

/**
 * Create an array of spot objects (mass-spot-mesh style)
 * @param {number} count
 * @param {{min:readonly [number,number,number],max: readonly [number,number,number]}} worldBounds
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
