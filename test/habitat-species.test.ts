import * as THREE from "three/webgpu";
import { describe, expect, test } from "vitest";

import { createSpeciesAssets } from "../src/client/habitat/species/index.ts";

const posedBellRadius = (
  asset: ReturnType<typeof createSpeciesAssets>["friedEgg"],
  index: number,
): number => {
  const matrices = Array.from({ length: asset.parts.length }, () => new THREE.Matrix4());
  asset.pose(0, matrices);
  const positions = asset.parts[index]!.geometry.getAttribute("position");
  const point = new THREE.Vector3();
  let radius = 0;
  for (let vertex = 0; vertex < positions.count; vertex += 1) {
    point
      .set(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex))
      .applyMatrix4(matrices[index]!);
    radius = Math.max(radius, Math.hypot(point.x, point.z));
  }
  return radius;
};

describe("recovered species assets", () => {
  test("fixed parts stay inside their envelope through a denser pulse sweep", () => {
    const assets = createSpeciesAssets(new THREE.Texture());
    const matrices = Array.from({ length: 10 }, () => new THREE.Matrix4());
    const point = new THREE.Vector3();
    try {
      expect(assets.friedEgg.bucket).toBe(8);
      expect(assets.whiteSpotted.bucket).toBe(9);
      expect(assets.friedEgg.parts).toHaveLength(3);
      expect(assets.whiteSpotted.parts).toHaveLength(10);
      expect(assets.friedEgg.extent.radius).toBeGreaterThan(0.6);
      expect(assets.whiteSpotted.extent.radius).toBeGreaterThan(0.6);

      let failure: string | undefined;
      for (const asset of assets.list) {
        for (let sample = 0; sample <= 128; sample += 1) {
          asset.pose((sample / 128) * 6, matrices);
          for (let part = 0; part < asset.parts.length; part += 1) {
            const positions = asset.parts[part]!.geometry.getAttribute("position");
            for (let vertex = 0; vertex < positions.count; vertex += 1) {
              if (failure !== undefined) continue;
              point
                .set(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex))
                .applyMatrix4(matrices[part]!);
              if (
                !Number.isFinite(point.x) ||
                !Number.isFinite(point.y) ||
                !Number.isFinite(point.z)
              ) {
                failure = `part ${part} vertex ${vertex} is not finite`;
              } else if (Math.hypot(point.x, point.z) > asset.extent.radius) {
                failure = `part ${part} vertex ${vertex} exceeds the radial envelope`;
              } else if (point.y > asset.extent.up || -point.y > asset.extent.down) {
                failure = `part ${part} vertex ${vertex} exceeds the height envelope`;
              }
            }
          }
        }
      }
      expect(failure).toBeUndefined();
    } finally {
      assets.dispose();
    }
  });

  test("repeats at the approved five-second and 5.4-second periods", () => {
    const assets = createSpeciesAssets(new THREE.Texture());
    const read = (asset: ReturnType<typeof createSpeciesAssets>["friedEgg"], seconds: number) => {
      const matrices = Array.from({ length: asset.parts.length }, () => new THREE.Matrix4());
      asset.pose(seconds, matrices);
      return matrices.flatMap((matrix) => matrix.elements);
    };
    try {
      const friedFirst = read(assets.friedEgg, 0.4);
      const friedNext = read(assets.friedEgg, 0.4 + 5.4);
      const whiteFirst = read(assets.whiteSpotted, 0.4);
      const whiteNext = read(assets.whiteSpotted, 0.4 + 5.0);
      friedFirst.forEach((value, index) => expect(friedNext[index]!).toBeCloseTo(value, 6));
      whiteFirst.forEach((value, index) => expect(whiteNext[index]!).toBeCloseTo(value, 6));
    } finally {
      assets.dispose();
    }
  });

  test("composes the white lobe as Rx then Ry and cancels the tip yaw", () => {
    const assets = createSpeciesAssets(new THREE.Texture());
    const matrices = Array.from({ length: 10 }, () => new THREE.Matrix4());
    try {
      assets.whiteSpotted.pose(1.43, matrices);
      const lobe = new THREE.Matrix4().extractRotation(matrices[1]!);
      const tip = new THREE.Matrix4().extractRotation(matrices[5]!);
      const expectedLobe = new THREE.Matrix4()
        .makeRotationX(0.012)
        .multiply(new THREE.Matrix4().makeRotationY(-0.08));
      const expectedTip = new THREE.Matrix4().makeRotationX(0.012);
      lobe.elements.forEach((value, index) =>
        expect(value).toBeCloseTo(expectedLobe.elements[index]!, 6),
      );
      tip.elements.forEach((value, index) =>
        expect(value).toBeCloseTo(expectedTip.elements[index]!, 6),
      );
    } finally {
      assets.dispose();
    }
  });

  test("normalizes each bell to the moon's radius", () => {
    const assets = createSpeciesAssets(new THREE.Texture());
    try {
      expect(posedBellRadius(assets.friedEgg, 1)).toBeCloseTo(0.6, 5);
      expect(posedBellRadius(assets.whiteSpotted, 9)).toBeCloseTo(0.6, 5);
    } finally {
      assets.dispose();
    }
  });

  test("disposes every unique geometry, material, and texture exactly once", () => {
    const spotted = new THREE.Texture();
    const assets = createSpeciesAssets(spotted);
    const counts = new Map<object, number>();
    const track = (resource: THREE.BufferGeometry | THREE.Material | THREE.Texture): void => {
      if (counts.has(resource)) return;
      counts.set(resource, 0);
      resource.addEventListener("dispose", () => {
        counts.set(resource, (counts.get(resource) ?? 0) + 1);
      });
    };
    for (const asset of assets.list) {
      for (const part of asset.parts) {
        track(part.geometry);
        track(part.material);
      }
    }
    track(spotted);

    assets.dispose();
    expect(counts.size).toBe(17);
    for (const count of counts.values()) expect(count).toBe(1);
  });
});
