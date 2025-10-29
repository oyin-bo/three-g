# Live BlueSky Firehose → Particle Graph Demo (livebs)

This document proposes a full demo that streams BlueSky’s firehose into a live particle+graph simulation:
- Particles represent accounts and posts.
- Edges represent interactions (follow, like, repost, reply, mention, quote, etc.).
- Forces = Laplacian graph model (spring-like attraction/repulsion) + negative-gravity monopole kernel for spatial separation.
- Live insertion via large preallocated GPU textures with zero-mass/NaN placeholders.
- Early scaffolding exists under `demo/bs/local/coldsky/atlas` (e.g., `index.js`, `boot/firehose-to-bubbles.js`).
  IMPORTANT: The live demo will be developed as a new app from scratch and may copy patterns from [Atlas](https://github.com/mihailik/atlas) as needed.
  [Coldsky](https://github.com/colds-ky/basic) is an API for fetching BlueSky data, including a live firehose and CAR decoding.

The goal: a smooth, continuous visualization of social activity, scalable to large, streaming graphs, with knobs for profiling and debugging.


## High-level architecture

- Source
  - Live: BlueSky firehose (`demo/bs/local/coldsky/firehose.js`)
  - Offline: CAR archives (`demo/bs/local/coldsky/coldsky/download-cars.js`)
- Ingestion
  - Parse events into a compact, append-only store of Profiles and Posts.
  - Maintain a live edge list with rolling time window and exponential decay.
- Mapping → Simulation
  - Assign each entity (profile/post) to a particle "slot" (index) in preallocated textures.
  - Maintain CPU-side maps: entityId → slotIndex; free-list/ring for unused slots.
  - Update Laplacian edges incrementally; rebuild textures in small patches.
- Rendering & Physics
  - Particle system using existing GPU kernels: start with monopole method (tunable G < 0 to create repulsion) plus Laplacian-force module for graph attraction.
  - Mass=0 means inactive slot; NaN positions ignored by shader paths when needed.
- UI & Control
  - `AtlasComponent` wrapper (`demo/bs/local/coldsky/atlas/index.js`) boots the experience.
  - REPL via daebug to switch methods, sizes, and parameters at runtime.


## Data model

- Entities
  - Profile: unique by DID; includes handle, display name, avatar (optional), and lightweight metadata.
  - Post: unique by at:// URI; includes author DID, timestamp, reply/quote pointers, lightweight text metrics.
- Interactions → Edges
  - follow(profileA → profileB) → edge(A,B, w=1)
  - like(postLiker → postAuthor/post) → edge(liker, post, w=1); optional edge(liker, author, w=0.25)
  - repost(reposter → post/author) → edge(reposter, post, w=2); edge(reposter, author, w=0.5)
  - reply(replier → parentPost/author) → edge(replier, parentPost, w=3); edge(replier, parentAuthor, w=1)
  - quote(quotingAuthor → quotedPost/author) → edge(quotingAuthor, quotedPost, w=2.5); edge(→ author, w=0.75)
  - mention(author → mentionedProfile) → edge(author, mentioned, w=0.75)

Weights are initial heuristics; we’ll tune via REPL.

- Time and decay
  - Each edge has `lastSeen` and `weight0` (base weight). Effective weight: `w = weight0 * exp(-dt / tau)`.
  - `tau` configurable per interaction type or global.


## Ingestion pipeline

- Live firehose
  - Use `firehose.js` generator (`firehose(address?)`). Batch by small blocks of records.
  - Convert records to `CompactProfile`, `CompactPost`, and `EdgeEvent` structs.
  - Push into a `DBAccess` facade (in-memory first; pluggable to persistent layer later).
- Offline CARs
  - `download-cars.js` fetches repos; a reader will walk records and feed the same ingestion API as firehose.


### Minimal ingestion contracts

- DBAccess
  - Methods
    - `async *firehose(): AsyncGenerator<{ posts: CompactPost[], profiles: CompactProfile[], edges: EdgeEvent[] }>`
    - `getOrCreateEntitySlot(id: string, type: 'profile'|'post'): number`
    - `commitEdges(edges: EdgeEvent[])`: merges, deduplicates, updates decay fields
    - `gc(deadlineMs?: number)`: reclaims stale entities and edges; returns freed slots
  - Notes
    - For the demo, `firehose()` can wrap the real firehose iterator and emit compact chunks sized to frame budgets.

- CompactProfile (proposal)
  - `{ did: string, shortDID: string, handle?: string, displayName?: string, lastActiveTs: number }`
- CompactPost (proposal)
  - `{ uri: string, shortUri: string, authorShortDID: string, time: number, replyTo?: string, quoteOf?: string }`
- EdgeEvent (proposal)
  - `{ src: string, dst: string, kind: 'follow'|'like'|'repost'|'reply'|'quote'|'mention', ts: number, w0?: number }`


## Particle allocation and lifecycle

- Preallocation
  - Choose texture size N×N (power-of-two recommended). Example: 2048×2048 → 4,194,304 slots.
  - Textures: position (RGBA32F), velocity (RGBA32F), mass (or mass in pos.w), color (RGBA8), optional flags.
  - Initialize all slots with: pos.xyz = NaN, pos.w = 0 (mass), vel = 0.

- Slot states
  - Free: pos.w==0 and pos.xyz=NaN (or a bitflag field) → ignored by physics and renderer.
  - Live: pos.w>0 → simulated and rendered.

- Allocation
  - Maintain a CPU free-list (stack or ring). On new entity: pop index; if empty, optionally grow to next texture tier (or drop oldest).
  - Initialize:
    - Profiles: place on an annulus or jittered grid; tiny initial velocity.
    - Posts: near the author’s position with random small offset.
    - Mass: small positive value; use negative gravity constant to create repulsion in monopole kernel.

- Update
  - Existing entities: refresh lastActive; apply soft moves for profile name/handle changes (no position jumps).

- Deactivation/GC
  - Fade: decay color alpha or mass over T seconds before freeing, to avoid popping.
  - Free slot: set pos.xyz=NaN, pos.w=0; push index back to free-list.


## GPU updates (live insertion)

- Texture writes
  - Use contiguous batches of indices when possible; group by row to minimize `gl.texSubImage2D` calls.
  - For sparse writes, maintain a small PBO or CPU staging buffer and coalesce per frame.

- Ping-pong textures
  - Physics uses ping-pong FBOs per step. Insertions must write into the "current" read side; mirror to the write side before the next step or let first step propagate.
  - Provide a helper `injectParticles(indices, posBuf, velBuf, massBuf, colorBuf)` that performs uploads to both ping-pong sides safely between kernel passes.

- Synchronization
  - Perform uploads right after a frame’s physics step, before rendering, or at frame start before step—stay consistent to avoid tearing.


## Laplacian graph forces

- Module
  - Reuse the `LaplacianForceModuleKernels` pattern from `demo-kernels.js` to compute forces `F_graph`.
  - Apply additively to velocities via a small shader pass (see `createGraphVelocityKernel`).

- Dynamic edges
  - Maintain CSR-like textures (offsets + adjacency) or flat edge list texture per frame window.
  - For incremental updates:
    - Buffer new edges on CPU, coalesce, apply `texSubImage2D` to adjacency segments.
    - Periodically (e.g., every few seconds) rebuild full adjacency to defragment.

- Edge weights and decay
  - Compute effective weight on CPU each frame or every K frames; clamp small values to zero and prune.


## Physics blend: negative gravity + graph attraction

- Monopole kernel with G < 0 (repulsion) prevents collapse and spreads clusters.
- Laplacian edges pull connected entities closer.
- Optional world bounds to keep layout centered; gentle damping to stabilize.


## Visual encoding

- Color
  - Profiles: HSL by handle hash; Posts: tint towards author’s color; brightness by recency.
- Size
  - Profiles: by degree/centrality (capped); Posts: by engagement.
- Effects
  - Flash on new edges; trail via velocity magnitude; fade inactive.


## Frame budgeting and backpressure

- Ingestion loop adapts to frame time:
  - Target 60 FPS; budget ~2–3 ms for uploads, ~2–3 ms for graph updates.
  - If behind, drop low-priority edges first (likes) and queue for later.

- Batching
  - Accumulate insertions until either count threshold (e.g., 2048) or time slice (~4 ms) reached, then upload.


## Integration and reference code

- Atlas prototype (REFERENCE ONLY — do not edit in-place)
  - `demo/bs/local/coldsky/atlas` is a proof-of-concept sketch. Treat it as documentation and examples of ideas and flows, but do not modify it directly.
  - Use `atlas` for quick reference on bootstrapping, data-shaping, and UI ideas; copy/port small pieces into the new app rather than evolving `atlas` itself.

- New application (recommended)
  - Create a fresh app at `apps/livebs/` (or `demo/livebs/` if you prefer to keep demos together). This new app will contain the production-ready wiring:
    - `apps/livebs/src/boot.js` — application bootstrap and lifecycle
    - `apps/livebs/src/ingest/firehose-adapter.js` — adapter wrapping `firehose.js` to emit compact chunks
    - `apps/livebs/src/sim/allocator.js` — slot allocator, free-list, and CPU-side maps
    - `apps/livebs/src/sim/gpu-uploader.js` — texture staging, `injectParticles` helper and ping-pong sync
    - `apps/livebs/src/sim/graph-module.js` — Laplacian adjacency management and decay
    - `apps/livebs/src/ui/*` — React or plain DOM controls and REPL hooks

- demo kernels
  - Reuse patterns from `demo-kernels.js` where appropriate:
    - World bounds handling, color texture build logic.
    - Graph forces application path (`createGraphVelocityKernel`).
    - Title/method switching and REPL helpers.

- New glue
  - The `state()` concept from the `atlas` POC remains a useful design: implement an orchestrator in `apps/livebs/src/sim/orchestrator.js` that exposes a clean contract for ingestion, uploads, and GC:
    - Track `bubbles` (→ particles), maintain `entity→index`, `freeList`, `pendingUploads`, and `pendingEdges`.
    - Expose methods `addRecords`, `addProfiles` to process firehose slices.
    - Provide `flushUploads()` to push data to GPU between physics passes.


## Contracts (tiny)

- Inputs
  - Firehose/Offline records; current GL context and particle textures; time delta.
- Outputs
  - Updated textures (pos/vel/mass/color), updated edge textures/SSBOs, draw.
- Error modes
  - Exceed capacity → drop low-priority inserts, log counters.
  - WebSocket drop → auto-reconnect; backfill from offline if available.
  - Texture upload failure → mark indices dirty and retry next frame.
- Success
  - Smooth 60 FPS under typical load; visually coherent clusters; no unbounded memory growth.


## Edge cases

- Bursty traffic (viral threads): cap per-frame inserts; prioritize replies/quotes over likes.
- Author churn (handle changes): stable by DID; remap visuals without reallocation.
- Deletes/blocks: fade edges quickly; optionally hide content nodes.
- Very large degree hubs: cap per-node edge fanout for Laplacian step; sample edges.
- Reconnection: dedupe by URI/CID, ignore duplicates.


## Testing & verification

- REPL (daebug)
  - Toggle: method, G, damping, tau, max inserts/frame, edge weights.
  - Metrics: nodes, edges, dropped inserts, upload ms, graph ms, total frame ms.

- Offline smoke tests
  - Use CARs from `download-cars.js` to seed replay streams; simulate 1×–10× speed.

- Visual checks
  - Cluster formation around conversations; post nodes gravitate near their authors.
  - Negative gravity keeps global structure separated; Laplacian tightens local communities.


## Performance targets (initial)

- Capacity: 1–4 million preallocated slots (e.g., 2048²–4096²) depending on GPU.
- Sustained inserts: 2–10k entities/minute with negligible stutter.
- Graph updates: 100–300k edges active with decay and sampling.


## Milestones

1) Skeleton wiring
- Implement `state()` in `firehose-to-bubbles.js`: maps, free-list, pending buffers.
- Hook live firehose to `addRecords`/`addProfiles` and basic slot insertion.
- Upload positions/masses/colors for a few hundred nodes; render static.

2) Physics + graph
- Enable monopole negative gravity; tune damping.
- Add Laplacian module; build minimal adjacency textures; apply velocity pass.

3) Streaming + decay
- Batch uploads; incremental edge updates with decay.
- GC faded entities; free-list recycling.

4) Offline replay + knobs
- CAR-based replay; REPL controls; performance counters overlay.

5) Polish
- Better colors/sizing; flashes on events; tooltips/hover (optional).


## File layout (proposed changes)

- `demo/bs/local/coldsky/atlas/boot/firehose-to-bubbles.js`
  - Flesh out `state()` + export orchestrator to the `boot` layer.
- `demo/bs/local/coldsky/atlas/boot/…`
  - Bootstrapping glue to particle system (create textures, pass handles to uploader).
- `particle-system/graph-laplacian-kernels/*`
  - Reuse existing kernels; add helpers for dynamic updates if needed.


## Notes

- Keep code paths REPL-friendly (quick rebuilds on save).
- Start simple: one edge texture format, small textures; improve as constraints appear.
- Document constants inline for tuning (weights, tau, budgets).