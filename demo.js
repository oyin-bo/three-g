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
const planaCheckbox = /** @type {HTMLInputElement} */ (document.getElementById('plana-checkbox'));
const profilerOutput = /** @type {HTMLDivElement} */ (document.getElementById('profiler-output'));

// 3. Initialize state
const gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());

let particleCount = 500000;
const worldBounds = /** @type {const} */({
  min: [-2, -0.1, -2],
  max: [2, 0.1, 2]
});

let profilingEnabled = false;
let planAEnabled = false;
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

// DevTools hook for Plan A control
/** @type {any} */ (window).planA = (enabled) => {
  if (typeof enabled === 'boolean') {
    planAEnabled = enabled;
    planaCheckbox.checked = enabled;
    console.log('[Demo] Plan A ' + (enabled ? 'enabled' : 'disabled') + ' via DevTools');
    recreateAll();
  } else {
    return planAEnabled;
  }
};

window.verifyPM = function() {
  if (!physics || !physics._system) {
    console.error('[verifyPM] Physics system not initialized');
    return;
  }
  
  const system = physics._system;
  const pmForceTexture = system.pmForceTexture;
  
  if (!pmForceTexture) {
    console.error('[verifyPM] pmForceTexture not found');
    return;
  }
  
  console.log('[verifyPM] Verifying PM force computation...');
  console.log('[verifyPM] pmForceTexture:', pmForceTexture);
  console.log('[verifyPM] Texture dimensions:', system.textureWidth, 'x', system.textureHeight);
  
  const gl = system.gl;
  const width = system.textureWidth;
  const height = system.textureHeight;
  
  // Read back force texture
  const pixels = new Float32Array(width * height * 4);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, pmForceTexture, 0);
  
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('[verifyPM] Framebuffer incomplete!');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return;
  }
  
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Analyze forces
  let nonZeroCount = 0;
  let maxForce = 0;
  let totalForce = 0;
  const sampleSize = 100;
  
  for (let i = 0; i < sampleSize && i < width * height; i++) {
    const idx = i * 4;
    const fx = pixels[idx];
    const fy = pixels[idx + 1];
    const fz = pixels[idx + 2];
    const force = Math.sqrt(fx*fx + fy*fy + fz*fz);
    
    if (force > 0.0000001) {
      nonZeroCount++;
    }
    maxForce = Math.max(maxForce, force);
    totalForce += force;
  }
  
  const avgForce = totalForce / sampleSize;
  
  console.log('[verifyPM] === Force Statistics ===');
  console.log(`[verifyPM] Sampled: ${sampleSize} particles`);
  console.log(`[verifyPM] Non-zero forces: ${nonZeroCount} (${(nonZeroCount/sampleSize*100).toFixed(1)}%)`);
  console.log(`[verifyPM] Max force magnitude: ${maxForce.toExponential(3)}`);
  console.log(`[verifyPM] Mean force magnitude: ${avgForce.toExponential(3)}`);
  
  if (nonZeroCount === 0) {
    console.warn('[verifyPM] ⚠️  ALL FORCES ARE ZERO! PM pipeline may not be working correctly.');
  } else {
    console.log('[verifyPM] ✅ Forces detected - PM pipeline appears to be working!');
  }
};

// Debug helper: Check force grid textures (before sampling)
window.verifyForceGrids = function() {
  if (!physics || !physics._system) {
    console.error('[verifyForceGrids] Physics system not initialized');
    return;
  }
  
  const system = physics._system;
  const forceGrids = system.pmForceGrids;
  
  if (!forceGrids) {
    console.error('[verifyForceGrids] pmForceGrids not found');
    return;
  }
  
  console.log('[verifyForceGrids] Checking force grid textures...');
  
  const gl = system.gl;
  const texSize = forceGrids.textureSize;
  
  // Read back X force grid
  const pixels = new Float32Array(texSize * texSize * 4);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, forceGrids.x, 0);
  
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('[verifyForceGrids] Framebuffer incomplete!');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return;
  }
  
  gl.readPixels(0, 0, texSize, texSize, gl.RGBA, gl.FLOAT, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Analyze force grid X
  let nonZeroCount = 0;
  let maxVal = 0;
  let minVal = 0;
  let totalAbs = 0;
  const sampleSize = Math.min(1000, texSize * texSize);
  
  for (let i = 0; i < sampleSize; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const val = Math.sqrt(r*r + g*g); // Complex magnitude
    
    if (Math.abs(val) > 0.0000001) {
      nonZeroCount++;
    }
    maxVal = Math.max(maxVal, val);
    minVal = Math.min(minVal, val);
    totalAbs += Math.abs(val);
  }
  
  const avgVal = totalAbs / sampleSize;
  
  console.log('[verifyForceGrids] === Force Grid X Analysis ===');
  console.log(`[verifyForceGrids] Texture size: ${texSize}x${texSize}`);
  console.log(`[verifyForceGrids] Sampled: ${sampleSize} pixels`);
  console.log(`[verifyForceGrids] Non-zero values: ${nonZeroCount} (${(nonZeroCount/sampleSize*100).toFixed(1)}%)`);
  console.log(`[verifyForceGrids] Max value: ${maxVal.toExponential(3)}`);
  console.log(`[verifyForceGrids] Min value: ${minVal.toExponential(3)}`);
  console.log(`[verifyForceGrids] Mean |value|: ${avgVal.toExponential(3)}`);
  
  if (nonZeroCount === 0) {
    console.warn('[verifyForceGrids] ⚠️  FORCE GRID IS ALL ZEROS! Inverse FFT may have failed.');
  } else {
    console.log('[verifyForceGrids] ✅ Force grid contains data.');
  }
};

/**
 * Verify force spectra (BEFORE inverse FFT) to check gradient computation
 */
window.verifyForceSpectra = function() {
  if (!physics || !physics._system) {
    console.error('[verifyForceSpectra] Physics system not initialized');
    return;
  }
  
  const system = physics._system;
  const forceSpectra = system.pmForceSpectrum;
  
  if (!forceSpectra) {
    console.error('[verifyForceSpectra] pmForceSpectrum not found');
    return;
  }
  
  console.log('[verifyForceSpectra] Checking force spectrum textures...');
  
  const gl = system.gl;
  const texSize = forceSpectra.textureSize;
  
  // Read back X force spectrum (complex: RG = real, imaginary)
  const pixels = new Float32Array(texSize * texSize * 4);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, forceSpectra.x.texture, 0);
  
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    console.error('[verifyForceSpectra] Framebuffer incomplete!');
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return;
  }
  
  gl.readPixels(0, 0, texSize, texSize, gl.RGBA, gl.FLOAT, pixels);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  
  // Analyze force spectrum X
  let nonZeroCount = 0;
  let maxMag = 0;
  let minMag = Infinity;
  let totalMag = 0;
  const sampleSize = Math.min(1000, texSize * texSize);
  
  for (let i = 0; i < sampleSize; i++) {
    const idx = i * 4;
    const real = pixels[idx];
    const imag = pixels[idx + 1];
    const magnitude = Math.sqrt(real*real + imag*imag); // Complex magnitude
    
    if (magnitude > 1e-10) {
      nonZeroCount++;
    }
    maxMag = Math.max(maxMag, magnitude);
    minMag = Math.min(minMag, magnitude);
    totalMag += magnitude;
  }
  
  const avgMag = totalMag / sampleSize;
  
  console.log('[verifyForceSpectra] === Force Spectrum X Analysis ===');
  console.log(`[verifyForceSpectra] Texture size: ${texSize}x${texSize}`);
  console.log(`[verifyForceSpectra] Sampled: ${sampleSize} pixels`);
  console.log(`[verifyForceSpectra] Non-zero values: ${nonZeroCount} (${(nonZeroCount/sampleSize*100).toFixed(1)}%)`);
  console.log(`[verifyForceSpectra] Max magnitude: ${maxMag.toExponential(3)}`);
  console.log(`[verifyForceSpectra] Min magnitude: ${minMag === Infinity ? 0 : minMag.toExponential(3)}`);
  console.log(`[verifyForceSpectra] Mean magnitude: ${avgMag.toExponential(3)}`);
  
  if (nonZeroCount === 0) {
    console.warn('[verifyForceSpectra] ⚠️  FORCE SPECTRUM IS ALL ZEROS! Gradient computation may have failed.');
  } else {
    console.log('[verifyForceSpectra] ✅ Force spectrum contains data.');
  }
};

// @ts-ignore
window.verifyPotentialSpectrum = function() {
  console.log('[verifyPotentialSpectrum] Checking potential spectrum texture...');
  
  const psys = window.physics.particleSystem;
  if (!psys || !psys.pmPotentialSpectrum || !psys.pmPotentialSpectrum.texture) {
    console.error('[verifyPotentialSpectrum] ❌ pmPotentialSpectrum not found!');
    return;
  }

  const gl = psys.renderer.getContext();
  const tex = psys.pmPotentialSpectrum.texture;
  const width = psys.pmPotentialSpectrum.textureSize;
  const height = psys.pmPotentialSpectrum.textureSize;

  // Create framebuffer to read texture
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

  // Check framebuffer status
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    console.error(`[verifyPotentialSpectrum] ❌ Framebuffer not complete: ${status}`);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    return;
  }

  // Read pixels (RG32F format - complex numbers)
  const pixels = new Float32Array(width * height * 4); // RGBA even though texture is RG
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);

  // Cleanup
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fb);

  // Sample 1000 random pixels and compute complex magnitude
  const sampleCount = 1000;
  let nonZeroCount = 0;
  let maxMag = 0;
  let minMag = Infinity;
  let sumMag = 0;

  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.floor(Math.random() * (width * height)) * 4;
    const real = pixels[idx];     // R channel - real part
    const imag = pixels[idx + 1]; // G channel - imaginary part
    
    // Complex magnitude: |z| = sqrt(real² + imag²)
    const mag = Math.sqrt(real * real + imag * imag);
    
    if (mag > 1e-10) {
      nonZeroCount++;
      maxMag = Math.max(maxMag, mag);
      minMag = Math.min(minMag, mag);
    }
    sumMag += mag;
  }

  const avgMag = sumMag / sampleCount;
  const nonZeroPercent = (nonZeroCount / sampleCount * 100).toFixed(1);

  console.log('[verifyPotentialSpectrum] === Potential Spectrum Analysis ===');
  console.log(`[verifyPotentialSpectrum] Texture size: ${width}x${height}`);
  console.log(`[verifyPotentialSpectrum] Sampled: ${sampleCount} pixels`);
  console.log(`[verifyPotentialSpectrum] Non-zero values: ${nonZeroCount} (${nonZeroPercent}%)`);
  console.log(`[verifyPotentialSpectrum] Max magnitude: ${maxMag.toExponential(3)}`);
  console.log(`[verifyPotentialSpectrum] Min magnitude: ${minMag === Infinity ? 0 : minMag.toExponential(3)}`);
  console.log(`[verifyPotentialSpectrum] Mean magnitude: ${avgMag.toExponential(3)}`);

  if (nonZeroCount === 0) {
    console.warn('[verifyPotentialSpectrum] ⚠️ POTENTIAL SPECTRUM IS ALL ZEROS! Poisson solver may have failed.');
  } else {
    console.log('[verifyPotentialSpectrum] ✅ Potential spectrum contains data.');
  }
};

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

// 7. Plan A checkbox handler
planaCheckbox.onchange = () => {
  planAEnabled = planaCheckbox.checked;
  console.log('[Demo] Plan A ' + (planAEnabled ? 'enabled' : 'disabled'));
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
  gravityStrength += 0.00005;

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
    theta: 0.5,
    gravityStrength,
    softening: 0.2,
    dt: 10 / 60,
    enableProfiling: profilingEnabled,
    planA: planAEnabled
  });

  const textureSize = physics.getTextureSize();
  
  const m = massSpotMesh({
    textureMode: true,
    particleCount: particleCount,
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
    mass = 1 - Math.pow(mass, 1 / 20);
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
