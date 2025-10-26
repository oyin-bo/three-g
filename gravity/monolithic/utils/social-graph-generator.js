// @ts-check

/**
 * Hierarchical social graph generator
 *
 * Generates realistic social network-like graphs with:
 * - Multi-level hierarchy (super-hubs → hubs → regular nodes)
 * - Preferential attachment (nodes connect to hubs)
 * - Hub-to-hub backbone (strong connections between hubs)
 * - Clusters with high intra-cluster density
 * - Inter-cluster bridges (primarily through hubs)
 * - Dense cliques around hubs
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
 *   hubRatio?: number,
 *   seed?: number
 * }} [options]
 * @returns {{from: number, to: number, strength: number}[]}
 */
export function generateSocialGraph(N, options = {}) {
  const {
    avgDegree = 4,
    powerLawExponent = 2.5,
    numClusters = Math.ceil(Math.sqrt(N) / 2),
    clusterSizeRange = [
      Math.max(5, Math.floor(N / 50)),
      Math.max(20, Math.floor(N / 10)),
    ],
    cliqueSize = 5,
    numCliques = Math.max(1, Math.floor(N / 100)),
    intraClusterProb = 0.3,
    interClusterProb = 0.01,
    strengthMin = 0.5,
    strengthMax = 2.0,
    hubRatio = 0.02,
    seed = 42,
  } = options;

  // Simple seeded random number generator (LCG)
  let rngState = seed;
  function random() {
    rngState = (rngState * 1664525 + 1013904223) >>> 0;
    return (rngState >>> 0) / 0xffffffff;
  }

  /** @type {Array<{from: number, to: number, strength: number}>} */
  const edges = [];

  // GPU texture limit with RGBA8 packing: 16384×16384 = 268M edges
  // For safety and reasonable graph densities, cap at 100M edges
  const MAX_EDGES = 100_000_000;

  // For large graphs (>100K nodes), skip deduplication to avoid Map size limits
  // With proper probability scaling, duplicate probability is low (<1%)
  const useDedup = N <= 100_000;

  /** @type {Map<number | string, boolean> | null} */
  const edgeMap = useDedup ? new Map() : null;
  const maxNodeForPacking = (1 << 24) - 1;

  /**
   * Add edge with optional deduplication and capacity limit
   * @param {number} from
   * @param {number} to
   * @param {number} strength
   * @returns {boolean} true if added, false if skipped (duplicate or limit reached)
   */
  function addEdge(from, to, strength) {
    if (from === to) return false;
    if (edges.length >= MAX_EDGES) return false; // Stop at capacity

    const [a, b] = from < to ? [from, to] : [to, from];

    if (useDedup && edgeMap) {
      // Deduplicate for small graphs
      let key;
      if (N <= maxNodeForPacking) {
        // Memory-efficient numeric packing for nodes < 16M
        key = a * maxNodeForPacking + b;
      } else {
        key = `${a}-${b}`;
      }

      if (edgeMap.has(key)) return false; // Duplicate
      edgeMap.set(key, true);
    }

    edges.push({ from: a, to: b, strength });
    return true;
  }

  // 1. Assign nodes to clusters
  /** @type {number[]} */
  const nodeCluster = new Array(N);
  let currentNode = 0;

  for (let c = 0; c < numClusters; c++) {
    const clusterSize = Math.floor(
      clusterSizeRange[0] +
        random() * (clusterSizeRange[1] - clusterSizeRange[0])
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

  // 3. Identify hub nodes (hierarchical structure)
  const numHubs = Math.max(1, Math.floor(N * hubRatio));
  const numSuperHubs = Math.max(1, Math.floor(numHubs * 0.1)); // Top 10% of hubs

  /** @type {number[]} */
  const hubNodes = [];
  /** @type {number[]} */
  const superHubs = [];

  // Select hubs: one per cluster + global hubs
  for (let c = 0; c < numClusters; c++) {
    const nodes = clusterNodes[c];
    if (nodes.length > 0) {
      const hubIdx = nodes[Math.floor(random() * Math.min(3, nodes.length))];
      hubNodes.push(hubIdx);
    }
  }

  // Add additional random hubs
  while (hubNodes.length < numHubs) {
    const idx = Math.floor(random() * N);
    if (!hubNodes.includes(idx)) hubNodes.push(idx);
  }

  // Select super-hubs from hubs
  for (let i = 0; i < numSuperHubs && i < hubNodes.length; i++) {
    superHubs.push(hubNodes[i]);
  }

  console.log(
    `[SocialGraph] Hierarchy: ${superHubs.length} super-hubs, ${
      hubNodes.length
    } hubs, ${N - hubNodes.length} regular nodes`
  );

  // 4. Hub-to-hub backbone (strong connections between hubs)
  for (let i = 0; i < superHubs.length; i++) {
    for (let j = i + 1; j < superHubs.length; j++) {
      if (edges.length >= MAX_EDGES) break;
      const strength = strengthMax * 1.5; // Super-strong hub connections
      addEdge(superHubs[i], superHubs[j], strength);
    }
  }

  // Connect regular hubs to super-hubs
  for (const hub of hubNodes) {
    if (superHubs.includes(hub)) continue;

    // Connect to 1-3 super-hubs
    const numConnections = 1 + Math.floor(random() * 3);
    for (let c = 0; c < numConnections && edges.length < MAX_EDGES; c++) {
      const superHub = superHubs[Math.floor(random() * superHubs.length)];
      const strength = strengthMax * 1.2;
      addEdge(hub, superHub, strength);
    }
  }

  // 5. Intra-cluster edges with preferential attachment to hubs
  for (let c = 0; c < numClusters; c++) {
    if (edges.length >= MAX_EDGES) {
      console.warn(
        `[SocialGraph] Reached edge limit (${MAX_EDGES}) at cluster ${c}/${numClusters}`
      );
      break;
    }

    const nodes = clusterNodes[c];
    const m = nodes.length;
    if (m < 2) continue;

    // Find cluster hub (if any)
    const clusterHub = nodes.find((n) => hubNodes.includes(n));

    // Calculate target edges for this cluster
    const possiblePairs = (m * (m - 1)) / 2;
    const targetEdges = Math.floor(possiblePairs * intraClusterProb);

    // Preferential attachment: 60% connect to hub, 40% random pairs
    const hubEdgeRatio = clusterHub ? 0.6 : 0.0;
    const hubEdges = Math.floor(targetEdges * hubEdgeRatio);
    const randomEdges = targetEdges - hubEdges;

    // Connect nodes to cluster hub
    if (clusterHub) {
      for (let e = 0; e < hubEdges && edges.length < MAX_EDGES; e++) {
        let node;
        do {
          node = nodes[Math.floor(random() * m)];
        } while (node === clusterHub);

        const strength = strengthMin + random() * (strengthMax - strengthMin);
        addEdge(clusterHub, node, strength);
      }
    }

    // Random pairs within cluster
    for (let e = 0; e < randomEdges && edges.length < MAX_EDGES; e++) {
      const i = Math.floor(random() * m);
      let j = Math.floor(random() * m);
      if (i === j) j = (j + 1) % m;

      const strength = strengthMin + random() * (strengthMax - strengthMin);
      addEdge(nodes[i], nodes[j], strength);
    }
  }

  // 6. Inter-cluster bridges (primarily through hubs)
  if (edges.length < MAX_EDGES) {
    // Hubs create most inter-cluster connections
    for (const hub of hubNodes) {
      if (edges.length >= MAX_EDGES) break;

      const myCluster = nodeCluster[hub];
      const numBridges = 3 + Math.floor(random() * 5); // Hubs have more bridges

      for (let b = 0; b < numBridges; b++) {
        let otherCluster;
        do {
          otherCluster = Math.floor(random() * numClusters);
        } while (otherCluster === myCluster && numClusters > 1);

        const otherNodes = clusterNodes[otherCluster];
        if (otherNodes.length > 0) {
          // Preferentially connect to other hubs
          let target;
          if (random() < 0.7) {
            const otherHubs = otherNodes.filter((n) => hubNodes.includes(n));
            target =
              otherHubs.length > 0
                ? otherHubs[Math.floor(random() * otherHubs.length)]
                : otherNodes[Math.floor(random() * otherNodes.length)];
          } else {
            target = otherNodes[Math.floor(random() * otherNodes.length)];
          }

          const strength =
            strengthMin + random() * (strengthMax - strengthMin) * 0.8;
          addEdge(hub, target, strength);
        }
      }
    }

    // Regular nodes have fewer inter-cluster bridges
    const numRegularBridges = Math.floor(N * interClusterProb);
    for (let b = 0; b < numRegularBridges && edges.length < MAX_EDGES; b++) {
      const i = Math.floor(random() * N);
      if (hubNodes.includes(i)) continue; // Skip hubs, already connected

      const myCluster = nodeCluster[i];
      let otherCluster;
      do {
        otherCluster = Math.floor(random() * numClusters);
      } while (otherCluster === myCluster && numClusters > 1);

      const otherNodes = clusterNodes[otherCluster];
      if (otherNodes.length > 0) {
        const j = otherNodes[Math.floor(random() * otherNodes.length)];
        const strength =
          strengthMin + random() * (strengthMax - strengthMin) * 0.5;
        addEdge(i, j, strength);
      }
    }
  }

  // 7. Dense cliques around hubs
  if (edges.length < MAX_EDGES && numCliques > 0) {
    for (let c = 0; c < numCliques; c++) {
      if (edges.length >= MAX_EDGES) break;

      // Pick a hub as clique center
      const centerHub = hubNodes[Math.floor(random() * hubNodes.length)];
      const hubCluster = nodeCluster[centerHub];
      const candidates = clusterNodes[hubCluster].filter(
        (n) => n !== centerHub
      );

      // Create tight clique around hub
      const size = Math.min(cliqueSize, candidates.length);
      /** @type {number[]} */
      const cliqueMembers = [centerHub];

      for (let i = 0; i < size; i++) {
        cliqueMembers.push(
          candidates[Math.floor(random() * candidates.length)]
        );
      }

      // Fully connect clique (strong ties)
      for (let i = 0; i < cliqueMembers.length; i++) {
        for (let j = i + 1; j < cliqueMembers.length; j++) {
          const strength =
            strengthMin + random() * (strengthMax - strengthMin) * 1.3;
          addEdge(cliqueMembers[i], cliqueMembers[j], strength);
          if (edges.length >= MAX_EDGES) break;
        }
        if (edges.length >= MAX_EDGES) break;
      }
    }
  }

  // 8. Ensure minimum degree (connect isolated nodes to nearest hub)
  /** @type {number[]} */
  const actualDegrees = new Array(N).fill(0);
  for (const edge of edges) {
    actualDegrees[edge.from]++;
    actualDegrees[edge.to]++;
  }

  for (let i = 0; i < N; i++) {
    if (actualDegrees[i] === 0) {
      // Connect to hub in same cluster (hierarchical attachment)
      const myCluster = nodeCluster[i];
      const clusterHubs = clusterNodes[myCluster].filter((n) =>
        hubNodes.includes(n)
      );

      let target;
      if (clusterHubs.length > 0) {
        target = clusterHubs[Math.floor(random() * clusterHubs.length)];
      } else {
        // No hub in cluster, connect to any node
        const candidates = clusterNodes[myCluster].filter((n) => n !== i);
        target =
          candidates.length > 0
            ? candidates[Math.floor(random() * candidates.length)]
            : (i + 1) % N;
      }

      const strength = strengthMin + random() * (strengthMax - strengthMin);
      addEdge(i, target, strength);
    }
  }

  const actualAvgDegree = ((2 * edges.length) / N).toFixed(2);
  const dedupStatus = useDedup ? "deduped" : "no-dedup";
  console.log(
    `[SocialGraph] Generated: N=${N}, E=${edges.length}, avg_degree=${actualAvgDegree} (${dedupStatus})`
  );

  if (edges.length >= MAX_EDGES) {
    console.warn(
      `[SocialGraph] Hit edge capacity limit (${MAX_EDGES}). Consider reducing intraClusterProb or avgDegree.`
    );
  }

  if (!useDedup && edges.length > 1000) {
    // Estimate duplicate rate by sampling
    const sampleSize = Math.min(10000, edges.length);
    const sampleEdges = new Set();
    let duplicates = 0;
    for (let i = 0; i < sampleSize; i++) {
      const idx = Math.floor(Math.random() * edges.length);
      const e = edges[idx];
      const [a, b] = e.from < e.to ? [e.from, e.to] : [e.to, e.from];
      const key = `${a}-${b}`;
      if (sampleEdges.has(key)) duplicates++;
      else sampleEdges.add(key);
    }
    const dupRate = ((duplicates / sampleSize) * 100).toFixed(2);
    console.log(
      `[SocialGraph] Estimated duplicate rate (no dedup): ${dupRate}% (sampled ${sampleSize} edges)`
    );
  }

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

  console.log(
    `Generated tree graph: N=${N}, branching=${branchingFactor}, E=${edges.length}`
  );

  return edges;
}
