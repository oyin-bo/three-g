// @ts-check

import * as THREE from "three";
import { createScene } from "three-pop";
import { massSpotMesh, particleSystem } from "mavity";

import { firehose } from "coldsky";

console.log('coldsky ', { firehose, massSpotMesh, particleSystem, createScene });

const MAX_PARTICLES = 500000;

const particles = Array.from({ length: MAX_PARTICLES }, () => ({
  x: NaN,
  y: NaN,
  z: NaN,
  mass: 0,
  rgb: 0
}));

const { scene, renderer } = createScene();

const physics = particleSystem({
  gl: renderer.getContext(),
  particles,
  method: 'monopole',
  worldBounds: { min: [-4, -4, -2], max: [4, 4, 2] }
});


const { mesh } = massSpotMesh({
  textureMode: true,
  particleCount: physics.particleCount,
  textures: {
    position: physics.positionTexture,
    //color: physics.getColorTexture(),
    size: [physics.width, physics.height]
  },
  fog: { start: 15, gray: 40 }
});