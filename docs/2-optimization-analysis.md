# GPU-Bound Particle System: Optimization Strategy

**Current Performance:** 500K particles @ 50 FPS (medium GPU), 50M particles @ <10 FPS  
**Target:** 10× throughput improvement at same FPS  

## Executive Summary

The particle system is **definitively GPU-bound**. CPU orchestration overhead is negligible across the entire performance range. The optimization search space is therefore confined to:

1. **Reducing GPU shader workload** (ALU operations, texture fetches)
2. **Reducing memory bandwidth** (texture access patterns, data format)
3. **Algorithmic replacement** (trading exactness for asymptotic complexity gains)
4. **Platform migration** (WebGPU compute shaders for better GPU utilization)

This document outlines profiling strategy, optimization hypotheses, and a staged investigation plan.

---

## I. Profiling Strategy

### Why GPU-Only Profiling?

**Validated assumption:** At both 500K @ 50 FPS and 50M @ <10 FPS, the system remains responsive with low CPU utilization. The FPS drop at high particle counts correlates directly with increased fragment shader workload (texture fetches scale with particle count). CPU orchestration (texture binding, uniform updates, draw calls) does not exhibit this scaling behavior.

**Conclusion:** CPU timing would only measure JS/WebGL API overhead, which is already known to be sub-millisecond. All optimization effort should target GPU execution.

### Recommended Profiling Approach

**Primary: GPU Timer Queries**
- Use `EXT_disjoint_timer_query_webgl2` (widely supported on desktop WebGL2)
- Instrument each major GPU pass with non-blocking queries
- Collect results 2-3 frames later to avoid pipeline stalls
- Average over 100+ frames for statistical stability
- **Pitfall:** Don't poll query results immediately—this forces a CPU-GPU sync and destroys parallelism

**Secondary: Browser DevTools**
- Chrome Performance panel with "GPU" category enabled
- Provides command-level breakdown without code changes
- Useful for validating timer query results
- **Limitation:** Coarser granularity, doesn't show internal shader hotspots

**Tertiary: Vendor Profilers (Optional)**
- NVIDIA Nsight Graphics, AMD Radeon GPU Profiler, Intel GPA
- Shows hardware counters: memory bandwidth, cache hit rates, ALU occupancy
- **When to use:** After identifying the bottleneck pass, if you need microarchitecture-level insight

### Critical Measurement Points

The pipeline has six major GPU passes per frame:

1. **Octree Aggregation** (`aggregation.frag.js`)
   - Single fullscreen pass writing to texture pyramid base
   - Expected cost: Low (simple atomic-like operations via blending)

2. **Pyramid Reduction** (`reduction.frag.js`)
   - 10 sequential passes, each reading 8 texels from previous level
   - Expected cost: Low-medium (80 texture fetches total)

3. **Force Traversal** (`traversal.frag.js`) ⚠️
   - Single fullscreen pass, one invocation per particle
   - **Expected bottleneck:** 287 texture fetches per particle
   - At 500K particles: 143.5 million texture fetches per frame
   - Each fetch: pyramid texture lookup (cache-hostile random access)

4. **Velocity Integration** (`vel_integrate.frag.js`)
   - Simple shader: read force, integrate velocity
   - Expected cost: Very low (2-3 texture fetches, minimal ALU)

5. **Position Integration** (`pos_integrate.frag.js`)
   - Simple shader: read velocity, integrate position
   - Expected cost: Very low (2-3 texture fetches, minimal ALU)

6. **Render Pass** (`render.vert.js` + `render.frag.js`)
   - Point sprite rendering
   - Expected cost: Low-medium (depends on viewport coverage and overdraw)

**Hypothesis:** Traversal shader dominates frame time (60-80% of GPU work). Profiling should confirm this before optimization work begins.

---

## II. Optimization Search Space

### A. Reduce Traversal Shader Workload

**Current implementation analysis:**

The traversal shader performs hierarchical force summation using the Barnes-Hut octree. For each particle, it:

1. Starts at octree root (level 9)
2. For each octree node, computes θ = cell_size / distance
3. If θ < THETA (0.5), treats node as single mass point
4. Otherwise, descends to 8 children and recurses
5. For near-field cells (distance < R0 × cell_size), samples a 5×5×5 kernel of neighboring cells

**Key bottleneck:** The near-field kernel performs **125 texture fetches** per near-field encounter. Since particles are spatially clustered, most particles encounter 1-3 near-field cells, resulting in 125-375 fetches just for near-field.

**Optimization opportunities:**

1. **Reduce near-field kernel size**
   - Current: 5×5×5 = 125 samples
   - Proposed: 3×3×3 = 27 samples (81% reduction)
   - **Trade-off:** Slightly less accurate near-field force (acceptable for chaotic N-body)
   - **Expected gain:** 30-40% reduction in texture fetches → ~1.5× speedup if traversal is 70% of frame time

2. **Adaptive near-field sampling**
   - Use 3×3×3 for most particles, 5×5×5 only for high-density regions
   - Requires density heuristic (e.g., cell particle count from pyramid)
   - **Complexity:** Medium (need additional uniform or texture lookup)

3. **Early termination for negligible forces**
   - Skip nodes where estimated_force / accumulated_force < epsilon (e.g., 0.01)
   - Requires maintaining running force magnitude in shader
   - **Expected gain:** 10-20% fewer node visits in sparse regions

4. **Adjust THETA (opening angle)**
   - Current: 0.5 (conservative, accurate)
   - Increasing to 0.7-0.8 reduces tree depth traversal
   - **Trade-off:** Less accurate force (may cause energy drift in orbits)
   - **Expected gain:** 15-25% fewer node visits

5. **Texture fetch optimization**
   - Current: Each pyramid lookup is a dependent texture read
   - Investigate: Can we pack octree data more efficiently? (e.g., use texture arrays, reduce format precision)
   - **Complexity:** High (requires rethinking data layout)

**Investigation priority:**
1. Profile to confirm traversal dominance
2. Test near-field kernel reduction (3×3×3) — low-hanging fruit
3. Add early termination — medium effort, measurable gain
4. Experiment with THETA tuning — easy but needs visual validation

### B. Reduce Pyramid/Aggregation Cost

**Current implementation:**

The octree is rebuilt every frame:
1. Clear 10 levels of textures (memset-like operation)
2. Aggregate particles into base level (single pass, additive blending)
3. Reduce pyramid bottom-up (10 passes, each reading 8 children)

**Total cost estimate:** 15-20% of frame time (based on complexity analysis)

**Your original idea: Lazy octree rebuild with particle migration**

This is a strong intuition. Key insight: particles move slowly (typical velocity << cell size per frame), so most particles remain in the same octree cell across frames.

**Incremental update strategies:**

1. **Lazy rebuild (simplest)**
   - Rebuild octree every N frames (N=2-4)
   - Between rebuilds, use stale octree (slight force error accumulates)
   - **Expected gain:** 50-75% reduction in build cost → 7-14% overall speedup
   - **Risk:** Force errors may compound, causing energy drift
   - **Validation needed:** Monitor total energy, angular momentum over time

2. **Incremental migration (complex)**
   - Track which particles crossed cell boundaries since last rebuild
   - Only re-aggregate "dirty" cells and propagate changes up the pyramid
   - **Challenges:**
     - GPU-based boundary detection (compare old/new cell ID)
     - Partial pyramid updates (hard to parallelize efficiently on GPU)
     - State management (need persistent particle→cell mapping)
   - **Expected gain:** Potentially 2-3× in build cost if <30% of particles migrate per frame
   - **Complexity:** Very high (4+ new shader passes, complex logic)

3. **Hybrid: Lazy + Spillover Buffers**
   - Rebuild every N frames
   - Between rebuilds, maintain a small "spillover" buffer of boundary-crossers
   - Apply spillover forces as corrections (like a residual)
   - **Complexity:** Medium-high
   - **Expected gain:** Better accuracy than pure lazy rebuild

**Investigation priority:**
1. Implement lazy rebuild first (N=4) — very simple, measure energy drift
2. If drift is acceptable, this is a 10-15% speedup for minimal effort
3. If drift is problematic, investigate spillover or incremental schemes

### C. Algorithmic Replacement

**Current: Barnes-Hut O(N log N)**
- Hierarchical tree traversal
- Well-suited for clustered distributions
- **Limitation:** Still requires tree traversal for every particle

**Alternative algorithms:**

1. **Particle-Mesh (PM)**
   - Deposit particle mass onto a 3D grid (texture)
   - Solve Poisson equation on grid (FFT or multigrid)
   - Interpolate forces back to particles
   - **Complexity:** O(N + M log M) where M = grid size
   - **GPU suitability:** Excellent (grid operations are highly parallel)
   - **Expected gain:** 5-10× for large N (>1M particles)
   - **Trade-off:** Softens forces at grid scale (need fine grid for accuracy)

2. **Fast Multipole Method (FMM)**
   - Like Barnes-Hut but with multipole expansions (higher-order approximations)
   - **Complexity:** O(N) asymptotically
   - **GPU suitability:** Poor (complex tree structure, hard to parallelize)
   - **Expected gain:** 3-5× for very large N, but GPU implementation is challenging

3. **Particle-Particle Particle-Mesh (P3M)**
   - Hybrid: PM for long-range, direct summation for short-range
   - Best of both worlds: accurate near-field, efficient far-field
   - **Complexity:** High (need to split force calculation)
   - **Expected gain:** 8-15× for large N with clustering

**Investigation priority:**
1. Research PM algorithm (simpler than P3M)
2. Prototype grid deposition and force interpolation shaders
3. Compare accuracy vs. current Barnes-Hut on a test case (e.g., gravitational collapse)
4. If PM is viable, this is the path to true 10× gains

### D. Memory Bandwidth Optimization

**Current texture formats:**
- Pyramid: RGBA32F (16 bytes per texel)
- Particle positions/velocities: RGBA32F

**GPU memory bandwidth:**
- At 500K particles, traversal reads ~143M texels/frame
- At 16 bytes/texel: 2.29 GB/frame
- At 50 FPS: **114 GB/s bandwidth required**
- This saturates mid-range GPU memory bandwidth (e.g., GTX 1660 has ~192 GB/s)

**Optimization opportunities:**

1. **Use RGBA16F for pyramid data**
   - Half precision sufficient for mass sums and centroids
   - Halves bandwidth: 57 GB/s
   - **Risk:** Precision loss in deep octree levels (test needed)

2. **Pack octree data more tightly**
   - Current: (mass, cx, cy, cz) in RGBA
   - Could encode mass as log scale, quantize centroid to int16
   - **Complexity:** High (shader changes, decompression overhead)

3. **Improve texture cache locality**
   - Current: Random access pattern (octree traversal is inherently cache-hostile)
   - Possible: Z-order curve (Morton encoding) for spatial coherence
   - **Complexity:** Very high (requires data layout redesign)

**Investigation priority:**
1. Test RGBA16F pyramid (easy change, measure precision impact)
2. Profile memory bandwidth with vendor tools (if traversal is still slow after fetch reduction)

### E. Platform Migration: WebGPU

**Current: WebGL2 fragment shaders**
- Limited to rasterization-based compute (fullscreen quads)
- No explicit compute shaders
- No shared memory for workgroup-local data

**WebGPU compute shaders:**
- Direct compute dispatch (no rasterization overhead)
- Workgroup shared memory (reduce global memory fetches)
- Better asynchronous execution (command encoding can overlap)
- **Expected gain:** 2-4× from reduced API overhead and better GPU utilization

**Migration cost:** High (full pipeline rewrite), but may be necessary for >10M particles

---

## III. Staged Investigation Plan

### Phase 1: Profiling & Validation (Week 1)

**Goal:** Confirm bottleneck hypothesis with hard data

**Tasks:**
1. Implement GPU timer queries around 6 major passes
2. Run at 500K particles, collect 120-frame averages
3. Validate that traversal is 60-80% of GPU time
4. Establish baseline metrics:
   - Total frame time
   - Per-pass breakdown
   - Energy conservation (drift rate)

**Deliverable:** Profiling report with confirmed bottleneck and baseline metrics

### Phase 2: Low-Hanging Fruit (Week 2)

**Goal:** Quick wins to validate optimization approach

**Tasks:**
1. Reduce near-field kernel 5×5×5 → 3×3×3
2. Add early termination for negligible forces
3. Implement lazy rebuild (interval=4 frames)
4. Re-profile and measure gains

**Expected outcome:** 1.5-2× speedup (40-50 FPS → 60-100 FPS at 500K)

**Decision point:** If energy drift is acceptable, keep lazy rebuild. Otherwise, revert and investigate spillover.

### Phase 3: Algorithmic Research (Week 3-4)

**Goal:** Evaluate PM algorithm feasibility

**Tasks:**
1. Literature review: PM for gravitational N-body on GPU
2. Prototype 3D grid deposition shader (particles → grid mass)
3. Prototype Poisson solver (multigrid or FFT-based)
4. Prototype force interpolation shader (grid → particle forces)
5. Compare accuracy with Barnes-Hut on test case (e.g., two-body orbit)

**Decision point:** If PM accuracy is acceptable, proceed to full implementation. Otherwise, consider P3M or stick with optimized Barnes-Hut.

### Phase 4: Full PM Implementation (Week 5-6, if Phase 3 is positive)

**Goal:** Replace Barnes-Hut with PM for 5-10× gain

**Tasks:**
1. Integrate PM pipeline into particle system
2. Tune grid resolution (trade-off: accuracy vs. performance)
3. Optimize Poisson solver (critical for performance)
4. Re-profile and validate

**Expected outcome:** 5-10× throughput (500K @ 50 FPS → 5M @ 50 FPS)

### Phase 5: Memory Bandwidth (If Needed)

**Goal:** Further optimize if PM is still bandwidth-limited

**Tasks:**
1. Switch pyramid to RGBA16F
2. Profile memory bandwidth with vendor tools
3. Experiment with data packing

**Expected outcome:** 1.2-1.5× additional gain

---

## IV. Risk Assessment & Pitfalls

### Common Pitfalls

1. **Optimizing without profiling**
   - Don't assume the bottleneck—measure it
   - GPU timer queries are non-negotiable before optimization

2. **Breaking energy conservation**
   - Lazy rebuild and kernel reduction change force calculation
   - Monitor total energy, angular momentum, virial ratio
   - Visualization is not enough—numerical validation required

3. **Premature algorithmic replacement**
   - PM is complex; don't commit until Phase 2 optimizations are exhausted
   - A well-optimized Barnes-Hut may reach 2-3× gains, which might be sufficient

4. **GPU profiling stalls**
   - Never poll timer queries immediately after draw call
   - Use a query pool with 2-3 frame latency

5. **Over-reliance on THETA tuning**
   - Increasing THETA too much causes visible artifacts (orbital decay)
   - Validate with known test cases (e.g., solar system, galaxy merger)

### When to Stop Optimizing

**Diminishing returns threshold:**
- If Phase 2 optimizations reach 100+ FPS at 500K, you've achieved ~2× gain
- If that's acceptable, declare victory and focus on other features
- Only pursue PM if you need 5M+ particles at interactive rates

**Alternative success criteria:**
- Maybe 10× particle count isn't the goal—what about visual quality at current count?
- Consider: better rendering (lighting, trails), physics fidelity (collisions, mergers), or user interaction (selection, grouping)

---

## V. Recommended Next Steps

**Immediate (this week):**
1. Implement GPU profiling with `EXT_disjoint_timer_query_webgl2`
2. Collect baseline metrics at 500K particles
3. Confirm traversal shader is the bottleneck

**Short-term (next 2 weeks):**
4. Implement Phase 2 optimizations (near-field reduction, early termination, lazy rebuild)
5. Measure gains and energy drift
6. If 2× gain is achieved and energy is stable, decide whether to continue to PM

**Medium-term (if pursuing 10× goal):**
7. Research and prototype PM algorithm
8. Compare accuracy with Barnes-Hut
9. If viable, implement full PM pipeline

**This plan prioritizes measurement over speculation, quick wins over complex rewrites, and scientific validation over visual inspection. Good luck!**