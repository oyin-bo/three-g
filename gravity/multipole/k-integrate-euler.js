// @ts-check

/**
 * Combined velocity and position integration
 * 
 * Single-pass integration using MRT (Multiple Render Targets):
 * - Updates velocities from forces (kick)
 * - Updates positions from new velocities (drift)
 * 
 * Follows the WebGL2 Kernel contract from docs/8-webgl-kernels.md.
 */

import { fsQuadVert } from '../core-shaders.js';
import { formatNumber, readLinear } from '../diag.js';

export class KIntegrateEuler {
  /**
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   inPosition?: WebGLTexture|null,
   *   inVelocity?: WebGLTexture|null,
   *   inForce?: WebGLTexture|null,
   *   outPosition?: WebGLTexture|null,
   *   outVelocity?: WebGLTexture|null,
   *   width?: number,
   *   height?: number,
   *   dt?: number,
   *   damping?: number,
   *   maxSpeed?: number,
   *   maxAccel?: number
   * }} options
   */
  constructor(options) {
    this.gl = options.gl;

    // Resource slots - follow kernel contract: (truthy || === null) ? use : create
    this.inPosition = (options.inPosition || options.inPosition === null) ?
      options.inPosition :
      createTextureRGBA32F(this.gl, options.width || 0, options.height || 0);
    this.inVelocity = (options.inVelocity || options.inVelocity === null) ?
      options.inVelocity :
      createTextureRGBA32F(this.gl, options.width || 0, options.height || 0);
    this.inForce = (options.inForce || options.inForce === null) ?
      options.inForce :
      createTextureRGBA32F(this.gl, options.width || 0, options.height || 0);
    this.outPosition = (options.outPosition || options.outPosition === null) ?
      options.outPosition :
      createTextureRGBA32F(this.gl, options.width || 0, options.height || 0);
    this.outVelocity = (options.outVelocity || options.outVelocity === null) ?
      options.outVelocity :
      createTextureRGBA32F(this.gl, options.width || 0, options.height || 0);

    // Texture dimensions
    this.width = options.width || 0;
    this.height = options.height || 0;

    // Physics parameters
    this.dt = options.dt !== undefined ? options.dt : (1 / 60);
    this.damping = options.damping !== undefined ? options.damping : 0.0;
    this.maxSpeed = options.maxSpeed !== undefined ? options.maxSpeed : 2.0;
    this.maxAccel = options.maxAccel !== undefined ? options.maxAccel : 1.0;

    // Create shader program
    const vert = this.gl.createShader(this.gl.VERTEX_SHADER);
    if (!vert) throw new Error('Failed to create vertex shader');
    this.gl.shaderSource(vert, fsQuadVert);
    this.gl.compileShader(vert);
    if (!this.gl.getShaderParameter(vert, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(vert);
      this.gl.deleteShader(vert);
      throw new Error(`Vertex shader compile failed: ${info}`);
    }

    const frag = this.gl.createShader(this.gl.FRAGMENT_SHADER);
    if (!frag) throw new Error('Failed to create fragment shader');
    this.gl.shaderSource(frag, integratePhysicsFrag);
    this.gl.compileShader(frag);
    if (!this.gl.getShaderParameter(frag, this.gl.COMPILE_STATUS)) {
      const info = this.gl.getShaderInfoLog(frag);
      this.gl.deleteShader(frag);
      throw new Error(`Fragment shader compile failed: ${info}`);
    }

    this.program = this.gl.createProgram();
    if (!this.program) throw new Error('Failed to create program');
    this.gl.attachShader(this.program, vert);
    this.gl.attachShader(this.program, frag);
    this.gl.linkProgram(this.program);
    if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
      const info = this.gl.getProgramInfoLog(this.program);
      this.gl.deleteProgram(this.program);
      throw new Error(`Program link failed: ${info}`);
    }

    this.gl.deleteShader(vert);
    this.gl.deleteShader(frag);

    // Cache uniform locations
    this.uniforms = {
      u_position: this.gl.getUniformLocation(this.program, 'u_position'),
      u_velocity: this.gl.getUniformLocation(this.program, 'u_velocity'),
      u_force: this.gl.getUniformLocation(this.program, 'u_force'),
      u_texSize: this.gl.getUniformLocation(this.program, 'u_texSize'),
      u_dt: this.gl.getUniformLocation(this.program, 'u_dt'),
      u_damping: this.gl.getUniformLocation(this.program, 'u_damping'),
      u_maxSpeed: this.gl.getUniformLocation(this.program, 'u_maxSpeed'),
      u_maxAccel: this.gl.getUniformLocation(this.program, 'u_maxAccel')
    };

    // Create quad VAO
    const quadVAO = this.gl.createVertexArray();
    if (!quadVAO) throw new Error('Failed to create VAO');
    this.gl.bindVertexArray(quadVAO);
    const buffer = this.gl.createBuffer();
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, buffer);
    const quadVertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, quadVertices, this.gl.STATIC_DRAW);
    this.gl.enableVertexAttribArray(0);
    this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
    this.gl.bindVertexArray(null);
    this.quadVAO = quadVAO;

    // Create MRT framebuffer (configured per-run). Keep a small
    // shadow of attachments so run() can rebind only when they change.
    this.outFramebuffer = this.gl.createFramebuffer();
    /** @type {{ position: WebGLTexture, velocity: WebGLTexture } | null} */
    this._fboShadow = null;
  }

  /**
   * Capture complete computational state for debugging and testing
   * @param {{pixels?: boolean}} [options] - Capture options
   */
  valueOf({ pixels } = {}) {
    const value = {
      position: this.inPosition && readLinear({
        gl: this.gl, texture: this.inPosition, width: this.width,
        height: this.height, count: this.width * this.height,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      velocity: this.inVelocity && readLinear({
        gl: this.gl, texture: this.inVelocity, width: this.width,
        height: this.height, count: this.width * this.height,
        channels: ['vx', 'vy', 'vz', 'color'], pixels
      }),
      force: this.inForce && readLinear({
        gl: this.gl, texture: this.inForce, width: this.width,
        height: this.height, count: this.width * this.height,
        channels: ['fx', 'fy', 'fz', 'unused'], pixels
      }),
      outPosition: this.outPosition && readLinear({
        gl: this.gl, texture: this.outPosition, width: this.width,
        height: this.height, count: this.width * this.height,
        channels: ['x', 'y', 'z', 'mass'], pixels
      }),
      outVelocity: this.outVelocity && readLinear({
        gl: this.gl, texture: this.outVelocity, width: this.width,
        height: this.height, count: this.width * this.height,
        channels: ['vx', 'vy', 'vz', 'color'], pixels
      }),
      width: this.width,
      height: this.height,
      dt: this.dt,
      damping: this.damping,
      maxSpeed: this.maxSpeed,
      maxAccel: this.maxAccel,
      renderCount: this.renderCount
    };

    // Compute average speed and displacement
    const avgSpeedIn = value.velocity?.vx ?
      Math.sqrt(value.velocity.vx.mean ** 2 + value.velocity.vy.mean ** 2 + value.velocity.vz.mean ** 2) : 0;
    const avgSpeedOut = value.outVelocity?.vx ?
      Math.sqrt(value.outVelocity.vx.mean ** 2 + value.outVelocity.vy.mean ** 2 + value.outVelocity.vz.mean ** 2) : 0;
    const displacement = value.position?.x && value.outPosition?.x ?
      Math.sqrt(
        (value.outPosition.x.mean - value.position.x.mean) ** 2 +
        (value.outPosition.y.mean - value.position.y.mean) ** 2 +
        (value.outPosition.z.mean - value.position.z.mean) ** 2
      ) : 0;

    value.toString = () =>
      `KIntegratePhysics(${this.width}×${this.height}) dt=${formatNumber(this.dt)} damping=${formatNumber(this.damping)} maxSpeed=${formatNumber(this.maxSpeed)} maxAccel=${formatNumber(this.maxAccel)} #${this.renderCount}

position: ${value.position}

velocity: ${value.velocity ? `avgSpeed=${formatNumber(avgSpeedIn)} ` : ''}${value.velocity}

force: ${value.force}

→ outPosition: ${value.outPosition ? `displacement=${formatNumber(displacement)} ` : ''}${value.outPosition}

→ outVelocity: ${value.outVelocity ? `avgSpeed=${formatNumber(avgSpeedOut)} ` : ''}${value.outVelocity}`;

    return value;
  }

  /**
   * Get human-readable string representation of kernel state
   * @returns {string} Compact summary
   */
  toString() {
    return this.valueOf().toString();
  }

  /**
   * Run the kernel (synchronous)
   */
  run() {
    const gl = this.gl;

    if (!this.inPosition || !this.inVelocity || !this.inForce || 
        !this.outPosition || !this.outVelocity) {
      throw new Error('KIntegratePhysics: missing required textures');
    }

    gl.useProgram(this.program);

    // Ensure framebuffer attachments match our outputs (MRT)
    if (!this._fboShadow || 
        this._fboShadow.position !== this.outPosition ||
        this._fboShadow.velocity !== this.outVelocity) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.outPosition, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.outVelocity, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        throw new Error(`Framebuffer incomplete: ${status}`);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this._fboShadow = { position: this.outPosition, velocity: this.outVelocity };
    }

    // Bind output framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.outFramebuffer);
    gl.viewport(0, 0, this.width, this.height);

    // Setup GL state
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);

    // Bind input textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.inPosition);
    if (this.uniforms.u_position) {
      gl.uniform1i(this.uniforms.u_position, 0);
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.inVelocity);
    if (this.uniforms.u_velocity) {
      gl.uniform1i(this.uniforms.u_velocity, 1);
    }

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.inForce);
    if (this.uniforms.u_force) {
      gl.uniform1i(this.uniforms.u_force, 2);
    }

    // Set uniforms
    if (this.uniforms.u_texSize) {
      gl.uniform2f(this.uniforms.u_texSize, this.width, this.height);
    }
    if (this.uniforms.u_dt) {
      gl.uniform1f(this.uniforms.u_dt, this.dt);
    }
    if (this.uniforms.u_damping) {
      gl.uniform1f(this.uniforms.u_damping, this.damping);
    }
    if (this.uniforms.u_maxSpeed) {
      gl.uniform1f(this.uniforms.u_maxSpeed, this.maxSpeed);
    }
    if (this.uniforms.u_maxAccel) {
      gl.uniform1f(this.uniforms.u_maxAccel, this.maxAccel);
    }

    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    // Unbind textures
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);

    // Unbind framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.renderCount = (this.renderCount || 0) + 1;
  }

  dispose() {
    const gl = this.gl;

    if (this.program) gl.deleteProgram(this.program);
    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);
    if (this.outFramebuffer) gl.deleteFramebuffer(this.outFramebuffer);

    if (this.inPosition) gl.deleteTexture(this.inPosition);
    if (this.inVelocity) gl.deleteTexture(this.inVelocity);
    if (this.inForce) gl.deleteTexture(this.inForce);
    if (this.outPosition) gl.deleteTexture(this.outPosition);
    if (this.outVelocity) gl.deleteTexture(this.outVelocity);

    this._fboShadow = null;
  }
}

/**
 * Combined physics integration shader (MRT)
 * Outputs both updated position and velocity in a single pass
 */
const integratePhysicsFrag = /* glsl */`#version 300 es
precision highp float;

uniform sampler2D u_position;
uniform sampler2D u_velocity;
uniform sampler2D u_force;
uniform vec2 u_texSize;
uniform float u_dt;
uniform float u_damping;
uniform float u_maxSpeed;
uniform float u_maxAccel;

layout(location = 0) out vec4 outPosition;
layout(location = 1) out vec4 outVelocity;

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  vec4 pos = texelFetch(u_position, coord, 0);
  vec4 vel = texelFetch(u_velocity, coord, 0);
  
  // Skip particles with NaN in position/velocity or invalid mass
  float mass = pos.w;
  if (isnan(pos.x) || isnan(pos.y) || isnan(pos.z) || 
      isnan(vel.x) || isnan(vel.y) || isnan(vel.z) || 
      isnan(mass) || mass <= 0.0) {
    // Output unchanged for invalid particles
    outPosition = pos;
    outVelocity = vel;
    return;
  }
  
  // Kick: update velocity from force
  vec3 force = texelFetch(u_force, coord, 0).xyz;
  
  // Skip if force has NaN
  if (isnan(force.x) || isnan(force.y) || isnan(force.z)) {
    outPosition = pos;
    outVelocity = vel;
    return;
  }
  
  // Clamp force to maxAccel
  float fmag = length(force);
  if (fmag > u_maxAccel) {
    force = force / fmag * u_maxAccel;
  }
  
  // Integrate velocity with force
  vec3 newVel = vel.xyz + force * u_dt;
  
  // Apply damping
  newVel = newVel * (1.0 - u_damping);
  
  // Clamp speed to maxSpeed
  float vmag = length(newVel);
  if (vmag > u_maxSpeed) {
    newVel = newVel / vmag * u_maxSpeed;
  }
  
  // Drift: update position with NEW velocity (correct Euler integration)
  vec3 newPos = pos.xyz + newVel * u_dt;
  
  // Output both updates
  outPosition = vec4(newPos, mass);           // Preserve mass
  outVelocity = vec4(newVel, vel.w);          // Preserve color/metadata
}`;

/**
 * Helper: Create a RGBA32F texture
 * @param {WebGL2RenderingContext} gl
 * @param {number} width
 * @param {number} height
 */
function createTextureRGBA32F(gl, width, height) {
  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to create texture');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}
