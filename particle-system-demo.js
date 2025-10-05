import * as THREE from 'three';
import { massSpotMesh } from './index.js';
import { barnesHutSystem } from './particle-system/index.js';

// 1. Setup Scene (manual setup matching texture-mode.js)
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
camera.position.set(0, 2, 15);

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

// 2. Initialize Barnes-Hut GPU Physics
const gl = renderer.getContext();
const particleCount = 50000;

console.log('Initializing Barnes-Hut system with', particleCount, 'particles...');

const physics = barnesHutSystem({
  gl: gl,
  particleCount: particleCount,
  worldBounds: {
    min: [-10, -10, -5],
    max: [10, 10, 5]
  },
  theta: 0.5,              // Barnes-Hut threshold
  gravityStrength: 0.0003, // Force multiplier
  softening: 0.2,          // Softening length
  initialSpeed: 0.05,      // Initial velocity
  dt: 10 / 60,             // Timestep
  damping: 0.0,            // Velocity damping
  maxSpeed: 2.0,           // Speed limiter
  maxAccel: 1.0            // Acceleration limiter
});

// Wait for initialization before creating mesh
await physics.ready();

const texSize = physics.getTextureSize();
console.log('Barnes-Hut system ready! Texture size:', texSize);

// 3. Create Mesh with textureMode (GPU-to-GPU zero-copy pipeline)
const mesh = massSpotMesh({
  textureMode: true,
  particleCount: particleCount,
  textures: {
    position: physics.getPositionTexture(),
    color: physics.getColorTexture(),
    size: [texSize.width, texSize.height]
  },
  fog: { start: 15, gray: 40 }
});

scene.add(mesh);

// expose for debugging
window.physics = physics;
window.mesh = mesh;
window.renderer = renderer;
window.camera = camera;

console.log('GPU Barnes-Hut N-body simulation running with zero-copy textures');

// Debug: sample first texel from position texture every second
(function startDebugReadback(){
  const gl = renderer.getContext();
  const fb = gl.createFramebuffer();
  const width = texSize.width;
  const height = texSize.height;
  const buf = new Float32Array(4);
  setInterval(() => {
    const tex = physics.getPositionTexture();
    if (!tex) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      console.warn('Debug readback: framebuffer incomplete', status);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    console.log('Debug position texel [0,0]:', buf);
  }, 1000);
})();

// 4. Render Loop with Physics
let time = 0;
let frameCount = 0;
const startTime = performance.now();

renderer.setAnimationLoop(() => {
  // Run physics simulation (GPU compute)
  physics.compute();
  
  // Update mesh textures (they're already bound, but update the wrapper)
  mesh.updateTextures(
    physics.getPositionTexture(),
    physics.getColorTexture()
  );
  
  // Rotate camera for better view
  time += 0.005;
  camera.position.x = Math.sin(time) * 15;
  camera.position.z = Math.cos(time) * 15;
  camera.lookAt(0, 0, 0);
  
  // Render
  renderer.render(scene, camera);
  
  // FPS counter
  frameCount++;
  if (frameCount % 60 === 0) {
    const elapsed = (performance.now() - startTime) / 1000;
    const fps = frameCount / elapsed;
    console.log(`FPS: ${fps.toFixed(1)}, Frame: ${frameCount}`);
  }
});
