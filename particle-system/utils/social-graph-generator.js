// @ts-check

/**
 * Social graph generator with power-law degree distribution, cliques, and clusters
 * 
 * Generates realistic social network-like graphs with:
 * - Power-law degree distribution (scale-free networks)
 * - Dense cliques (friend groups, families)
 * - Clusters with high intra-cluster edges
 * - Inter-cluster bridges (weak ties)
 * - Variable edge strengths
 * 
 * @param {number} N - Number of nodes
 * @param {{
 *   avgDegree?: number,
 *   powerLawExponent?: number,
 *   numClusters?: number,
 *   clusterSizeRange?: [number, number],
 *   cliqueSize?: number,
 *   numCliques?: number,
 *   intraClusterProb?: number,
 *   interClusterProb?: number,
 *   strengthMin?: number,
 *   strengthMax?: number,
 *   seed?: number
 * }} [options]
 * @returns {{from: number, to: number, strength: number}[]}
 */
export function generateSocialGraph(N, options = {}) {
  const {
    avgDegree = 4,
    powerLawExponent = 2.5,
    numClusters = Math.ceil(Math.sqrt(N) / 2),
    clusterSizeRange = [Math.max(5, Math.floor(N / 50)), Math.max(20, Math.floor(N / 10))],
    cliqueSize = 5,
    numCliques = Math.max(1, Math.floor(N / 100)),
    intraClusterProb = 0.3,
    interClusterProb = 0.01,
    strengthMin = 0.5,
    strengthMax = 2.0,
    seed = 42
  } = options;
  
  // Simple seeded random number generator (LCG)
  let rngState = seed;
  function random() {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return (rngState >>> 0) / 0xFFFFFFFF;
  }
  
  /** @type {Set<string>} */
  const edgeSet = new Set();
  /** @type {{from: number, to: number, strength: number}[]} */
  const edges = [];
  
  /**
   * Add edge with deduplication
   * @param {number} from
   * @param {number} to
   * @param {number} strength
   */
  function addEdge(from, to, strength) {
    if (from === to) return;
    const [a, b] = from < to ? [from, to] : [to, from];
    const key = `${a}-${b}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      edges.push({ from: a, to: b, strength });
    }
  }
  
  // 1. Assign nodes to clusters
  /** @type {number[]} */
  const nodeCluster = new Array(N);
  let currentNode = 0;
  
  for (let c = 0; c < numClusters; c++) {
    const clusterSize = Math.floor(
      clusterSizeRange[0] + random() * (clusterSizeRange[1] - clusterSizeRange[0])
    );
    const nodesInCluster = Math.min(clusterSize, N - currentNode);
    
    for (let i = 0; i < nodesInCluster; i++) {
      if (currentNode < N) {
        nodeCluster[currentNode++] = c;
      }
    }
  }
  
  // Assign remaining nodes to random clusters
  while (currentNode < N) {
    nodeCluster[currentNode++] = Math.floor(random() * numClusters);
  }
  
  // 2. Create cluster adjacency lists
  /** @type {number[][]} */
  const clusterNodes = Array.from({ length: numClusters }, () => []);
  for (let i = 0; i < N; i++) {
    clusterNodes[nodeCluster[i]].push(i);
  }
  
  // 3. Generate power-law degree sequence (preferential attachment hubs)
  /** @type {number[]} */
  const targetDegrees = new Array(N);
  let totalDegreeSum = 0;
  
  for (let i = 0; i < N; i++) {
    // Power-law distribution: P(k) ~ k^(-gamma)
    // Use inverse transform sampling
    const u = random();
    const k = Math.floor(Math.pow(1 - u, -1 / (powerLawExponent - 1)));
    targetDegrees[i] = Math.max(1, Math.min(k, N / 2)); // Clamp to reasonable range
    totalDegreeSum += targetDegrees[i];
  }
  
  // Normalize to match avgDegree
  const scaleFactor = (avgDegree * N) / totalDegreeSum;
  for (let i = 0; i < N; i++) {
    targetDegrees[i] = Math.max(1, Math.floor(targetDegrees[i] * scaleFactor));
  }
  
  // 4. Intra-cluster edges (dense within communities)
  for (let c = 0; c < numClusters; c++) {
    const nodes = clusterNodes[c];
    const m = nodes.length;
    
    for (let i = 0; i < m; i++) {
      for (let j = i + 1; j < m; j++) {
        if (random() < intraClusterProb) {
          const strength = strengthMin + random() * (strengthMax - strengthMin);
          addEdge(nodes[i], nodes[j], strength);
        }
      }
    }
  }
  
  // 5. Inter-cluster bridges (weak ties)
  for (let i = 0; i < N; i++) {
    const myCluster = nodeCluster[i];
    
    // Try to connect to nodes in other clusters
    const numBridges = Math.floor(1 + random() * 3); // 1-3 bridges per node
    for (let b = 0; b < numBridges; b++) {
      if (random() < interClusterProb) {
        // Pick a random different cluster
        let otherCluster;
        do {
          otherCluster = Math.floor(random() * numClusters);
        } while (otherCluster === myCluster && numClusters > 1);
        
        // Pick random node from that cluster
        const otherNodes = clusterNodes[otherCluster];
        if (otherNodes.length > 0) {
          const j = otherNodes[Math.floor(random() * otherNodes.length)];
          const strength = strengthMin + random() * (strengthMax - strengthMin) * 0.5; // Weaker bridges
          addEdge(i, j, strength);
        }
      }
    }
  }
  
  // 6. Dense cliques (small fully-connected subgraphs)
  for (let c = 0; c < numCliques; c++) {
    /** @type {number[]} */
    const cliqueNodes = [];
    const clusterIdx = Math.floor(random() * numClusters);
    const candidates = clusterNodes[clusterIdx];
    
    // Pick random nodes from cluster
    const size = Math.min(cliqueSize, candidates.length);
    const shuffled = [...candidates].sort(() => random() - 0.5);
    for (let i = 0; i < size; i++) {
      cliqueNodes.push(shuffled[i]);
    }
    
    // Fully connect clique
    for (let i = 0; i < cliqueNodes.length; i++) {
      for (let j = i + 1; j < cliqueNodes.length; j++) {
        const strength = strengthMin + random() * (strengthMax - strengthMin) * 1.5; // Stronger clique ties
        addEdge(cliqueNodes[i], cliqueNodes[j], strength);
      }
    }
  }
  
  // 7. Ensure minimum degree (prevent isolated nodes)
  /** @type {number[]} */
  const actualDegrees = new Array(N).fill(0);
  for (const edge of edges) {
    actualDegrees[edge.from]++;
    actualDegrees[edge.to]++;
  }
  
  for (let i = 0; i < N; i++) {
    if (actualDegrees[i] === 0) {
      // Connect to random node in same cluster
      const myCluster = nodeCluster[i];
      const candidates = clusterNodes[myCluster].filter(n => n !== i);
      if (candidates.length > 0) {
        const j = candidates[Math.floor(random() * candidates.length)];
        const strength = strengthMin + random() * (strengthMax - strengthMin);
        addEdge(i, j, strength);
      }
    }
  }
  
  console.log(`Generated social graph: N=${N}, E=${edges.length}, avg_degree=${(2 * edges.length / N).toFixed(2)}`);
  
  return edges;
}

/**
 * Generate a simple grid graph (lattice structure)
 * Useful for testing spring forces in a regular pattern
 * 
 * @param {number} rows - Number of rows
 * @param {number} cols - Number of columns
 * @param {{
 *   diagonal?: boolean,
 *   strength?: number
 * }} [options]
 * @returns {{from: number, to: number, strength: number}[]}
 */
export function generateGridGraph(rows, cols, options = {}) {
  const { diagonal = false, strength = 1.0 } = options;
  
  /** @type {{from: number, to: number, strength: number}[]} */
  const edges = [];
  
  const nodeIndex = (r, c) => r * cols + c;
  
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = nodeIndex(r, c);
      
      // Horizontal edge
      if (c < cols - 1) {
        edges.push({ from: i, to: nodeIndex(r, c + 1), strength });
      }
      
      // Vertical edge
      if (r < rows - 1) {
        edges.push({ from: i, to: nodeIndex(r + 1, c), strength });
      }
      
      // Diagonal edges
      if (diagonal) {
        if (r < rows - 1 && c < cols - 1) {
          edges.push({ from: i, to: nodeIndex(r + 1, c + 1), strength });
        }
        if (r < rows - 1 && c > 0) {
          edges.push({ from: i, to: nodeIndex(r + 1, c - 1), strength });
        }
      }
    }
  }
  
  console.log(`Generated grid graph: ${rows}x${cols}, E=${edges.length}`);
  
  return edges;
}

/**
 * Generate a tree graph (hierarchical structure)
 * 
 * @param {number} N - Number of nodes
 * @param {{
 *   branchingFactor?: number,
 *   strength?: number
 * }} [options]
 * @returns {{from: number, to: number, strength: number}[]}
 */
export function generateTreeGraph(N, options = {}) {
  const { branchingFactor = 3, strength = 1.0 } = options;
  
  /** @type {{from: number, to: number, strength: number}[]} */
  const edges = [];
  
  for (let i = 1; i < N; i++) {
    const parent = Math.floor((i - 1) / branchingFactor);
    edges.push({ from: parent, to: i, strength });
  }
  
  console.log(`Generated tree graph: N=${N}, branching=${branchingFactor}, E=${edges.length}`);
  
  return edges;
}
