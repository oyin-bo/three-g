# WebGL2 Kernel Testing with Daebug REPL

A pragmatic plan for testing WebGL2 compute kernels (see [8-webgl-kernels.md](8-webgl-kernels.md)) using the daebug file-based REPL. This approach leverages daebug's existing infrastructure to provide interactive, reproducible unit tests for GPU code running in the browser.

## Philosophy: Pragmatic In-Browser Testing

Testing GPU code requires a real WebGL2 context. Rather than building custom test infrastructure, we integrate daebug's file-based REPL to:

- **Run tests in the native environment** (real browser, real GPU)
- **Preserve WebGL context across tests** for performance
- **Provide human-readable test logs** as markdown files
- **Enable AI-agent interaction** through daebug's chat format
- **Reuse existing infrastructure** instead of reinventing

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  daebug Server (Node.js)                            │
│  - Watches test files in daebug/ directory         │
│  - Sends code to browser                            │
│  - Captures results in markdown                     │
└─────────────────────────────────────────────────────┘
                        ↕
┌─────────────────────────────────────────────────────┐
│  Browser Page (http://localhost:8768/)              │
│  - Persistent WebGL2 context                        │
│  - Shared test utilities (getGL, createTestTexture) │
│  - Executes test code from daebug files            │
│  - Returns results (pass/fail/metrics)              │
└─────────────────────────────────────────────────────┘
```

### Key Design Decisions

1. **Single persistent GL context**: Create once when page loads, reuse across all tests
2. **Shared test utilities**: Import helper functions from a test module
3. **Main thread execution**: Forget workers for now—simpler, direct access to GL
4. **Markdown test logs**: Each test run documented in daebug/*.md files
5. **Tolerance-based assertions**: GPU math requires epsilon comparisons

## Implementation Components

### 1. Test Utilities Module (`particle-system/test-utils.js`)

A shared module that provides WebGL context management and test helpers:

```javascript
// particle-system/test-utils.js

let sharedGL = null;
let sharedCanvas = null;

/**
 * Get or create the shared WebGL2 context.
 * Reused across all tests for performance.
 */
export function getGL() {
  if (!sharedGL) {
    sharedCanvas = document.createElement('canvas');
    sharedCanvas.width = 256;
    sharedCanvas.height = 256;
    sharedGL = sharedCanvas.getContext('webgl2');
    
    if (!sharedGL) {
      throw new Error('WebGL2 not supported');
    }
    
    // Check for required extensions
    const ext = sharedGL.getExtension('EXT_color_buffer_float');
    if (!ext) {
      throw new Error('EXT_color_buffer_float not supported');
    }
  }
  return sharedGL;
}

/**
 * Create a small test texture with known values.
 */
export function createTestTexture(gl, width, height, data) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, 
                gl.RGBA, gl.FLOAT, data || null);
  return tex;
}

/**
 * Read back texture data to a Float32Array.
 */
export function readTexture(gl, texture, width, height) {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, 
                          gl.TEXTURE_2D, texture, 0);
  
  const pixels = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
  
  gl.deleteFramebuffer(fbo);
  return pixels;
}

/**
 * Tolerance-based float comparison.
 */
export function assertClose(actual, expected, tolerance = 1e-5, message = '') {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(
      `${message}\nExpected ${expected}, got ${actual} (diff: ${diff}, tolerance: ${tolerance})`
    );
  }
}

/**
 * Assert all values in array are finite (no NaN, no Infinity).
 */
export function assertAllFinite(array, message = 'Values must be finite') {
  for (let i = 0; i < array.length; i++) {
    if (!isFinite(array[i])) {
      throw new Error(`${message}: array[${i}] = ${array[i]}`);
    }
  }
}

/**
 * Dispose all non-null properties of an object (kernel cleanup).
 */
export function disposeKernel(kernel) {
  const gl = getGL();
  for (const key in kernel) {
    const val = kernel[key];
    if (val && typeof val === 'object') {
      if (val.delete) val.delete();
      else if (val.dispose) val.dispose();
      else if (WebGLTexture && val instanceof WebGLTexture) {
        gl.deleteTexture(val);
      } else if (WebGLFramebuffer && val instanceof WebGLFramebuffer) {
        gl.deleteFramebuffer(val);
      }
      kernel[key] = null;
    }
  }
}

/**
 * Clean up the shared GL context (call between test runs if needed).
 */
export function resetGL() {
  if (sharedGL && sharedCanvas) {
    // Optionally clear state, but usually reuse is fine
    const gl = sharedGL;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);
  }
}
```

### 2. Daebug Integration in `serve.js`

Integrate daebug into the three-g-1 server. The daebug library is designed to be embedded:

```javascript
// In serve.js (simplified integration)
import { createServer } from 'http';
import { startDaebugServer } from '../oyinbo/js/server.js';

const PORT = 8768;

// Start both servers
const httpServer = createServer((req, res) => {
  // Handle three-g-1 routes
  if (req.url === '/' || req.url === '/index.html') {
    // Serve main page with daebug client injection
    // ...
  }
  // Let other routes fall through
});

// Attach daebug to the same HTTP server
startDaebugServer(httpServer, {
  rootDir: process.cwd(), // three-g-1 root
  port: PORT
});

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log('Daebug REPL active - create test files in daebug/ directory');
});
```

### 3. Test File Structure

Tests live in `daebug/` directory as markdown files. Each test file is a conversation with the live page:

#### Example: `daebug/test-integrate-velocity.md`

```markdown
# Test: IntegrateVelocityKernel

> This file tests the velocity integration kernel with known inputs.

> **agent** to main-page at 14:23:01
```js
import { getGL, createTestTexture, readTexture, assertClose, disposeKernel } 
  from '/particle-system/test-utils.js';
import { IntegrateVelocityKernel } 
  from '/particle-system/gravity-multipole/k-integrate-velocity.js';

// Test: small 2x2 texture with known forces
const gl = getGL();
const width = 2, height = 2;

// Initial velocity: all zeros
const velData = new Float32Array(2 * 2 * 4); // 4 components per pixel
const velTex = createTestTexture(gl, width, height, velData);

// Force: constant acceleration in +X direction
const forceData = new Float32Array(2 * 2 * 4);
for (let i = 0; i < 4; i++) {
  forceData[i * 4 + 0] = 1.0; // fx = 1.0
  forceData[i * 4 + 1] = 0.0; // fy = 0.0
  forceData[i * 4 + 2] = 0.0; // fz = 0.0
  forceData[i * 4 + 3] = 1.0; // mass = 1.0
}
const forceTex = createTestTexture(gl, width, height, forceData);

// Create kernel
const kernel = new IntegrateVelocityKernel({
  gl,
  inVelocity: velTex,
  inForce: forceTex,
  outVelocity: null // kernel creates output
});

// Run integration (dt = 0.1)
kernel.dt = 0.1;
kernel.run();

// Read back result
const result = readTexture(gl, kernel.outVelocity, width, height);

// Assert: velocity should be force * dt = 1.0 * 0.1 = 0.1 in X
for (let i = 0; i < 4; i++) {
  assertClose(result[i * 4 + 0], 0.1, 1e-5, `Particle ${i} vx`);
  assertClose(result[i * 4 + 1], 0.0, 1e-5, `Particle ${i} vy`);
  assertClose(result[i * 4 + 2], 0.0, 1e-5, `Particle ${i} vz`);
}

// Cleanup
disposeKernel(kernel);

'✅ IntegrateVelocityKernel: velocity updated correctly';
```

> **main-page** to agent at 14:23:02 (127ms)
```JSON
"✅ IntegrateVelocityKernel: velocity updated correctly"
```

> Write code in a fenced JS block below to execute against this page.
```

The daebug server automatically:
1. Detects the new test file
2. Sends the code to the browser
3. Captures the result
4. Writes it back to the markdown file
5. Preserves the conversation history

### 4. Testing Workflow

#### Running Tests Manually

1. Start server: `npm start` (with daebug integrated)
2. Open browser: `http://localhost:8768/`
3. Create test file: `daebug/test-my-kernel.md`
4. Add test code in a fenced JS block with the agent header
5. Server executes and writes results back
6. Review results in the markdown file

#### Batch Testing

Create a test runner file that imports and runs multiple kernel tests:

```markdown
> **agent** to main-page at 14:30:00
```js
import { getGL } from '/particle-system/test-utils.js';

// Ensure GL context is ready
const gl = getGL();

// Run all kernel tests
const tests = [
  '/particle-system/gravity-multipole/k-integrate-velocity.test.js',
  '/particle-system/gravity-multipole/k-integrate-position.test.js',
  '/particle-system/gravity-multipole/k-aggregator.test.js',
  '/particle-system/gravity-multipole/k-pyramid-build.test.js',
  '/particle-system/gravity-multipole/k-traversal.test.js'
];

const results = [];
for (const testPath of tests) {
  try {
    const module = await import(testPath);
    if (module.runTests) {
      const result = await module.runTests(gl);
      results.push({ test: testPath, status: 'pass', result });
    }
  } catch (error) {
    results.push({ test: testPath, status: 'fail', error: error.message });
  }
}

// Format summary
const passed = results.filter(r => r.status === 'pass').length;
const failed = results.filter(r => r.status === 'fail').length;

`Test Summary: ${passed} passed, ${failed} failed\n` + 
  results.map(r => `  ${r.status === 'pass' ? '✅' : '❌'} ${r.test}`).join('\n');
```
```

### 5. Individual Kernel Test Modules

Each kernel can have a companion `.test.js` file that exports a test suite:

```javascript
// particle-system/gravity-multipole/k-integrate-velocity.test.js

import { createTestTexture, readTexture, assertClose, assertAllFinite } 
  from '../test-utils.js';
import { IntegrateVelocityKernel } from './k-integrate-velocity.js';

export async function runTests(gl) {
  const results = [];
  
  // Test 1: Zero force produces zero velocity change
  try {
    const velData = new Float32Array(4 * 4);
    const forceData = new Float32Array(4 * 4); // all zeros
    
    const velTex = createTestTexture(gl, 2, 2, velData);
    const forceTex = createTestTexture(gl, 2, 2, forceData);
    
    const kernel = new IntegrateVelocityKernel({
      gl,
      inVelocity: velTex,
      inForce: forceTex,
      outVelocity: null
    });
    
    kernel.dt = 0.1;
    kernel.run();
    
    const result = readTexture(gl, kernel.outVelocity, 2, 2);
    assertAllFinite(result, 'Result must be finite');
    
    for (let i = 0; i < result.length; i++) {
      assertClose(result[i], 0.0, 1e-6, `Zero force test pixel ${i}`);
    }
    
    results.push({ name: 'Zero force', status: 'pass' });
  } catch (error) {
    results.push({ name: 'Zero force', status: 'fail', error: error.message });
  }
  
  // Test 2: Constant force produces linear velocity
  // ... more tests ...
  
  return results;
}
```

## Testing Strategy

### Test Pyramid

1. **Unit Tests (70%)**: Individual kernel correctness
   - Small textures (2×2, 4×4, 8×8)
   - Known inputs, expected outputs
   - Boundary conditions, edge cases
   - Mass conservation, energy bounds

2. **Integration Tests (20%)**: Kernel composition
   - Multi-step pipelines (aggregator → pyramid → traversal)
   - Ping-pong buffer flipping
   - Framebuffer binding correctness

3. **Regression Tests (10%)**: Full system validation
   - Compare new kernel-based system vs. original implementation
   - Fixed-seed particle configurations
   - Tolerance-based numeric comparison

### Test Coverage Priorities

High priority kernels to test first:

1. ✅ **IntegrateVelocityKernel** - straightforward, good starter
2. ✅ **IntegratePositionKernel** - similar to velocity
3. **AggregatorKernel** - validates moment computation
4. **PyramidBuildKernel** - tests hierarchical structure
5. **TraversalKernel** - complex but critical

Medium priority:

- NearFieldKernel
- OccupancyKernel
- ReductionKernel

Lower priority:

- Debug/visualization kernels
- Utility kernels

## Assertions and Validation

### Numeric Tolerance

GPU floating-point math has platform-specific precision. Use tolerance-based assertions:

```javascript
// Bad: exact equality
assert(result === 0.1);

// Good: tolerance comparison
assertClose(result, 0.1, 1e-5);
```

### Physical Invariants

Test conservation laws and bounds:

```javascript
// Mass conservation
const totalMassBefore = sumMass(inputTexture);
const totalMassAfter = sumMass(outputTexture);
assertClose(totalMassBefore, totalMassAfter, 1e-4, 'Mass must be conserved');

// Energy bounds (no runaway acceleration)
const maxAccel = Math.max(...accelerationData);
assert(maxAccel < 100.0, 'Acceleration must be bounded');

// No NaN or Infinity
assertAllFinite(positionData, 'Positions must be finite');
```

### Determinism

Use fixed seeds for reproducible tests:

```javascript
// Set known particle positions
const positions = new Float32Array([
  0, 0, 0, 1,  // particle 0
  1, 0, 0, 1,  // particle 1
  0, 1, 0, 1,  // particle 2
  1, 1, 0, 1   // particle 3
]);
```

## Error Handling and Debugging

### Capture WebGL Errors

```javascript
function checkGLError(gl, context = '') {
  const err = gl.getError();
  if (err !== gl.NO_ERROR) {
    throw new Error(`WebGL error ${err} in ${context}`);
  }
}

// Use after GL calls
kernel.run();
checkGLError(gl, 'kernel.run()');
```

### Visualize Intermediate Results

For debugging, render textures to screen:

```javascript
// Add to test-utils.js
export function visualizeTexture(gl, texture, width, height) {
  const pixels = readTexture(gl, texture, width, height);
  console.table(
    Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        const idx = (y * width + x) * 4;
        return `(${pixels[idx].toFixed(2)}, ${pixels[idx+1].toFixed(2)}, ${pixels[idx+2].toFixed(2)})`;
      })
    )
  );
}
```

### Background Error Capture

Daebug automatically captures `window.onerror` and console output, providing rich debugging context in test logs.

## Benefits of This Approach

### Compared to Original Plan (9-webgl2-unit.md, 9.1-deliver-unit.md)

| Aspect | Original Plan | Daebug Approach |
|--------|--------------|-----------------|
| **Infrastructure** | Build from scratch | Reuse existing |
| **File watching** | Custom `fs.watch` + debounce | Built-in |
| **Communication** | Custom protocols | HTTP polling |
| **Test format** | Custom harness | Markdown + JS modules |
| **Results** | Custom formatting | Markdown chat log |
| **Error capture** | Manual implementation | Automatic |
| **Worker isolation** | Required | Optional (later) |
| **Code volume** | ~500+ lines new code | ~100 lines (test-utils) |
| **Dependencies** | None (constraint) | Daebug (already available) |

### Key Advantages

✅ **Minimal implementation** - only need test-utils.js, everything else is daebug  
✅ **Human-readable logs** - markdown format perfect for review and AI agents  
✅ **Interactive debugging** - can run individual tests, inspect state  
✅ **Reusable GL context** - fast test execution, no context recreation overhead  
✅ **Incremental testing** - add tests one kernel at a time  
✅ **Version controlled** - test logs are markdown files in git  
✅ **AI-agent friendly** - agents can read logs, write new tests, debug failures  

## Migration from Existing Tests

Current test infrastructure uses `kernel-tests.html` with manual test harness. Migration path:

1. **Keep kernel-tests.html** as a visual test page for development
2. **Add daebug tests** alongside for automated validation
3. **Extract test logic** from HTML into `.test.js` modules
4. **Share test-utils.js** between both approaches
5. **Gradually deprecate** manual HTML tests as daebug coverage grows

## Implementation Checklist

- [ ] Integrate daebug into serve.js
- [ ] Create `particle-system/test-utils.js` with shared utilities
- [ ] Write first test: `daebug/test-integrate-velocity.md`
- [ ] Verify test execution and result capture
- [ ] Create `.test.js` modules for existing kernels
- [ ] Add batch test runner
- [ ] Document testing workflow in main README
- [ ] Add tolerance constants and assertion helpers
- [ ] Create test data generators (fixed-seed particle configs)
- [ ] Add regression tests comparing kernel vs. original implementations

## Future Enhancements

Once basic testing works:

- **Web Worker tests**: Move long-running tests to worker realm for main thread responsiveness
- **CI integration**: Run daebug tests in headless browser (Playwright/Puppeteer)
- **Coverage tracking**: Instrument which shader branches are tested
- **Performance benchmarks**: Track kernel execution time across runs
- **Visual regression**: Capture rendered frames, compare against baselines

## Conclusion

This approach provides **pragmatic, production-ready testing** for WebGL2 kernels by leveraging daebug's existing infrastructure. It requires minimal new code, provides excellent developer experience, and enables both human developers and AI agents to validate GPU code effectively.

The key insight: **don't build a test framework—use the REPL as the test framework**. Daebug's file-based execution model is perfect for structured testing when combined with standard ES modules and shared test utilities.
