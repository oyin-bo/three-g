// @ts-check

/**
 * @param {{
 *  particleCount: number,
 *  gridDimensions: { x: number, y: number, z: number },
 *  rawPositionData: Float32Array,
 *  rawVelocityData: Float32Array,
 *  rawMassData: Float32Array,
 *  cpuOriginalIndexData: Int32Array,
 *  bounds: {x: {min: number, max: number}, y: {min: number, max: number}, z: {min: number, max: number}}
 * }} _
 */
export function sortParticleData({
  particleCount,
  gridDimensions,
  rawPositionData,
  rawVelocityData,
  rawMassData,
  cpuOriginalIndexData,
  bounds
}) {
  const cellWidth = (bounds.x.max - bounds.x.min) / gridDimensions.x;
  const cellHeight = (bounds.y.max - bounds.y.min) / gridDimensions.y;
  const cellDepth = (bounds.z.max - bounds.z.min) / gridDimensions.z;

  /** @param {number} particleIndex */
  const getCellIndex = (particleIndex) => {
    const x = rawPositionData[particleIndex * 3 + 0];
    const y = rawPositionData[particleIndex * 3 + 1];
    const z = rawPositionData[particleIndex * 3 + 2];

    const cellX = Math.floor((x - bounds.x.min) / cellWidth);
    const cellY = Math.floor((y - bounds.y.min) / cellHeight);
    const cellZ = Math.floor((z - bounds.z.min) / cellDepth);

    return (
      cellZ * gridDimensions.y * gridDimensions.x +
      cellY * gridDimensions.x +
      cellX
    );
  };

  cpuOriginalIndexData.sort((indexA, indexB) => {
    const cellIndexA = getCellIndex(indexA);
    const cellIndexB = getCellIndex(indexB);
    return cellIndexA - cellIndexB;
  });

  const positionData = new Float32Array(particleCount * 3);
  const velocityData = new Float32Array(particleCount * 3);
  const massData = new Float32Array(particleCount);

  const cellCount = gridDimensions.x * gridDimensions.y * gridDimensions.z;
  const cellSpanOffsetData = new Int32Array(cellCount);
  const cellTotalMassData = new Float32Array(cellCount);
  cellSpanOffsetData.fill(-1);
  cellTotalMassData.fill(0);

  for (let i = 0; i < cpuOriginalIndexData.length; i++) {
    const originalIndex = cpuOriginalIndexData[i];
    positionData[i * 3 + 0] = rawPositionData[originalIndex * 3 + 0];
    positionData[i * 3 + 1] = rawPositionData[originalIndex * 3 + 1];
    positionData[i * 3 + 2] = rawPositionData[originalIndex * 3 + 2];

    velocityData[i * 3 + 0] = rawVelocityData[originalIndex * 3 + 0];
    velocityData[i * 3 + 1] = rawVelocityData[originalIndex * 3 + 1];
    velocityData[i * 3 + 2] = rawVelocityData[originalIndex * 3 + 2];

    massData[i] = rawMassData[originalIndex];

    // Tessellation Logic
    const cellIndex = getCellIndex(originalIndex); // Using original index

    if (cellSpanOffsetData[cellIndex] === -1) {
      cellSpanOffsetData[cellIndex] = i;
    }

    cellTotalMassData[cellIndex] += massData[i];
  }

  for (let i = cellSpanOffsetData.length - 1; i >= 0; i--) {
    if (cellSpanOffsetData[i] === -1) {
      if (i === cellSpanOffsetData.length - 1) {
        cellSpanOffsetData[i] = particleCount;
      } else {
        cellSpanOffsetData[i] = cellSpanOffsetData[i + 1];
      }
    }
  }

  return {
    positionData,
    velocityData,
    massData,
    cellSpanOffsetData,
    cellTotalMassData
  };
}