# Force graphs

Below is a compact “field guide” to **adding massive, per‑edge forces** on top of your Barnes–Hut gravity in a way that stays GPU‑native and browser‑friendly. I’ve organized it from first principles to concrete execution plans, with specific designs that work in **WebGL2** (your current stack) and an optional path for **WebGPU** later.

---

## 0) The mental model: per‑edge forces ≈ (SDDMM ⊕ SpMV)

Most per‑edge force updates boil down to two ingredients:

- **SDDMM** (sampled dense–dense op): compute an edge‑wise scalar or vector from the two endpoint states, e.g.
  ( s\_{ij} = f(\mathbf{x}\_i,\mathbf{x}\_j)) (spring stiffness, distance kernel, etc.).
- **SpMV / g‑SpMM**: aggregate those edge messages back to nodes, e.g.
  ( \mathbf{F}_i = \sum_{j\in \mathcal{N}(i)} s\_{ij}\cdot g(\mathbf{x}\_i,\mathbf{x}\_j)).

State‑of‑the‑art GPU graph systems (Gunrock, GraphBLAST, DGL, cuGraph) formalize message passing this way and squeeze performance out of the **aggregation** step via sparse linear‑algebra primitives and careful load balancing. That framing is directly usable for physics‑style forces. ([arXiv][1])

---

## 1) Four execution strategies that work **today** in WebGL2

You’re already GPU‑ping‑ponging float textures for gravity. We’ll reuse that architecture. The key decision is **gather vs. scatter** and how to deal with **write conflicts** when many edges contribute to the same node.

### A) **Edge‑parallel “scatter” with additive blending** (atomic‑free)

**When to use:** you want a single pass over **E** edges and can enable float blending.

- **How it works:** Draw **2 points per edge** (to source and destination node “pixels” in an **acceleration FBO**) and enable **additive blending** so each fragment adds its force contribution to the proper node. This emulates atomicAdd for floats in WebGL2.
- **Data:** An **edge texture** `RG32F` with `(srcIdx, dstIdx)` plus an optional `RG32F` for `(weight, restLen)` etc. Positions come from your existing `position` texture.
- **Requirements:** `EXT_color_buffer_float` for rendering into FP textures, plus `EXT_float_blend` for blending FP. Both are widely available on WebGL2. ([MDN Web Docs][2])
- **Pros:** One pass, very simple; great for millions of edges on desktop GPUs (Cosmos / cosmograph does large layouts like this fully on GPU). ([GitHub][3])
- **Cons:** ROP/blend bandwidth can bottleneck on extremely high‑degree hubs; you rely on extensions; numeric sum order is non‑deterministic but acceptable for addition.

**Sketch (single instanced draw; 2 instances per edge):**

```glsl
// VS (WebGL2)
#version 300 es
precision highp float; precision highp int;
uniform sampler2D uEdges;      // RG32F: (src, dst)
uniform sampler2D uPosTex;     // RGBA32F: xyz...
uniform ivec2 uEdgeTexSize, uNodeTexSize;
uniform float uK, uRest;       // spring params, or pack per-edge

out vec3 vForce;

vec2 uvForIndex(int idx, ivec2 size) { // texelFetch space
  int x = idx % size.x; int y = idx / size.x; return vec2(x, y);
}
vec4 fetchTexel(sampler2D t, ivec2 size, int idx) {
  return texelFetch(t, ivec2(uvForIndex(idx, size)), 0);
}
vec2 nodePixel(int nodeIdx, ivec2 size) { // integer pixel coords
  return vec2(nodeIdx % size.x, nodeIdx / size.x);
}
vec2 pixelToClip(vec2 pxy, ivec2 size) { // place a 1x1 point on that pixel
  vec2 norm = (pxy + vec2(0.5)) / vec2(size);
  return norm * 2.0 - 1.0;
}

void main() {
  int edgeId = gl_InstanceID / 2;
  bool toSrc = (gl_InstanceID & 1) == 0;

  ivec2 euv = ivec2(uvForIndex(edgeId, uEdgeTexSize));
  vec2 e = texelFetch(uEdges, euv, 0).xy;
  int src = int(e.x + 0.5), dst = int(e.y + 0.5);

  vec3 ps = texelFetch(uPosTex, ivec2(nodePixel(src, uNodeTexSize)), 0).xyz;
  vec3 pd = texelFetch(uPosTex, ivec2(nodePixel(dst, uNodeTexSize)), 0).xyz;

  vec3 d  = pd - ps;
  float r = max(length(d), 1e-6);
  // Example: Hooke-like edge attraction toward rest length
  vec3 f  = uK * (r - uRest) * (d / r);

  int target = toSrc ? src : dst;
  vec2 pix   = nodePixel(target, uNodeTexSize);
  gl_Position = vec4(pixelToClip(pix, uNodeTexSize), 0.0, 1.0);
  gl_PointSize = 1.0;
  vForce = toSrc ? f : -f;  // equal & opposite
}
```

```glsl
// FS
#version 300 es
precision highp float;
in vec3 vForce;
layout(location=0) out vec4 outAcc;
void main(){ outAcc = vec4(vForce, 0.0); } // additive blend
```

In JS:

```js
gl.enable(gl.BLEND);
gl.blendFunc(gl.ONE, gl.ONE); // additive
// drawArraysInstanced(POINTS, 0, 1, edges * 2)
```

---

### B) **Vertex‑parallel “gather” over CSR** (also atomic‑free)

**When to use:** float blending not available, or you want deterministic per‑node writes.

- **How it works:** Store adjacency in **CSR** textures: `rowPtr` (N+1) and `colIdx` (E). Render **one fragment per node** that loops over that node’s neighbor subarray and accumulates forces into a local register, then writes **exactly one** texel (no conflicts).
- **Challenge in WebGL2:** Variable loop lengths. Solve by **sharding** high‑degree nodes: generate a “work list” of fixed‑size shards (e.g., 64 neighbors) so your shader loops with a fixed bound. If a node has 3000 neighbors, it becomes 47 shards; their partial sums are then **reduced** with blending or with a small second pass.
- **Pros:** No dependence on float blending for the main sum; avoids hotspot write contention; great cache reuse if you **reorder nodes**.
- **Cons:** Extra precomputed schedule; potentially two passes (partials → final).

This mirrors how high‑performance **SpMV** and **g‑SpMM** kernels balance irregular degrees; see GraphBLAST and GE‑SpMM. ([ACM Digital Library][4])

---

### C) **COO + segmented reduction pipeline** (deterministic, portable)

**When to use:** you prefer pure functional passes and no blending/atomics.

1. **Per‑edge pass:** compute edge contributions (m_e) and write into a texture keyed by destination (or source) index.
2. **Segmented reduction:** perform a log‑steps **segmented sum** by destination id (think “reduceByKey”) to produce one value per node. This is a standard GPU trick (ModernGPU has canonical recipes). ([moderngpu.github.io][5])

- **Pros:** Deterministic, no blending, no write conflicts; works on any WebGL2.
- **Cons:** Multi‑pass; you’ll implement a scan/reduce pyramid (WebGL2 texture scans are well‑trodden). ([NVIDIA Developer][6])

---

### D) **Exploit mathematical structure (Laplacian form)**

If your per‑edge force is **linear** in coordinates (e.g., classic spring: (\sum*j w*{ij}(x_j - x_i))), the total edge force is just **(-L\mathbf{x})** (graph Laplacian times positions). That is a pure **SpMV** (3 independent SpMVs for x/y/z), which is exactly what GPU graph stacks are maximized for (merge‑based CSR, balanceCSR, etc.). Implement “gather over CSR” once and you have optimal asymptotics and cache behavior. ([mgarland.org][7])

---

## 2) Industry‑grade patterns to borrow

- **Edge‑parallel with atomics** (WebGPU/CUDA): process each edge and `atomicAdd` to endpoints—then mitigate contention via **warp‑aggregated atomics** (pre‑sum within a warp and commit once) and **block‑local shared‑memory accumulation**, which is the standard for high‑degree hubs. WebGL2 lacks atomics; WebGPU gives you int atomics so you can use fixed‑point accumulators (e.g., 16.16) and convert back. ([NVIDIA Developer][8])
- **g‑SpMM / SDDMM fusion**: modern GNN kernels **fuse** “compute edge scalars” with “aggregate” to cut bandwidth (FusedMM). If you stick with WebGL2, do two passes; if/when you adopt WebGPU, fuse. ([arXiv][9])
- **Load balancing for irregular degrees**: merge‑based CSR (Merrill & Garland) yields near‑constant load per worker regardless of degree distribution—excellent for social graphs. ([mgarland.org][7])
- **Web‑scale precedents**: **cosmos.gl / Cosmograph** computes full force layouts in WebGL using shader‑only passes and blending, at hundreds of thousands of nodes/links. That validates the approach in browsers. ([GitHub][3])
- **cuGraph ForceAtlas2**: GPU layout for millions of edges; uses Barnes–Hut for repulsion, exact per‑edge attraction, and careful memory budgets (doc notes peak memory proportional to V). Good inspiration for parameterization and scheduling. ([RAPIDS Docs][10])

---

## 3) Data layout & memory: what scales

- **Adjacency**

  - **CSR** in textures: `rowPtr` (N+1, `R32F` OK), `colIdx` (E, `R32F` storing integer as float; safe up to ~16M). Store **weights/rest lengths** in parallel arrays (`R32F`/`RG32F`).
  - Or **COO (src,dst)** pairs in `RG32F` for edge‑parallel pipelines.

- **Reordering for locality**
  Reorder node indices **frequently** by **space‑filling curve** (Hilbert/Morton) based on the _current_ positions so neighbors in space map near in memory. This boosts texture cache hits for both position fetches and CSR walks and takes best advantage of your Barnes–Hut clustering (“graph clusters live near each other”). Space‑filling reorders are a classic cache‑locality booster. ([ACM Digital Library][11])
- **Precision & bandwidth**
  Consider `RGBA16F` for **accumulation** targets (forces) if the scene scale allows it; keep **positions** `RGBA32F` if needed. Blend requires the float‑blend extension for 32‑bit; half‑float blending is widely supported (via color‑buffer‑float; check caps). ([MDN Web Docs][2])

---

## 4) Scheduling strategies for **massive** degrees

- **Mini‑batch edges per frame (stochastic updates):** sample a subset of edges each frame and scale contributions by (1/p) to remain unbiased; over frames you approximate the full forces. This is SGD‑style variance‑reduction and is standard when degrees are in the thousands. Use a **degree‑aware sampler** (prioritize heavy edges, or stratify hubs). ([Massachusetts Institute of Technology][12])
- **Degree sharding:** cap per‑node processed neighbors per frame (e.g., top‑K by weight), and round‑robin through the remainder across frames. Works especially well with **KDK** integrators and damping.
- **Active‑edge filtering:** only recompute edges whose endpoints moved more than a threshold since last time; others reuse cached contributions (decay them with a small factor).
- **Multilevel (coarsen → refine):** compute forces on a **cluster graph** (Louvain/Leiden or label propagation), then refine within clusters. This is the backbone of scalable force layouts (Yifan Hu / FM³), and GPU community‑detection is readily available. ([RAPIDS Docs][13])
- **Graph sparsification (if acceptable):** keep a spectral sparsifier of edges using **effective resistance sampling** to preserve global structure while slashing E; refresh sparsifier occasionally. This gives you a principled way to reduce edge count without losing the shape. ([arXiv][14])

---

## 5) Three concrete blueprints you can drop into **THREE‑g**

### Blueprint 1 — **WebGL2, one‑pass scatter with blending (fastest path)**

1. Create an **accumulator FBO** `accEdges` (RGBA32F/16F).
2. Clear to zero; `gl.blendFunc(ONE, ONE)`.
3. **Instanced draw `POINTS` with 2 instances per edge** (as in (A)).
4. Sum with gravity in your integration pass (or blend directly into the gravity accumulator).
   **Notes:** Use **edge tiling** (draw edges in blocks of ~1–10M) to fit GPU caches and prevent driver timeouts. Make sure `EXT_color_buffer_float` + `EXT_float_blend` are enabled. ([MDN Web Docs][2])

### Blueprint 2 — **WebGL2, CSR gather with sharded work list (deterministic)**

1. Precompute CSR and a **work list** of `(nodeId, start, len≤L)` shards.
2. Pass 1: render **one fragment per shard**; loop `L` neighbors; output **partial** sum to an intermediate texture keyed by shard id.
3. Pass 2: **reduce** shard partials per node—either with additive blending (smaller traffic than per‑edge) or a segmented reduce pass.
   **Notes:** This is the functional analogue of CSR SpMV/g‑SpMM used by GraphBLAST/GE‑SpMM. ([ACM Digital Library][4])

### Blueprint 3 — **Laplacian springs = pure SpMV (3 channels)**

1. Build degree vector and adjacency once; at runtime do:
   [
   \mathbf{F} = -k(L\mathbf{x}) = -k\big((D-A)\mathbf{x}\big) = k\underbrace{(A\mathbf{x})}_{\text{neighbor sum}} - k\cdot \text{deg}\odot \mathbf{x}
   ]
2. Implement **CSR gather** for (A\mathbf{x}) and a trivial per‑node multiply for (D\mathbf{x}).
3. Repeat for y,z channels.
   **Notes:** You’ll get the best possible memory behavior because it’s exactly an SpMV—industry‑standard territory. ([mgarland.org][7])

---

## 6) Numerical & stability notes

- **Non‑associative sums:** additive blending sums in arbitrary order; that’s OK for forces, but if you ever need tighter numeric control, do **pairwise/segmented reductions** (C) to lower error. (Kahan compensation isn’t compatible with blending because it needs read‑modify‑write state.) ([NVIDIA Developer][6])
- **Hubs & timestep:** cap instantaneous force magnitude per node (`maxAccel`) and use a **KDK/symplectic** integrator with mild damping; this prevents hubs from “slingshotting” neighbors when edge mini‑batches vary per frame.
- **Bandwidth dominates:** edge updates are usually **memory‑bound**. Reordering nodes by **Hilbert/Morton** from current positions helps texture cache reuse dramatically. ([ACM Digital Library][11])

---

## 7) If/when you move to **WebGPU**

- **Edge‑parallel + atomics**: one thread per edge, two `atomicAdd`s to endpoints; reduce contention with **warp‑level pre‑sums** (or workgroup‑local shared buffers then single atomic to global). Atomic floats aren’t standard in WebGPU yet; a practical workaround is 32‑bit **fixed‑point** accumulation with integer atomics and a scale factor. ([NVIDIA Developer][8])
- **Fuse SDDMM⊕SpMM**: replicate **FusedMM** to cut memory traffic by half or better. ([arXiv][9])
- **Borrow kernels from GNN land**: GNN SpMM/SDDMM research (GE‑SpMM, cuTeSpMM) is exactly the optimization you need for message passing over edges. ([nicsefc.ee.tsinghua.edu.cn][15])

---

## 8) What others at scale actually use (for confidence)

- **cosmos.gl / Cosmograph** (browser, WebGL): force layout in shaders with GPU blending and MRT—hundreds of thousands of nodes/links interactively. ([GitHub][3])
- **RAPIDS cuGraph ForceAtlas2** (native, CUDA): O(N log N) repulsion (Barnes–Hut) + per‑edge attraction with GPU memory budgeting; demonstrates that mixing tree‑based “all‑particles” and edge‑wise forces scales to millions. ([RAPIDS Docs][10])
- **GraphBLAST / Gunrock / DGL**: production‑grade GPU frameworks that treat message passing as **(generalized) SpMM** and solve the exact **load‑balancing** and **memory‑access** pathologies of social graphs. ([arXiv][16])

---

## 9) Practical to‑do checklist for **THREE‑g**

1. **Pick a path now:** If the browser supports `EXT_float_blend`, implement **Blueprint 1** (scatter + blending). Otherwise, go **Blueprint 2** (CSR gather with shards). ([MDN Web Docs][17])
2. **Edge storage:** start with **COO RG32F** `(src,dst)` + `(weight,rest)`; pack indices as floats (safe under ~16M).
3. **Batching:** process edges in **tiles** (e.g., 1–5M per draw) and throttle with `EXT_disjoint_timer_query` if you already use GPU timers.
4. **Locality:** **reindex nodes** every few seconds of sim time using a Hilbert/Morton order of the current positions; rebuild CSR/COO tables with the new indices. ([ACM Digital Library][11])
5. **Scheduling:** for very high‑degree nodes, **shard** neighbors or **sample** edges across frames (compensate with (1/p)).
6. **Integration:** keep your Barnes–Hut gravity pipeline untouched; just **blend/accumulate** a second acceleration field from the graph forces before your KDK step.

---

### Closing thought

You don’t need one silver bullet; **combine**: (i) **scatter with blending** for simplicity and raw throughput, (ii) **CSR gather** or **segmented reduction** if you need determinism or extension‑free portability, and (iii) **reordering + sampling + sharding** to tame the heavy‑tail degree distribution typical of social graphs. That playbook is exactly how the “big” systems do it under the hood.

If you want, I can sketch the exact FBO/texture bindings and GL state changes to drop **Blueprint 1** into your current `demo.js` loop, and a minimal CSR builder for **Blueprint 2**.

[1]: https://arxiv.org/abs/1501.05387?utm_source=chatgpt.com "Gunrock: A High-Performance Graph Processing Library on the GPU"
[2]: https://developer.mozilla.org/en-US/docs/Web/API/EXT_color_buffer_float?utm_source=chatgpt.com "EXT_color_buffer_float extension - Web APIs | MDN"
[3]: https://github.com/cosmosgl/graph/blob/main/README.md?utm_source=chatgpt.com "graph/README.md at main · cosmosgl/graph · GitHub"
[4]: https://dl.acm.org/doi/fullHtml/10.1145/3466795?utm_source=chatgpt.com "GraphBLAST: A High-Performance Linear Algebra-based Graph Framework on ..."
[5]: https://moderngpu.github.io/segreduce.html?utm_source=chatgpt.com "Segmented Reduction - Modern GPU - GitHub"
[6]: https://developer.nvidia.com/gpugems/gpugems3/part-vi-gpu-computing/chapter-39-parallel-prefix-sum-scan-cuda?utm_source=chatgpt.com "Chapter 39. Parallel Prefix Sum (Scan) with CUDA"
[7]: https://mgarland.org/papers/2016/spmv/?utm_source=chatgpt.com "Michael Garland - Merge-based Parallel Sparse Matrix-vector Multiplication"
[8]: https://developer.nvidia.com/blog/cuda-pro-tip-optimized-filtering-warp-aggregated-atomics/?utm_source=chatgpt.com "CUDA Pro Tip: Optimized Filtering with Warp-Aggregated Atomics | NVIDIA ..."
[9]: https://arxiv.org/pdf/2011.06391?utm_source=chatgpt.com "FusedMM: A Unified SDDMM-SpMM Kernel for Graph Embedding and Graph ..."
[10]: https://docs.rapids.ai/api/cugraph/nightly/api_docs/api/cugraph/cugraph.force_atlas2/?utm_source=chatgpt.com "cugraph.force_atlas2 — cugraph 24.10.00 documentation - RAPIDS Docs"
[11]: https://dl.acm.org/doi/fullHtml/10.1145/3555353?utm_source=chatgpt.com "Cache-oblivious Hilbert Curve-based Blocking Scheme for Matrix ..."
[12]: https://www.mit.edu/~gfarina/2024/67220s24_L10_sgd/L10.pdf?utm_source=chatgpt.com "Lecture 10 Stochastic gradient descent - MIT"
[13]: https://docs.rapids.ai/api/cugraph/stable/graph_support/algorithms/louvain_community/?utm_source=chatgpt.com "Louvain Community — cugraph-docs 25.08.00 documentation"
[14]: https://arxiv.org/abs/0803.0929?utm_source=chatgpt.com "Graph Sparsification by Effective Resistances"
[15]: https://nicsefc.ee.tsinghua.edu.cn/nics_file/pdf/publications/2020/SC20_320.pdf?utm_source=chatgpt.com "a72-huang.pdf - Tsinghua University"
[16]: https://arxiv.org/abs/1908.01407?utm_source=chatgpt.com "GraphBLAST: A High-Performance Linear Algebra-based Graph Framework on the GPU"
[17]: https://developer.mozilla.org/en-US/docs/Web/API/EXT_float_blend?utm_source=chatgpt.com "EXT_float_blend extension - MDN Web Docs"
