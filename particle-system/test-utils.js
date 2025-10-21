// @ts-check

/**
 * Shared WebGL2 test utilities for kernel testing.
 * Provides a persistent GL context and helpers for GPU testing.
 */

let sharedGL = null;
let sharedCanvas = null;

/**
 * Get or create the shared WebGL2 context.
 * Reused across all tests for performance.
 * @returns {WebGL2RenderingContext}
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
    
    // Enable float blending for additive accumulation
    const floatBlend = sharedGL.getExtension('EXT_float_blend');
    if (!floatBlend) {
      console.warn('EXT_float_blend not supported - blending on float textures may not work');
    }
  }
  return sharedGL;
}

/**
 * Create a small test texture with known values.
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 * @param {Float32Array | null} data
 * @returns {WebGLTexture}
 */
export function createTestTexture(gl, width, height, data) {
  const tex = gl.createTexture();
  if (!tex) throw new Error('Failed to create texture');
  
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, 
    gl.RGBA, gl.FLOAT, data || null
  );
  gl.bindTexture(gl.TEXTURE_2D, null);
  
  return tex;
}

/**
 * Read back texture data to a Float32Array.
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @returns {Float32Array}
 */
export function readTexture(gl, texture, width, height) {
  const fbo = gl.createFramebuffer();
  if (!fbo) throw new Error('Failed to create framebuffer');
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, 
    gl.TEXTURE_2D, texture, 0
  );
  
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteFramebuffer(fbo);
    throw new Error(`Framebuffer incomplete: status ${status}`);
  }
  
  const pixels = new Float32Array(width * height * 4);
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.FLOAT, pixels);
  
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  
  return pixels;
}

/**
 * Tolerance-based float comparison.
 * @param {number} actual
 * @param {number} expected
 * @param {number} tolerance
 * @param {string} message
 * @throws {Error}
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
 * @param {Float32Array | number[]} array
 * @param {string} message
 * @throws {Error}
 */
export function assertAllFinite(array, message = 'Values must be finite') {
  for (let i = 0; i < array.length; i++) {
    if (!isFinite(array[i])) {
      throw new Error(`${message}: array[${i}] = ${array[i]}`);
    }
  }
}

/**
 * Assert that a value is exactly equal.
 * @param {number} actual
 * @param {number} expected
 * @param {string} message
 * @throws {Error}
 */
export function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(
      `${message}\nExpected ${expected}, got ${actual}`
    );
  }
}

/**
 * TODO: this function should not exist: it repeats what a kernel is supposed to do in the first place. We should remove it explicitly, but ONLY when the requested and planned!
 * Dispose all WebGL resources in an object (kernel cleanup).
 * @param {object} kernel
 */
export function disposeKernel(kernel) {
  const gl = getGL();
  for (const key in kernel) {
    const val = kernel[key];
    if (val && typeof val === 'object') {
      if (val.delete && typeof val.delete === 'function') {
        val.delete();
      } else if (val.dispose && typeof val.dispose === 'function') {
        val.dispose();
      } else if (val instanceof WebGLTexture) {
        gl.deleteTexture(val);
      } else if (val instanceof WebGLFramebuffer) {
        gl.deleteFramebuffer(val);
      } else if (val instanceof WebGLProgram) {
        gl.deleteProgram(val);
      } else if (val instanceof WebGLShader) {
        gl.deleteShader(val);
      } else if (val instanceof WebGLBuffer) {
        gl.deleteBuffer(val);
      } else if (val instanceof WebGLVertexArrayObject) {
        gl.deleteVertexArray(val);
      }
      kernel[key] = null;
    }
  }
}

/**
 * Clean up the shared GL context state (call between test groups if needed).
 */
export function resetGL() {
  if (!sharedGL) return;
  
  const gl = sharedGL;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.useProgram(null);
  gl.bindVertexArray(null);
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  
  // Clear any errors
  const busyUntil = Date.now() + 100;
  while (Date.now() < busyUntil) {
    if (gl.getError() === gl.NO_ERROR) break;
  }

  let glError = gl.getError();
  if (glError !== gl.NO_ERROR) throw new Error('gl.getError() expected to be gl.NO_ERROR ' + glError);
}

/**
 * Check for WebGL errors and throw if any found.
 * @param {WebGL2RenderingContext} gl
 * @param {string} context
 * @throws {Error}
 */
export function checkGLError(gl, context = '') {
  const err = gl.getError();
  if (err !== gl.NO_ERROR) {
    const errorMap = {
      [gl.INVALID_ENUM]: 'INVALID_ENUM',
      [gl.INVALID_VALUE]: 'INVALID_VALUE',
      [gl.INVALID_OPERATION]: 'INVALID_OPERATION',
      [gl.INVALID_FRAMEBUFFER_OPERATION]: 'INVALID_FRAMEBUFFER_OPERATION',
      [gl.OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
    };
    const errName = errorMap[err] || `UNKNOWN(${err})`;
    throw new Error(`WebGL error ${errName} in ${context}`);
  }
}

/**
 * Visualize a texture as a 2D table of values for debugging.
 * Useful for understanding texture contents.
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @param {string} label
 */
export function debugTexture(gl, texture, width, height, label = 'Texture') {
  const pixels = readTexture(gl, texture, width, height);
  console.log(`\n${label} (${width}×${height}):`);
  
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      row += `(${pixels[idx].toFixed(3)},${pixels[idx+1].toFixed(3)},${pixels[idx+2].toFixed(3)},${pixels[idx+3].toFixed(3)}) `;
    }
    console.log(row);
  }
}

/**
 * Sum a channel across all pixels in a texture (useful for conservation checks).
 * @param {WebGL2RenderingContext} gl
 * @param {WebGLTexture} texture
 * @param {number} width
 * @param {number} height
 * @param {number} channel - 0, 1, 2, or 3 for r, g, b, a
 * @returns {number}
 */
export function sumTextureChannel(gl, texture, width, height, channel = 0) {
  const pixels = readTexture(gl, texture, width, height);
  let sum = 0;
  for (let i = channel; i < pixels.length; i += 4) {
    sum += pixels[i];
  }
  return sum;
}
