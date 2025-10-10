// @ts-check

/**
 * PM Debug Test Runner
 * 
 * Comprehensive test suite for the PM/FFT pipeline
 * Runs all verifications to identify force calculation issues
 */

import { pmDebugInit, pmDebugRunSingle } from './index.js';
import { checkMassConservation, checkDCZero, checkFFTInverseIdentity, checkPoissonOnPlaneWave } from './metrics.js';

/**
 * Test 1: Mass Conservation
 * Verify that total mass is conserved during pm_deposit stage
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testMassConservation(psys) {
  console.log('\n========================================');
  console.log('TEST 1: Mass Conservation (pm_deposit)');
  console.log('========================================');
  
  // Initialize debug system
  pmDebugInit(psys, {
    enabled: true,
    assertInvariants: false,
    drawOverlays: false
  });
  
  // Run deposit stage with live input
  await pmDebugRunSingle(psys, 'pm_deposit', 
    { kind: 'live' },
    { kind: 'metrics', checks: { checkMassConservation: true } }
  );
  
  // Run explicit check
  const result = await checkMassConservation(psys);
  
  console.log(`\nResult: ${result.passed ? '✓ PASSED' : '✗ FAILED'}`);
  console.log(`  Grid Mass: ${result.gridMass.toFixed(6)}`);
  console.log(`  Particle Mass: ${result.particleMass.toFixed(6)}`);
  console.log(`  Relative Error: ${(result.error * 100).toFixed(4)}%`);
  
  return result;
}

/**
 * Test 2: Single Point Mass
 * Deposit a single point mass and verify grid response
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testSinglePointMass(psys) {
  console.log('\n========================================');
  console.log('TEST 2: Single Point Mass Deposition');
  console.log('========================================');
  
  // Run deposit with synthetic single point at grid center
  await pmDebugRunSingle(psys, 'pm_deposit',
    {
      kind: 'synthetic',
      synth: {
        type: 'gridImpulse',
        centerVoxel: [32, 32, 32], // Center of 64³ grid
        mass: 1.0
      }
    },
    {
      kind: 'overlay',
      view: {
        type: 'gridSlice',
        axis: 'z',
        index: 32
      }
    }
  );
  
  console.log('\nResult: ✓ Overlay rendered (check visualization)');
  console.log('  Expected: Single bright pixel at grid center');
}

/**
 * Test 3: Two Point Masses
 * Test symmetry and superposition
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testTwoPointMasses(psys) {
  console.log('\n========================================');
  console.log('TEST 3: Two Point Masses');
  console.log('========================================');
  
  await pmDebugRunSingle(psys, 'pm_deposit',
    {
      kind: 'synthetic',
      synth: {
        type: 'twoPointMasses',
        a: [20, 32, 32],
        b: [44, 32, 32],
        ma: 1.0,
        mb: 1.0
      }
    },
    {
      kind: 'overlay',
      view: {
        type: 'gridSlice',
        axis: 'z',
        index: 32
      }
    }
  );
  
  console.log('\nResult: ✓ Overlay rendered');
  console.log('  Expected: Two symmetric bright pixels along X axis');
}

/**
 * Test 4: Plane Wave Density
 * Test FFT roundtrip with known analytic solution
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testPlaneWave(psys) {
  console.log('\n========================================');
  console.log('TEST 4: Plane Wave Density (FFT Test)');
  console.log('========================================');
  
  const k = [4, 0, 0]; // Wave vector (4 periods in X)
  
  // Generate plane wave density
  await pmDebugRunSingle(psys, 'pm_deposit',
    {
      kind: 'synthetic',
      synth: {
        type: 'planeWaveDensity',
        k: k,
        amplitude: 1.0
      }
    },
    { kind: 'noop' }
  );
  
  // Run FFT forward
  await pmDebugRunSingle(psys, 'pm_fft_forward',
    { kind: 'live' },
    {
      kind: 'overlay',
      view: {
        type: 'spectrumMagnitude',
        logScale: true
      }
    }
  );
  
  console.log('\nResult: ✓ FFT forward completed');
  console.log(`  Expected: Peak at k=${k}`);
}

/**
 * Test 5: FFT Inverse Identity
 * Verify IFFT(FFT(f)) ≈ f
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testFFTRoundtrip(psys) {
  console.log('\n========================================');
  console.log('TEST 5: FFT Roundtrip (Inverse Identity)');
  console.log('========================================');
  
  // Run complete FFT forward + inverse cycle
  // This would require storing intermediate results
  
  console.log('\nResult: ⚠ Not yet implemented');
  console.log('  TODO: Implement snapshot/restore for roundtrip test');
}

/**
 * Test 6: DC Component Check
 * Verify DC mode (k=0) is zero after Poisson solve
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testDCZero(psys) {
  console.log('\n========================================');
  console.log('TEST 6: DC Zero Check (Poisson)');
  console.log('========================================');
  
  // Deposit uniform density (should have zero DC after mean subtraction)
  await pmDebugRunSingle(psys, 'pm_deposit',
    {
      kind: 'synthetic',
      synth: {
        type: 'planeWaveDensity',
        k: [1, 0, 0],
        amplitude: 1.0
      }
    },
    { kind: 'noop' }
  );
  
  // Run through pipeline to Poisson solve
  await pmDebugRunSingle(psys, 'pm_fft_forward', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_poisson', { kind: 'live' }, { kind: 'noop' });
  
  // Check DC component
  if (psys.pmPotentialSpectrum) {
    const result = await checkDCZero(psys, psys.pmPotentialSpectrum.texture);
    
    console.log(`\nResult: ${result.passed ? '✓ PASSED' : '✗ FAILED'}`);
    console.log(`  DC Real: ${result.dcReal.toExponential(3)}`);
    console.log(`  DC Imag: ${result.dcImag.toExponential(3)}`);
    console.log(`  Magnitude: ${result.magnitude.toExponential(3)}`);
    
    return result;
  } else {
    console.log('\nResult: ✗ FAILED - pmPotentialSpectrum not found');
  }
}

/**
 * Test 7: Poisson Equation Verification
 * Test -k²φ̂ = 4πGρ̂ for a plane wave
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testPoissonEquation(psys) {
  console.log('\n========================================');
  console.log('TEST 7: Poisson Equation (-k²φ̂ = 4πGρ̂)');
  console.log('========================================');
  
  const k = [2, 0, 0]; // Test wave vector
  
  // Generate plane wave
  await pmDebugRunSingle(psys, 'pm_deposit',
    {
      kind: 'synthetic',
      synth: {
        type: 'planeWaveDensity',
        k: k,
        amplitude: 1.0
      }
    },
    { kind: 'noop' }
  );
  
  // Run FFT and Poisson
  await pmDebugRunSingle(psys, 'pm_fft_forward', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_poisson', { kind: 'live' }, { kind: 'noop' });
  
  // Verify Poisson equation
  if (psys.pmDensitySpectrum && psys.pmPotentialSpectrum) {
    const result = await checkPoissonOnPlaneWave(
      psys,
      k,
      psys.pmDensitySpectrum.texture,
      psys.pmPotentialSpectrum.texture
    );
    
    console.log(`\nResult: ${result.passed ? '✓ PASSED' : '✗ FAILED'}`);
    console.log(`  Error: ${result.error.toExponential(3)}`);
    
    return result;
  } else {
    console.log('\nResult: ✗ FAILED - Spectrum textures not found');
  }
}

/**
 * Test 8: Force Gradient Check
 * Verify gradient computation from potential
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testForceGradient(psys) {
  console.log('\n========================================');
  console.log('TEST 8: Force Gradient (∇φ = -g)');
  console.log('========================================');
  
  // Use plane wave: φ = cos(k·r) → g = k sin(k·r)
  const k = [1, 0, 0];
  
  await pmDebugRunSingle(psys, 'pm_deposit',
    {
      kind: 'synthetic',
      synth: {
        type: 'planeWaveDensity',
        k: k,
        amplitude: 1.0
      }
    },
    { kind: 'noop' }
  );
  
  // Run through gradient computation
  await pmDebugRunSingle(psys, 'pm_fft_forward', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_poisson', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_gradient', { kind: 'live' }, { kind: 'noop' });
  
  console.log('\nResult: ⚠ Manual verification required');
  console.log('  TODO: Implement gradient validation');
}

/**
 * Test 9: Force Sampling
 * Test trilinear interpolation at particle positions
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testForceSampling(psys) {
  console.log('\n========================================');
  console.log('TEST 9: Force Sampling (Interpolation)');
  console.log('========================================');
  
  // Run full pipeline
  await pmDebugRunSingle(psys, 'pm_deposit', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_fft_forward', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_poisson', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_gradient', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_fft_inverse', { kind: 'live' }, { kind: 'noop' });
  await pmDebugRunSingle(psys, 'pm_sample', { kind: 'live' },
    {
      kind: 'readback',
      buffers: {
        forcePatch: { x: 0, y: 0, width: 4, height: 4 }
      }
    }
  );
  
  console.log('\nResult: ✓ Force sampling completed');
  console.log('  Check readback output above');
}

/**
 * Test 10: End-to-End Full Pipeline
 * Run complete PM/FFT pipeline and verify final forces
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function testFullPipeline(psys) {
  console.log('\n========================================');
  console.log('TEST 10: Full Pipeline (End-to-End)');
  console.log('========================================');
  
  // Run with live particles
  const { computePMForcesSync } = await import('../pipeline/pm-pipeline.js');
  
  console.log('\nRunning full PM/FFT pipeline...');
  computePMForcesSync(psys);
  
  console.log('\nResult: ✓ Pipeline completed');
  console.log('  Check profiler output for timing');
}

/**
 * Run all tests
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function runAllTests(psys) {
  console.log('\n');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   PM/FFT VERIFICATION TEST SUITE      ║');
  console.log('╚════════════════════════════════════════╝');
  
  const results = {
    massConservation: null,
    dcZero: null,
    poissonEquation: null
  };
  
  try {
    // Test 1: Mass Conservation
    results.massConservation = await testMassConservation(psys);
    
    // Test 2-3: Point masses (visual)
    await testSinglePointMass(psys);
    await testTwoPointMasses(psys);
    
    // Test 4: Plane wave
    await testPlaneWave(psys);
    
    // Test 6: DC zero
    results.dcZero = await testDCZero(psys);
    
    // Test 7: Poisson equation
    results.poissonEquation = await testPoissonEquation(psys);
    
    // Test 8-9: Gradient and sampling
    await testForceGradient(psys);
    await testForceSampling(psys);
    
    // Test 10: Full pipeline
    await testFullPipeline(psys);
    
  } catch (error) {
    console.error('\n✗ Test suite failed with error:', error);
    console.error(error.stack);
  }
  
  // Summary
  console.log('\n');
  console.log('╔════════════════════════════════════════╗');
  console.log('║          TEST SUMMARY                  ║');
  console.log('╚════════════════════════════════════════╝');
  
  let passed = 0;
  let failed = 0;
  
  if (results.massConservation) {
    if (results.massConservation.passed) {
      console.log('✓ Mass Conservation: PASSED');
      passed++;
    } else {
      console.log('✗ Mass Conservation: FAILED');
      failed++;
    }
  }
  
  if (results.dcZero) {
    if (results.dcZero.passed) {
      console.log('✓ DC Zero: PASSED');
      passed++;
    } else {
      console.log('✗ DC Zero: FAILED');
      failed++;
    }
  }
  
  if (results.poissonEquation) {
    if (results.poissonEquation.passed) {
      console.log('✓ Poisson Equation: PASSED');
      passed++;
    } else {
      console.log('✗ Poisson Equation: FAILED');
      failed++;
    }
  }
  
  console.log(`\nTotal: ${passed} passed, ${failed} failed`);
  
  return results;
}

/**
 * Quick diagnostic test - runs essential checks only
 * 
 * @param {import('../particle-system.js').ParticleSystem} psys
 */
export async function quickDiagnostic(psys) {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║     QUICK DIAGNOSTIC TEST              ║');
  console.log('╚════════════════════════════════════════╝');
  
  // Test mass conservation
  const massResult = await testMassConservation(psys);
  
  // Test Poisson on simple case
  const poissonResult = await testPoissonEquation(psys);
  
  console.log('\n');
  console.log('╔════════════════════════════════════════╗');
  console.log('║     DIAGNOSTIC COMPLETE                ║');
  console.log('╚════════════════════════════════════════╝');
  
  if (massResult?.passed && poissonResult?.passed) {
    console.log('✓ All critical tests passed');
  } else {
    console.log('✗ Critical issues detected:');
    if (!massResult?.passed) {
      console.log('  - Mass conservation failure');
    }
    if (!poissonResult?.passed) {
      console.log('  - Poisson solver failure');
    }
  }
  
  return { massResult, poissonResult };
}
