export default `#version 300 es
precision highp float;

uniform sampler2D u_velocity;
uniform sampler2D u_force;
uniform vec2 u_texSize;
uniform float u_dt;
uniform float u_damping;
uniform float u_maxSpeed;
uniform float u_maxAccel;

out vec4 fragColor;

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  vec4 vel = texelFetch(u_velocity, coord, 0);
  
  // Apply physics: force integration
  vec3 force = texelFetch(u_force, coord, 0).xyz;
  
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
