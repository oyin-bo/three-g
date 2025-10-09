// @ts-check

import * as THREE from 'three';
import { createScene } from 'three-pop';
import { massSpotMesh } from './mass-spot-mesh.js';
import { particleSystem } from './particle-system/index.js';

// 1. Setup Scene
const outcome = createScene({
  renderer: { antialias: true },
  camera: { fov: 40, near: 0.0001 },
  controls: { autoRotate: false }
});

const { scene, camera, container, renderer } = outcome;

/** @type {*} */(window).outcome = outcome;
/** @type {*} */(window).scene = scene;

scene.add(new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshBasicMaterial({ color: 0x00ff80, wireframe: true, visible: true })
));

container.style.cssText = 'position: absolute; top: 0; left: 0; inset: 0;';
camera.position.y = 1.1;

document.body.appendChild(container);

// 2. Get UI elements
const countInput = /** @type {HTMLInputElement} */ (document.getElementById('count-input'));
const profilingCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('profiling-checkbox'));
const plancCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('planc-checkbox'));
const profilerOutput = /** @type {HTMLDivElement} */ (document.getElementById('profiler-output'));

// 3. Initialize state
const gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());

let particleCount = 500000;
const worldBounds = /** @type {const} */({
  min: [-2, -0.1, -2],
  max: [2, 0.1, 2]
});

let profilingEnabled = false;
let plancEnabled = false;
let frameCount = 0;
let lastProfileUpdate = 0;

/** @type {any} */
let physics;
/** @type {any} */
let m;
let positionTextureWrappers = /** @type {THREE.ExternalTexture[]} */([]);
let isInitialized = false;

// 4. Animation loop - MUST be set BEFORE recreateAll()
outcome.animate = () => {
  if (!isInitialized) {
    const positionTextures = physics.getPositionTextures();
    const positionTexture0 = new THREE.ExternalTexture(positionTextures[0]);
    const positionTexture1 = new THREE.ExternalTexture(positionTextures[1]);
    positionTextureWrappers = [positionTexture0, positionTexture1];

    const colorTexture = new THREE.ExternalTexture(physics.getColorTexture());
    m.mesh.material.uniforms.u_colorTexture.value = colorTexture;

    isInitialized = true;
    return;
  }
  
  physics.compute();
  renderer.resetState();
  
  const currentIndex = physics.getCurrentIndex();
  m.mesh.material.uniforms.u_positionTexture.value = positionTextureWrappers[currentIndex];
  positionTextureWrappers[currentIndex].needsUpdate = true;
  
  if (profilingEnabled) {
    // We can't nest GPU timer queries, so we only measure rendering_total
    // The particle_draw and wireframe_cube are already measured inside via their onBeforeRender callbacks
    renderer.render(scene, camera);
    
    frameCount++;
    const now = performance.now();
    if (frameCount > 60 && now - lastProfileUpdate > 5000) {
      updateProfilingDisplay();
      lastProfileUpdate = now;
    }
  } else {
    renderer.render(scene, camera);
  }
};

recreateAll();

/** @type {any} */ (window).m = m;
/** @type {any} */ (window).physics = physics;

// 8. DevTools helpers for Plan C debugging
/** @type {any} */ (window).planC = (enabled) => {
  plancEnabled = enabled;
  plancCheckbox.checked = enabled;
  console.log('[Demo] Plan C toggled via DevTools:', enabled ? 'ON' : 'OFF');
  recreateAll();
};

// Debug utilities shortcut
/** @type {any} */ (window).dbg = {
  mode: (m) => physics && physics.setDebugMode(m),
  flags: (f) => physics && physics.setDebugFlags(f),
  step: () => physics && physics.step_Debug(),
  _utils: null
};

// Lazy-load debug utils
Object.defineProperty(/** @type {any} */ (window).dbg, 'utils', {
  get() {
    if (!this._utils && physics) {
      physics._debug().then(u => {
        this._utils = u;
        console.log('[Debug] Utilities loaded. Available functions:', Object.keys(u));
      });
    }
    return this._utils;
  }
});

console.log('[Demo] DevTools helpers available:');
console.log('  window.planC(true/false) - Toggle Plan C');
console.log('  window.dbg.mode(mode) - Set debug mode');
console.log('  window.dbg.flags({...}) - Set debug flags');
console.log('  window.dbg.step() - Execute debug step');
console.log('  window.dbg.utils - Lazy-load debug utilities');

// 5. Count input handler
/** @type {*} */
let inputTimeout;
countInput.oninput = () => {
  clearTimeout(inputTimeout);
  inputTimeout = setTimeout(() => {
    const count = parseInt(countInput.value.replace(/,|\.|\s/g, ''));
    if (Number.isFinite(count) && count > 0) {
      particleCount = count;
      recreateAll();
    }
  }, 600);
};

// 6. Profiling checkbox handler
profilingCheckbox.onchange = () => {
  profilingEnabled = profilingCheckbox.checked;
  profilerOutput.classList.toggle('visible', profilingEnabled);
  recreateAll();
};

// 7. Plan C checkbox handler
plancCheckbox.onchange = () => {
  plancEnabled = plancCheckbox.checked;
  console.log('[Demo] Plan C', plancEnabled ? 'enabled' : 'disabled');
  recreateAll();
};

function updateProfilingDisplay() {
  const physicsStats = physics.stats();
  const meshStats = m.stats();
  
  if (!physicsStats || !meshStats) {
    profilerOutput.innerHTML = 
      '<div class="warning">⚠️ GPU profiling not available (EXT_disjoint_timer_query_webgl2 extension not supported)</div>';
    return;
  }

  // Combine physics and rendering stats
  const results = { ...physicsStats, ...meshStats };
  const totalTime = Object.values(results).reduce((sum, val) => sum + (val || 0), 0);

  if (totalTime === 0) {
    profilerOutput.innerHTML = 
      '<div>Waiting for GPU timing data... (frame ' + frameCount + ')</div>';
    return;
  }

  const physicsStages = ['octree_clear', 'aggregation', 'pyramid_reduction', 'traversal', 'vel_integrate', 'pos_integrate'];
  
  const physicsTime = physicsStages.reduce((sum, name) => sum + (results[name] || 0), 0);
  const particleDrawTime = results['particle_draw'] || 0;
  
  const renderingTime = particleDrawTime;
  const grandTotal = physicsTime + renderingTime;
  
  const physicsPercent = (physicsTime / grandTotal * 100).toFixed(1);
  const renderingPercent = (renderingTime / grandTotal * 100).toFixed(1);

  let html = '<div style="font-weight: bold;">GPU Performance Profile</div>';
  html += '<div class="metric-row">';
  html += '<div class="metric-label">Total: ' + grandTotal.toFixed(2) + ' ms/frame (' + (1000 / grandTotal).toFixed(1) + ' FPS)</div>';
  html += '</div>';
  
  html += '<div class="section-header" style="color: #4fc3f7;">Physics (' + physicsPercent + '%): ' + physicsTime.toFixed(2) + ' ms</div>';
  physicsStages.forEach(name => {
    const time = results[name] || 0;
    if (time > 0) {
      const width = (time / grandTotal * 100);
      html += '<div class="metric-row">';
      html += '<div class="metric-bar physics-bar" style="width: ' + width + '%;"></div>';
      html += '<div class="metric-label">' + name + ': ' + time.toFixed(2) + ' ms</div>';
      html += '</div>';
    }
  });
  
  html += '<div class="section-header" style="color: #9fffc8;">Rendering (' + renderingPercent + '%): ' + renderingTime.toFixed(2) + ' ms</div>';
  
  if (particleDrawTime > 0) {
    const width = (particleDrawTime / grandTotal * 100);
    html += '<div class="metric-row">';
    html += '<div class="metric-bar rendering-bar" style="width: ' + width + '%;"></div>';
    html += '<div class="metric-label">particle_draw: ' + particleDrawTime.toFixed(2) + ' ms</div>';
    html += '</div>';
  }
  
  if (physicsTime > renderingTime * 2) {
    html += '<div class="metric-row" style="color: #ffa726; margin-top: 0.8em;">⚠️ Physics is the bottleneck</div>';
  } else if (renderingTime > physicsTime * 2) {
    html += '<div class="metric-row" style="color: #ffa726; margin-top: 0.8em;">⚠️ Rendering is the bottleneck</div>';
  }

  profilerOutput.innerHTML = html;
}

function recreateAll() {
  if (physics) physics.dispose();
  if (m && m.mesh) scene.remove(m.mesh);
  
  isInitialized = false;
  frameCount = 0;
  lastProfileUpdate = 0;
  positionTextureWrappers = [];
  
  const result = recreatePhysicsAndMesh();
  physics = result.physics;
  m = result.m;
  
  /** @type {any} */ (window).m = m;
  /** @type {any} */ (window).physics = physics;
}

function recreatePhysicsAndMesh() {
  const particles = createParticles(particleCount, worldBounds);

  const color1 = new THREE.Color().setHSL(0.0, 1.0, 0.6);
  const color2 = new THREE.Color().setHSL(0.33, 1.0, 0.6);
  const color3 = new THREE.Color().setHSL(0.66, 1.0, 0.6);
  const finalColor = new THREE.Color();

  let gravityStrength = Math.random();
  gravityStrength = gravityStrength * 0.0001;
  gravityStrength = gravityStrength * gravityStrength;
  gravityStrength += 0.0000005;

  const physics = particleSystem({
    gl,
    particles,
    get: (spot, out) => {
      const vx = Number(out.x || 0);
      const vy = Number(out.y || 0);
      const vz = Number(out.z || 0);
      const x = (vx - worldBounds.min[0]) / (worldBounds.max[0] - worldBounds.min[0]);
      const y = (vy - worldBounds.min[1]) / (worldBounds.max[1] - worldBounds.min[1]);
      const z = (vz - worldBounds.min[2]) / (worldBounds.max[2] - worldBounds.min[2]);

      finalColor.r = color1.r * x + color2.r * y + color3.r * z;
      finalColor.g = color1.g * x + color2.g * y + color3.g * z;
      finalColor.b = color1.b * x + color2.b * y + color3.b * z;

      const factor = 1 / (x + y + z || 1);
      finalColor.r *= factor;
      finalColor.g *= factor;
      finalColor.b *= factor;

      out.rgb =
        ((Math.floor(x * 255) & 0xff) << 16) |
        ((Math.floor(y * 255) & 0xff) << 8) |
        (Math.floor(z * 255) & 0xff);
    },
    theta: 0.65,  // Optimized for performance (was 0.5)
    gravityStrength,
    softening: 0.2,
    dt: 10 / 60,
    enableProfiling: profilingEnabled,
    planC: plancEnabled
  });

  const textureSize = physics.getTextureSize();
  
  const m = massSpotMesh({
    textureMode: true,
    particleCount,
    textures: {
      position: physics.getPositionTexture(),
      color: physics.getColorTexture(),
      size: [textureSize.width, textureSize.height]
    },
    fog: { start: 0.3, gray: 50 },
    enableProfiling: profilingEnabled,
    gl
  });

  scene.add(m.mesh);
  
  return { physics, m };
}

/**
 * Create an array of spot objects (mass-spot-mesh style)
 * @param {number} count
 * @param {{min:readonly [number,number,number],max: readonly [number,number,number]}} worldBounds
 */
function createParticles(count, worldBounds) {
  const spots = new Array(count);
  const center = [
    (worldBounds.min[0] + worldBounds.max[0]) / 2,
    (worldBounds.min[1] + worldBounds.max[1]) / 2,
    (worldBounds.min[2] + worldBounds.max[2]) / 2
  ];

  // Calculate disc dimensions from worldBounds
  const radiusX = (worldBounds.max[0] - worldBounds.min[0]) / 2;
  const radiusZ = (worldBounds.max[2] - worldBounds.min[2]) / 2;
  const heightRange = worldBounds.max[1] - worldBounds.min[1];

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    // For density proportional to r^2 (empty center, dense edges):
    // PDF: p(r) ∝ r^2, so CDF ∝ r^3
    // Inverse CDF: r = u^(1/3) where u is uniform [0,1]
    const radiusFactor = Math.pow(Math.random(), 1/7);
    const height = (Math.random() - 0.5) * heightRange;
    let mass = Math.random();
    mass = 1 - Math.pow(mass, 1/20);
    mass = 0.01 + mass * 10;

    spots[i] = {
      x: center[0] + Math.cos(angle) * radiusFactor * radiusX,
      y: center[1] + height,
      z: center[2] + Math.sin(angle) * radiusFactor * radiusZ,
      mass
    };
  }

  return spots;
}
