# Kernels — WebGL2 Kernel building blocks

This document specifies the canonical shape and semantics for a `Kernel` (a single WebGL2 shader pass / FBO invocation) used across the project. The goal is extreme simplicity and consistent, deterministic lifetime rules so kernels are easy to test, compose and reason about.

Keep these rules as the single source of truth for all Kernel implementations.

## Quick summary (one line)
- A Kernel is a class with only a constructor(options), plain instance properties for resources, a synchronous `run()` and a `dispose()` method. The constructor may create default GPU resources only when the caller omits a property; presence (truthy) or explicit `null` prevents creation. `run()` performs the pass; `dispose()` deletes every non-null property.

## Shape of a Kernel
-- Constructor signature: `constructor(options)`
  - `options.gl` is expected (a `WebGL2RenderingContext`) but the constructor does not validate it.
  - Matching keys on `options` are treated as initial values for the instance properties of the kernel.
 - Required members on every kernel instance:
  - Flat resource properties (example): `this.inPosition`, `this.outPosition`, `this.inVelocity`, `this.outVelocity`, etc.
  - A synchronous `run()` method which performs one draw/dispatch.
  - A `dispose()` method which deletes any non-null resource property and clears it.

No other API surface is required.

## Constructor resource rule (precise)
For each resource slot the Kernel needs, the constructor must implement this exact rule:

- If `options[slot]` is *truthy* OR `options[slot] === null` -> the Kernel does NOT create the slot and sets `this[slot] = options[slot]`.
  - In other words: presence (truthy) or explicit `null` means "do not create".
- Otherwise (the option is absent or falsy other than `null`) -> the Kernel MUST create a default GPU resource for the slot and assign it to `this[slot]`.

Notes:
- The Kernel does not convert or coerce non-texture values. If the caller supplies something that is not a GPU object (TypedArray, number, etc.), the Kernel will still store it and the caller is responsible for correctness.
- The Kernel must not attempt any implicit typed-array → texture creation or uploads. Simplicity: caller creates textures when they want them.

## Property types and normalization
- Allowed runtime values for `this[slot]` are up to the caller — the Kernel will not enforce them. Typical usage expects WebGL textures or small wrapper objects.
- `null` explicitly means "no resource yet". Caller may set the property before calling `run()`.

## run() semantics
- `run()` is synchronous and performs a single shader pass or compute-like render:
  - Bind inputs (whatever is in `this.in*` properties) to texture units.
  - Bind output framebuffer(s) using `this.out*` properties.
  - Set uniforms and issue `drawArrays`/`drawElements`.
  - No implicit validation/checking of properties — if a property is missing or not a correct GPU handle, errors or GL failures are the caller's problem.
  - `run()` returns `void`.

## dispose() semantics (simple and unconditional)
- `dispose()` must iterate every known resource property on the instance and, for each property with a non-null value, attempt to free it and then set it to `null`.
  - Freeing strategy is best-effort and must swallow errors: if a property has `.delete()` or `.dispose()` call it; otherwise try `gl.deleteTexture(...)` or `gl.deleteFramebuffer(...)` if applicable; if neither applies just set `this[prop] = null`.
- Important: this is unconditional — if the caller passed an external texture as `options.someSlot` and it remains non-null at `dispose()` time, `dispose()` will delete it. If the caller wants to keep an externally-managed resource, the caller must set `kernel.someSlot = null` before calling `dispose()`.

This rule intentionally keeps the object model minimal and removes hidden ownership semantics.

## Ping-pong semantics (caller-managed flip)
- Naming convention: prefer `inXyz` / `outXyz` for pairs (or `curXyz` / `nextXyz`). Be consistent.
- The Kernel NEVER swaps or flips ping-pong buffers. The caller always owns the flip. The Kernel writes into `outXyz` and leaves property references unchanged.
- If the Kernel created both `inXyz` and `outXyz` (because the options did not contain those keys), those created resources will remain as properties on the Kernel and will be deleted by `dispose()` unless the caller explicitly nulls them first.

Rationale: this keeps swapping semantics explicit and predictable. Tests or pipelines that want automatic internal state should allocate their own PingPong helper or manage the flip explicitly.

## Naming conventions
- Use explicit names that communicate intent and use-case. Examples:
  - `inPosition`, `outPosition` — particle positions
  - `inVelocity`, `outVelocity` — velocities
  - `pmGrid`, `pmForceTexture` — pipeline-specific grids/textures

Keep names stable so tools and test harnesses can reference them reliably.

## Examples

### Test-isolated kernel (Kernel creates an output)

```js
// Ask kernel to *not* create inputs but create any missing outputs
const kernel = new MyKernel({ gl, inPosition: null, inVelocity: null });

// Caller supplies valid textures (caller is responsible)
kernel.inPosition = smallPosTexture;
kernel.inVelocity = smallVelTexture;

kernel.run(); // kernel writes into kernel.outVelocity (created by the kernel)

// Caller readback if desired (read pixels via helper)
// Cleanup — kernel will delete any non-null properties
kernel.dispose();

// If caller wants to keep smallPosTexture, it must null the property before dispose:
// kernel.inPosition = null; kernel.inVelocity = null; kernel.dispose();
```

### Pipeline with caller-owned ping-pong (caller flips)

```js
const posA = createTexture(gl,w,h), posB = createTexture(gl,w,h);
const velA = createTexture(gl,w,h), velB = createTexture(gl,w,h);

const kernel = new MyKernel({ gl, inPosition: posA, outPosition: posB, inVelocity: velA, outVelocity: velB });
kernel.run();

// Caller flips the ping-pong pair explicitly
[ posA, posB ] = [ posB, posA ];
[ velA, velB ] = [ velB, velA ];

// On teardown, if caller wants to preserve posA etc.:
kernel.inPosition = null; kernel.outPosition = null; // so dispose won't delete them
kernel.dispose();
```

## Rules of thumb (do / don't)
- DO keep the Kernel API minimal and predictable: constructor options + flat properties + run + dispose.
- DO make the caller responsible for creating valid GPU handles if the caller provided truthy values in `options`.
- DO document slot names and expected formats in the Kernel subclass implementation (each subclass knows its shapes).
- DON'T expect Kernel to validate or coerce inputs; Kernel does not perform typed-array uploads or format conversions.
- DON'T pass TypedArrays in `options`; Kernel will not convert or upload them — the caller must provide GPU textures.
- DON'T rely on `dispose()` preserving externally-provided textures unless the caller nulls them first.

## Migration notes and suggested workflow

1. Implement kernels to follow this contract incrementally. Existing code often already follows similar patterns (ping-pong, explicit swap). Start by wrapping single-draw passes (integrator, simple reductions) into Kernel subclasses that follow this model.
2. For complex subsystems that currently own many textures (quadtree/texture arrays), keep the same internal allocation but expose those important GPU handles as properties so tests can snapshot them.
3. Tests: use small resolutions, set `in*` properties to small test textures, call `run()`, read back and assert invariants (mass conservation, no NaN, bounded accelerations). Use `dispose()` when done.

## Testing & CI guidance
- Prefer invariant-based assertions and toleranced numeric comparisons rather than bitwise equality.
- Use small test textures (e.g., 4×4 or 8×8) for kernel-level unit tests to avoid expensive readback.
- In CI, run tests in a headless browser environment that supports the required GL extensions (EXT_color_buffer_float) or pin expectations to tolerances that are driver-independent.

## Short FAQ

-- Q: Should a Kernel null caller-supplied textures before calling `dispose()`?
-- A: Yes — if the caller wants to keep a supplied texture across Kernel disposal, set the corresponding property to `null` before calling `dispose()` to prevent deletion.

-- Q: Are typed arrays accepted as constructor values?
-- A: The Kernel contract intentionally forbids implicit conversions — the constructor will store whatever the caller provided and the caller is responsible for correctness.

-- Q: Who flips ping-pong?
-- A: The caller. The Kernel writes to `outXyz` and does not mutate properties.

---

This document intentionally keeps the Kernel contract minimal and leaves correctness responsibilities to the caller. That design enables simple tests, straightforward composition, and a small API surface that is easy to reason about across the many different pipeline styles in this project.
