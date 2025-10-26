// @ts-check

/**
 * Force Sampling Vertex Shader
 * 
 * Reads particle positions from texture and passes to fragment shader
 */

export default /* glsl */`#version 300 es
precision highp float;

uniform sampler2D u_positionTexture;
uniform vec2 u_textureSize;

out vec3 v_particlePosition;
out float v_particleMass;

void main() {
  // Get particle index from gl_VertexID
  int particleIndex = gl_VertexID;
  
  // Convert to texture coordinates
  int texWidth = int(u_textureSize.x);
  int texX = particleIndex % texWidth;
  int texY = particleIndex / texWidth;
  vec2 texCoord = (vec2(texX, texY) + 0.5) / u_textureSize;
  
  // Read particle position and mass
  vec4 posData = texture(u_positionTexture, texCoord);
  vec3 position = posData.xyz;
  float mass = posData.w;
  
  v_particlePosition = position;
  v_particleMass = mass;
  
  // Output position for point rendering
  // Map particle index to output position, centered on pixel
  float outputX = (float(texX) + 0.5) / u_textureSize.x * 2.0 - 1.0;
  float outputY = (float(texY) + 0.5) / u_textureSize.y * 2.0 - 1.0;
  
  gl_Position = vec4(outputX, outputY, 0.0, 1.0);
  gl_PointSize = 1.0;
}
`;
