// @ts-check

/**
 * Common utilities shared between ParticleSystemLegacy and ParticleSystemPlanC
 */

export function createRenderTexture(gl, width, height, internalFormat, type) {
  const format = internalFormat ?? gl.RGBA32F;
  const dataType = type ?? gl.FLOAT;
  
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, format, width, height, 0, gl.RGBA, dataType, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const framebuffer = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);

  return { texture, framebuffer };
}

export function createPingPongTextures(gl, width, height) {
  const textures = [];
  const framebuffers = [];
  
  for (let i = 0; i < 2; i++) {
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, width, height, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    
    textures.push(texture);
    framebuffers.push(framebuffer);
  }
  
  return {
    textures,
    framebuffers,
    currentIndex: 0,
    getCurrentTexture: function() { return this.textures[this.currentIndex]; },
    getTargetTexture: function() { return this.textures[1 - this.currentIndex]; },
    getTargetFramebuffer: function() { return this.framebuffers[1 - this.currentIndex]; },
    swap: function() { this.currentIndex = 1 - this.currentIndex; }
  };
}

export function createGeometry(gl, particleCount) {
  const quadVertices = new Float32Array([
    -1, -1,  1, -1,  -1, 1,  1, 1
  ]);
  
  const quadVAO = gl.createVertexArray();
  gl.bindVertexArray(quadVAO);
  
  const quadBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  
  const particleIndices = new Float32Array(particleCount);
  for (let i = 0; i < particleCount; i++) {
    particleIndices[i] = i;
  }
  
  const particleVAO = gl.createVertexArray();
  gl.bindVertexArray(particleVAO);
  
  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, particleIndices, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 1, gl.FLOAT, false, 0, 0);
  
  gl.bindVertexArray(null);
  
  return { quadVAO, particleVAO };
}

export function uploadTextureData(gl, texture, data, width, height, format, type) {
  const texFormat = format ?? gl.RGBA;
  const texType = type ?? gl.FLOAT;
  
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, texFormat, texType, data);
}

export function createShader(gl, type, source) {
  const shader = gl.createShader(type);
  if (!shader) {
    throw new Error('Failed to create shader');
  }
  
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile failed: ' + info);
  }
  
  return shader;
}

export function createProgram(gl, vertexSource, fragmentSource) {
  const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  
  const program = gl.createProgram();
  if (!program) {
    throw new Error('Failed to create program');
  }
  
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    throw new Error('Program link failed: ' + info);
  }
  
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  
  return program;
}

export function calculateParticleTextureDimensions(particleCount) {
  const width = Math.ceil(Math.sqrt(particleCount));
  const height = Math.ceil(particleCount / width);
  const actualSize = width * height;
  
  return { width, height, actualSize };
}

export function checkWebGL2Support(gl) {
  const colorBufferFloat = gl.getExtension('EXT_color_buffer_float');
  const floatBlend = gl.getExtension('EXT_float_blend');
  
  if (!colorBufferFloat) {
    throw new Error('EXT_color_buffer_float extension not supported');
  }
  
  let disableFloatBlend = false;
  if (!floatBlend) {
    console.warn('EXT_float_blend extension not supported');
    disableFloatBlend = true;
  }
  
  return { disableFloatBlend };
}
