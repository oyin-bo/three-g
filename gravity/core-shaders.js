// @ts-check

export const fsQuadVert = /* glsl */`#version 300 es
precision highp float;

layout(location=0) in vec2 a_position;
out vec2 v_uv;

void main() {
  v_uv = a_position * 0.5 + 0.5;  // Convert from [-1,1] to [0,1]
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

export const posIntegrateFrag = /* glsl */`#version 300 es
precision highp float;

uniform sampler2D u_positions;
uniform sampler2D u_velocity;
uniform vec2 u_texSize;
uniform int u_particleCount;
uniform float u_dt;

out vec4 fragColor;

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int idx = coord.y * int(u_texSize.x) + coord.x;
  vec4 pos = texelFetch(u_positions, coord, 0);
  if (idx >= u_particleCount) {
    fragColor = pos;
    return;
  }
  vec3 vel = texelFetch(u_velocity, coord, 0).xyz;
  vec3 newPos = pos.xyz + vel * u_dt;
  fragColor = vec4(newPos, pos.w);
}`;

export const velIntegrateFrag = /* glsl */`#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform sampler2D u_force;
uniform sampler2D u_position;
uniform vec2 u_texSize;
uniform float u_dt;
uniform float u_damping;
uniform float u_maxSpeed;
uniform float u_maxAccel;

out vec4 fragColor;

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  vec4 vel = texelFetch(u_velocity, coord, 0);
  vec4 pos = texelFetch(u_position, coord, 0);
  
  // Skip particles with NaN in position/velocity or invalid mass
  float mass = pos.w;
  if (isnan(pos.x) || isnan(pos.y) || isnan(pos.z) || isnan(vel.x) || isnan(vel.y) || isnan(vel.z) || 
      isnan(mass) || mass <= 0.0) {
    fragColor = vel;  // Output unchanged for invalid particles
    return;
  }
  
  // Apply physics: force integration
  vec3 force = texelFetch(u_force, coord, 0).xyz;
  
  // Skip if force has NaN
  if (isnan(force.x) || isnan(force.y) || isnan(force.z)) {
    fragColor = vel;
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
  
  fragColor = vec4(newVel, 0.0);
}`;
