# Monopole Integration Tests

This directory contains comprehensive integration tests for the monopole particle system implementation.

## Test Files

All test files are **fully self-contained** with inline helper functions per project policy. NO shared utilities exist.

### 1. monopole.small-scale.test.js (5 tests)
Basic correctness validation on minimal particle configurations:
- Single particle at rest remains stationary
- Two particles attract (mutual gravitational force)
- Three-body Lagrange L4 (equilateral triangle orbit)
- Ten particles in cluster (contraction verification)
- Empty system (zero particles edge case)

### 2. monopole.large-scale.test.js (3 tests)
Scaling behavior and numerical stability validation:
- 100 particles uniform distribution
- 1,000 particles clustered (Plummer-like)
- 10,000 particles with hierarchy (dense core + halo)

### 3. monopole.known-solutions.test.js (3 tests)
Analytical solution validation:
- Binary orbit (circular)
- Binary orbit stability
- Three-body figure-8

### 4. monopole.conservation.test.js (3 tests)
Physics invariants over extended simulation:
- Momentum conservation
- Angular momentum conservation
- Energy conservation (KE + PE)

### 5. monopole.stability.test.js (4 tests)
Extreme conditions and edge cases:
- Long integration (10,000 steps)
- Close encounters (softening validation)
- Extreme mass ratios (1:1000)
- Boundary stress (particles near world limits)

### 6. monopole.convergence.test.js (3 tests)
Refinement behavior validation:
- Theta parameter convergence
- Softening length convergence
- Particle count convergence

### 7. monopole.resource-mgmt.test.js (2 tests)
GPU resource lifecycle and memory management:
- Create/dispose cycle (10 iterations)
- Texture reuse (external texture management)

## Running the Tests

These tests are designed to run in a **browser environment** via the daebug REPL.

### Using Daebug REPL

1. Start the daebug server:
   ```bash
   npm start
   ```

2. Open browser to `http://localhost:8768/`

3. Open `daebug.md` in the repo root to find your session file

4. In the session file, import and run tests:
   ```js
   // Import a test file
   const tests = await import('/particle-system/gravity-monopole/monopole.small-scale.test.js?t=' + Date.now());
   
   // Run all tests in the file
   await tests.runAllTests()
   ```

5. Or run individual tests:
   ```js
   const tests = await import('/particle-system/gravity-monopole/monopole.small-scale.test.js?t=' + Date.now());
   await tests.testSingleParticleAtRest()
   ```

### Test Results

Each test returns a result object with:
- `passed`: boolean indicating success
- `test`: string name of the test
- Additional diagnostic data specific to the test

The `runAllTests()` function returns:
- `passed`: number of tests that passed
- `total`: total number of tests
- `results`: array of individual test results

## Test Coverage

**Total: 23 tests across 7 files**

The test suite covers:
- ✓ Basic correctness (small particle counts)
- ✓ Scaling behavior (up to 10,000 particles)
- ✓ Analytical solutions (orbital mechanics)
- ✓ Conservation laws (momentum, angular momentum, energy)
- ✓ Numerical stability (long integration, extreme conditions)
- ✓ Convergence properties (parameter refinement)
- ✓ Resource management (GPU lifecycle)

## Design Principles

Per project policy:
- Each test file is **completely self-contained**
- All utility functions are **inline** within each test file
- **NO shared code** exists across test files
- Tests create and dispose their own GL contexts
- Tests are isolated and can run independently

## Notes

- Tests require WebGL2 support
- Tests use `EXT_color_buffer_float` extension
- Each test creates an offscreen canvas
- GL contexts are properly cleaned up after each test
- Tests are designed for browser environment (require `document` object)
