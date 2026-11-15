import * as THREE from "three/webgpu";
import { exp, float, positionWorld, uniform, vec3 } from "three/tsl";

import { TANK } from "./constants.ts";

export const habitatSource = {
  tint: uniform(new THREE.Color(0x00cfff)),
  white: uniform(new THREE.Color(0xf1f3ff)),
  surround: uniform(new THREE.Color(0x655cf0)),
  position: uniform(new THREE.Vector3(0.12, 5.3, -1.7)),
  width: 0.38,
  spread: 0.43,
  extinction: 0.13,
  depthWidthRatio: 0.8,
  depthWidthMin: 0.6,
  gaussianFalloff: 1.45,
  intensity: 1.7,
  distanceAttenuationPerUnit: 0.14,
};

const SCATTER = { depthFraction: 0.8, backWeight: 0.48, middleWeight: 0.34, frontWeight: 0.18 };

export function sourceIrradiance(point = positionWorld) {
  const travel = habitatSource.position.y.sub(point.y).max(0);
  const width = travel.mul(habitatSource.spread).add(habitatSource.width);
  const dx = point.x.sub(habitatSource.position.x).div(width);
  const dz = point.z
    .sub(habitatSource.position.z)
    .div(width.mul(habitatSource.depthWidthRatio).add(habitatSource.depthWidthMin));
  return exp(dx.mul(dx).add(dz.mul(dz)).mul(-habitatSource.gaussianFalloff))
    .mul(exp(travel.mul(-habitatSource.extinction)))
    .mul(
      float(habitatSource.intensity).div(
        travel.mul(habitatSource.distanceAttenuationPerUnit).add(1),
      ),
    );
}

export function waterScatter() {
  const p = positionWorld;
  return sourceIrradiance(vec3(p.x, p.y, -TANK.halfDepth * SCATTER.depthFraction))
    .mul(SCATTER.backWeight)
    .add(sourceIrradiance(vec3(p.x, p.y, 0)).mul(SCATTER.middleWeight))
    .add(
      sourceIrradiance(vec3(p.x, p.y, TANK.halfDepth * SCATTER.depthFraction)).mul(
        SCATTER.frontWeight,
      ),
    );
}
