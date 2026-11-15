import * as THREE from "three/webgpu";
import {
  Fn,
  abs,
  attribute,
  cameraPosition,
  color,
  dot,
  length,
  mix,
  normalWorld,
  normalWorldGeometry,
  normalize,
  oneMinus,
  positionGeometry,
  positionWorld,
  pow,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
} from "three/tsl";

import { BELL_FRINGE_END, BELL_FRINGE_START, BELL_RIM, BELL_TOP } from "./bell.ts";
import { TANK } from "./constants.ts";
import { habitatSource, sourceIrradiance } from "./source.ts";

export const waterFog = {
  tint: uniform(new THREE.Color(0x131451)),
  strength: 0.52,
};

const FADE = attribute("fade", "float");
const ENERGY = attribute("energy", "float");
const WARM = attribute("warm", "float");
const EMPHASIS = attribute("emphasis", "float");
const STATE_GLOW = { warmthBlendMin: -0.2, warmthBlendMax: 0.2, running: 0.65, attention: 0.95 };
const SELECTION_GLOW = { edgeExponent: 3.2, edgeStrength: 2.8, interiorStrength: 0.06 };
const DEPTH_FOG_EXPONENT = 1.35;
const ATTENTION_TINT_STRENGTH = 0.16;
const ATTENTION = mix(
  color(0xffbc55),
  color(0xff756f),
  smoothstep(STATE_GLOW.warmthBlendMin, STATE_GLOW.warmthBlendMax, WARM),
);

function stateGlow() {
  return mix(
    color(0xbcecff).mul(ENERGY.mul(STATE_GLOW.running)),
    ATTENTION.mul(STATE_GLOW.attention),
    abs(WARM),
  );
}

function selectionGlow() {
  const view = normalize(cameraPosition.sub(positionWorld));
  const edge = pow(oneMinus(abs(dot(normalWorld, view))), SELECTION_GLOW.edgeExponent);
  return color(0xc9f7ff)
    .mul(edge.mul(SELECTION_GLOW.edgeStrength).add(SELECTION_GLOW.interiorStrength))
    .mul(EMPHASIS);
}

function depthFog() {
  const near = smoothstep(-TANK.halfDepth, TANK.halfDepth, positionWorld.z);
  return pow(oneMinus(near), DEPTH_FOG_EXPONENT).mul(waterFog.strength);
}

function createBellMaterial(map: THREE.Texture) {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const clover = texture(map);

  material.colorNode = Fn(() => {
    const texel = clover.sample(uv());
    const drop = positionGeometry.y.sub(BELL_TOP).div(BELL_RIM - BELL_TOP);
    const rim = smoothstep(0.5, 1, drop);
    const fringe = smoothstep(BELL_FRINGE_START, BELL_FRINGE_END, positionGeometry.y.mul(-1));
    const tissue = mix(color(0xf8f1ec), color(0xd4dce8), rim.mul(0.3).add(fringe.mul(0.15)));
    const view = normalize(cameraPosition.sub(positionWorld));
    const facing = abs(dot(normalWorld, view));
    const light = dot(normalWorld, normalize(habitatSource.position)).max(0).mul(0.95).add(0.34);
    const edge = pow(oneMinus(facing), 2.4).mul(0.16);
    const fog = depthFog();
    return texel.rgb
      .mul(tissue)
      .mul(light.add(edge))
      .mul(oneMinus(fog))
      .add(waterFog.tint.mul(fog))
      .add(ATTENTION.mul(abs(WARM).mul(ATTENTION_TINT_STRENGTH)))
      .add(stateGlow().mul(0.55))
      .add(selectionGlow().mul(0.7));
  })();

  material.opacityNode = Fn(() => {
    const radius = length(uv().sub(0.5));
    const wash = oneMinus(smoothstep(0.2, 0.67, radius))
      .mul(0.36)
      .add(0.58);
    return wash
      .mul(0.94)
      .mul(oneMinus(depthFog().mul(0.28)))
      .mul(FADE);
  })();

  return material;
}

function createArmMaterial() {
  const material = new THREE.MeshStandardNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    roughness: 0.85,
    metalness: 0,
  });
  const along = attribute("along", "float");

  material.colorNode = Fn(() => {
    const tissue = mix(color(0xeee8e5), color(0xc9c4d8), smoothstep(0.35, 1, along));
    const fog = depthFog();
    return tissue
      .mul(oneMinus(fog))
      .add(waterFog.tint.mul(fog))
      .add(ATTENTION.mul(abs(WARM).mul(ATTENTION_TINT_STRENGTH)));
  })();

  material.emissiveNode = Fn(() =>
    vec3(0.08, 0.08, 0.1)
      .add(vec3(0.12, 0.15, 0.22).mul(sourceIrradiance()))
      .mul(oneMinus(depthFog().mul(0.62)))
      .add(stateGlow())
      .add(selectionGlow()),
  )();

  material.opacityNode = Fn(() =>
    oneMinus(smoothstep(0.72, 1, along).mul(0.12))
      .mul(0.88)
      .mul(oneMinus(depthFog().mul(0.3)))
      .mul(FADE),
  )();

  return material;
}

export interface SpeciesMaterialOptions {
  readonly color: number;
  readonly map?: THREE.Texture;
  readonly vertexColors: boolean;
  readonly emissive: number;
  readonly emissiveIntensity: number;
  readonly flatShading: boolean;
  readonly opacity: number;
}

const SPECIES_LIGHT = {
  gain: 0.95,
  floor: 0.42,
  edgePower: 2.4,
  edgeStrength: 0.14,
};
const SPECIES_GLOW = { running: 0.55, selection: 0.7 };

export function createSpeciesMaterial(
  options: SpeciesMaterialOptions,
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  Object.assign(material, { flatShading: options.flatShading });

  const tint = color(options.color);
  const base =
    options.map !== undefined
      ? texture(options.map).rgb.mul(tint)
      : options.vertexColors
        ? attribute("color", "vec3").mul(tint)
        : tint;

  material.colorNode = Fn(() => {
    const normal = options.flatShading ? normalWorldGeometry : normalWorld;
    const view = normalize(cameraPosition.sub(positionWorld));
    const facing = abs(dot(normal, view));
    const light = dot(normal, normalize(habitatSource.position))
      .max(0)
      .mul(SPECIES_LIGHT.gain)
      .add(SPECIES_LIGHT.floor);
    const edge = pow(oneMinus(facing), SPECIES_LIGHT.edgePower).mul(SPECIES_LIGHT.edgeStrength);
    const fog = depthFog();
    return base
      .mul(light.add(edge))
      .add(color(options.emissive).mul(options.emissiveIntensity))
      .mul(oneMinus(fog))
      .add(waterFog.tint.mul(fog))
      .add(ATTENTION.mul(abs(WARM).mul(ATTENTION_TINT_STRENGTH)))
      .add(stateGlow().mul(SPECIES_GLOW.running))
      .add(selectionGlow().mul(SPECIES_GLOW.selection));
  })();

  material.opacityNode = Fn(() => oneMinus(depthFog().mul(0.3)).mul(FADE).mul(options.opacity))();

  return material;
}

export interface JellyMaterials {
  readonly bell: THREE.MeshBasicNodeMaterial;
  readonly arm: THREE.MeshStandardNodeMaterial;
  readonly clover: THREE.Texture;
}

export function createJellyMaterials(clover: THREE.Texture): JellyMaterials {
  return {
    bell: createBellMaterial(clover),
    arm: createArmMaterial(),
    clover,
  };
}

export const disposeMaterials = (materials: JellyMaterials): void => {
  materials.bell.dispose();
  materials.arm.dispose();
  materials.clover.dispose();
};
