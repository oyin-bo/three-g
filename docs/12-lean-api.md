# 12 — Lean API for ParticleSystem and Pluggable Forces

This document specifies a lean, GPU-first API for a ParticleSystem that owns integration kernels and schedules pluggable Force modules (e.g., Gravity* variants and GraphLaplacian). It emphasizes small, composable interfaces, predictable execution, and scale-up paths.

## Objectives

- GPU-first compute: particles live in textures; compute via WebGL2 render passes.
- Forces are independent contributors to acceleration, orchestrated by the ParticleSystem.
- ParticleSystem owns frame graph: clear → forces → integrate → swap.
- Scales across Gravity methods (monopole, Barnes–Hut/quadrupole, PM/mesh, spectral) and Graph Laplacian on large graphs.
- Supports injection/drain of live particles and targeted read/write for debugging/bridging.

## Core data model

- Capacity-driven atlas (W×H) with liveCount ≤ capacity.
- Double-buffered attributes (ping-pong):
  - positionMass: RGBA32F (x, y, z, mass)
  - velocityColor: RGBA32F (vx, vy, vz, aux/color)
- Accumulation and masks:
  - acceleration: RGBA32F (ax, ay, az, aux), cleared each frame
  - aliveMask: R8 or R32F (0/1) optional for lifecycle
- Optional textures (as needs arise): ids/age/random, constraints, bounds/reduction intermediates.
- Format detection and fallbacks (RGBA16F + blending when 32F blending unavailable).

## Key concepts and contracts

Lean, stable interfaces (TypeScript-style for clarity). Concrete classes may be JS.

### GPUPass

- Represents a single render pass.
- Fields: program, uniforms, samplers, framebuffer/target, viewport/scissor, blendMode ('add'|'replace').

### Force

- Pluggable module that contributes to acceleration.
- Contract:
  - id: string
  - onAttach(ps): void|Promise<void> — allocate shaders/buffers; validate formats/capacity
  - getRequirements(): { reads: string[]; writes: string[]; blend?: 'add'|'replace' }
  - getPasses(state, dt): GPUPass[] — render passes to run this frame
  - step?(dt): void — optional CPU orchestration
  - onDetach(): void
  - dispose(): void
- Convention: Forces generally write to the shared acceleration target with additive blending.

### Integrator

- Owns position/velocity update; default is semi-implicit Euler.
- Contract:
  - onAttach(ps): void
  - run({ dt, substeps }: { dt: number; substeps: number }): GPUPass[] | void
  - onDetach(): void
  - dispose(): void

Mathematics (semi-implicit Euler):

- $v_{t+\Delta t} = v_t + a_t\,\Delta t$
- $p_{t+\Delta t} = p_t + v_{t+\Delta t}\,\Delta t$

### ParticleSystem

- Orchestrates frame execution, owns textures, capacity, and lifecycle.
- Constructor (indicative):
  - new ParticleSystem({ gl, capacity, forces?, integrator?, dt?, substeps?, world?, formats? })
- Methods:
  - step({ dt?, substeps? } = {}): void
  - addForce(force: Force): void
  - removeForce(force: Force): void
  - inject(particles, opts?): number[] — write new particles into free slots; returns indices
  - drain(opts?): number[] — free slots by predicate/indices/count; may defer compaction
  - write(attr, src, indices|rect): void — CPU→GPU targeted update
  - read(attr, dst, indices|rect): void — GPU→CPU targeted readback
  - get textures(): { positionMass, velocityColor, acceleration, aliveMask? }
  - dispose(): void

Helper functions (public, dev-friendly):

- writeTextureRgba({ gl, particles, get, texture, textureWidth, textureHeight, textureIndex })
- readTextureRgba(gl, particles, set, texture, textureWidth, textureHeight, textureIndex)

## Frame scheduling (step)

Deterministic, minimal phases:

1) Clear acceleration target to zero.
2) For each force:
   - Validate read/write set once (startup) and blend mode.
   - Run returned GPUPass[] in order; typical target is acceleration with 'add' blending.
3) Integrator:
   - Run integrator passes (v ← v + a·dt; p ← p + v·dt), respecting aliveMask.
4) Swap ping-pong position/velocity.

Optional at end: tiny telemetry (timings) for REPL.

## Lifecycle and particle management

- Track capacity, liveCount; maintain a free-list of indices for O(1) inject/drain.
- inject(particles):
  - Map particles → texture writes via writeTextureRgba into free slots; set aliveMask.
- drain(...):
  - Mark slots free; clear aliveMask; optionally compact later.
- Selective read/write:
  - Index-based and rect-based variants for efficiency.

## Gravity* as a Force

Single GravityForce with a pluggable method: 'monopole' | 'quadrupole' | 'mesh' | 'spectral'.

- Shared params: { G, softening, bounds?, ... }
- Monopole (O(N²)):
  - One or a few tiled kernels; accumulates directly into acceleration.
- Quadrupole (Barnes–Hut):
  - Passes: build linear octree (Morton), compute multipoles, traverse → accumulate.
- PM/Mesh:
  - Passes: density rasterization → FFT → Poisson solve (k-space) → inverse → gradient → accumulate.
- Spectral:
  - Variant of PM with spectral adjustments; same pipeline shape, different kernels.

Each variant exposes getPasses(...) that binds current pos/mass (and aliveMask) and writes to acceleration with additive blending.

## GraphLaplacian as a Force

GraphLaplacianForce computes L·p (and optional damping) in gather mode.

- Inputs (textures):
  - CSR rowPtr (N+1), colIdx (M), weight (M). Optional restLength per edge.
- Kernel:
  - For vertex i: a_i += Σ_j w_ij (p_j − p_i)
  - Optional damping: a_i += −γ v_i
- Passes: typically one gather pass → acceleration. Constraints via a pin mask or penalty forces.

## World bounds and constraints

- Modes: none | clamp | wrap | reflect; applied during integration.
- Bounds update: optional reduction pass every K frames to track AABB when flagged.

## Performance notes

- Prefer persistent allocations sized to capacity; avoid per-frame realloc.
- Use RGBA16F+blend when RGBA32F blending unsupported; detect extensions at attach.
- Substeps: support N substeps (dt/N) for stability; allow heuristics or user control.
- Keep force-private buffers separate; only the acceleration target is shared.

## Testing and REPL integration

- Expose `window.physics` as the ParticleSystem instance in `index.html`.
- Force switching: `window.setMethod('spectral'|'quadrupole'|'mesh'|'monopole')` to reconfigure GravityForce.
- Minimal REPL snippets:
  - `physics.compute()`/`physics.step()` once; show timings.
  - Readback small slices to validate kernels via `readTextureRgba`.

## MVP milestones

1) Core PS skeleton
   - Ping-pong pos/vel, acceleration target, clear pass
   - Semi-implicit Euler integrator
   - Force plug API; trivial ConstantForce for validation
   - writeTextureRgba/readTextureRgba helpers
2) Gravity(monopole) + GraphLaplacian(gather)
   - Accumulate into acceleration with aliveMask; basic params
3) Gravity BH + PM/Spectral
   - Multi-pass pipelines; frame-graph orchestration
4) Lifecycle and robustness
   - inject/drain with free-list; bounds update; substeps policies; docs + REPL aids

## Edge cases to handle

- Texture format support and blending limitations (fallback to 16F).
- Capacity > max texture size → multi-atlas tiling (defer until needed).
- Force add/remove mid-frame → apply at frame boundaries.
- dt spikes → clamp or auto-substep.
- CSR changes vs liveCount; pinning out-of-range nodes.

## Pseudocode sketch for step()

```js
step({ dt = this.dt, substeps = this.substeps } = {}) {
  clear(accelerationTarget);
  for (const force of forces) runPasses(force.getPasses(state, dt));
  runPasses(integrator.run({ dt, substeps }));
  swap(positionPing, positionPong); swap(velocityPing, velocityPong);
}
```

## Open items (tracked for future iterations)

- Optional integrators (Verlet, RK2/RK4) as plugins.
- Constraints API (pin sets, distance constraints) built as forces.
- Metrics/telemetry hooks and budgeted scheduling.
- Multi-atlas scaling for very large N.

---

This API keeps Forces small and composable, isolates shared state to explicit textures, and gives the ParticleSystem a simple, predictable frame graph while leaving ample room to scale across Gravity* methods and graph workloads.
