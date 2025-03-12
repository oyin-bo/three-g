// @ts-check

import { createComputeState } from '../compute/index.js';
import { createAndCompileShader } from '../gl-utils/create-and-compile-shader.js';
import { glErrorProgramLinkingString } from '../gl-utils/gl-errors.js';
import { createGLBuffer } from './create-gl-buffer.js';
import { readParticleData } from './read-particle-data/index.js';

/**
 * @template {import('..').ParticleCore} TParticle
 * @param {{
 *  gl: WebGL2RenderingContext,
 *  state?: import('./index.js').ParticleSystemState<TParticle>,
 *  get?: (particle: TParticle, coords: import('..').CoordsParam) => void,
 *  particles: TParticle[]
 * }} _
 * @returns {import('.').ParticleSystemState<TParticle>}
 */
export function upload({ gl, state, get, particles }) {

  const {
    dynamicData,
    massData,
  } = readParticleData({ particles, get });

  const dynamicBuffer = createGLBuffer(gl, state?.dynamicBuffer, dynamicData);
  const dynamicBufferOut = createGLBuffer(gl, state?.dynamicBufferOut);

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

out float outMass;
out float outMassArc;
out vec3 outPositionArc;
out vec3 outVelocityArc;
out int outCpuIndex;

void main() {
  outMass = mass;
  outMassArc = mass;
  outPositionArc = position;
  outVelocityArc = velocity;
  outCpuIndex = gl_VertexID;
}
      `);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);

    // Transform feedback variables
    const varyings = [
      'outMass',
      'outMassArc',
      'outPositionArc',
      'outVelocityArc',
      'outCpuIndex'
    ];
    gl.transformFeedbackVaryings(program, varyings, gl.INTERLEAVED_ATTRIBS);

    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const errorString = glErrorProgramLinkingString({ gl, program });
      gl.deleteProgram(program);
      throw new Error(errorString);
    }

    gl.validateProgram(program);

    if (!gl.getProgramParameter(program, gl.VALIDATE_STATUS)) {
      const errorString = glErrorProgramLinkingString({ gl, program });
      gl.deleteProgram(program);
      throw new Error(errorString);
    }

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
