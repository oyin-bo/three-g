import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh } from 'three-g';

// Get UI elements
const countInput = /** @type {HTMLInputElement} */ (document.getElementById('count-input'));
const profilingCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('profiling-checkbox'));
const profilerOutput = /** @type {HTMLDivElement} */ (document.getElementById('profiler-output'));

let profilingEnabled = false;
let particleCount = 40000;
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

const colors = [...Array(4000)].map(() =>
  new THREE.Color().setHSL(Math.random(), 1, 0.5).getHex());

let m = massSpotMesh({
  spots: createSpots(particleCount),
  get: (_spot, coords) => {
    coords.rgb = colors[coords.index % colors.length];
  },
  fog: 200,
  enableProfiling: profilingEnabled,
  gl
});
scene.add(m.mesh);

container.style.cssText = 'position: absolute; top: 0; left: 0; inset: 0;';
camera.position.y = 2;
document.body.appendChild(container);

// Update count input to show formatted number
countInput.value = particleCount.toLocaleString();

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
  m = massSpotMesh({
    spots: createSpots(particleCount),
    get: (_spot, coords) => {
      coords.rgb = colors[coords.index % colors.length];
    },
    fog: 200,
    enableProfiling: profilingEnabled,
    gl
  });
  scene.add(m.mesh);
}

function createSpots(count) {
  return [...Array(count)].map(() => ({
    x: Math.random() * 2 * Math.sign(Math.random() - 0.5),
    y: Math.random() * 2 * Math.sign(Math.random() - 0.5),
    z: Math.random() * Math.sign(Math.random() - 0.5),
    mass: Math.random() * 0.02,
  }));
}
