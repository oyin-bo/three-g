// @ts-check

/**
 * Laplacian Force Module (Blueprint 3: SpMV for linear springs)
 *
 * Computes per-edge attraction forces via CSR SpMV on GPU:
 *   F_attr[i] = k * (sum_j w_ij * x_j  -  deg[i] * x_i)
 *
 * Uses sharded CSR gather + segmented reduction (or additive blending)
 * to handle irregular degree distributions efficiently in WebGL2.
 */

/**
 * @typedef {{from: number, to: number, strength: number}} Edge
 */

export class LaplacianForceModule {
  /**
   * @param {Iterable<Edge>} edges
   * @param {WebGL2RenderingContext} gl
   * @param {{
   *   k?: number,
   *   normalized?: boolean,
   *   shardSize?: number,
   *   particleCount: number,
   *   textureWidth: number,
   *   textureHeight: number,
   *   disableFloatBlend: boolean
   * }} options
   */
  constructor(edges, gl, options) {
    this.edges = Array.from(edges);
    this.options = {
      k: options.k ?? 0.01,
      normalized: options.normalized ?? false,
      shardSize: options.shardSize ?? 64,
    };

    // GPU resources
    this.gl = gl;
    this.particleCount = 0;
    this.textureWidth = 0;
    this.textureHeight = 0;

    // CSR arrays (CPU)
    this.rowPtr = null;
    this.colIdx = null;
    this.weight = null;
    this.deg = null;
    this.degInv = null;

    // Shards
    this.shards = null; // Array of {nodeId, start, len}
    this.numShards = 0;

    // GPU textures
    this.edgeDataTex = null; // Packed RGBA8: [nodeIdx_24bit, weight_8bit]
    this.colIdxTex = null;
    this.weightTex = null;
    this.shardsTex = null;
    this.degTex = null;
    this.degInvTex = null;
    this.partialsTex = null;
    this.partialsTexPingPong = null;
    this.AxTex = null;

    // Weight quantization range
    this.weightRange = { min: 0, max: 1 };

    // FBOs
    this.partialsFBO = null;
    this.partialsFBOPingPong = null;
    this.AxFBO = null;

    // Programs
    this.partialsProgram = null;
    this.reduceBlendProgram = null;
    this.reduceSegmentedProgram = null;
    this.laplacianFinishProgram = null;

    // VAOs
    this.quadVAO = null;

    this.particleCount = options.particleCount;
    this.textureWidth = options.textureWidth;
    this.textureHeight = options.textureHeight;
    this.disableFloatBlend = options.disableFloatBlend;

    // Build CSR
    this.buildCSR();

    // Build shards
    this.buildShards();

    // Upload to GPU
    if (!this.gl) {
      throw new Error('LaplacianForceModule requires a valid WebGL2RenderingContext');
    }

    this.createTextures();
    this.uploadData();

    // Compile shaders
    this.createPrograms();

    // Create geometry
    this.createGeometry();

  }

  /**
   * Build CSR (Compressed Sparse Row) from edges
   */
  buildCSR() {
    const N = this.particleCount;
    const edges = this.edges;

    // Count degree (both directions for undirected)
    const degreeCount = new Float32Array(N);
    const adjacency = Array.from({ length: N }, () => []);

    for (const e of edges) {
      const { from, to, strength } = e;
      if (from < 0 || from >= N || to < 0 || to >= N) {
        console.warn(`Edge out of bounds: ${from} -> ${to}`);
        continue;
      }

      // Undirected: add both directions
      adjacency[from].push({ to, weight: strength });
      adjacency[to].push({ to: from, weight: strength });

      degreeCount[from] += strength;
      degreeCount[to] += strength;
    }

    // Build CSR arrays
    const E = adjacency.reduce((sum, list) => sum + list.length, 0);
    this.rowPtr = new Float32Array(N + 1);
    this.colIdx = new Float32Array(E);
    this.weight = new Float32Array(E);
    this.deg = degreeCount;

    let offset = 0;
    for (let i = 0; i < N; i++) {
      this.rowPtr[i] = offset;
      const neighbors = adjacency[i];

      for (let j = 0; j < neighbors.length; j++) {
        this.colIdx[offset] = neighbors[j].to;
        this.weight[offset] = neighbors[j].weight;
        offset++;
      }
    }
    this.rowPtr[N] = offset;

    // Compute degInv for normalized mode
    if (this.options.normalized) {
      this.degInv = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        this.degInv[i] = this.deg[i] > 0 ? 1.0 / this.deg[i] : 0;
      }
    }

    console.log(`[LaplacianForce] Built CSR: N=${N}, E=${E}`);
  }

  /**
   * Build shards for load balancing
   */
  buildShards() {
    const N = this.particleCount;
    const L = this.options.shardSize;
    const shardsList = [];

    for (let i = 0; i < N; i++) {
      const start = this.rowPtr[i];
      const end = this.rowPtr[i + 1];
      const degree = end - start;

      if (degree === 0) continue;

      // Split into shards of size L
      for (let offset = 0; offset < degree; offset += L) {
        const len = Math.min(L, degree - offset);
        shardsList.push({
          nodeId: i,
          start: start + offset,
          len: len,
        });
      }
    }

    this.shards = shardsList;
    this.numShards = shardsList.length;

    console.log(`[LaplacianForce] Generated ${this.numShards} shards (L=${L})`);
  }

  /**
   * Create GPU textures
   *
   * OPTIMIZED PACKING for millions of edges:
   * - edgeData: RGBA8 texture packing [nodeIdx_R, nodeIdx_G, nodeIdx_B, weight]
   *   * 24 bits for node index (supports up to 16M nodes)
   *   * 8 bits for quantized weight (256 levels, 0-1 range)
   *   * 32 bits total per edge (2× reduction vs R32F+R32F)
   */
  createTextures() {
    const gl = this.gl;
    if (!gl) {
      throw new Error('createTextures called without WebGL context');
    }

    // Pack colIdx + weight into single RGBA8 texture (memory efficient!)
    // RGBA = [nodeIdx_R, nodeIdx_G, nodeIdx_B, weight_quantized]
    const edgeDataSize = this.calculateTextureSize(this.colIdx.length);
    this.edgeDataTex = this.createDataTexture(
      edgeDataSize.width,
      edgeDataSize.height,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE
    );

    // Keep separate R32F textures for backwards compatibility with existing shaders
    // TODO: Update shaders to use packed edgeData texture
    const colIdxSize = this.calculateTextureSize(this.colIdx.length);
    this.colIdxTex = this.createDataTexture(
      colIdxSize.width,
      colIdxSize.height,
      gl.R32F,
      gl.RED,
      gl.FLOAT
    );

    const weightSize = this.calculateTextureSize(this.weight.length);
    this.weightTex = this.createDataTexture(
      weightSize.width,
      weightSize.height,
      gl.R32F,
      gl.RED,
      gl.FLOAT
    );

    // shards texture (numShards * 4 for RGBA packing: nodeId, start, len, 0)
    const shardsSize = this.calculateTextureSize(this.numShards);
    this.shardsTex = this.createDataTexture(
      shardsSize.width,
      shardsSize.height,
      gl.RGBA32F,
      gl.RGBA,
      gl.FLOAT
    );

    // deg texture
    const degSize = this.calculateTextureSize(this.particleCount);
    this.degTex = this.createDataTexture(
      degSize.width,
      degSize.height,
      gl.R32F,
      gl.RED,
      gl.FLOAT
    );

    if (this.degInv) {
      this.degInvTex = this.createDataTexture(
        degSize.width,
        degSize.height,
        gl.R32F,
        gl.RED,
        gl.FLOAT
      );
    }

    // partials textures (numShards, ping-pong for reduction)
    const partialsSize = this.calculateTextureSize(this.numShards);
    this.partialsTex = this.createRenderTexture(
      partialsSize.width,
      partialsSize.height
    );
    this.partialsTexPingPong = this.createRenderTexture(
      partialsSize.width,
      partialsSize.height
    );

    // Ax texture (N elements)
    const AxSize = this.calculateTextureSize(this.particleCount);
    this.AxTex = this.createRenderTexture(AxSize.width, AxSize.height);

    // FBOs
    this.partialsFBO = this.createFramebuffer(this.partialsTex);
    this.partialsFBOPingPong = this.createFramebuffer(this.partialsTexPingPong);
    this.AxFBO = this.createFramebuffer(this.AxTex);
  }

  /**
   * Calculate texture dimensions for 1D data
   */
  calculateTextureSize(length) {
    const gl = this.gl;
    const maxSize = gl ? gl.getParameter(gl.MAX_TEXTURE_SIZE) : 16384;

    // Use sqrt layout capped at maxSize
    const width = Math.min(maxSize, Math.ceil(Math.sqrt(length)));
    const height = Math.ceil(length / width);

    if (height > maxSize) {
      console.error(
        `[LaplacianForce] Texture size exceeded! Need ${width}x${height} but max is ${maxSize}`
      );
      console.error(
        `[LaplacianForce] Data length: ${length}, Max elements: ${
          maxSize * maxSize
        }`
      );
      throw new Error(
        `Texture size limit exceeded: need ${width}x${height}, max is ${maxSize}x${maxSize}`
      );
    }

    return { width, height };
  }

  /**
   * Create data texture
   */
  createDataTexture(width, height, internalFormat, format, type) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      internalFormat,
      width,
      height,
      0,
      format,
      type,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /**
   * Create render texture
   */
  createRenderTexture(width, height) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA32F,
      width,
      height,
      0,
      gl.RGBA,
      gl.FLOAT,
      null
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return tex;
  }

  /**
   * Create framebuffer
   */
  createFramebuffer(texture) {
    const gl = this.gl;
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      texture,
      0
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return fbo;
  }

  /**
   * Upload data to textures
   */
  uploadData() {
    const gl = this.gl;

    // Upload packed edgeData (RGBA8: 24-bit index + 8-bit weight)
    const edgeDataSize = this.calculateTextureSize(this.colIdx.length);
    const edgeDataPacked = new Uint8Array(
      edgeDataSize.width * edgeDataSize.height * 4
    );

    // Find weight range for quantization
    let minWeight = Infinity,
      maxWeight = -Infinity;
    for (let i = 0; i < this.weight.length; i++) {
      minWeight = Math.min(minWeight, this.weight[i]);
      maxWeight = Math.max(maxWeight, this.weight[i]);
    }
    this.weightRange = { min: minWeight, max: maxWeight };

    // Pack edges: [nodeIdx_R, nodeIdx_G, nodeIdx_B, weight_quantized]
    for (let i = 0; i < this.colIdx.length; i++) {
      const nodeIdx = Math.floor(this.colIdx[i]);
      const weight = this.weight[i];

      // Pack node index into 24 bits (3 bytes)
      edgeDataPacked[i * 4 + 0] = (nodeIdx >> 16) & 0xff; // High byte
      edgeDataPacked[i * 4 + 1] = (nodeIdx >> 8) & 0xff; // Mid byte
      edgeDataPacked[i * 4 + 2] = nodeIdx & 0xff; // Low byte

      // Quantize weight to 8 bits (0-255)
      const weightNorm = (weight - minWeight) / (maxWeight - minWeight + 1e-10);
      edgeDataPacked[i * 4 + 3] = Math.floor(weightNorm * 255);
    }

    gl.bindTexture(gl.TEXTURE_2D, this.edgeDataTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      edgeDataSize.width,
      edgeDataSize.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      edgeDataPacked
    );

    console.log(
      `[LaplacianForce] Packed ${this.colIdx.length} edges into RGBA8 texture (${edgeDataSize.width}x${edgeDataSize.height})`
    );
    console.log(
      `[LaplacianForce] Weight range: [${minWeight.toExponential(
        2
      )}, ${maxWeight.toExponential(2)}]`
    );

    // Upload colIdx (legacy R32F for existing shaders)
    const colIdxSize = this.calculateTextureSize(this.colIdx.length);
    const colIdxPadded = new Float32Array(colIdxSize.width * colIdxSize.height);
    colIdxPadded.set(this.colIdx);
    gl.bindTexture(gl.TEXTURE_2D, this.colIdxTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      colIdxSize.width,
      colIdxSize.height,
      gl.RED,
      gl.FLOAT,
      colIdxPadded
    );

    // Upload weight (legacy R32F for existing shaders)
    const weightSize = this.calculateTextureSize(this.weight.length);
    const weightPadded = new Float32Array(weightSize.width * weightSize.height);
    weightPadded.set(this.weight);
    gl.bindTexture(gl.TEXTURE_2D, this.weightTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      weightSize.width,
      weightSize.height,
      gl.RED,
      gl.FLOAT,
      weightPadded
    );

    // Upload shards (pack as RGBA: nodeId, start, len, 0)
    const shardsSize = this.calculateTextureSize(this.numShards);
    const shardsPacked = new Float32Array(
      shardsSize.width * shardsSize.height * 4
    );
    for (let i = 0; i < this.shards.length; i++) {
      shardsPacked[i * 4 + 0] = this.shards[i].nodeId;
      shardsPacked[i * 4 + 1] = this.shards[i].start;
      shardsPacked[i * 4 + 2] = this.shards[i].len;
      shardsPacked[i * 4 + 3] = 0;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.shardsTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      shardsSize.width,
      shardsSize.height,
      gl.RGBA,
      gl.FLOAT,
      shardsPacked
    );

    // Upload deg
    const degSize = this.calculateTextureSize(this.particleCount);
    const degPadded = new Float32Array(degSize.width * degSize.height);
    degPadded.set(this.deg);
    gl.bindTexture(gl.TEXTURE_2D, this.degTex);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      degSize.width,
      degSize.height,
      gl.RED,
      gl.FLOAT,
      degPadded
    );

    if (this.degInv && this.degInvTex) {
      const degInvPadded = new Float32Array(degSize.width * degSize.height);
      degInvPadded.set(this.degInv);
      gl.bindTexture(gl.TEXTURE_2D, this.degInvTex);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        degSize.width,
        degSize.height,
        gl.RED,
        gl.FLOAT,
        degInvPadded
      );
    }

    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /**
   * Create shader programs
   */
  createPrograms() {
    const gl = this.gl;

    // Pass 1: partials shader
    this.partialsProgram = this.createProgram(
      this.getFullscreenVS(),
      this.getPartialsFS()
    );

    // Pass 2: reduction (blending variant)
    this.reduceBlendProgram = this.createProgram(
      this.getPointVS(),
      this.getReduceBlendFS()
    );

    // Pass 3: laplacian finish
    this.laplacianFinishProgram = this.createProgram(
      this.getFullscreenVS(),
      this.getLaplacianFinishFS()
    );
  }

  /**
   * Create shader program
   */
  createProgram(vertSrc, fragSrc) {
    const gl = this.gl;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vertSrc);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error("VS compile error: " + gl.getShaderInfoLog(vs));
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fragSrc);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error("FS compile error: " + gl.getShaderInfoLog(fs));
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("Program link error: " + gl.getProgramInfoLog(prog));
    }

    gl.deleteShader(vs);
    gl.deleteShader(fs);

    return prog;
  }

  /**
   * Create geometry
   */
  createGeometry() {
    const gl = this.gl;

    // Quad for fullscreen passes
    const quadVertices = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);

    this.quadVAO = gl.createVertexArray();
    gl.bindVertexArray(this.quadVAO);

    const quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quadVertices, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindVertexArray(null);
  }

  /**
   * Accumulate forces into target
   * @param {{
   *   gl: WebGL2RenderingContext,
   *   positionTextures: any,
   *   targetForce: {texture: WebGLTexture, framebuffer: WebGLFramebuffer},
   *   textureSize: {width: number, height: number},
   *   currentIndex: number,
   *   dt: number,
   *   forKDKPhase?: string
   * }} ctx
   */
  accumulate(ctx) {
    const gl = this.gl;
    const positionTex = ctx.positionTextures.textures[ctx.currentIndex];

    // Pass 1: compute partials
    this.runPartialsPass(positionTex);

    // Pass 2: reduce partials to Ax
    if (this.disableFloatBlend) {
      // TODO: implement segmented reduction fallback
      console.warn(
        "[LaplacianForce] Segmented reduction not yet implemented, skipping"
      );
      return;
    } else {
      this.runReduceBlendPass();
    }

    // Pass 3: compute F_attr = k * (Ax - deg*x) and add to targetForce
    this.runLaplacianFinishPass(ctx.targetForce, positionTex);
  }

  /**
   * Pass 1: compute partials (one fragment per shard)
   */
  runPartialsPass(positionTex) {
    const gl = this.gl;
    const prog = this.partialsProgram;

    gl.useProgram(prog);

    // Bind FBO
    const partialsSize = this.calculateTextureSize(this.numShards);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.partialsFBO);
    gl.viewport(0, 0, partialsSize.width, partialsSize.height);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shardsTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uShards"), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.colIdxTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uColIdx"), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.weightTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uWeight"), 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, positionTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uPos"), 3);

    // Uniforms
    const shardsSize = this.calculateTextureSize(this.numShards);
    gl.uniform2i(
      gl.getUniformLocation(prog, "uShardSize"),
      shardsSize.width,
      shardsSize.height
    );

    const colIdxSize = this.calculateTextureSize(this.colIdx.length);
    gl.uniform2i(
      gl.getUniformLocation(prog, "uColIdxSize"),
      colIdxSize.width,
      colIdxSize.height
    );

    const posSize = { width: this.textureWidth, height: this.textureHeight };
    gl.uniform2i(
      gl.getUniformLocation(prog, "uPosSize"),
      posSize.width,
      posSize.height
    );

    gl.uniform1i(
      gl.getUniformLocation(prog, "uShardBlockSize"),
      this.options.shardSize
    );

    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Pass 2: reduce partials via additive blending
   */
  runReduceBlendPass() {
    const gl = this.gl;
    const prog = this.reduceBlendProgram;

    gl.useProgram(prog);

    // Bind Ax FBO
    const AxSize = this.calculateTextureSize(this.particleCount);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.AxFBO);
    gl.viewport(0, 0, AxSize.width, AxSize.height);

    // Clear Ax
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Enable additive blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // Bind partials texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.partialsTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uPartials"), 0);

    // Bind shards texture (to get nodeId)
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.shardsTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uShards"), 1);

    // Uniforms
    const shardsSize = this.calculateTextureSize(this.numShards);
    gl.uniform2i(
      gl.getUniformLocation(prog, "uShardSize"),
      shardsSize.width,
      shardsSize.height
    );
    gl.uniform2i(
      gl.getUniformLocation(prog, "uAxSize"),
      AxSize.width,
      AxSize.height
    );
    gl.uniform2i(
      gl.getUniformLocation(prog, "uPartialsSize"),
      shardsSize.width,
      shardsSize.height
    );

    // Draw points (one per shard)
    gl.drawArrays(gl.POINTS, 0, this.numShards);

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Pass 3: compute F_attr = k * (Ax - deg*x) and add to targetForce
   */
  runLaplacianFinishPass(targetForce, positionTex) {
    const gl = this.gl;
    const prog = this.laplacianFinishProgram;

    gl.useProgram(prog);

    // Bind target force FBO
    gl.bindFramebuffer(gl.FRAMEBUFFER, targetForce.framebuffer);
    gl.viewport(0, 0, this.textureWidth, this.textureHeight);

    // Enable additive blending to add to existing force
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);

    // Bind textures
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.AxTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uAx"), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.degTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uDeg"), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, positionTex);
    gl.uniform1i(gl.getUniformLocation(prog, "uPos"), 2);

    // Uniforms
    const AxSize = this.calculateTextureSize(this.particleCount);
    gl.uniform2i(
      gl.getUniformLocation(prog, "uAxSize"),
      AxSize.width,
      AxSize.height
    );

    const degSize = this.calculateTextureSize(this.particleCount);
    gl.uniform2i(
      gl.getUniformLocation(prog, "uDegSize"),
      degSize.width,
      degSize.height
    );

    gl.uniform2i(
      gl.getUniformLocation(prog, "uPosSize"),
      this.textureWidth,
      this.textureHeight
    );
    gl.uniform1f(gl.getUniformLocation(prog, "uK"), this.options.k);

    // Draw
    gl.bindVertexArray(this.quadVAO);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.disable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * Dispose GPU resources
   */
  dispose() {
    if (!this.gl) return;

    const gl = this.gl;

    if (this.colIdxTex) gl.deleteTexture(this.colIdxTex);
    if (this.weightTex) gl.deleteTexture(this.weightTex);
    if (this.shardsTex) gl.deleteTexture(this.shardsTex);
    if (this.degTex) gl.deleteTexture(this.degTex);
    if (this.degInvTex) gl.deleteTexture(this.degInvTex);
    if (this.partialsTex) gl.deleteTexture(this.partialsTex);
    if (this.partialsTexPingPong) gl.deleteTexture(this.partialsTexPingPong);
    if (this.AxTex) gl.deleteTexture(this.AxTex);

    if (this.partialsFBO) gl.deleteFramebuffer(this.partialsFBO);
    if (this.partialsFBOPingPong)
      gl.deleteFramebuffer(this.partialsFBOPingPong);
    if (this.AxFBO) gl.deleteFramebuffer(this.AxFBO);

    if (this.partialsProgram) gl.deleteProgram(this.partialsProgram);
    if (this.reduceBlendProgram) gl.deleteProgram(this.reduceBlendProgram);
    if (this.reduceSegmentedProgram)
      gl.deleteProgram(this.reduceSegmentedProgram);
    if (this.laplacianFinishProgram)
      gl.deleteProgram(this.laplacianFinishProgram);

    if (this.quadVAO) gl.deleteVertexArray(this.quadVAO);

    this.isInitialized = false;
  }

  // ============ Shader Sources ============

  getFullscreenVS() {
    return `#version 300 es
precision highp float;
in vec2 position;
out vec2 vUV;
void main() {
  vUV = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;
  }

  getPartialsFS() {
    return `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uShards;
uniform sampler2D uColIdx;
uniform sampler2D uWeight;
uniform sampler2D uPos;

uniform ivec2 uShardSize;
uniform ivec2 uColIdxSize;
uniform ivec2 uPosSize;
uniform int uShardBlockSize;

in vec2 vUV;
out vec4 outPartial;

vec4 fetch1D(sampler2D tex, ivec2 size, int idx) {
  ivec2 uv = ivec2(idx % size.x, idx / size.x);
  return texelFetch(tex, uv, 0);
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int sid = coord.y * uShardSize.x + coord.x;
  
  // Fetch shard info
  vec4 shardData = fetch1D(uShards, uShardSize, sid);
  int nodeId = int(shardData.x + 0.5);
  int start = int(shardData.y + 0.5);
  int len = int(shardData.z + 0.5);
  
  vec3 sumx = vec3(0.0);
  float wsum = 0.0;
  
  // Loop over neighbors in this shard
  for (int k = 0; k < 256; k++) {
    if (k >= len || k >= uShardBlockSize) break;
    
    int e = start + k;
    float nbrIdx = fetch1D(uColIdx, uColIdxSize, e).x;
    int nbr = int(nbrIdx + 0.5);
    float w = fetch1D(uWeight, uColIdxSize, e).x;
    
    vec3 xj = fetch1D(uPos, uPosSize, nbr).xyz;
    sumx += w * xj;
    wsum += w;
  }
  
  outPartial = vec4(sumx, wsum);
}`;
  }

  getPointVS() {
    return `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uShards;
uniform ivec2 uShardSize;
uniform ivec2 uAxSize;

vec4 fetch1D(sampler2D tex, ivec2 size, int idx) {
  ivec2 uv = ivec2(idx % size.x, idx / size.x);
  return texelFetch(tex, uv, 0);
}

void main() {
  int sid = gl_VertexID;
  
  // Fetch nodeId from shard
  vec4 shardData = fetch1D(uShards, uShardSize, sid);
  int nodeId = int(shardData.x + 0.5);
  
  // Place point at nodeId pixel in Ax texture
  ivec2 nodePixel = ivec2(nodeId % uAxSize.x, nodeId / uAxSize.x);
  vec2 nodeUV = (vec2(nodePixel) + 0.5) / vec2(uAxSize);
  vec2 clipPos = nodeUV * 2.0 - 1.0;
  
  gl_Position = vec4(clipPos, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;
  }

  getReduceBlendFS() {
    return `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uPartials;
uniform ivec2 uPartialsSize;

vec4 fetch1D(sampler2D tex, ivec2 size, int idx) {
  ivec2 uv = ivec2(idx % size.x, idx / size.x);
  return texelFetch(tex, uv, 0);
}

out vec4 outAx;

void main() {
  int sid = int(gl_FragCoord.x);
  vec4 partial = fetch1D(uPartials, uPartialsSize, sid);
  outAx = partial;
}`;
  }

  getLaplacianFinishFS() {
    return `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D uAx;
uniform sampler2D uDeg;
uniform sampler2D uPos;

uniform ivec2 uAxSize;
uniform ivec2 uDegSize;
uniform ivec2 uPosSize;
uniform float uK;

in vec2 vUV;
out vec4 outForce;

vec4 fetch1D(sampler2D tex, ivec2 size, int idx) {
  ivec2 uv = ivec2(idx % size.x, idx / size.x);
  return texelFetch(tex, uv, 0);
}

void main() {
  ivec2 coord = ivec2(gl_FragCoord.xy);
  int i = coord.y * uPosSize.x + coord.x;
  
  vec3 Ax = fetch1D(uAx, uAxSize, i).xyz;
  float deg = fetch1D(uDeg, uDegSize, i).x;
  vec3 xi = fetch1D(uPos, uPosSize, i).xyz;
  
  // F_attr = k * (Ax - deg*xi)
  vec3 F_attr = uK * (Ax - deg * xi);
  
  outForce = vec4(F_attr, 0.0);
}`;
  }
}
