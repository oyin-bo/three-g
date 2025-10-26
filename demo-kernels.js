// @ts-check

import * as THREE from "three";
import { createScene } from "three-pop";
import { massSpotMesh } from "./mass-spot-mesh.js";
import { particleSystemKernels } from "./particle-system/particle-system-kernels.js";
import { LaplacianForceModuleKernels } from "./particle-system/graph-laplacian-kernels/laplacian-force-module-kernels.js";
import { generateSocialGraph } from "./particle-system/utils/social-graph-generator.js";

const COLOR1 = new THREE.Color().setHSL(0.0, 1.0, 0.6);
const COLOR2 = new THREE.Color().setHSL(0.33, 1.0, 0.6);
const COLOR3 = new THREE.Color().setHSL(0.66, 1.0, 0.6);
const SCRATCH_COLOR = new THREE.Color();

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
const graphForceCheckbox = /** @type {HTMLInputElement} */ (
  document.getElementById("graph-force-checkbox")
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
let graphForcesEnabled = false;

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

/**
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{ min: [number, number, number], max: [number, number, number] }} worldBounds
 */
function encodeRGBFromBounds(x, y, z, worldBounds) {
  const nx = (x - worldBounds.min[0]) / (worldBounds.max[0] - worldBounds.min[0]);
  const ny = (y - worldBounds.min[1]) / (worldBounds.max[1] - worldBounds.min[1]);
  const nz = (z - worldBounds.min[2]) / (worldBounds.max[2] - worldBounds.min[2]);

  SCRATCH_COLOR.r = COLOR1.r * nx + COLOR2.r * ny + COLOR3.r * nz;
  SCRATCH_COLOR.g = COLOR1.g * nx + COLOR2.g * ny + COLOR3.g * nz;
  SCRATCH_COLOR.b = COLOR1.b * nx + COLOR2.b * ny + COLOR3.b * nz;

  const norm = 1 / (nx + ny + nz || 1);
  SCRATCH_COLOR.multiplyScalar(norm);

  const r = Math.max(0, Math.min(255, Math.floor(SCRATCH_COLOR.r * 255)));
  const g = Math.max(0, Math.min(255, Math.floor(SCRATCH_COLOR.g * 255)));
  const b = Math.max(0, Math.min(255, Math.floor(SCRATCH_COLOR.b * 255)));

  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

/** @type {ReturnType<typeof particleSystemKernels> | null} */
let physics = null;
/** @type {ReturnType<typeof massSpotMesh> | null} */
let m = null;
/** @type {LaplacianForceModuleKernels | null} */
let graphModule = null;
let positionTextureWrapper = /** @type {THREE.ExternalTexture | null} */ (null);
let isInitialized = false;
// Global color texture loaded from colors array
/** @type {WebGLTexture | null} */
let colorTexGlobal = null;
// Snapshot of previous GPU-resident particle state (readback)
/** @type {{positions:Float32Array, velocities:Float32Array, masses:Float32Array, logicalCount:number, textureWidth:number, textureHeight:number}|null} */
let previousParticleSnapshot = null;
// Preserve the very first color bytes produced so colours remain identical
// across subsequent recreates. This is the source-of-truth for colours.
/** @type {Uint8Array|null} */
let originalColorBuffer = null;
let originalColorWidth = 0;
let originalColorHeight = 0;

// 4. Animation loop - MUST be set BEFORE recreateAll()
outcome.animate = () => {
  if (!physics || !m) {
    return;
  }

  if (!isInitialized) {
    const positionTexture = physics.positionTexture;
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
    //console.log("[Demo Kernels] Method toggled via DevTools:", method);
    recreateAll();
  } else {
    console.error(
      '[Demo Kernels] Invalid method. Use "monopole", "quadrupole", "spectral", or "mesh"'
    );
  }
};

// console.log("[Demo Kernels] DevTools helpers available:");
// console.log(
//   '  window.setMethod("monopole"|"quadrupole"|"spectral"|"mesh") - Switch calculation method'
// );
// console.log("  window.physics - Access kernel-based particle system");
// console.log("  window.m - Access mass spot mesh");

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

// 8. Graph forces checkbox handler
graphForceCheckbox.onchange = () => {
  graphForcesEnabled = graphForceCheckbox.checked;
  console.log(
    "[Demo Kernels] Graph forces:",
    graphForcesEnabled ? "ENABLED" : "DISABLED"
  );
  recreateAll();
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

  // Capture the running system's GPU-resident particle state (positions, velocities, masses)
  // so the next kernel system can 'take over' the same particles. This reads the
  // active position/velocity textures directly (no external helpers).
  if (physics) {
    try {
      const snap = captureParticleState(physics);
      if (snap) previousParticleSnapshot = snap;
    } catch (err) {
      console.warn('[Demo Kernels] Failed to capture particle state:', err);
    }
  }

  if (physics) physics.dispose();
  if (m && m.mesh) scene.remove(m.mesh);
  if (graphModule) graphModule.dispose();

  isInitialized = false;
  frameCount = 0;
  positionTextureWrapper = null;
  graphModule = null;

  updateStatus("Creating particle system...");

  const result = recreatePhysicsAndMesh();
  physics = result.physics;
  m = result.m;
  graphModule = result.graphModule;

  /** @type {any} */ (window).m = m;
  /** @type {any} */ (window).physics = physics;
  /** @type {any} */ (window).graphModule = graphModule;
  
  updateStatus("Initializing...");
}

function recreatePhysicsAndMesh() {
  // Generate default particles then overlay preserved state from a previous
  // system snapshot (if available). This ensures overlapping indices keep
  // their positions, masses and velocities.
  const generated = createParticles(particleCount, worldBounds);
  let particles = generated;

  if (previousParticleSnapshot) {
    const snap = previousParticleSnapshot;
    const overlap = Math.min(snap.logicalCount || 0, particleCount);
    // Create a copy so we don't mutate the generated array reference
    particles = generated.slice();

    for (let i = 0; i < overlap; i++) {
      const pidx = i * 3;
      particles[i] = {
        x: snap.positions[pidx + 0],
        y: snap.positions[pidx + 1],
        z: snap.positions[pidx + 2],
        mass: snap.masses[i],
        vx: snap.velocities[pidx + 0],
        vy: snap.velocities[pidx + 1],
        vz: snap.velocities[pidx + 2]
      };
    }

    // Clear snapshot after applying it once
    previousParticleSnapshot = null;
  }

  let gravityStrength = Math.random();
  gravityStrength = gravityStrength * 0.0001;
  gravityStrength = gravityStrength * gravityStrength;
  gravityStrength += 0.0000005;

  // Generate graph edges if graph forces enabled
  let edges = null;
  let laplacianModule = null;
  
  if (graphForcesEnabled) {
    console.log(`[Demo Kernels] Generating social graph for ${particleCount} nodes...`);
    
    // Target avg degree: 6 edges/node
    const targetAvgDegree = 6;
    const numClusters = Math.max(10, Math.ceil(Math.sqrt(particleCount) / 10));
    const avgClusterSize = particleCount / numClusters;
    const targetEdgesPerCluster = targetAvgDegree * avgClusterSize * 0.8;
    const possiblePairsPerCluster = (avgClusterSize * (avgClusterSize - 1)) / 2;
    const intraClusterProb = targetEdgesPerCluster / possiblePairsPerCluster;
    
    edges = generateSocialGraph(particleCount, {
      avgDegree: targetAvgDegree,
      powerLawExponent: 2.3,
      numClusters: numClusters,
      intraClusterProb: intraClusterProb,
      interClusterProb: 0.002,
      strengthMin: 0.001,
      strengthMax: 0.005,
    });
    
    console.log(
      `[Demo Kernels] Generated ${edges.length} edges (avg degree: ${(
        (2 * edges.length) / particleCount
      ).toFixed(2)})`
    );
    
    // Use NEGATIVE gravity for repulsion when using graph forces
    gravityStrength = -gravityStrength * 0.005; // Negative = repulsion
    console.log(
      `[Demo Kernels] Using negative gravity (repulsion): ${gravityStrength.toExponential(2)}`
    );
  }

  let system;

  try {
    const kernelOptions = /** @type {Parameters<typeof particleSystemKernels>[0]} */ ({
      gl,
      particles,
      method: /** @type {'monopole' | 'quadrupole' | 'spectral' | 'mesh'} */ (calculationMethod),
      gravityStrength,
      softening: 0.002,
      dt: 10 / 60,
      damping: 0.002,
      worldBounds,
      get: /** @type {NonNullable<Parameters<typeof particleSystemKernels>[0]['get']>} */ ((spot, out) => {
        const sx = spot?.x ?? 0;
        const sy = spot?.y ?? 0;
        const sz = spot?.z ?? 0;
        out.rgb = encodeRGBFromBounds(sx, sy, sz, worldBounds);
      })
    });

    if (calculationMethod === 'mesh') {
      kernelOptions.mesh = {
        assignment: 'cic',
        gridSize: 64,
        slicesPerRow: 8,
        nearFieldRadius: 2
      };
    } else {
      kernelOptions.theta = 0.7;
    }

    system = particleSystemKernels(kernelOptions);
    console.log(`[Demo Kernels] Created kernel system: ${calculationMethod}`);
    // Record logical particle count provided to the kernel creator so we can
    // match it during future readbacks/unloads.
    try {
      system['__logicalParticleCount'] = particles.length;
    } catch (e) {
      // ignore
    }
  } catch (error) {
    console.error(`[Demo Kernels] Failed to create ${calculationMethod} system:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    updateStatus(`Error: ${errorMessage}`);
    throw error;
  }

  const textureSize = { width: system.textureWidth, height: system.textureHeight };
  const positionTexture = system.positionTexture;

  const colorTexture = buildColorTexture(gl, particles, textureSize, worldBounds);
  colorTexGlobal = colorTexture;

  const meshInstance = massSpotMesh({
    textureMode: true,
    particleCount,
    textures: {
      // positionTexture is always defined here
      position: /** @type {WebGLTexture} */ (positionTexture),
      color: colorTexture,
      size: [textureSize.width, textureSize.height],
    },
    fog: { start: 0.3, gray: 50 },
    enableProfiling: false,
    gl,
  });

  scene.add(meshInstance.mesh);

  // Create LaplacianForceModuleKernels if graph forces are enabled
  if (graphForcesEnabled && edges) {
    const textureSize = system.getTextureSize ? system.getTextureSize() : { width: system.textureWidth, height: system.textureHeight };
    const hasFloatBlend = !!gl.getExtension('EXT_float_blend');
    
    laplacianModule = new LaplacianForceModuleKernels({
      gl,
      edges,
      particleCount,
      textureWidth: textureSize.width || system.textureWidth,
      textureHeight: textureSize.height || system.textureHeight,
      k: 0.3,  // Spring constant (3x stronger)
      shardSize: 64,
      normalized: false,
      disableFloatBlend: !hasFloatBlend
    });
  }

  return { physics: system, m: meshInstance, graphModule: laplacianModule };
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

  const radiusX = (worldBounds.max[0] - worldBounds.min[0]) / 2;
  const radiusZ = (worldBounds.max[2] - worldBounds.min[2]) / 2;
  const heightRange = worldBounds.max[1] - worldBounds.min[1];

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
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

/**
 * @param {WebGL2RenderingContext} gl
 * @param {ReadonlyArray<{ x?: number, y?: number, z?: number }>} particles
 * @param {{ width: number, height: number }} textureSize
 * @param {{ min: [number, number, number], max: [number, number, number] }} worldBounds
 */
function buildColorTexture(gl, particles, textureSize, worldBounds) {
  if (colorTexGlobal) {
    gl.deleteTexture(colorTexGlobal);
    colorTexGlobal = null;
  }
  const totalTexels = textureSize.width * textureSize.height;
  const colors = new Uint8Array(totalTexels * 4);

  // Prefer the original color buffer (first-created) to avoid recomputing
  // colours which can drift over repeated recreates. If original buffer
  // exists, copy its overlapping bytes and compute any remaining texels.
  if (originalColorBuffer && originalColorWidth === textureSize.width && originalColorHeight === textureSize.height) {
    colors.set(originalColorBuffer.subarray(0, Math.min(originalColorBuffer.length, colors.length)));
  } else if (originalColorBuffer) {
    // Different texture size: copy overlapping byte range
    colors.set(originalColorBuffer.subarray(0, Math.min(originalColorBuffer.length, colors.length)));
    for (let i = Math.floor(Math.min(originalColorBuffer.length, colors.length) / 4); i < totalTexels; i++) {
      const base = i * 4;
      const rgb = i < particles.length
        ? encodeRGBFromBounds(particles[i].x || 0, particles[i].y || 0, particles[i].z || 0, worldBounds)
        : 0;
      colors[base + 0] = (rgb >> 16) & 0xff;
      colors[base + 1] = (rgb >> 8) & 0xff;
      colors[base + 2] = rgb & 0xff;
      colors[base + 3] = 255;
    }
  } else {
    for (let i = 0; i < totalTexels; i++) {
      const base = i * 4;
      const rgb = i < particles.length
        ? encodeRGBFromBounds(particles[i].x || 0, particles[i].y || 0, particles[i].z || 0, worldBounds)
        : 0;
      colors[base + 0] = (rgb >> 16) & 0xff;
      colors[base + 1] = (rgb >> 8) & 0xff;
      colors[base + 2] = rgb & 0xff;
      colors[base + 3] = 255;
    }
  }

  // Record the original color buffer on first creation so future recreates
  // reuse the exact bytes (avoid recomputation).
  if (!originalColorBuffer) {
    originalColorBuffer = colors.slice();
    originalColorWidth = textureSize.width;
    originalColorHeight = textureSize.height;
  }

  const texture = gl.createTexture();
  if (!texture) {
    throw new Error('Failed to create color texture');
  }

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA, textureSize.width, textureSize.height, 0,
    gl.RGBA, gl.UNSIGNED_BYTE, colors
  );
  gl.bindTexture(gl.TEXTURE_2D, null);

  return texture;
}

// Read back GPU particle textures (position, velocity) directly into CPU arrays.
// Returns arrays sized to the previous logical particle count when available.
/** @param {any} system */
function captureParticleState(system) {
  if (!system || !system.gl) return null;
  const glCtx = system.gl;

  const texW = system.textureWidth || (system.getTextureSize && system.getTextureSize().width) || 0;
  const texH = system.textureHeight || (system.getTextureSize && system.getTextureSize().height) || 0;
  if (!texW || !texH) return null;

  const totalTexels = texW * texH;
  const posBuf = new Float32Array(totalTexels * 4);
  const velBuf = new Float32Array(totalTexels * 4);

  const prevFB = glCtx.getParameter(glCtx.FRAMEBUFFER_BINDING);
  const fb = glCtx.createFramebuffer();
  if (!fb) throw new Error('Failed to allocate framebuffer for particle readback');

  try {
    glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, fb);

    // Read positions
    glCtx.framebufferTexture2D(glCtx.FRAMEBUFFER, glCtx.COLOR_ATTACHMENT0, glCtx.TEXTURE_2D, system.positionTexture, 0);
    glCtx.readPixels(0, 0, texW, texH, glCtx.RGBA, glCtx.FLOAT, posBuf);

    // Read velocities
    glCtx.framebufferTexture2D(glCtx.FRAMEBUFFER, glCtx.COLOR_ATTACHMENT0, glCtx.TEXTURE_2D, system.velocityTexture, 0);
    glCtx.readPixels(0, 0, texW, texH, glCtx.RGBA, glCtx.FLOAT, velBuf);
  } finally {
    glCtx.bindFramebuffer(glCtx.FRAMEBUFFER, prevFB);
    glCtx.deleteFramebuffer(fb);
  }

  if (!system.positionTexture || !system.velocityTexture) return null;

  const logicalCount = system['__logicalParticleCount'] || (system.options && system.options.particleCount) || totalTexels;

  const positions = new Float32Array(logicalCount * 3);
  const velocities = new Float32Array(logicalCount * 3);
  const masses = new Float32Array(logicalCount);

  for (let i = 0; i < logicalCount; i++) {
    const s = i * 4;
    const d = i * 3;
    positions[d + 0] = posBuf[s + 0];
    positions[d + 1] = posBuf[s + 1];
    positions[d + 2] = posBuf[s + 2];
    masses[i] = posBuf[s + 3];

    velocities[d + 0] = velBuf[s + 0];
    velocities[d + 1] = velBuf[s + 1];
    velocities[d + 2] = velBuf[s + 2];
  }

  return { positions, velocities, masses, logicalCount, textureWidth: texW, textureHeight: texH };
}

/**
 * Read back a color texture (RGBA8) into a Uint8Array.
 * @param {WebGL2RenderingContext} glctx
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array|null}
 */
function captureColorTexture(glctx, texture, width, height) {
  if (!glctx || !texture || !width || !height) return null;
  const total = width * height;
  const buf = new Uint8Array(total * 4);

  const prevFB = glctx.getParameter(glctx.FRAMEBUFFER_BINDING);
  const fb = glctx.createFramebuffer();
  if (!fb) throw new Error('Failed to allocate framebuffer for color readback');

  try {
    glctx.bindFramebuffer(glctx.FRAMEBUFFER, fb);
    glctx.framebufferTexture2D(glctx.FRAMEBUFFER, glctx.COLOR_ATTACHMENT0, glctx.TEXTURE_2D, texture, 0);
    glctx.readPixels(0, 0, width, height, glctx.RGBA, glctx.UNSIGNED_BYTE, buf);
  } finally {
    glctx.bindFramebuffer(glctx.FRAMEBUFFER, prevFB);
    glctx.deleteFramebuffer(fb);
  }

  return buf;
}
