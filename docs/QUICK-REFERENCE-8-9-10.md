# Quick Reference: PR #8 vs #9 vs #10

## At a Glance

| | PR #8 ⭐ | PR #9 | PR #10 |
|---|---------|-------|---------|
| **Approach** | Shared utilities | Self-contained | Self-contained + REPL |
| **Total LOC** | 2,142 | 2,309 | 3,345 |
| **Test LOC** | 1,641 | 2,309 | 3,345 |
| **Utilities LOC** | 501 | 0 (inline) | 0 (inline) |
| **Code Duplication** | 0% | ~40% | ~55% |
| **README** | ❌ | ❌ | ✅ |
| **Node.js Tests** | ✅ | ✅ | ✅ |
| **Browser REPL** | ⚠️ | ⚠️ | ✅ |
| **Maintainability** | 🟢 High | 🟡 Medium | 🟡 Medium |

## Code Size Comparison

```
PR #8:  test-utils-integration.js (501) + 7 test files (1,641) = 2,142 LOC
PR #9:  7 test files with inline utils = 2,309 LOC
PR #10: 7 test files with inline utils + exports + README = 3,345 LOC + docs
```

## Feature Matrix

| Feature | #8 | #9 | #10 | Notes |
|---------|----|----|-----|-------|
| **Shared utility module** | ✅ | ❌ | ❌ | Reduces duplication |
| **Node.js `test()` framework** | ✅ | ✅ | ✅ | Standard testing |
| **Exported test functions** | ❌ | ❌ | ✅ | For REPL access |
| **Structured return values** | ❌ | ❌ | ✅ | Diagnostic objects |
| **README documentation** | ❌ | ❌ | ✅ | Usage examples |
| **Implementation doc** | ✅ | ❌ | ❌ | Summary document |
| **Test name prefixes** | ⚠️ | ✅ | ✅ | `monopole.category:` |

## Code Sample Comparison

### PR #8: Shared Utilities
```javascript
import { createTestCanvas, readParticleData } from '../test-utils-integration.js';

test('monopole small-scale: single particle at rest', async () => {
  const canvas = createTestCanvas();
  const gl = createGLContext(canvas);
  // 30 lines of test logic
});
```
**Benefits:** Clean, focused, no duplication

### PR #9: Inline Utilities
```javascript
function createTestCanvas() { /* 30 lines */ }
function readParticleData() { /* 40 lines */ }
// ... 10+ utility functions repeated in each file

test('monopole.small-scale: single particle', async () => {
  const canvas = createTestCanvas();
  // 30 lines of test logic
});
```
**Benefits:** Self-contained, but duplicated across all 7 files

### PR #10: REPL Exports
```javascript
function createTestCanvas() { /* 30 lines */ }
function readParticleData() { /* 40 lines */ }
// ... 10+ utility functions repeated in each file

export async function testSingleParticleAtRest() {
  const canvas = createTestCanvas();
  // 30 lines of test logic
  return { passed: true, test: '...', data: {...} };
}

test('monopole.small-scale: single particle', async () => {
  await testSingleParticleAtRest();
});

export async function runAllTests() { /* ... */ }
```
**Benefits:** REPL-ready, but most verbose with duplication

## Utility Functions Provided

### PR #8 (`test-utils-integration.js`)
- ✅ GL context management (3 functions)
- ✅ Particle data generation (5 functions)
- ✅ GPU data reading (2 functions)
- ✅ Physics calculations (4 functions)
- ✅ Assertions (4 functions)
- ✅ Trajectory sampling (1 function)

**Total: 19 shared utility functions**

### PR #9 & #10
- ⚠️ Same 19 functions **duplicated in each of 7 test files**
- Each file: ~150-250 LOC of utilities + test logic

## Maintenance Scenario

**Bug in `readParticleData()` function:**

| | PR #8 | PR #9 | PR #10 |
|---|-------|-------|---------|
| **Files to edit** | 1 | 7 | 7 |
| **Risk of inconsistency** | Low | High | High |
| **Time to fix** | 2 min | 15 min | 15 min |

## Test Execution

### Command Line (All PRs)
```bash
# Run all tests
node --test particle-system/gravity-monopole/*.test.js

# Run specific file
node --test particle-system/gravity-monopole/monopole.small-scale.test.js
```

### Browser REPL

**PR #8 (after enhancement):**
```javascript
import { testSingleParticleAtRest } from '/particle-system/gravity-monopole/monopole.small-scale.test.js';
await testSingleParticleAtRest()
```

**PR #10 (native):**
```javascript
import * as tests from '/particle-system/gravity-monopole/monopole.small-scale.test.js';
await tests.testSingleParticleAtRest()
await tests.runAllTests()
```

## Recommendation Summary

### ⭐ Choose PR #8 + Enhancements

**Base:** PR #8 (clean architecture, shared utilities)

**Add from PR #10:**
1. Comprehensive README
2. Exported test functions for REPL
3. Structured return values

**Result:** Best of both worlds
- 2,142 LOC + README (not 3,345 LOC)
- No code duplication (not 55%)
- Works in Node.js CLI and browser REPL
- Professional architecture
- Easy to maintain

## Files Changed by PR

### PR #8
```
+ particle-system/test-utils-integration.js (501 LOC)
+ particle-system/gravity-monopole/monopole.*.test.js (7 files, 1,641 LOC)
+ docs/8.6.1-monopole-IMPLEMENTED.md
```

### PR #9
```
+ particle-system/gravity-monopole/monopole.*.test.js (7 files, 2,309 LOC)
```

### PR #10
```
+ particle-system/gravity-monopole/monopole.*.test.js (7 files, 3,345 LOC)
+ particle-system/gravity-monopole/README.md
```

---

**Detailed analysis:** `docs/PR-COMPARISON-8-9-10.md`
**Recommendation:** `docs/RECOMMENDATION-MONOPOLE-TESTS.md`
