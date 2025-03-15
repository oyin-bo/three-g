// @ts-check

import { createComputeState } from '../compute/index.js';
import { createAndCompileShader } from '../gl-utils/create-and-compile-shader.js';
import { linkValidateProgram } from '../gl-utils/link-validate-program.js';
import { createGLBuffer, createTexture } from './create-buffers-and-texture.js';
import { readParticleData } from './read-particle-data/index.js';

/**
 * @template {import('..').ParticleCore} TParticle
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  state?: import('./index.js').ParticleSystemState<TParticle>,
 *  get?: (particle: TParticle, coords: import('..').CoordsParam) => void,
 *  particles: TParticle[],
 * }} _
 * @returns {import('.').ParticleSystemState<TParticle>}
 */
export function upload({ gl, state, get, particles }) {
  // TODO: delete old textures, programs etc.

  const stride = (gl.getParameter(gl.MAX_TEXTURE_SIZE) / 2) | 0;
  let rowCount = (particles.length / stride) | 0;
  if (stride * rowCount < particles.length) rowCount++;

  const {
    dynamicData,
    massData,
  } = readParticleData({ particles, get, stride });

  const textures = {
    dynamic: createTexture({ gl, stride, rowCount, internalFormat: gl.RGB32F, format: gl.RGB, type: gl.FLOAT, data: dynamicData }),
    dynamicOut: createTexture({ gl, stride, rowCount, internalFormat: gl.RGB32F, format: gl.RGB, type: gl.FLOAT }),

    static: createTexture({ gl, stride, rowCount, internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT }),
    staticOut: createTexture({ gl, stride, rowCount, internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT }),

    orders: createTexture({ gl, stride, rowCount, internalFormat: gl.R32I, format: gl.RED_INTEGER, type: gl.INT }),
    ordersOut: createTexture({ gl, stride, rowCount, internalFormat: gl.R32I, format: gl.RED_INTEGER, type: gl.INT }),
  }

  const massUploadTexture = createTexture({ gl, stride, rowCount, internalFormat: gl.R32F, format: gl.RED, type: gl.FLOAT, data: massData });

  const uploadProgram = state?.uploadProgram || createUploadProgram();

  const computeState = state?.computeState || createComputeState({ gl, dynamicBuffer, staticBuffer });

  runUploadProgram();

  return {
    particles,
    textures,
    uploadProgram,
    computeState
  };

  function createUploadProgram() {    
    const vertexShader = createAndCompileShader(gl, gl.VERTEX_SHADER, /* glsl */`
#version 300 es
void main() {
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    gl_PointSize = float(max(${stride}, ${rowCount}));
}
`);

    const fragmentShader = createAndCompileShader(gl, gl.FRAGMENT_SHADER, /* glsl */`
#version 300 es
precision highp float;

uniform sampler2D massUploadTexture;

out float outMass;

void main() {
  ivec2 texCoord = ivec2(gl_FragCoord.xy); // Get fragment coordinates as integers

  // Calculate texture coordinates within the massUploadTexture
  vec2 massTexCoord = vec2(float(texCoord.x) / ${stride}.0, float(texCoord.y) / ${rowCount}.0);

  // Read mass value from the massUploadTexture
  float mass = texture(massUploadTexture, massTexCoord).r;

  outMass = mass;
}
      `);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    linkValidateProgram(gl, program);

    return program;
  }

  function runUploadProgram() {
    gl.useProgram(uploadProgram);

    // Bind the mass upload texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, massUploadTexture);
    gl.uniform1i(gl.getUniformLocation(uploadProgram, 'massUploadTexture'), 0); // Texture unit 0

    // Bind the output texture (static texture) as a render target
    gl.bindFramebuffer(gl.FRAMEBUFFER, staticFramebuffer); // Assuming you have a framebuffer for staticTexture

    // Set the viewport to match the texture size
    gl.viewport(0, 0, stride, rowCount);

    // Clear the output texture (optional)
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.drawArrays(gl.POINTS, 0, 1);

    // Clean up
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Unbind framebuffer
  }
}
