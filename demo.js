// @ts-check

import * as THREE from "three";
import { createScene } from "three-pop";
import { massSpotMesh } from "./mass-spot-mesh.js";
import { particleSystemKernels, unloadKernelParticleData } from "./gravity/gravity.js";
import { GraphLaplacian } from "./graph/laplacian/graph-laplacian.js";
import { generateSocialGraph } from "./gravity/monolithic/utils/social-graph-generator.js";

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
const [countInput, graphForceCheckbox, monopoleRadio, quadrupoleRadio, spectralRadio, meshRadio] =
  ['count-input', 'graph-force-checkbox', 'monopole-radio', 'quadrupole-radio', 'spectral-radio', 'mesh-radio'].map(
    id => /** @type {HTMLInputElement} */ (document.getElementById(id)));
const statusDiv = /** @type {HTMLDivElement} */ (document.getElementById("kernel-status"));

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
/** @type {GraphLaplacian | null} */
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

/**
 * Create a simple kernel to apply forces to velocities
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createGraphVelocityKernel(gl, width, height) {
  const vertexShader = gl.createShader(gl.VERTEX_SHADER);
  if (!vertexShader) throw new Error('Failed to create vertex shader');
  gl.shaderSource(vertexShader, `#version 300 es
    in vec2 a_position;
    out vec2 v_texCoord;
    void main() {
      v_texCoord = a_position * 0.5 + 0.5;
      gl_Position = vec4(a_position, 0.0, 1.0);
    }
  `);
  gl.compileShader(vertexShader);
  
  const fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
  if (!fragmentShader) throw new Error('Failed to create fragment shader');
  gl.shaderSource(fragmentShader, `#version 300 es
    precision highp float;
    uniform sampler2D u_velocity;
    uniform sampler2D u_position;
    uniform sampler2D u_force;
    uniform float u_dt;
    uniform float u_damping;
    in vec2 v_texCoord;
    out vec4 outColor;
    
    void main() {
      vec4 vel = texture(u_velocity, v_texCoord);
      vec4 pos = texture(u_position, v_texCoord);
      vec4 force = texture(u_force, v_texCoord);
      
      float mass = pos.w;
      if (mass > 0.0) {
        // Apply force: v += (F / m) * dt
        vec3 accel = force.xyz / mass;
        vel.xyz += accel * u_dt;
        
        // Apply damping
        vel.xyz *= (1.0 - u_damping);
      }
      
      outColor = vel;
    }
  `);
  gl.compileShader(fragmentShader);
  
  const program = gl.createProgram();
  if (!program) throw new Error('Failed to create program');
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  
  const positionBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  
  const framebuffer = gl.createFramebuffer();
  
  return {
    apply({ inVelocity, inPosition, inForce, outVelocity, dt, damping }) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, outVelocity, 0);
      
      // Check framebuffer status
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        console.error('[GraphVelocityKernel] Framebuffer incomplete:', status);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return;
      }
      
      gl.viewport(0, 0, width, height);
      
      gl.useProgram(program);
      
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, inVelocity);
      gl.uniform1i(gl.getUniformLocation(program, 'u_velocity'), 0);
      
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, inPosition);
      gl.uniform1i(gl.getUniformLocation(program, 'u_position'), 1);
      
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, inForce);
      gl.uniform1i(gl.getUniformLocation(program, 'u_force'), 2);
      
      gl.uniform1f(gl.getUniformLocation(program, 'u_dt'), dt);
      gl.uniform1f(gl.getUniformLocation(program, 'u_damping'), damping);
      
      const posLoc = gl.getAttribLocation(program, 'a_position');
      gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
      gl.enableVertexAttribArray(posLoc);
      gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
      
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  };
}

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

  // Step 1: Apply gravity forces
  physics.step();
  
  // Step 2: Apply graph forces additively to velocities
  if (graphModule) {
    try {
      const physAny = /** @type {any} */ (physics);
      const gl = physics.gl;
      
      // Create force texture and framebuffer for graph forces if needed
      if (!physAny._graphForceTexture) {
        physAny._graphForceTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, physAny._graphForceTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, physics.textureWidth, physics.textureHeight, 0, gl.RGBA, gl.FLOAT, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindTexture(gl.TEXTURE_2D, null);
        
        physAny._graphForceFB = gl.createFramebuffer();
      }
      
      // Clear force texture to zero
      gl.bindFramebuffer(gl.FRAMEBUFFER, physAny._graphForceFB);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, physAny._graphForceTexture, 0);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      
      // Compute graph forces
      graphModule.accumulate({
        positionTexture: physAny.positionTexture,
        targetForceTexture: physAny._graphForceTexture,
        targetForceFramebuffer: physAny._graphForceFB,
        dt: physAny.options?.dt || 10/60
      });
      
      // Apply graph forces to velocities (F*dt/m added to velocity)
      // This requires a simple shader that reads force texture and updates velocity texture
      if (!physAny._graphVelocityKernel) {
        // Create a simple kernel to apply forces to velocities
        physAny._graphVelocityKernel = createGraphVelocityKernel(gl, physics.textureWidth, physics.textureHeight);
      }
      
      physAny._graphVelocityKernel.apply({
        inVelocity: physAny.velocityTexture,
        inPosition: physAny.positionTexture,
        inForce: physAny._graphForceTexture,
        outVelocity: physAny.velocityTextureWrite,
        dt: physAny.options?.dt || 10/60,
        damping: physAny.options?.damping || 0.002
      });
      
      // Swap velocity textures
      const tmp = physAny.velocityTexture;
      physAny.velocityTexture = physAny.velocityTextureWrite;
      physAny.velocityTextureWrite = tmp;
      
    } catch (err) {
      console.warn('[Demo Kernels] Graph forces error:', err);
    }
  }
  
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
      const snap = unloadKernelParticleData({ system: physics });
      if (snap) {
        previousParticleSnapshot = {
          positions: snap.positions,
          velocities: snap.velocities,
          masses: snap.masses,
          logicalCount: physics.options?.particleCount || physics.textureWidth * physics.textureHeight,
          textureWidth: physics.textureWidth,
          textureHeight: physics.textureHeight
        };
      }
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
    const targetAvgDegree = 8;
    const numClusters = Math.max(10, Math.ceil(Math.sqrt(particleCount) / 10));
    const avgClusterSize = particleCount / numClusters;
    const targetEdgesPerCluster = targetAvgDegree * avgClusterSize * 0.9;
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
    
    // Reassign particle masses based on edge connectivity (degree)
    const degreeCount = new Float32Array(particleCount);
    for (const edge of edges) {
      degreeCount[edge.from]++;
      degreeCount[edge.to]++;
    }
    
    // Find min/max degree for normalization
    let minDegree = Infinity;
    let maxDegree = -Infinity;
    for (let i = 0; i < particleCount; i++) {
      if (degreeCount[i] < minDegree) minDegree = degreeCount[i];
      if (degreeCount[i] > maxDegree) maxDegree = degreeCount[i];
    }
    
    // Assign masses: higher degree = higher mass (range: 0.1 to 10.0)
    const massMin = 0.1;
    const massMax = 10.0;
    for (let i = 0; i < particleCount; i++) {
      const normalizedDegree = maxDegree > minDegree 
        ? (degreeCount[i] - minDegree) / (maxDegree - minDegree)
        : 0.5;
      particles[i].mass = massMin + normalizedDegree * (massMax - massMin);
    }
    
    console.log(
      `[Demo Kernels] Reassigned masses: min=${minDegree} edges (mass=${massMin}), max=${maxDegree} edges (mass=${massMax})`
    );
    
    // Use NEGATIVE gravity for repulsion when using graph forces
    gravityStrength = -gravityStrength * 0.02; // Negative = repulsion
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
      softening: 0.006,
      dt: 10 / 60,
      damping: 0.006,
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
    
    laplacianModule = new GraphLaplacian({
      gl,
      edges,
      particleCount,
      textureWidth: textureSize.width || system.textureWidth,
      textureHeight: textureSize.height || system.textureHeight,
      k: 1,  // Spring constant (3x stronger)
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

    // Small randomized initial velocities with a slight clockwise bias
    // around the world center (y-axis). We compute a tangential direction
    // from the particle's angle and add a little random jitter so motion
    // isn't perfectly uniform.
    const velScale = -0.02; // base velocity magnitude
    const tangentialStrength = 0.5 * Math.random(); // fraction of velScale used for circular bias
    const jitterScale = 0.25; // fraction of velScale used for random jitter

    // Tangential direction (clockwise): angle - PI/2
    const tangentialAngle = angle - Math.PI / 2;
    const tx = Math.cos(tangentialAngle) * velScale * radiusFactor * tangentialStrength;
    const tz = Math.sin(tangentialAngle) * velScale * radiusFactor * tangentialStrength;

    const vx = tx + (Math.random() - 0.5) * velScale * jitterScale;
    const vy = (Math.random() - 0.5) * velScale * 0.5; // keep vertical small
    const vz = tz + (Math.random() - 0.5) * velScale * jitterScale;

    spots[i] = {
      x: center[0] + Math.cos(angle) * radiusFactor * radiusX,
      y: center[1] + height,
      z: center[2] + Math.sin(angle) * radiusFactor * radiusZ,
      mass,
      vx,
      vy,
      vz,
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



