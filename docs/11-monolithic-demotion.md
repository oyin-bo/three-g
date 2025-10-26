# 11: Monolithic Particle System Demotion

## Executive Summary

The three-g library has evolved to support multiple particle system implementations, with **kernel-based systems** (Monopole/Quadrupole/Spectral/Mesh kernels) representing the current architectural frontier. The monolithic implementations (legacy non-kernel classes) have been superseded by superior kernel variants in all key metrics: performance, maintainability, and GPU utilization.

This document outlines an orderly migration plan to:
1. **Designate** monolithic systems as deprecated/archived
2. **Relocate** monolithic code to a dedicated `monolithic/` subdirectory
3. **Promote** kernel-based implementations as the primary API
4. **Restructure** root-level demos to highlight kernels-based architecture

## Current Architecture Overview

### Monolithic Systems (To Be Demoted)

Located in `particle-system/` root:

| System | File | Status | Notes |
|--------|------|--------|-------|
| Quadrupole (Monolithic) | `gravity-quadrupole/` | Legacy | Tree-code with 2nd-order multipole moments |
| Monopole (Monolithic) | `gravity-monopole/` | Legacy | Tree-code with 1st-order multipole moments |
| Spectral (Monolithic) | `gravity-spectral/` | Legacy | FFT-based Particle-Mesh; heavy CPU orchestration |
| Mesh (Monolithic) | `gravity-mesh/` | Legacy | Direct grid-based gravitational potential |
| Main Exports | `index.js` | Monolithic-Primary | Exports `particleSystem()` function |

### Kernel-Based Systems (To Be Promoted)

Located in `particle-system/` subdirectories:

| System | File | Status | Notes |
|--------|------|--------|-------|
| Monopole (Kernels) | `gravity-multipole/particle-system-monopole-kernels.js` | **Current** | Leaner CPU, GPU-native compute |
| Quadrupole (Kernels) | `gravity-multipole/particle-system-quadrupole-kernels.js` | **Current** | Leaner CPU, GPU-native compute |
| Spectral (Kernels) | `gravity-spectral-kernels/` | **Current** | Optimized FFT pipeline with K-FFT |
| Mesh (Kernels) | `gravity-mesh-kernels/` | **Current** | Direct kernel-based assignment/integration |
| Main Exports | `particle-system-kernels.js` | Kernels-Primary | Exports `particleSystemKernels()` function |
| Demo | `demo-kernels.js` | Kernels-Primary | Full-featured demo highlighting kernels |

### Root-Level Demos (Current State)

| File | Architecture | Role |
|------|--------------|------|
| `index.html` | Monolithic | Primary demo (to move) |
| `demo.js` | Monolithic | Main demo logic (to move) |
| `index-kernels.html` | Kernels | Alternate demo (to become primary) |
| `demo-kernels.js` | Kernels | Kernels demo logic (to become primary) |
| `simplistic.html` | Monolithic | Pure rendering demo |
| `simplistic.js` | Monolithic | Pure rendering logic |
| `texture-mode.html` | Monolithic | Custom GPGPU integration |
| `texture-mode.js` | Monolithic | Custom GPGPU logic |

### Supporting Infrastructure

| Directory | Purpose |
|-----------|---------|
| `particle-system/graph-laplacian/` | Force-directed layout (monolithic) |
| `particle-system/graph-laplacian-kernels/` | Force-directed layout (kernels) |
| `particle-system/utils/` | Shared utilities (both) |
| `particle-system/shaders/` | Shared shader code (both) |

## Naming Convention Swap

### Current Naming Paradigm (Legacy-Default)

- **Monolithic systems**: Suffixless names (e.g., `ParticleSystemMonopole`, `particle-system-monopole.js`)
- **Kernel systems**: `-kernels` suffix (e.g., `ParticleSystemMonopoleKernels`, `particle-system-monopole-kernels.js`)
- **Directory names**: `-kernels` suffix for kernel variants (e.g., `gravity-spectral-kernels/`, `gravity-mesh-kernels/`)

### New Naming Paradigm (Kernels-Default)

After demotion, the naming should reflect architectural reality:

- **Kernel systems** (Primary): Suffixless, clean names (e.g., `ParticleSystemMonopole`, `particle-system-monopole.js`)
- **Monolithic systems** (Legacy): `-monolithic` suffix (e.g., `ParticleSystemMonolithicMonopole`, `particle-system-monolithic-monopole.js`)
- **Directory names**: Clean names for kernels (e.g., `gravity-spectral/`, `gravity-mesh/`), `-monolithic` suffix for legacy

### Renaming Specification

#### File Renames (Kernels-Based, in particle-system/)

| Current (kernels) | New (suffixless) | Location |
|-------------------|------------------|----------|
| `particle-system-monopole-kernels.js` | `particle-system-monopole.js` | `gravity-multipole/` |
| `particle-system-quadrupole-kernels.js` | `particle-system-quadrupole.js` | `gravity-multipole/` |
| `particle-system-spectral-kernels.js` | `particle-system-spectral.js` | `gravity-spectral/` |
| `particle-system-mesh-kernels.js` | `particle-system-mesh.js` | `gravity-mesh/` |
| `particle-system-kernels.js` | `particle-system.js` | `particle-system/` (root) |

#### Class Renames (Kernels-Based, becomes default)

| Current (kernels) | New (suffixless) | Notes |
|-------------------|------------------|-------|
| `ParticleSystemMonopoleKernels` | `ParticleSystemMonopole` | `gravity-multipole/particle-system-monopole.js` |
| `ParticleSystemQuadrupoleKernels` | `ParticleSystemQuadrupole` | `gravity-multipole/particle-system-quadrupole.js` |
| `ParticleSystemSpectralKernels` | `ParticleSystemSpectral` | `gravity-spectral-kernels/particle-system-spectral.js` |
| `ParticleSystemMeshKernels` | `ParticleSystemMesh` | `gravity-mesh-kernels/particle-system-mesh.js` |

#### Directory Renames (Kernels-Based, becomes primary structure)

| Current (kernels) | New (suffixless) | Contains |
|-------------------|------------------|----------|
| `gravity-spectral-kernels/` | `gravity-spectral/` | K-FFT, K-Poisson, K-Deposit, K-Integrate, etc. |
| `gravity-mesh-kernels/` | `gravity-mesh/` | K-Deposit, K-Integrate for mesh method |
| `graph-laplacian-kernels/` | `graph-laplacian/` | Kernel-based force-directed layout |

#### File Renames (Monolithic-Based, moved to monolithic/)

| Current (monolithic) | New (with -monolithic) | Location |
|----------------------|------------------------|----------|
| `particle-system-quadrupole.js` | `particle-system-monolithic-quadrupole.js` | `monolithic/particle-system/gravity-quadrupole/` |
| `particle-system-monopole.js` | `particle-system-monolithic-monopole.js` | `monolithic/particle-system/gravity-monopole/` |
| `particle-system-spectral.js` | `particle-system-monolithic-spectral.js` | `monolithic/particle-system/gravity-spectral/` |
| `particle-system-mesh.js` | `particle-system-monolithic-mesh.js` | `monolithic/particle-system/gravity-mesh/` |
| `index.js` (in particle-system) | `particle-system-monolithic.js` | `monolithic/particle-system/` |

#### Class Renames (Monolithic-Based, becomes legacy)

| Current (monolithic) | New (with -monolithic) | Notes |
|----------------------|------------------------|-------|
| `ParticleSystemQuadrupole` | `ParticleSystemMonolithicQuadrupole` | `monolithic/particle-system/gravity-quadrupole/` |
| `ParticleSystemMonopole` | `ParticleSystemMonolithicMonopole` | `monolithic/particle-system/gravity-monopole/` |
| `ParticleSystemSpectral` | `ParticleSystemMonolithicSpectral` | `monolithic/particle-system/gravity-spectral/` |
| `ParticleSystemMesh` | `ParticleSystemMonolithicMesh` | `monolithic/particle-system/gravity-mesh/` |

#### Export Function Renames

| Current | New | Location | Architecture |
|---------|-----|----------|--------------|
| `particleSystemKernels()` | `particleSystem()` | `particle-system/particle-system.js` | Kernels (primary) |
| `particleSystem()` | `particleSystemMonolithic()` | `monolithic/particle-system/particle-system-monolithic.js` | Monolithic (legacy) |

### Directory Structure After Renaming

```
particle-system/                           (kernels-based, primary)
├── gravity-multipole/
│   ├── particle-system-monopole.js        (was: -kernels)
│   ├── particle-system-quadrupole.js      (was: -kernels)
│   ├── k-*.js
│   └── shaders/
├── gravity-spectral/                      (was: gravity-spectral-kernels/)
│   ├── particle-system-spectral.js        (was: -kernels)
│   ├── k-*.js
│   └── shaders/
├── gravity-mesh/                          (was: gravity-mesh-kernels/)
│   ├── particle-system-mesh.js            (was: -kernels)
│   ├── k-*.js
│   └── shaders/
├── graph-laplacian/                       (was: graph-laplacian-kernels/)
│   ├── laplacian-force-module.js
│   └── k-*.js
├── particle-system.js                     (was: particle-system-kernels.js; exports particleSystem())
├── utils/
├── shaders/
└── test-utils.js

monolithic/                                (monolithic-based, legacy)
├── particle-system/
│   ├── gravity-quadrupole/
│   │   └── particle-system-monolithic-quadrupole.js
│   ├── gravity-monopole/
│   │   └── particle-system-monolithic-monopole.js
│   ├── gravity-spectral/
│   │   ├── particle-system-monolithic-spectral.js
│   │   └── pm-*.js (pipeline orchestration)
│   ├── gravity-mesh/
│   │   └── particle-system-monolithic-mesh.js
│   ├── graph-laplacian/
│   │   └── laplacian-force-module.js
│   ├── particle-system-monolithic.js      (exports particleSystemMonolithic())
│   └── diag.js
├── index.html
├── demo.js
├── simplistic.html
├── simplistic.js
├── texture-mode.html
├── texture-mode.js
└── README.md
```

## Migration Plan

### Phase 1: Directory Structure Reorganization & Renaming

This phase involves two concurrent operations:
1. **Directory restructuring**: Move monolithic systems to `monolithic/`, promote kernels to primary
2. **Naming convention swap**: Remove `-kernels` suffix from files/classes; add `-monolithic` to legacy code

#### 1.1 Rename Kernel Files (In particle-system/)

**File Renames** (primary architecture):

```bash
# gravity-multipole/
particle-system-monopole-kernels.js     → particle-system-monopole.js
particle-system-quadrupole-kernels.js   → particle-system-quadrupole.js

# gravity-spectral-kernels/ directory renamed to gravity-spectral/
particle-system-spectral-kernels.js     → gravity-spectral/particle-system-spectral.js

# gravity-mesh-kernels/ directory renamed to gravity-mesh/
particle-system-mesh-kernels.js         → gravity-mesh/particle-system-mesh.js

# graph-laplacian-kernels/ directory renamed to graph-laplacian/
# (retain existing graph-laplacian/laplacian-force-module.js naming)

# particle-system/ root
particle-system-kernels.js              → particle-system.js

# Export function rename
export function particleSystemKernels() → export function particleSystem()
```

**Class Renames** (primary architecture):

```javascript
// gravity-multipole/particle-system-monopole.js
export class ParticleSystemMonopoleKernels → export class ParticleSystemMonopole

// gravity-multipole/particle-system-quadrupole.js
export class ParticleSystemQuadrupoleKernels → export class ParticleSystemQuadrupole

// gravity-spectral/particle-system-spectral.js
export class ParticleSystemSpectralKernels → export class ParticleSystemSpectral

// gravity-mesh/particle-system-mesh.js
export class ParticleSystemMeshKernels → export class ParticleSystemMesh
```

**Directory Renames** (primary architecture):

```bash
gravity-spectral-kernels/    → gravity-spectral/
gravity-mesh-kernels/        → gravity-mesh/
graph-laplacian-kernels/     → graph-laplacian/
```

#### 1.2 Rename Monolithic Files (Move to monolithic/)

When moving monolithic systems to `monolithic/particle-system/`, rename them with `-monolithic` suffix:

**File Renames** (legacy architecture):

```bash
# monolithic/particle-system/gravity-quadrupole/
particle-system-quadrupole.js           → particle-system-monolithic-quadrupole.js

# monolithic/particle-system/gravity-monopole/
particle-system-monopole.js             → particle-system-monolithic-monopole.js

# monolithic/particle-system/gravity-spectral/
particle-system-spectral.js             → particle-system-monolithic-spectral.js

# monolithic/particle-system/gravity-mesh/
particle-system-mesh.js                 → particle-system-monolithic-mesh.js

# monolithic/particle-system/
index.js                                → particle-system-monolithic.js

# Export function rename
export function particleSystem()        → export function particleSystemMonolithic()
```

**Class Renames** (legacy architecture):

```javascript
// monolithic/particle-system/gravity-quadrupole/particle-system-monolithic-quadrupole.js
export class ParticleSystemQuadrupole → export class ParticleSystemMonolithicQuadrupole

// monolithic/particle-system/gravity-monopole/particle-system-monolithic-monopole.js
export class ParticleSystemMonopole → export class ParticleSystemMonolithicMonopole

// monolithic/particle-system/gravity-spectral/particle-system-monolithic-spectral.js
export class ParticleSystemSpectral → export class ParticleSystemMonolithicSpectral

// monolithic/particle-system/gravity-mesh/particle-system-monolithic-mesh.js
export class ParticleSystemMesh → export class ParticleSystemMonolithicMesh
```

#### 1.3 Create Renamed Directory Structure

After renames, structure is:

```
particle-system/                           (kernels-based, PRIMARY)
├── gravity-multipole/
│   ├── particle-system-monopole.js        (was: -kernels)
│   ├── particle-system-quadrupole.js      (was: -kernels)
│   ├── k-*.js                             (kernel implementations)
│   └── shaders/
├── gravity-spectral/                      (was: gravity-spectral-kernels/, renamed)
│   ├── particle-system-spectral.js        (was: particle-system-spectral-kernels.js)
│   ├── k-*.js
│   └── shaders/
├── gravity-mesh/                          (was: gravity-mesh-kernels/, renamed)
│   ├── particle-system-mesh.js            (was: particle-system-mesh-kernels.js)
│   ├── k-*.js
│   └── shaders/
├── graph-laplacian/                       (was: graph-laplacian-kernels/, renamed)
│   ├── laplacian-force-module.js
│   └── k-*.js
├── particle-system.js                     (was: particle-system-kernels.js, exports particleSystem())
├── utils/
├── shaders/
└── test-utils.js

monolithic/                                (monolithic-based, LEGACY)
├── particle-system/
│   ├── gravity-quadrupole/
│   │   ├── particle-system-monolithic-quadrupole.js
│   │   ├── debug/
│   │   └── shaders/
│   ├── gravity-monopole/
│   │   └── particle-system-monolithic-monopole.js
│   ├── gravity-spectral/
│   │   ├── particle-system-monolithic-spectral.js  (was: particle-system-spectral.js)
│   │   ├── pm-*.js                                 (pipeline orchestration, renamed: pm-monolithic-*.js)
│   │   ├── debug/
│   │   └── shaders/
│   ├── gravity-mesh/
│   │   └── particle-system-monolithic-mesh.js
│   ├── graph-laplacian/
│   │   └── laplacian-force-module.js
│   ├── particle-system-monolithic.js      (was: index.js, exports particleSystemMonolithic())
│   └── diag.js
├── index.html
├── demo.js
├── simplistic.html
├── simplistic.js
├── texture-mode.html
├── texture-mode.js
└── README.md

root/
├── index.html                             (NEW: promote from index-kernels.html)
├── index.js                               (primary entry point, updated exports)
├── demo.js                                (NEW: promote from demo-kernels.js)
├── demo.css                               (unchanged)
├── particle-system/                       (kernels-based, PROMOTED to primary)
├── monolithic/                            (legacy systems, DEMOTED)
├── README.md                              (updated)
└── docs/
    └── 11-monolithic-demotion.md          (this file)
```

### Phase 2: Kernel System Renaming & Promotion

This phase renames kernel systems in-place (removing `-kernels` suffixes) and promotes them to primary status.

#### 2.1 Step 1: Rename Directory Names (kernels)

```bash
# Rename kernel directories to suffixless names:
particle-system/gravity-spectral-kernels/  → particle-system/gravity-spectral/
particle-system/gravity-mesh-kernels/      → particle-system/gravity-mesh/
particle-system/graph-laplacian-kernels/   → particle-system/graph-laplacian/
```

**Note**: `gravity-multipole/` is already suffixless; it contains both monopole and quadrupole kernel variants.

#### 2.2 Step 2: Rename Kernel Files (Monolithic→Kernels)

Remove `-kernels` suffix from all kernel-based particle system files:

```bash
# gravity-multipole directory:
particle-system-monopole-kernels.js     → particle-system-monopole.js
particle-system-quadrupole-kernels.js   → particle-system-quadrupole.js

# gravity-spectral directory (after renaming):
particle-system-spectral-kernels.js     → particle-system-spectral.js

# gravity-mesh directory (after renaming):
particle-system-mesh-kernels.js         → particle-system-mesh.js

# particle-system root:
particle-system-kernels.js              → particle-system.js
```

#### 2.3 Step 3: Rename Kernel Classes (Monolithic→Kernels)

Update all class exports and imports in `particle-system/`:

**Kernel Monopole** (gravity-multipole/particle-system-monopole.js):
```javascript
export class ParticleSystemMonopoleKernels → export class ParticleSystemMonopole
```

**Kernel Quadrupole** (gravity-multipole/particle-system-quadrupole.js):
```javascript
export class ParticleSystemQuadrupoleKernels → export class ParticleSystemQuadrupole
```

**Kernel Spectral** (gravity-spectral/particle-system-spectral.js):
```javascript
export class ParticleSystemSpectralKernels → export class ParticleSystemSpectral
```

**Kernel Mesh** (gravity-mesh/particle-system-mesh.js):
```javascript
export class ParticleSystemMeshKernels → export class ParticleSystemMesh
```

**Kernel System Root** (particle-system/particle-system.js):
```javascript
// OLD export name:
export function particleSystemKernels(options) { ... }

// NEW export name (becomes primary):
export function particleSystem(options) { ... }
```

#### 2.4 Step 4: Update Imports Throughout particle-system/

Update all import statements that reference renamed kernel files:

**In particle-system/particle-system.js** (was particle-system-kernels.js):
```javascript
// OLD:
import { ParticleSystemMonopoleKernels } from './gravity-multipole/particle-system-monopole-kernels.js';
import { ParticleSystemQuadrupoleKernels } from './gravity-multipole/particle-system-quadrupole-kernels.js';
import { ParticleSystemSpectralKernels } from './gravity-spectral-kernels/particle-system-spectral-kernels.js';
import { ParticleSystemMeshKernels } from './gravity-mesh-kernels/particle-system-mesh-kernels.js';

// NEW:
import { ParticleSystemMonopole } from './gravity-multipole/particle-system-monopole.js';
import { ParticleSystemQuadrupole } from './gravity-multipole/particle-system-quadrupole.js';
import { ParticleSystemSpectral } from './gravity-spectral/particle-system-spectral.js';
import { ParticleSystemMesh } from './gravity-mesh/particle-system-mesh.js';
```

**In all test files** throughout particle-system/ directories:
- `*.test.js` files that import renamed classes
- Search: `ParticleSystemMonopoleKernels` → replace with `ParticleSystemMonopole`
- Search: `ParticleSystemSpectralKernels` → replace with `ParticleSystemSpectral`
- Search: `ParticleSystemMeshKernels` → replace with `ParticleSystemMesh`
- Search: `ParticleSystemQuadrupoleKernels` → replace with `ParticleSystemQuadrupole`

**In all kernel files** (k-*.js):
- Update JSDoc type hints and comments
- Update import paths for renamed directories

### Phase 3: Monolithic System Renaming & Archival

This phase moves monolithic systems to `monolithic/` AND renames them with `-monolithic` suffix.

#### 3.1 Step 1: Move Monolithic Directories

Move entire monolithic particle system components to `monolithic/particle-system/`:

```bash
# Create monolithic archive structure
mkdir -p monolithic/particle-system

# Move monolithic systems:
particle-system/gravity-quadrupole/     → monolithic/particle-system/gravity-quadrupole/
particle-system/gravity-monopole/       → monolithic/particle-system/gravity-monopole/
particle-system/gravity-spectral/       → monolithic/particle-system/gravity-spectral/  # (OLD, before kernel rename)
particle-system/gravity-mesh/           → monolithic/particle-system/gravity-mesh/  # (OLD, before kernel rename)
particle-system/graph-laplacian/        → monolithic/particle-system/graph-laplacian/  # (OLD, before kernel rename)
particle-system/diag.js                 → monolithic/particle-system/diag.js
```

#### 3.2 Step 2: Rename Monolithic Particle System Files

After moving to `monolithic/particle-system/`, add `-monolithic` suffix to avoid conflicts:

```bash
# monolithic/particle-system/gravity-quadrupole/
particle-system-quadrupole.js           → particle-system-monolithic-quadrupole.js

# monolithic/particle-system/gravity-monopole/
particle-system-monopole.js             → particle-system-monolithic-monopole.js

# monolithic/particle-system/gravity-spectral/
particle-system-spectral.js             → particle-system-monolithic-spectral.js

# monolithic/particle-system/gravity-mesh/
particle-system-mesh.js                 → particle-system-monolithic-mesh.js

# monolithic/particle-system/ (root)
index.js                                → particle-system-monolithic.js

# Rename monolithic pipeline files (gravity-spectral only, not used in kernels):
pm-poisson.js                           → pm-monolithic-poisson.js
pm-grid.js                              → pm-monolithic-grid.js
pm-pipeline.js                          → pm-monolithic-pipeline.js
pm-gradient.js                          → pm-monolithic-gradient.js
pm-force-sample.js                      → pm-monolithic-force-sample.js
pm-deposit.js                           → pm-monolithic-deposit.js
pm-fft.js                               → pm-monolithic-fft.js
```

#### 3.3 Step 3: Rename Monolithic Classes

Update all class exports in moved/renamed files:

**Monolithic Quadrupole** (monolithic/particle-system/gravity-quadrupole/particle-system-monolithic-quadrupole.js):
```javascript
export class ParticleSystemQuadrupole → export class ParticleSystemMonolithicQuadrupole
```

**Monolithic Monopole** (monolithic/particle-system/gravity-monopole/particle-system-monolithic-monopole.js):
```javascript
export class ParticleSystemMonopole → export class ParticleSystemMonolithicMonopole
```

**Monolithic Spectral** (monolithic/particle-system/gravity-spectral/particle-system-monolithic-spectral.js):
```javascript
export class ParticleSystemSpectral → export class ParticleSystemMonolithicSpectral
```

**Monolithic Mesh** (monolithic/particle-system/gravity-mesh/particle-system-monolithic-mesh.js):
```javascript
export class ParticleSystemMesh → export class ParticleSystemMonolithicMesh
```

**Monolithic System Root** (monolithic/particle-system/particle-system-monolithic.js):
```javascript
// OLD export name (from original particle-system/index.js):
export function particleSystem(options) { ... }

// NEW export name (becomes legacy):
export function particleSystemMonolithic(options) { ... }
```

#### 3.4 Step 4: Update Imports in Monolithic Files

After moving/renaming, update all imports in `monolithic/particle-system/`:

**In monolithic/particle-system/particle-system-monolithic.js:**
```javascript
// OLD (from original particle-system/index.js):
import { ParticleSystemMesh } from './gravity-mesh/particle-system-mesh.js';
import { ParticleSystemMonopole } from './gravity-monopole/particle-system-monopole.js';
import { ParticleSystemQuadrupole } from './gravity-quadrupole/particle-system-quadrupole.js';
import { ParticleSystemSpectral } from './gravity-spectral/particle-system-spectral.js';

// NEW (after renames):
import { ParticleSystemMonolithicMesh } from './gravity-mesh/particle-system-monolithic-mesh.js';
import { ParticleSystemMonolithicMonopole } from './gravity-monopole/particle-system-monolithic-monopole.js';
import { ParticleSystemMonolithicQuadrupole } from './gravity-quadrupole/particle-system-monolithic-quadrupole.js';
import { ParticleSystemMonolithicSpectral } from './gravity-spectral/particle-system-monolithic-spectral.js';
```

**In monolithic particle system files:**
- Update imports in all system-specific files
- Update JSDoc type hints to reference renamed classes
- Update references in debug/ subdirectories

**In monolithic pipeline files** (gravity-spectral/pm-monolithic-*.js):
```javascript
// OLD reference:
import { ParticleSystemSpectral } from './particle-system-spectral.js';

// NEW reference:
import { ParticleSystemMonolithicSpectral } from './particle-system-monolithic-spectral.js';
```

### Phase 4: Move Monolithic Demo Files & Update Root Exports

#### 2.3 Promote Kernel Demos to Root

**Action**: Create new primary demos at root level:
- Create new `index.html` based on `monolithic/index-kernels.html` (adjust import paths)
- Create new `demo.js` based on `monolithic/demo-kernels.js` (no path changes needed)

**Rationale**:
- `index-kernels.html` becomes primary (`index.html`)
- `demo-kernels.js` becomes primary (`demo.js`)
- These are the forward-looking implementations with superior architecture

#### 2.4 Update Import Paths

For files remaining in `particle-system/`, update imports from monolithic systems:

**In monolithic/particle-system/index.js:**
```javascript
// OLD (would break after move):
import { ParticleSystemQuadrupole } from './gravity-quadrupole/...';

// Must remain same relative to monolithic/particle-system/ after move
// (No changes needed if directory structure preserved)
```

**In root-level files that reference particle systems:**
- `mass-spot-mesh.js` – check for imports; likely compatible
- `index.js` (main entry) – verify exports
- Other utilities – check imports

### Phase 4: Move Monolithic Demo Files & Update Root Exports

#### 4.1 Move Demo HTML/JS to monolithic/

Move root-level monolithic demo files:

```bash
# Move monolithic demos:
index.html          → monolithic/index.html
demo.js             → monolithic/demo.js
simplistic.html     → monolithic/simplistic.html
simplistic.js       → monolithic/simplistic.js
texture-mode.html   → monolithic/texture-mode.html
texture-mode.js     → monolithic/texture-mode.js
```

#### 4.2 Promote Kernel Demos to Root

Create new primary demos at root level from kernel variants:

```bash
# Copy kernel demos to root:
index-kernels.html  → index.html (remove -kernels from title)
demo-kernels.js     → demo.js
```

#### 4.3 Update HTML Import Paths in Demos

**In monolithic/index.html** (moved from root):
- Update `<script type="importmap">` import map:
  ```javascript
  "three-g": "./index.js"        → "three-g": "../index.js"
  "three-g/": "./"               → "three-g/": "../"
  ```
- Update `<link rel="stylesheet" href="demo.css">` to `href="../demo.css"`

**In monolithic/simplistic.html** & **monolithic/texture-mode.html**:
- Same import path updates as above

#### 4.4 Update Root-Level Exports (index.js)

Update `root/index.js` to export both architectures:

```javascript
// Primary (Kernels) - becomes default
export { particleSystem } from './particle-system/particle-system.js';

// Legacy (Monolithic) - re-exported for backward compatibility
export { particleSystemMonolithic } from './monolithic/particle-system/particle-system-monolithic.js';

// Supporting exports
export { massSpotMesh } from './mass-spot-mesh.js';
export * from './particle-system/utils/index.js';
export * from './particle-system/particle-system.js';  // exports all particle-system exports
```

#### 4.5 Update package.json Export Map

Update `package.json` to support both imports:

```json
{
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./kernels": "./particle-system/particle-system.js",
    "./monolithic": "./monolithic/particle-system/particle-system-monolithic.js",
    "./*": "./*"
  }
}
```

This enables:
```javascript
// Use kernels (primary):
import { particleSystem } from 'three-g';
import { particleSystem } from 'three-g/kernels';

// Use monolithic (legacy):
import { particleSystemMonolithic } from 'three-g/monolithic';

// Legacy compat:
import { particleSystemMonolithic as particleSystem } from 'three-g/monolithic';
```

### Phase 5: Documentation & Deprecation Notices

#### 5.1 Create Monolithic Deprecation README

**File**: `monolithic/README.md`

```markdown
# Monolithic Particle Systems (Deprecated)

## Status
These implementations have been superseded by **kernel-based** particle systems.

## What Changed
- **Kernel implementations** provide superior GPU utilization
- **Reduced CPU overhead** through direct WebGL compute
- **Unified architecture** across all methods (Monopole, Quadrupole, Spectral, Mesh)

## Using Monolithic Systems

To use legacy monolithic systems:

```javascript
import { particleSystemMonolithic } from './monolithic/particle-system/particle-system-monolithic.js';

const physics = particleSystemMonolithic({
  gl,
  particles,
  method: 'quadrupole', // or 'monopole', 'spectral', 'mesh'
  ...options
});
```

## Migration Path

See `docs/11-monolithic-demotion.md` for full migration strategy.

Recommended: Use **kernel-based** systems instead:

```javascript
import { particleSystem } from './particle-system/particle-system.js';

const physics = particleSystem({
  gl,
  particles,
  method: 'quadrupole',
  ...options
});
```

## Available Demos

- **Monolithic Demos**: `monolithic/index.html`, `monolithic/simplistic.html`
- **Kernel Demos**: `index.html` (root) – **Recommended**
```

#### 5.2 Update Root README.md

Add deprecation notice to `README.md`:

```markdown
## Architecture: Kernel-Based Systems (Current)

The primary physics implementations now use **kernel-based architecture** for optimal GPU utilization.

### Legacy Systems

Monolithic particle system implementations have been relocated to `monolithic/` directory and are maintained for backward compatibility but no longer recommended for new projects.

See `docs/11-monolithic-demotion.md` for migration details.
```

#### 5.3 Add JSDoc Deprecation Warnings

In `monolithic/particle-system/particle-system-monolithic.js`:

```javascript
/**
 * @deprecated Use particleSystem() from particle-system.js instead
 * 
 * Create a GPU-accelerated N-body simulation (monolithic architecture)
 * 
 * This implementation is maintained for backward compatibility but superseded
 * by kernel-based systems which provide superior performance and maintainability.
 * 
 * @see particleSystem
 * @see docs/11-monolithic-demotion.md
 */
export function particleSystemMonolithic({ ... }) {
  // ...
}
```

### Phase 6: Link & Navigation Updates

#### 6.1 Update HTML Navigation Links

**In new root `index.html` (from index-kernels.html)**:
```html
#### 6.1 Update HTML Navigation Links

**In root index.html** (from renamed index-kernels.html):
```html
<div class="bottom-right-panel">
  <a href="monolithic/index.html">Classic Demo</a>
  &nbsp;
  <a href="monolithic/simplistic.html">Simplistic</a>
  &nbsp;
  <a href="monolithic/texture-mode.html">Texture Mode</a>
</div>
```

**In monolithic/index.html**:
```html
<div class="bottom-right-panel">
  <a href="../index.html">Kernel Demo (Current)</a>
  &nbsp;
  <a href="simplistic.html">Simplistic</a>
  &nbsp;
  <a href="texture-mode.html">Texture Mode</a>
</div>
```

#### 6.2 Update monolithic/*.html import paths

For all HTML files moved to `monolithic/`:
- Update `<script type="importmap">` import paths to parent directory
- Update CSS paths relative to new location
- Update script src if needed

Example for `monolithic/index.html`:
```html
<script type="importmap">
{
  "imports": {
    "three": "https://threejs.org/build/three.module.js",
    "three/examples/": "https://threejs.org/examples/",
    "three/addons/": "https://threejs.org/examples/jsm/",
    "three-pop": "https://esm.sh/three-pop",
    "three-g": "../index.js",
    "three-g/": "../"
  }
}
</script>

<link rel="stylesheet" href="../demo.css">
```

#### 6.3 Update monolithic demo JS files

In `monolithic/demo.js` (moved from root):
```javascript
// OLD (root imports):
import { particleSystem } from "./particle-system/index.js";

// NEW (from monolithic/ subdirectory):
import { particleSystemMonolithic } from "./particle-system/particle-system-monolithic.js";
```

### Phase 7: Testing & Validation

#### 7.1 Run All Test Suites

Verify both kernel and monolithic systems work after renaming:

```bash
# Test kernel systems (renamed, promoted)
npm test -- particle-system/

# Test monolithic systems (renamed, archived)
npm test -- monolithic/particle-system/
```

#### 7.2 Run All Demos via REPL

Test all demo pages are accessible and functional:

1. **Root demos (kernels)**:
   - `http://localhost:8768/index.html` – main demo
   - Check REPL: `window.physics ? 'kernels ok' : 'failed'`

2. **Monolithic demos (legacy)**:
   - `http://localhost:8768/monolithic/index.html` – legacy demo
   - `http://localhost:8768/monolithic/simplistic.html` – rendering only
   - Check REPL: `window.physics ? 'monolithic ok' : 'failed'`

#### 7.3 Verify Import Paths

Test that all imports resolve correctly:

```javascript
// Should work (kernels primary):
const { particleSystem } = await import('three-g/particle-system/particle-system.js');

// Should work (legacy via export):
const { particleSystemMonolithic } = await import('three-g/monolithic/particle-system/particle-system-monolithic.js');

// Should work (package exports):
import { particleSystem } from 'three-g';  // kernels
import { particleSystemMonolithic } from 'three-g/monolithic';  // legacy
```

#### 7.4 Verify Backward Compatibility

Check that legacy imports still work (with deprecation warnings):

```javascript
// OLD code (still works):
import { particleSystem } from 'three-g/monolithic/particle-system/particle-system-monolithic.js';

// NEW code (recommended):
import { particleSystem } from 'three-g';
```
```

**In `monolithic/index.html`**:
```html
<div class="bottom-right-panel">
  <!-- Link back to current demos -->
  <a href="../index.html">Kernel Demo (Current)</a>
  &nbsp;
  <a href="simplistic.html">Simplistic</a>
  &nbsp;
  <a href="texture-mode.html">Texture Mode</a>
</div>
```

#### 4.2 Update monolithic/*.html import paths

For all HTML files moved to `monolithic/`:
- Update `<script src="demo.js">` → `<script src="demo.js">` (unchanged, same directory)
- Update CSS paths: `<link rel="stylesheet" href="demo.css">` → relative path from new location
- Update importmap: `"three-g": "./index.js"` → `"three-g": "../index.js"`

Example for `monolithic/index.html`:
```html
<script type="importmap">
{
  "imports": {
    "three": "https://threejs.org/build/three.module.js",
    "three/examples/": "https://threejs.org/examples/",
    "three/addons/": "https://threejs.org/examples/jsm/",
    "three-pop": "https://esm.sh/three-pop",
    "three-g": "../index.js",
    "three-g/": "../"
  }
}
</script>

<link rel="stylesheet" href="../demo.css">
```

**For monolithic demo JS files** that import from `particle-system/`:

In `monolithic/demo.js`:
```javascript
// OLD (root location):
import { particleSystem } from "./particle-system/index.js";

// NEW (from monolithic/ subdirectory):
import { particleSystem } from "../monolithic/particle-system/index.js";
// OR use node_modules resolution:
import { particleSystem } from "three-g/monolithic/particle-system/index.js";
```

### Phase 5: Kernel-Based Demos at Root

#### 5.1 Copy index-kernels.html → index.html

Create new `index.html` in root by copying `index-kernels.html`:

```html
<!DOCTYPE html>
<html lang="en" style="background: black; color: white;">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Gravity: three-g ⧸𝗻𝗽𝗺</title>
  <link rel="stylesheet" href="demo.css">
</head>

<body>
<script type="importmap">
{
  "imports": {
    "three": "https://threejs.org/build/three.module.js",
    "three/examples/": "https://threejs.org/examples/",
    "three/addons/": "https://threejs.org/examples/jsm/",
    "three-pop": "https://esm.sh/three-pop",
    "three-g": "./index.js",
    "three-g/": "./"
  }
}
</script>

<!-- Controls Panel -->
<div id="controls-panel">
  <input type="text" id="count-input" value="50,000">
  <!-- ... controls ... -->
</div>

<script src="demo.js" type="module"></script>

<div class="bottom-right-panel">
  <!-- Link to legacy demos in monolithic/ -->
  <a href="monolithic/index.html">Classic Demo</a>
  &nbsp;
  <a href="monolithic/simplistic.html">Simplistic</a>
  &nbsp;
  <a href="monolithic/texture-mode.html">Texture Mode</a>
</div>

</body>
</html>
```

#### 5.2 Copy demo-kernels.js → demo.js

Create new `demo.js` in root by copying `demo-kernels.js`:

No import path changes needed (it already imports from `./particle-system/...`).

**Note**: After moving old `demo.js` to monolithic, the old one needs import adjustments:

In `monolithic/demo.js`:
```javascript
// OLD import (from root):
import { particleSystem } from "./particle-system/index.js";

// NEW import (from monolithic/):
import { particleSystem } from "./particle-system/index.js";
// ^ still works! stays relative within monolithic/
```

### Phase 6: Import/Export Consolidation

#### 6.1 Root index.js Exports

Ensure `index.js` remains the primary entry point, exporting both APIs for compatibility:

```javascript
// Primary (Kernels)
export { particleSystemKernels } from './particle-system/particle-system-kernels.js';

// Legacy (Monolithic) - re-export from archived location
export { particleSystem } from './monolithic/particle-system/index.js';

// Supporting exports
export { massSpotMesh } from './mass-spot-mesh.js';
export * from './particle-system/utils/index.js';
```

#### 6.2 package.json Entry Points

Update `package.json` to maintain backward compatibility:

```json
{
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./kernels": "./particle-system/particle-system-kernels.js",
    "./monolithic": "./monolithic/particle-system/index.js",
    "./*": "./*"
  }
}
```

This allows both:
```javascript
import { particleSystemKernels } from 'three-g/kernels';
import { particleSystem } from 'three-g/monolithic';
import { particleSystem } from 'three-g'; // legacy compat
```

## Execution Plan (Recommended Phases)

This plan is presented as ordered phases rather than timeboxed weeks. Execute phases in sequence; teams can schedule them using their preferred cadence.

### Phase: Planning & Inventory
- [ ] Review this document with the team
- [ ] Inventory all files that require renaming or moving (see Naming Specification)
- [ ] Run test suites for both kernel and monolithic systems
- [ ] Verify current demos function as expected

### Phase: Kernel System Renaming (In-Place)
- [ ] Rename kernel directories to remove `-kernels` suffix (e.g., `gravity-spectral-kernels/` → `gravity-spectral/`)
- [ ] Rename kernel particle system files (`particle-system-*-kernels.js` → `particle-system-*.js`)
- [ ] Rename kernel classes (drop `Kernels` suffix)
- [ ] Update all imports and tests referencing renamed kernel files/classes
- [ ] Rename export function: `particleSystemKernels()` → `particleSystem()`

### Phase: Monolithic System Archival & Renaming
- [ ] Move monolithic directories into `monolithic/particle-system/`
- [ ] Rename monolithic particle system files to add `-monolithic` suffix (avoid name collisions)
- [ ] Rename monolithic classes to include `Monolithic` in their names
- [ ] Rename monolithic pipeline files (gravity-spectral PM pipeline) with `pm-monolithic-*` pattern
- [ ] Update all imports and debug code referencing monolithic files/classes
- [ ] Rename export function: `particleSystem()` → `particleSystemMonolithic()`

### Phase: Demo Reorganization & Root Updates
- [ ] Move legacy demo files into `monolithic/` and adjust import paths
- [ ] Promote kernel demos to root (`index-kernels.html` → `index.html`, `demo-kernels.js` → `demo.js`)
- [ ] Update HTML navigation links to point between kernel and monolithic demos
- [ ] Update root `index.js` exports to expose both kernel and monolithic APIs
- [ ] Update `package.json` export map to provide explicit entry points for kernels and monolithic exports

### Phase: Testing, Documentation & Validation
- [ ] Run unit and integration tests for both architectures
- [ ] Test all demos in the browser and via the daebug REPL
- [ ] Verify import paths resolve for both package and local imports
- [ ] Add `monolithic/README.md` with deprecation and migration guidance
- [ ] Update root `README.md` and add JSDoc deprecation warnings in monolithic exports

### Phase: Release & Housekeeping
- [ ] Review the complete set of changes and confirm tests and demos pass
- [ ] Commit with clear messages describing renames and archival
- [ ] Tag the repository for release and update the CHANGELOG
- [ ] Publish release notes explaining the naming swap and migration path

## Naming Summary (Quick Reference)

### Before (Current State)

```
Kernels (legacy name):  Monolithic (default):
├── gravity-spectral-kernels/    ├── gravity-spectral/
├── gravity-mesh-kernels/        ├── gravity-mesh/
├── graph-laplacian-kernels/     ├── graph-laplacian/
├── particle-system-*-kernels.js ├── particle-system-*.js
├── ParticleSystemSpectralKernels    ├── ParticleSystemSpectral
├── particleSystemKernels()      └── particleSystem()
```

### After (New State)

```
Kernels (PRIMARY - no suffix):  Monolithic (LEGACY - with suffix):
├── gravity-spectral/           ├── gravity-spectral/
├── gravity-mesh/               ├── gravity-mesh/
├── graph-laplacian/            ├── graph-laplacian/
├── particle-system-*.js        ├── particle-system-monolithic-*.js
├── ParticleSystemSpectral      ├── ParticleSystemMonolithicSpectral
├── particleSystem()            └── particleSystemMonolithic()
```

## Backward Compatibility Strategy

### Import Paths

| Code Pattern | After Migration | Status |
|--------------|-----------------|--------|
| `import { particleSystem } from 'three-g'` | Works (kernels) | ✅ Compatible |
| `import { particleSystemMonolithic } from 'three-g/monolithic'` | Works (legacy) | ✅ Compatible |
| `import { particleSystem } from './particle-system/particle-system.js'` | Works (kernels) | ✅ Compatible |
| `import { particleSystem } from './particle-system/particle-system-kernels.js'` | Breaks (renamed) | ❌ Breaking |
| `import { ParticleSystemSpectralKernels } from './particle-system/'` | Breaks (renamed) | ❌ Breaking |

### Deprecation Timeline

- **v3.0**: Monolithic systems moved/renamed; kernel systems promoted; primary demo uses kernels
- **v3.x**: Monolithic code maintained; deprecation warnings in JSDoc
- **v4.x (future)**: Option to remove monolithic code if cleanup desired

## Testing Strategy

### Unit Tests (Phase 7)

Run existing test suite for both architectures:
```bash
# Kernel tests
npm test  # verify gravity-spectral-kernels, gravity-mesh-kernels, etc.

# Monolithic tests (from monolithic/ after move)
npx test monolithic/particle-system/
```

### Integration Tests (Phase 5)

Test all demo pages via REPL:
1. Root `index.html` → `demo.js` (kernels)
2. `monolithic/index.html` → `demo.js` (monolithic)
3. `monolithic/simplistic.html` (rendering only)
4. `monolithic/texture-mode.html` (custom GPGPU)

### Import Resolution Tests (Phase 6)

Verify all import paths resolve correctly:
```javascript
// In browser console or daebug REPL
const { particleSystem } = await import('./monolithic/particle-system/index.js');
const { particleSystemKernels } = await import('./particle-system/particle-system-kernels.js');
```

## FAQ & Considerations

### Q: Will existing projects break?

**A**: Depends on import path specificity:
- `import { particleSystem } from 'three-g'` → ✅ Still works (re-exported)
- `import { particleSystem } from 'three-g/particle-system'` → ❌ Will break (moved to `three-g/monolithic/particle-system`)

### Q: Why promote kernels over monolithic?

**A**: Kernel-based systems deliver:
- **Better performance**: Direct GPU compute, less CPU orchestration
- **Simpler code**: Unified K-FFT, K-Deposit, K-Integrate pipeline
- **GPU-native**: Leverages WebGL2 compute shaders effectively
- **Easier maintenance**: Centralized kernel architecture vs. scattered monolithic logic

### Q: Can I still use monolithic systems?

**A**: Yes! They remain functional in `monolithic/particle-system/`. However, they are:
- No longer the default
- Subject to maintenance hold
- Documented as "legacy" in JSDoc

### Q: Should I migrate my project?

**A**: If you're:
- **Starting new**: Use kernel-based (`particleSystemKernels`)
- **Maintaining existing**: Gradual migration recommended; file issue for support
- **Heavy customization**: Consider contributing kernel variants

### Q: What about graph-laplacian?

**A**: Both monolithic and kernel versions exist:
- `particle-system/graph-laplacian/` → move to `monolithic/particle-system/graph-laplacian/`
- `particle-system/graph-laplacian-kernels/` → keep in `particle-system/`

Root-level demos will use kernel version. Monolithic demos will use monolithic version.

## Related Documentation

- `docs/8-webgl-kernels.md` – Kernel architecture overview
- `docs/8.8.1-spectral-magnitude.md` – Spectral method details
- `docs/8.6.1-monopole.md` – Monopole kernel implementation
- `README.md` – API reference

## Success Criteria

✅ All demos accessible and functional at new locations
✅ Import paths resolve correctly for both architectures  
✅ REPL debugging works seamlessly
✅ Backward compatibility maintained for common imports
✅ Documentation updated with deprecation notices
✅ Git history clean and organized
✅ No performance regression in kernel systems
✅ Build/test pipeline passes all checks
