// @ts-check

/**
 * GPU Profiler using EXT_disjoint_timer_query_webgl2
 * 
 * Implements non-blocking GPU timer queries to measure GPU pass execution time.
 * Results are collected 2-3 frames later to avoid pipeline stalls.
 * Averages over 100+ frames for statistical stability.
 */
export class GPUProfiler {
  constructor(gl) {
    this.gl = gl;
    this.enabled = false;
    this.ext = null;
    
    // Query management
    this.pendingQueries = [];
    this.results = {};
    this.frameSamples = {};
    this.maxSamples = 100; // Average over 100 frames
    
    // Try to enable the extension
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    
    if (!this.ext) {
      console.warn('GPUProfiler: EXT_disjoint_timer_query_webgl2 not available');
      return;
    }
    
    this.enabled = true;
  }
  
  /**
   * Begin timing a GPU pass
   * @param {string} name - Name of the pass to profile
   */
  begin(name) {
    if (!this.enabled) return;
    
    const gl = this.gl;
    const query = gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    
    // Store query for later collection
    this.pendingQueries.push({ name, query, frameStarted: Date.now() });
  }
  
  /**
   * End timing for the current GPU pass
   */
  end() {
    if (!this.enabled) return;
    
    const gl = this.gl;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
  }
  
  /**
   * Collect results from completed queries (non-blocking)
   * Should be called once per frame after a delay (2-3 frames)
   */
  update() {
    if (!this.enabled) return;
    
    const gl = this.gl;
    
    // Check for GPU disjoint (timer invalidation)
    if (gl.getParameter(this.ext.GPU_DISJOINT_EXT)) {
      // Discard all pending queries - they're invalid
      this.pendingQueries.forEach(({ query }) => gl.deleteQuery(query));
      this.pendingQueries = [];
      return;
    }
    
    // Check pending queries for results
    const stillPending = [];
    
    for (const { name, query, frameStarted } of this.pendingQueries) {
      // Non-blocking check: is result available?
      const available = gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE);
      
      if (available) {
        // Get result in nanoseconds, convert to milliseconds
        const timeNs = gl.getQueryParameter(query, gl.QUERY_RESULT);
        const timeMs = timeNs / 1000000;
        
        // Add to rolling average
        if (!this.frameSamples[name]) {
          this.frameSamples[name] = [];
        }
        this.frameSamples[name].push(timeMs);
        
        // Keep only last N samples
        if (this.frameSamples[name].length > this.maxSamples) {
          this.frameSamples[name].shift();
        }
        
        // Update average
        const samples = this.frameSamples[name];
        const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
        this.results[name] = avg;
        
        // Clean up query
        gl.deleteQuery(query);
      } else {
        // Result not ready yet, keep pending
        stillPending.push({ name, query, frameStarted });
      }
    }
    
    this.pendingQueries = stillPending;
  }
  
  /**
   * Get profiling result for a specific pass
   * @param {string} name - Name of the pass
   * @returns {number} Average time in milliseconds
   */
  get(name) {
    return this.results[name] || 0;
  }
  
  /**
   * Get all profiling results
   * @returns {Object.<string, number>} Map of pass names to average times (ms)
   */
  getAll() {
    return { ...this.results };
  }
  
  /**
   * Get total GPU frame time
   * @returns {number} Total time in milliseconds
   */
  getTotalTime() {
    return Object.values(this.results).reduce((a, b) => a + b, 0);
  }
  
  /**
   * Reset all profiling data
   */
  reset() {
    this.results = {};
    this.frameSamples = {};
    
    // Clean up pending queries
    const gl = this.gl;
    this.pendingQueries.forEach(({ query }) => gl.deleteQuery(query));
    this.pendingQueries = [];
  }
  
  /**
   * Cleanup resources
   */
  dispose() {
    this.reset();
    this.enabled = false;
  }
}
