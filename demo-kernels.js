// @ts-check

import * as THREE from "three";
import { createScene } from "three-pop";
import { massSpotMesh } from "./mass-spot-mesh.js";

// Import kernel-based particle systems
import { ParticleSystemMonopoleKernels } from "./particle-system/gravity-multipole/particle-system-monopole-kernels.js";
import { ParticleSystemQuadrupoleKernels } from "./particle-system/gravity-multipole/particle-system-quadrupole-kernels.js";
import { ParticleSystemSpectralKernels } from "./particle-system/gravity-spectral-kernels/particle-system-spectral-kernels.js";
import { ParticleSystemMeshKernels } from "./particle-system/gravity-mesh-kernels/particle-system-mesh-kernels.js";

// 1. Setup Scene
const outcome = createScene({
  renderer: { antialias: true },
  camera: { fov: 40, near: 0.0001 },
  controls: { autoRotate: false },
});

const { scene, camera, container, renderer } = outcome;

/** @type {*} */ (window).outcome = outcome;
/** @type {*} */ (window).scene = scene;

scene.add(
  new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshBasicMaterial({
      color: 0x00ff80,
      wireframe: true,
      visible: true,
    })
  )
);

container.style.cssText = "position: absolute; top: 0; left: 0; inset: 0;";
camera.position.y = 1.1;

document.body.appendChild(container);

// 2. Get UI elements
const countInput = /** @type {HTMLInputElement} */ (
  document.getElementById("count-input")
);
const monopoleRadio = /** @type {HTMLInputElement} */ (
  document.getElementById("monopole-radio")
);
const quadrupoleRadio = /** @type {HTMLInputElement} */ (
  document.getElementById("quadrupole-radio")
);
const spectralRadio = /** @type {HTMLInputElement} */ (
  document.getElementById("spectral-radio")
);
const meshRadio = /** @type {HTMLInputElement} */ (
  document.getElementById("mesh-radio")
);
const statusDiv = /** @type {HTMLDivElement} */ (
  document.getElementById("kernel-status")
);

// 3. Initialize state
const gl = /** @type {WebGL2RenderingContext} */ (renderer.getContext());

let particleCount = 50000;
const worldBounds = /** @type {{ min: [number, number, number], max: [number, number, number] }} */ ({
  min: [-2, -0.1, -2],
  max: [2, 0.1, 2]
});

/** @type {'monopole' | 'quadrupole' | 'spectral' | 'mesh'} */
let calculationMethod = "monopole"; // Default to monopole
let frameCount = 0;

countInput.value = particleCount.toLocaleString();

const originalTitle = document.title;
const gravityIndex = originalTitle.indexOf("Gravity");
const titleSuffix = gravityIndex !== -1 ? originalTitle.slice(gravityIndex + "Gravity".length) : "";
const methodTitleMap = /** @type {Record<'quadrupole' | 'monopole' | 'spectral' | 'mesh', string>} */ ({
  quadrupole: "Quadrupole",
  monopole: "Monopole",
  spectral: "Spectral",
  mesh: "Mesh",
});

/**
 * @param {'monopole' | 'quadrupole' | 'spectral' | 'mesh'} method
 */
function updateDocumentTitle(method) {
  const label = methodTitleMap[method] || method;
  const formattedLabel = label.charAt(0).toUpperCase() + label.slice(1);
  if (gravityIndex !== -1) {
    document.title = `Kernel ${formattedLabel} Gravity${titleSuffix}`;
  } else {
    document.title = `Kernel ${formattedLabel} Gravity`;
  }
}

/** @type {ParticleSystemMonopoleKernels | ParticleSystemQuadrupoleKernels | ParticleSystemSpectralKernels | ParticleSystemMeshKernels | null} */
let physics = null;
/** @type {ReturnType<typeof massSpotMesh> | null} */
let m = null;
let positionTextureWrapper = /** @type {THREE.ExternalTexture | null} */ (null);
let isInitialized = false;
// Global color texture loaded from colors array
/** @type {WebGLTexture | null} */
let colorTexGlobal = null;

// 4. Animation loop - MUST be set BEFORE recreateAll()
outcome.animate = () => {
  if (!physics || !m) {
    return;
  }

  if (!isInitialized) {
    const positionTexture =
      physics instanceof ParticleSystemMonopoleKernels ?
        physics.positionTexture :
        physics.getPositionTexture();
    positionTextureWrapper = new THREE.ExternalTexture(positionTexture);

    // Use pre-loaded global color texture
    if (!colorTexGlobal) {
      return;
    }
    const colorTexture = new THREE.ExternalTexture(colorTexGlobal);
    m.mesh.material.uniforms.u_colorTexture.value = colorTexture;

    isInitialized = true;
    updateStatus("Running");
    return;
  }

  physics.step();
  renderer.resetState();

  if (positionTextureWrapper) {
    m.mesh.material.uniforms.u_positionTexture.value = positionTextureWrapper;
    positionTextureWrapper.needsUpdate = true;
  }

  renderer.render(scene, camera);
  frameCount++;
};

updateDocumentTitle(calculationMethod);
recreateAll();

/** @type {any} */ (window).m = m;
/** @type {any} */ (window).physics = physics;

// 5. DevTools helpers for method switching
/** @type {any} */ (window).setMethod = (/** @type {any} */ method) => {
  if (
    method === "monopole" ||
    method === "quadrupole" ||
    method === "spectral" ||
    method === "mesh"
  ) {
    calculationMethod = method;
    monopoleRadio.checked = method === "monopole";
    quadrupoleRadio.checked = method === "quadrupole";
    spectralRadio.checked = method === "spectral";
    meshRadio.checked = method === "mesh";
    updateDocumentTitle(calculationMethod);
    console.log("[Demo Kernels] Method toggled via DevTools:", method);
    recreateAll();
  } else {
    console.error(
      '[Demo Kernels] Invalid method. Use "monopole", "quadrupole", "spectral", or "mesh"'
    );
  }
};

console.log("[Demo Kernels] DevTools helpers available:");
console.log(
  '  window.setMethod("monopole"|"quadrupole"|"spectral"|"mesh") - Switch calculation method'
);
console.log("  window.physics - Access kernel-based particle system");
console.log("  window.m - Access mass spot mesh");

// 6. Count input handler
/** @type {*} */
let inputTimeout;
countInput.oninput = () => {
  clearTimeout(inputTimeout);
  inputTimeout = setTimeout(() => {
    const count = parseInt(countInput.value.replace(/,|\.|\s/g, ""));
    if (Number.isFinite(count) && count > 0) {
      particleCount = count;
      recreateAll();
    }
  }, 600);
};

// 7. Calculation method radio handlers
monopoleRadio.onchange = () => {
  if (monopoleRadio.checked) {
    calculationMethod = "monopole";
    updateDocumentTitle(calculationMethod);
    console.log("[Demo Kernels] Switched to Monopole (1st-order)");
    recreateAll();
  }
};

quadrupoleRadio.onchange = () => {
  if (quadrupoleRadio.checked) {
    calculationMethod = "quadrupole";
    updateDocumentTitle(calculationMethod);
    console.log("[Demo Kernels] Switched to Quadrupole (2nd-order)");
    recreateAll();
  }
};

spectralRadio.onchange = () => {
  if (spectralRadio.checked) {
    calculationMethod = "spectral";
    updateDocumentTitle(calculationMethod);
    console.log("[Demo Kernels] Switched to Spectral (PM/FFT)");
    recreateAll();
  }
};

meshRadio.onchange = () => {
  if (meshRadio.checked) {
    calculationMethod = "mesh";
    updateDocumentTitle(calculationMethod);
    console.log("[Demo Kernels] Switched to Mesh");
    recreateAll();
  }
};

/**
 * @param {string} message
 */
function updateStatus(message) {
  if (statusDiv) {
    statusDiv.textContent = message;
  }
}

function recreateAll() {
  updateStatus("Disposing previous system...");
  
  if (physics) physics.dispose();
  if (m && m.mesh) scene.remove(m.mesh);

  isInitialized = false;
  frameCount = 0;
  positionTextureWrapper = null;

  updateStatus("Creating particle system...");
  
  const result = recreatePhysicsAndMesh();
  physics = result.physics;
  m = result.m;

  /** @type {any} */ (window).m = m;
  /** @type {any} */ (window).physics = physics;
  
  updateStatus("Initializing...");
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

  // Calculate texture dimensions
  const textureWidth = Math.ceil(Math.sqrt(particleCount));
  const textureHeight = Math.ceil(particleCount / textureWidth);
  const actualTextureSize = textureWidth * textureHeight;

  const positions = new Float32Array(actualTextureSize * 4);
  const velocities = new Float32Array(actualTextureSize * 4);
  const colors = new Uint8Array(actualTextureSize * 4);

  // Populate buffers
  for (let i = 0; i < particles.length; i++) {
    const spot = particles[i];
    const vx = spot.x || 0;
    const vy = spot.y || 0;
    const vz = spot.z || 0;
    const x =
      (vx - worldBounds.min[0]) / (worldBounds.max[0] - worldBounds.min[0]);
    const y =
      (vy - worldBounds.min[1]) / (worldBounds.max[1] - worldBounds.min[1]);
    const z =
      (vz - worldBounds.min[2]) / (worldBounds.max[2] - worldBounds.min[2]);

    finalColor.r = color1.r * x + color2.r * y + color3.r * z;
    finalColor.g = color1.g * x + color2.g * y + color3.g * z;
    finalColor.b = color1.b * x + color2.b * y + color3.b * z;

    const factor = 1 / (x + y + z || 1);
    finalColor.r *= factor;
    finalColor.g *= factor;
    finalColor.b *= factor;

    const b = i * 4;
    positions[b + 0] = spot.x;
    positions[b + 1] = spot.y;
    positions[b + 2] = spot.z;
    positions[b + 3] = spot.mass;

    velocities[b + 0] = 0;
    velocities[b + 1] = 0;
    velocities[b + 2] = 0;
    velocities[b + 3] = 0;

    colors[b + 0] = Math.floor(x * 255);
    colors[b + 1] = Math.floor(y * 255);
    colors[b + 2] = Math.floor(z * 255);
    colors[b + 3] = 255;
  }

  const particleData = {
    positions,
    velocities,
    colors
  };

  /** @type {ParticleSystemMonopoleKernels | ParticleSystemQuadrupoleKernels | ParticleSystemSpectralKernels | ParticleSystemMeshKernels} */
  let system;

  try {
    switch (calculationMethod) {
      case 'mesh': {
        system = new ParticleSystemMeshKernels(gl, {
          particleData,
          worldBounds,
          mesh: {
            assignment: 'cic',
            gridSize: 64,
            slicesPerRow: 8,
            nearFieldRadius: 2
          },
          gravityStrength,
          softening: 0.002,
          dt: 10 / 60,
          damping: 0.002
        });
        console.log("[Demo Kernels] Created ParticleSystemMeshKernels");
        break;
      }
      case 'spectral': {
        system = new ParticleSystemSpectralKernels(gl, {
          particleData,
          worldBounds,
          gridSize: 64,
          assignment: 'CIC',
          gravityStrength,
          softening: 0.002,
          dt: 10 / 60,
          damping: 0.002
        });
        console.log("[Demo Kernels] Created ParticleSystemSpectralKernels");
        break;
      }
      case 'quadrupole': {
        system = new ParticleSystemQuadrupoleKernels(gl, {
          particleData,
          worldBounds,
          theta: 0.7,
          gravityStrength,
          softening: 0.002,
          dt: 10 / 60,
          damping: 0.002,
          enableQuadrupoles: true
        });
        console.log("[Demo Kernels] Created ParticleSystemQuadrupoleKernels");
        break;
      }
      case 'monopole':
      default: {
        system = new ParticleSystemMonopoleKernels({
          gl,
          particleData,
          worldBounds,
          theta: 0.7,
          gravityStrength,
          softening: 0.002,
          dt: 10 / 60,
          damping: 0.002
        });
        console.log("[Demo Kernels] Created ParticleSystemMonopoleKernels");
        break;
      }
    }
  } catch (error) {
    console.error(`[Demo Kernels] Failed to create ${calculationMethod} system:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateStatus(`Error: ${errorMessage}`);
    throw error;
  }

  const textureSize = { width: system.textureWidth, height: system.textureHeight };
  const positionTexture =
    system instanceof ParticleSystemMonopoleKernels ?
      system.positionTexture :
      system.getPositionTexture();

  // Dispose previous color texture if any
  if (colorTexGlobal) {
    gl.deleteTexture(colorTexGlobal);
    colorTexGlobal = null;
  }
  // Create color texture from colors array
  const colorTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, colorTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, textureSize.width, textureSize.height, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, colors
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  // Store for animation use
  colorTexGlobal = colorTex;

  const meshInstance = massSpotMesh({
    textureMode: true,
    particleCount,
    textures: {
      // positionTexture is always defined here
      position: /** @type {WebGLTexture} */ (positionTexture),
      color: colorTex,
      size: [textureSize.width, textureHeight],
    },
    fog: { start: 0.3, gray: 50 },
    enableProfiling: false,
    gl,
  });

  scene.add(meshInstance.mesh);

  return { physics: system, m: meshInstance };
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
    (worldBounds.min[2] + worldBounds.max[2]) / 2,
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
    const radiusFactor = Math.pow(Math.random(), 1 / 7);
    const height = (Math.random() - 0.5) * heightRange;
    let mass = Math.random();
    mass = 1 - Math.pow(mass, 1 / 20);
    mass = 0.01 + mass * 10;

    spots[i] = {
      x: center[0] + Math.cos(angle) * radiusFactor * radiusX,
      y: center[1] + height,
      z: center[2] + Math.sin(angle) * radiusFactor * radiusZ,
      mass,
    };
  }

  return spots;
}
