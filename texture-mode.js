import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh } from './index.js';

// Get UI elements
const countInput = /** @type {HTMLInputElement} */ (document.getElementById('count-input'));
const profilingCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('profiling-checkbox'));
const profilerOutput = /** @type {HTMLDivElement} */ (document.getElementById('profiler-output'));

let profilingEnabled = false;
let particleCount = 50000;
let frameCount = 0;
let lastProfileUpdate = 0;

const outcome = createScene({
  renderer: { antialias: true },
  camera: { fov: 40, near: 0.0001 }
});

const { scene, camera, container, renderer } = outcome;
const gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());

// Set up animation callback for profiling
outcome.animate = () => {
  if (profilingEnabled && m) {
    frameCount++;
    const now = performance.now();
    if (frameCount > 60 && now - lastProfileUpdate > 5000) {
      updateProfilingDisplay();
      lastProfileUpdate = now;
    }
  }
};

scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ff80, wireframe: true })
));

container.style.cssText = 'position: absolute; top: 0; left: 0; inset: 0;';
camera.position.y = 2;
document.body.appendChild(container);

// Update count input to show formatted number
countInput.value = particleCount.toLocaleString();

let m = createMeshWithTextures(particleCount);
scene.add(m.mesh);

// Count input handler
let inputTimeout;
countInput.oninput = () => {
  clearTimeout(inputTimeout);
  inputTimeout = setTimeout(() => {
    const count = parseInt(countInput.value.replace(/,|\.|\s/g, ''));
    if (Number.isFinite(count) && count > 0) {
      particleCount = count;
      recreateMesh();
    }
  }, 600);
};

// Profiling checkbox handler
profilingCheckbox.onchange = () => {
  profilingEnabled = profilingCheckbox.checked;
  profilerOutput.classList.toggle('visible', profilingEnabled);
  frameCount = 0;
  lastProfileUpdate = 0;
  recreateMesh();
};

function updateProfilingDisplay() {
  const stats = m.stats();
  
  if (!stats) {
    profilerOutput.innerHTML = 
      '<div class="warning">⚠️ GPU profiling not available</div>';
    return;
  }

  const results = stats;
  const particleDrawTime = results['particle_draw'] || 0;

  if (particleDrawTime === 0) {
    profilerOutput.innerHTML = 
      '<div>Waiting for GPU timing data... (frame ' + frameCount + ')</div>';
    return;
  }

  let html = '<div style="font-weight: bold;">GPU Performance Profile</div>';
  html += '<div class="metric-row">';
  html += '<div class="metric-label">Particle Draw: ' + particleDrawTime.toFixed(2) + ' ms (' + (1000 / particleDrawTime).toFixed(1) + ' FPS)</div>';
  html += '</div>';

  profilerOutput.innerHTML = html;
}

function recreateMesh() {
  scene.remove(m.mesh);
  m = createMeshWithTextures(particleCount);
  scene.add(m.mesh);
}

function createMeshWithTextures(count) {
  const textureSize = Math.ceil(Math.sqrt(count));
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

  return massSpotMesh({
    textureMode: true,
    particleCount: actualParticleCount,
    textures: {
      position: positionTexture,
      color: colorTexture,
      size: [textureSize, textureSize]
    },
    fog: 200,
    enableProfiling: profilingEnabled,
    gl
  });
}
