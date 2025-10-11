# Unload: read computed particle state back to CPU

Goal

Provide a small, deterministic API to read particle results (positions and velocities) from GPU textures back into a caller-provided JS structure.

API

unload(particles, set?)

- particles: array of objects. Each element may already be a plain particle with optional numeric fields: x, y, z, vx, vy, vz. The array length defines how many particles to unpack.
- set (optional): function called for each particle to receive unpacked values. Signature:
  ({ particle, index, x?, y?, z?, vx?, vy?, vz? }) => void

Behavior

- The function will read the minimal set of GPU textures that contain computed data (positions and velocities). It will map texture texels to particle indices using the existing particle->texel packing scheme used by the pipeline.
- For each particle index i (0..N-1) it will read x,y,z into x,y,z and vx,vy,vz from velocity textures when available.
- If a provided particle object already has those fields, they will be overwritten. If a `set` callback is provided it will be called for every particle after unpacking; callers can store the values wherever they like.
- The function must be synchronous from the caller's point of view only after the GPU readback completes. Implementation will perform an async readPixels/read or a mapped buffer read and then synchronously call the `set` callbacks once data is available. The exported `unload` may return a Promise that resolves when done.

Return value

- Promise<void> that resolves when all particles have been updated. (If implementation can do synchronous blocking readback in the environment, return Promise.resolve()).

Edge cases and rules

- If `particles` is not an array or its length doesn't match the active particle count, the function should throw an error. Prefer strict validation to avoid silent truncation.
- Missing fields: if textures don't provide z or vz (2D-only systems), set those fields to 0 or leave undefined depending on project conventions — choose 0 for numeric consistency.
- If both raw particle objects and a `set` callback are provided, prefer calling `set`. The `set` receives the original particle object in `particle` so it may also mutate it.
- Large particle counts: do readback in large, contiguous chunks where possible to avoid repeated GPU round-trips. Use a typed buffer sized to N * components.
- Precision: preserve float32 precision when reading back; float16-packed textures must be unpacked on read.

Implementation steps (developer-ready)

1. Validation
	# Unload: read computed particle state back to CPU

	## Goal

	Provide a small, deterministic API to read particle results (positions and velocities) from GPU textures back into a caller-provided JS structure.

	## API

	unload(particles, set?)

	- particles: array of objects. Each element may already be a plain particle with optional numeric fields: x, y, z, vx, vy, vz. The array length defines how many particles to unpack.
	- set (optional): function called for each particle to receive unpacked values. Signature:
	  ({ particle, index, x?, y?, z?, vx?, vy?, vz? }) => void

	## Behavior

	- The function will read the minimal set of GPU textures that contain computed data (positions and velocities). It will map texture texels to particle indices using the existing particle->texel packing scheme used by the pipeline.
	- For each particle index i (0..N-1) it will read x,y,z into x,y,z and vx,vy,vz from velocity textures when available.
	- If a provided particle object already has those fields, they will be overwritten. If a `set` callback is provided it will be called for every particle after unpacking; callers can store the values wherever they like.
	- The function must be synchronous from the caller's point of view only after the GPU readback completes. Implementation will perform an async readPixels/read or a mapped buffer read and then synchronously call the `set` callbacks once data is available. The exported `unload` may return a Promise that resolves when done.

	## Return value

	- Promise<void> that resolves when all particles have been updated. (If implementation can do synchronous blocking readback in the environment, return Promise.resolve()).

	## Edge cases and rules

	- If `particles` is not an array or its length doesn't match the active particle count, the function should throw an error. Prefer strict validation to avoid silent truncation.
	- Missing fields: if textures don't provide z or vz (2D-only systems), set those fields to 0 or leave undefined depending on project conventions — choose 0 for numeric consistency.
	- If both raw particle objects and a `set` callback are provided, prefer calling `set`. The `set` receives the original particle object in `particle` so it may also mutate it.
	- Large particle counts: do readback in large, contiguous chunks where possible to avoid repeated GPU round-trips. Use a typed buffer sized to N * components.
	- Precision: preserve float32 precision when reading back; float16-packed textures must be unpacked on read.

	## Implementation steps (developer-ready)

	### 1. Validation

		- assert Array.isArray(particles)
		- read active particle count (N) from pipeline state and assert particles.length === N

	### 2. Determine texture layout

		- reuse the existing packing function that maps particle index -> texel coordinate. Usually the pipeline already stores width/height and packing stride.
		- compute texel coordinates for indices 0..N-1

	### 3. Allocate CPU buffer

		- create a Float32Array of length N * componentsPerParticle (componentsPerParticle = 6 for x,y,z,vx,vy,vz)
		- prefer a single readPixels into a RGBA float texture or a buffer mapped read if using WebGPU/WebGL2 + EXT_color_buffer_float + readPixelsFloat

	### 4. Issue GPU readback

		- bind the textures or framebuffer used for final position/velocity output
		- perform a single readPixels or a single buffer map read to fill the Float32Array
		- if the platform only allows RGBA per-texel, expand unpacking accordingly (e.g. two RGBA reads map to 6 components)

	### 5. Unpack into particles

		- iterate i from 0 to N-1:
		  - compute source offset in the CPU buffer for particle i
		  - read x,y,z,vx,vy,vz (use 0 for missing component)
		  - if set provided: call set({ particle: particles[i], index: i, x, y, z, vx, vy, vz })
		  - else: mutate particles[i].x = x; particles[i].y = y; ...

	### 6. Return

		- resolve the returned Promise once all particles are updated

	## Testing and verification

	- Unit test: create a tiny pipeline with 4 particles whose positions are computed on GPU to known values. Call `unload(particles)` and assert particle objects contain expected x/y/z and vx/vy/vz.
	- Test with `set` callback: pass an array of empty objects and set function that pushes values into another array. Confirm order and values match.
	- Stress test: test with large N (e.g., 1e5) to validate memory usage and that readback uses a single contiguous buffer.

	## Follow-ups / optional improvements

	- Provide an alternative API `unloadIntoTypedArrays` that writes directly into caller-provided Float32Arrays for zero-allocation critical paths.
	- Support partial ranges: allow optional start/length args to read subsets of particles.
	- If using WebGL1, provide a fallback packing/unpacking path that reads RGBA unsigned bytes and decodes floats.

	## Examples

	- Basic (mutate existing array):

	  await unload(particles)

	- Using `set` to store values elsewhere:

	  await unload(particles, ({ index, x, y, z, vx, vy, vz }) => {
		 bufferX[index] = x
		 bufferY[index] = y
		 // ...
	  })

	Keep it simple: the exported `unload` should be small, predictable, and documented. It must validate inputs, read back all needed textures in as few GPU calls as possible, and then either mutate the provided particle objects or call the provided `set` callback for each particle.
