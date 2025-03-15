// @ts-check

import { createComputeState } from '../compute/index.js';
import { createAndCompileShader } from '../gl-utils/create-and-compile-shader.js';
import { linkValidateProgram } from '../gl-utils/link-validate-program.js';
import { createGLBuffer } from './create-buffers-and-texture.js';
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

  const stride = (gl.getParameter(gl.MAX_TEXTURE_SIZE) / 2) | 0;
  let rowCount = (particles.length / stride) | 0;
  if (stride * rowCount < particles.length) rowCount++;

  const {
    dynamicData,
    massData,
  } = readParticleData({ particles, get, stride });

  const dynamicBuffer = createGLBuffer(gl, state?.dynamicBuffer, dynamicData);
  const dynamicBufferOut = createGLBuffer(gl, state?.dynamicBufferOut);
  const dynamicTexture = gl.createTexture();
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, stride, rowCount, 0, gl.RGB, gl.FLOAT, dynamicData);

  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const staticBuffer = createGLBuffer(gl, state?.staticBuffer);
  const staticBufferOut = createGLBuffer(gl, state?.staticBufferOut);

  const ordersBuffer = createGLBuffer(gl, state?.ordersBuffer);
  const ordersBufferOut = createGLBuffer(gl, state?.ordersBufferOut);

  const massUploadBuffer = createGLBuffer(gl, undefined, massData);

  const uploadProgram = state?.uploadProgram || createUploadProgram();

  const computeState = state?.computeState || createComputeState({ gl, dynamicBuffer, staticBuffer });

  runUploadProgram();

  return {
    particles,
    dynamicBuffer,
    dynamicBufferOut,
    dynamicTexture,
    staticBuffer,
    staticBufferOut,
    ordersBuffer,
    ordersBufferOut,
    uploadProgram,
    computeState
  };

  function createUploadProgram() {
    const vertexShader = createAndCompileShader(gl, gl.VERTEX_SHADER,
      /* glsl */`
#version 300 es
layout (location = 0) in vec3 position;
layout (location = 1) in vec3 velocity;
layout (location = 2) in float mass;

flat out float outMass;
flat out float outMass_arc;
flat out vec3 outPosition_arc;
flat out vec3 outVelocity_arc;
flat out int outCpuIndex;
flat out int outCpuIndex_arc;

void main() {
  outMass = mass;
  outMass_arc = mass;
  outPosition_arc = position;
  outVelocity_arc = velocity;
  outCpuIndex = gl_VertexID;
  outCpuIndex_arc = gl_VertexID;
}
      `);

    const fragmentShader = createAndCompileShader(gl, gl.FRAGMENT_SHADER, `
        #version 300 es
        void main() {}`);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);

    // Transform feedback variables
    gl.transformFeedbackVaryings(
      program,
      [
        'outMass',
        'outMass_arc',
        'outPosition_arc',
        'outVelocity_arc',
        'outCpuIndex',
        'outCpuIndex_arc'
      ],
      gl.INTERLEAVED_ATTRIBS
    );

    linkValidateProgram(gl, program);

    return program;
  }

  function runUploadProgram() {
    gl.useProgram(uploadProgram);

    // Bind input buffers
    gl.bindBuffer(gl.ARRAY_BUFFER, dynamicBuffer);
    const positionLocation = 0; // Assuming position is the first attribute
    const velocityLocation = 1; // Assuming velocity is the second attribute

    gl.enableVertexAttribArray(positionLocation);
    gl.enableVertexAttribArray(velocityLocation);

    const positionSize = 3;
    const velocitySize = 3;
    const stride = (positionSize + velocitySize) * Float32Array.BYTES_PER_ELEMENT;
    const positionOffset = 0;
    const velocityOffset = positionSize * Float32Array.BYTES_PER_ELEMENT;

    gl.vertexAttribPointer(positionLocation, positionSize, gl.FLOAT, false, stride, positionOffset);
    gl.vertexAttribPointer(velocityLocation, velocitySize, gl.FLOAT, false, stride, velocityOffset);

    gl.bindBuffer(gl.ARRAY_BUFFER, massUploadBuffer);
    const massLocation = 2; // Assuming mass is the third attribute
    gl.enableVertexAttribArray(massLocation);
    gl.vertexAttribPointer(massLocation, 1, gl.FLOAT, false, 0, 0);

    // Bind output buffer for transform feedback
    gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, 0, staticBuffer);

    gl.beginTransformFeedback(gl.POINTS);
    gl.drawArrays(gl.POINTS, 0, particles.length);
    gl.endTransformFeedback();

    gl.disableVertexAttribArray(positionLocation);
    gl.disableVertexAttribArray(velocityLocation);
    gl.disableVertexAttribArray(massLocation);

    gl.deleteBuffer(massUploadBuffer);
  }
}
