# Refactoring alternatives

## Plan A — Replace the current “voxel pyramid” with a **Linear Octree (LBVH) in Morton order**

**What you have now (baseline):**
You’re building a *uniform* 64³ L0 grid, then reducing it to coarser levels (32³ → … → 1³). Aggregation happens by writing mass‑weighted positions and mass into L0 via `aggregation.vert.js` and summing 8 children per parent in `reduction.frag.js`. Forces are computed by scanning fixed neighborhoods across levels in `traversal.frag.js`. The whole pipeline is orchestrated in `ParticleSystem.buildQuadtree()` and then `pipelineCalculateForces`/integration steps.    

**Goal of this plan:**
Keep BH physics, but **swap the data structure**: instead of a fixed voxel pyramid, build a **linear octree** from **Morton (Z‑order)‑sorted particles**. This is the classic LBVH/L‑octree approach and is far more traversal‑friendly on GPU.

**High‑level pipeline (new/changed passes):**

1. **Encode Morton keys** (new):

   * Quantize positions to L bits per axis and **bit‑interleave** to 30–60‑bit keys (packed in RG32UI if needed).
   * GPU pass `encode_morton.frag` reads particle positions from your positions texture (same layout you already use for rendering and integration). Reuse your texture addressing utilities and world bounds from `ParticleSystem` to normalize to the grid. 

2. **Radix sort by key** (new):

   * Implement an LSD radix sort using ping‑pong FBOs and scans/histograms per digit (4–8 bits per pass).
   * Outputs: a sorted **index buffer texture** and optionally **positions/velocities** reordered into Morton order (reorder once per frame or every K frames).

3. **Linear octree build from sorted keys** (new):

   * Use **longest‑common‑prefix (LCP)** between adjacent keys to define internal nodes, their ranges, and children.
   * Store nodes in flat textures: `node[i] = {start, count, left, right, levelOrPrefixLen, mass, COM, (optional) quadrupole}`.

4. **Refit multipoles** (new):

   * Bottom‑up pass to compute **mass/COM** and optional **quadrupole** from children. This substitutes your current reduction pyramid; you no longer need `reduction.frag.js` for tree data. 

5. **Stackless traversal for forces** (replace):

   * Replace `traversal.frag.js`’s fixed‑neighborhood logic with a **stackless** LBVH traversal over node arrays (parent/next pointers or restart‑trail).
   * Evaluate targets **in Morton order** to maximize texture coherence and stable accumulation (reduces “murmurations” amplitude). 

6. **Integration** (reuse):

   * Keep your velocity and position integration passes as‑is (`vel_integrate.frag.js`, `pos_integrate.frag.js`). Consider switching to KDK leapfrog ordering later; the wiring is already split velocity→position.  

**What stays vs. goes:**

* **Keep:** particle textures, integration passes, rendering.
* **Replace:** `buildQuadtree()`’s aggregation + pyramid with **encode→sort→build→refit** passes; replace `traversal.frag.js` sampling logic with **LBVH traversal**.  

**Why this can help both perf & stability:**

* Traversal is **coherent** (Morton order) and **adaptive** (hierarchy), not a fixed 26/125‑stencil scan.
* Summation order becomes more stable frame‑to‑frame, softening the emergent “flock” artifacts (you’ll still want symplectic integration and a tighter MAC for best behavior).
* It sets you up to add **quadrupoles** + better **MAC** soon after, for higher θ at similar error.

**Risk/complexity:**

* Highest engineering effort (radix sort + LCP build + traversal rewrite), but it future‑proofs the solver.

---

## Plan B — Switch far‑field to **PM/FFT** and keep only near‑field local interactions (TreePM)

**Goal of this plan:**
Replace the expensive long‑range BH with a **Particle‑Mesh** (PM) solver via FFT on a uniform 3D grid. Keep a small **short‑range** correction (local cells only). This gives the biggest scalability bump and also **damps discreteness noise** that seeds “murmurations.”

**High‑level pipeline:**

1. **Mass deposition to a 3D grid** (modify/reuse):

   * Reuse your L0 “sliced 3D grid” layout: you already map (x,y,z) to a **64³ grid packed into a 2D texture** via `slicesPerRow`.
   * Add a **mass‑only deposition pass** (NGP to start; CIC/TSC later). You can base it on `aggregation.vert.js`, but write **mass** to L0 (and skip pos·mass), using additive blending you already gate on (`EXT_float_blend`).  

2. **3D FFT (Stockham) on the sliced volume** (new):

   * Implement three 1D FFT passes (X, then Y, then Z‑through‑slices). Store complex spectra in RG32F (real/imag).
   * You do **not** need the pyramid reduction for PM; one grid is enough. (Keep it around as a fallback.)

3. **Poisson solve in k‑space** (new):

   * Multiply by **Green’s function** ( \hat\phi(\mathbf{k}) = -4\pi G \hat\rho(\mathbf{k}) / (|\mathbf{k}|^2 + k_\text{soft}^2) ) (set DC to 0).
   * If using CIC/TSC, optionally **deconvolve** the assignment window to un‑bias the spectrum.

4. **Acceleration field** (new):

   * Either (a) compute **(\hat{\mathbf{g}}(\mathbf{k}) = i\mathbf{k}\hat\phi(\mathbf{k}))** and inverse‑FFT 3 vector fields to real space, or (b) inverse‑FFT φ and do a 3D finite‑difference gradient in real space. (a) is cleaner spectrally.

5. **Sample PM force at particles** (new):

   * A fragment pass reads positions, performs **trilinear interpolation** from the (sliced) 3D acceleration textures, and writes the **far‑field force** texture.

6. **Short‑range correction** (reuse/modify):

   * For near‑field (within a few cells), either:

     * Keep a **tiny BH** (L0 only + a couple of coarse levels), or
     * Do **local direct sums** over a few neighbor cells using your existing L0 addressing helpers.
   * You already have the logic and world‑to‑grid mapping in `traversal.frag.js`; you’d pare it down to a **small fixed neighborhood** pass. 

7. **Integration & render** (reuse):

   * Same as now: `vel_integrate.frag.js`, `pos_integrate.frag.js`, then draw.  

**What stays vs. goes:**

* **Keep:** world bounds & 3D slicing scheme (already robust in your aggregator and traversal), integration, rendering.
* **Replace:** the full BH traversal for the far‑field with FFT passes + a simple near‑field pass.

**Why this can help both perf & stability:**

* Far‑field becomes **O(G log G)** and very smooth; reduces anisotropic BH errors that nudge the COM.
* Near‑field is cheap and local; you can cap work deterministically per particle.

**Risk/complexity:**

* Medium‑high (FFT plumbing + spectral math), but you avoid the complexity of LBVH builds and get a large upside in scalability.

---

## Plan C — Keep the current pyramid, but add **Quadrupoles + improved MAC** (FMM‑lite), and make the integrator explicitly **symplectic**

**Goal of this plan:**
Minimal disruption: **keep your current files and level layout**, but significantly improve **accuracy per node** and **opening decisions** so you can raise θ without artifacts. This directly targets the “murmurations” while giving a modest perf win.

**High‑level changes:**

1. **Augment node data to include 2nd moments (for quadrupoles)** (modify):

   * Today L0 stores **∑(pos·mass) and ∑mass** per voxel (RGB=∑m·x,y,z, A=∑m); parents sum children in `reduction.frag.js`.  
   * Add **another MRT attachment** that accumulates raw second moments needed for a quadrupole: ∑m·x², ∑m·y², ∑m·z², and ∑m·xy/xz/yz (you can pack the six unique components across two RGBA targets).
   * Your `ParticleSystem.checkWebGL2Support()` already probes `EXT_color_buffer_float` and `EXT_float_blend`; use that to enable float additive blending to multiple attachments (fallback: do two passes if float blend is missing). 

2. **Reduce second‑moment attachments through the pyramid** (modify):

   * Mirror the child‑sum logic in `reduction.frag.js` for the added attachments so every level carries mass, COM numerators, and second moments. 

3. **Upgrade the opening criterion (MAC) and force model** (replace small part of traversal):

   * In `traversal.frag.js`, replace ( s/d < \theta ) with **( d > s/\theta + \delta )** where **(\delta)** is the **COM offset** from the voxel center—compute voxel center from (level, voxel index) and subtract COM.
   * When accepted, use **quadrupole** (monopole + Q) for the force instead of pure COM; this **reduces anisotropy** in far‑field error and lets you run **larger θ** at the same quality. 

4. **Symplectic integration (KDK) + optional COM clamp** (small change):

   * Keep your `vel_integrate.frag.js` and `pos_integrate.frag.js`, but order them **Kick‑Drift‑(optionally Kick)** to make the scheme **time‑reversible**. This sharply limits energy drift that fuels flock‑like motion.
   * Optional: after force accumulation, subtract the **mean force or COM velocity** as a momentum clamp (debug toggle) to remove visible COM drift while you validate the quadrupole/MAC changes.  

5. **Tuning:**

   * Retune `softening` and `theta`—with Q and the improved MAC you can **increase θ** and reduce visits while *reducing* the “murmuration.”

**What stays vs. goes:**

* **Keep:** all your textures, passes, and level structure; the pyramid remains intact.
* **Change:** add MRT attachments in aggregation; extend `reduction.frag.js`; update the acceptance test and node evaluation math inside `traversal.frag.js`; small integrator ordering tweak.   

**Why this can help both perf & stability:**

* Quadrupoles + better MAC reduce **directional bias** and let you prune more aggressively at the same error.
* Symplectic timestepping curbs long‑term energy drift—the other big driver of “murmurations.”

**Risk/complexity:**

* Lowest code churn; mostly shader math and a few extra attachments/passes.

---

### Picking among the three

* **You want maximum scalability and smoother far‑field right now:** pick **Plan B (PM/FFT)**, then keep a tiny near‑field correction.
* **You want a long‑term, GPU‑native tree you can keep improving:** pick **Plan A (LBVH with Morton)**.
* **You want behavioral fixes and a moderate perf win with minimal disruption:** pick **Plan C (Quadrupole + MAC + symplectic)**.

If you tell me which direction you favor, I can draft the **pass graph and texture layouts** (names, formats, and attachment counts) and outline *exact* edits to the specific files (e.g., how to extend `aggregation.vert.js` to MRT, what structs to add to the LBVH node textures, and how to gate the two traversal paths in `ParticleSystem`).    
