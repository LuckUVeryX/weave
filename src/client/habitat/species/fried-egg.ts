import * as THREE from "three/webgpu";
import { MarchingCubes } from "three/addons/objects/MarchingCubes.js";

import { createSpeciesMaterial } from "../materials.ts";
import {
  applyVertexColors,
  arcProfile,
  latheGeometry,
  warpRim,
  type SpeciesPart,
  type StudySpecies,
} from "./asset.ts";

const EGG_PROFILE = [
  [0.0, 0.88],
  [0.18, 0.872],
  [0.36, 0.845],
  [0.53, 0.792],
  [0.68, 0.71],
  [0.81, 0.598],
  [0.91, 0.462],
  [0.98, 0.312],
  [1.015, 0.165],
  [1.015, 0.045],
  [1.0, -0.02],
  [0.975, -0.06],
  [0.94, -0.08],
] as const;

const BOSS_PROFILE = [
  [0.0, 0.145],
  [0.06, 0.1405],
  [0.12, 0.126],
  [0.18, 0.104],
  [0.23, 0.076],
  [0.27, 0.044],
  [0.29, 0.016],
  [0.295, 0.0],
] as const;

const BELL_SEGMENTS = 56;
const BOSS_SEGMENTS = 40;
const BOSS_POSITION = new THREE.Vector3(0.01, 0.855, 0.01);
const UNDERBODY_ORIGIN_Y = -0.03;
const PERIOD = 5.4;

const LOBES = [
  { x: -0.43, y: -0.4, z: -0.01, width: 0.28, height: 0.375, depth: 0.21 },
  { x: 0.43, y: -0.4, z: -0.01, width: 0.28, height: 0.375, depth: 0.21 },
  { x: 0.0, y: -0.46, z: 0.36, width: 0.285, height: 0.4, depth: 0.25 },
  { x: 0.04, y: -0.4, z: -0.41, width: 0.26, height: 0.35, depth: 0.24 },
] as const;

const underbodyGeometry = (material: THREE.Material): THREE.BufferGeometry => {
  const resolution = 36;
  const surface = new MarchingCubes(resolution, material, false, false, 7000);
  surface.isolation = 0;
  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const px = (x / resolution) * 2 - 1;
        const py = (y / resolution) * 2 - 1;
        const pz = (z / resolution) * 2 - 1;
        let distance = Math.hypot(px / 0.52, (py - 0.01) / 0.34, pz / 0.46) - 1;
        distance *= 0.34;
        for (const lobe of LOBES) {
          const upper = THREE.MathUtils.smoothstep(py, -0.65, -0.12);
          const neck = 1 - upper * 0.3;
          const dx = (px - lobe.x * (1 - upper * 0.34)) / (lobe.width * neck);
          const dy = (py - lobe.y) / lobe.height;
          const dz = (pz - lobe.z * (1 - upper * 0.34)) / (lobe.depth * neck);
          const next = (Math.hypot(dx, dy, dz) - 1) * Math.min(lobe.width, lobe.depth);
          const blend = THREE.MathUtils.lerp(0.025, 0.18, upper);
          const h = Math.max(blend - Math.abs(distance - next), 0) / blend;
          distance = Math.min(distance, next) - h * h * blend * 0.25;
        }
        surface.field[x + y * resolution + z * resolution * resolution] = -distance;
      }
    }
  }
  surface.update();

  const geometry = new THREE.BufferGeometry();
  for (const name of ["position", "normal"] as const) {
    const source = surface.geometry.getAttribute(name);
    geometry.setAttribute(
      name,
      new THREE.Float32BufferAttribute(source.array.slice(0, surface.count * 3), 3),
    );
  }
  surface.geometry.dispose();
  geometry.computeBoundingSphere();
  return geometry;
};

export const createFriedEgg = (bucket: number): StudySpecies => {
  const bellMaterial = createSpeciesMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0x000000,
    emissiveIntensity: 0,
    flatShading: false,
    opacity: 1,
  });
  const bossMaterial = createSpeciesMaterial({
    color: 0xf0ad57,
    vertexColors: false,
    emissive: 0x000000,
    emissiveIntensity: 0,
    flatShading: false,
    opacity: 1,
  });
  const lobeMaterial = createSpeciesMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: 0x000000,
    emissiveIntensity: 0,
    flatShading: false,
    opacity: 1,
  });

  const bell = latheGeometry(EGG_PROFILE, arcProfile(EGG_PROFILE), BELL_SEGMENTS);
  warpRim(bell, { waves: 4, radial: 0.03, vertical: 0.05, phase: 1.1, from: 0.66 });
  const crown = new THREE.Color("#f8eed7");
  const rim = new THREE.Color("#e7d0a9");
  applyVertexColors(bell, (position, color) => {
    const drop = THREE.MathUtils.clamp((0.88 - position.y) / 0.96, 0, 1);
    color.copy(crown).lerp(rim, THREE.MathUtils.smoothstep(drop, 0.42, 1) * 0.62);
  });

  const boss = latheGeometry(BOSS_PROFILE, arcProfile(BOSS_PROFILE), BOSS_SEGMENTS);

  const underbody = underbodyGeometry(lobeMaterial);
  const lobeIvory = new THREE.Color("#ecdfd4");
  const lobeViolet = new THREE.Color("#9f80cf");
  applyVertexColors(underbody, (position, color) => {
    const tip = THREE.MathUtils.smoothstep(-position.y, 0.43, 0.82);
    color.copy(lobeIvory).lerp(lobeViolet, tip * 0.95);
  });

  const parts: ReadonlyArray<SpeciesPart> = [
    { geometry: underbody, material: lobeMaterial },
    { geometry: bell, material: bellMaterial },
    { geometry: boss, material: bossMaterial },
  ];
  const euler = new THREE.Euler(0, 0, 0, "XYZ");
  const rotation = new THREE.Matrix4();
  const offset = new THREE.Matrix4().makeTranslation(
    BOSS_POSITION.x,
    BOSS_POSITION.y,
    BOSS_POSITION.z,
  );

  const restPose = (out: ReadonlyArray<THREE.Matrix4>): void => {
    out[0]!.makeTranslation(0, UNDERBODY_ORIGIN_Y, 0);
    out[1]!.makeScale(1, 1, 1);
    out[2]!.copy(out[1]!).multiply(offset);
  };

  return {
    bucket,
    parts,
    textures: [],
    period: PERIOD,
    bellPart: 1,
    restPose,
    pose: (seconds, out) => {
      const wave = Math.sin((seconds / PERIOD) * Math.PI * 2);
      out[0]!
        .makeTranslation(0, UNDERBODY_ORIGIN_Y + wave * 0.015, 0)
        .multiply(rotation.makeRotationFromEuler(euler.set(wave * 0.022, 0, wave * 0.014)));
      out[1]!.makeScale(1 + wave * 0.016, 1 - wave * 0.026, 1 + wave * 0.016);
      out[2]!.copy(out[1]!).multiply(offset);
    },
  };
};
