import * as THREE from "three/webgpu";
import { describe, expect, test } from "vitest";

import { CLOVER_MARKS } from "../src/client/habitat/clover.ts";
import { createJellyMaterials, disposeMaterials } from "../src/client/habitat/materials.ts";
import {
  EXTENT,
  createInstanceAttributes,
  createPhaseGeometry,
  detailFor,
  disposePhase,
} from "../src/client/habitat/geometry.ts";

const TAU = Math.PI * 2;
const PHASES = 8;

const componentCount = (index: ArrayLike<number>, count: number): number => {
  const parent = Array.from({ length: count }, (_, vertex) => vertex);
  const find = (vertex: number): number => {
    let current = vertex;
    while (parent[current] !== current) current = parent[current]!;
    while (parent[vertex] !== vertex) {
      const next = parent[vertex]!;
      parent[vertex] = current;
      vertex = next;
    }
    return current;
  };
  for (let at = 0; at < index.length; at += 3) {
    const a = find(index[at]!);
    const b = find(index[at + 1]!);
    const c = find(index[at + 2]!);
    parent[b] = a;
    parent[c] = a;
  }
  const referenced = new Uint8Array(count);
  for (let at = 0; at < index.length; at += 1) referenced[index[at]!] = 1;
  const roots = new Set<number>();
  for (let vertex = 0; vertex < count; vertex += 1) {
    if (referenced[vertex] === 1) roots.add(find(vertex));
  }
  return roots.size;
};

describe("moon jelly anatomy", () => {
  test("the clover marks hold four inward-opening horseshoes", () => {
    expect(CLOVER_MARKS).toHaveLength(4);
    for (const [index, mark] of CLOVER_MARKS.entries()) {
      expect(mark.angle).toBeCloseTo(Math.PI / 4 + (index * Math.PI) / 2, 10);
      const span = mark.end - mark.start;
      expect(span).toBeLessThan(TAU);
      const gapCentre = mark.end + (TAU - span) / 2;
      expect(Math.cos(gapCentre - mark.angle)).toBeCloseTo(-1, 10);
    }
  });

  test("the materials own and dispose one clover texture", () => {
    const clover = new THREE.Texture();
    let disposed = 0;
    clover.addEventListener("dispose", () => {
      disposed += 1;
    });
    const materials = createJellyMaterials(clover);
    disposeMaterials(materials);
    expect(disposed).toBe(1);
  });

  test("the bell and four folded arms fit the placement envelope in every phase", () => {
    const instances = createInstanceAttributes(1);
    const tiers = [0, 41, 121, 281, 1000];
    let failure: string | undefined;
    for (const count of tiers) {
      const detail = detailFor(count);
      for (let bucket = 0; bucket < PHASES; bucket += 1) {
        const phase = createPhaseGeometry(detail, bucket / PHASES, instances);
        try {
          for (const name of ["bell", "arms"] as const) {
            const positions = phase[name].getAttribute("position");
            const normals = phase[name].getAttribute("normal");
            for (let vertex = 0; vertex < positions.count; vertex += 1) {
              const x = positions.getX(vertex);
              const y = positions.getY(vertex);
              const z = positions.getZ(vertex);
              const radius = Math.hypot(x, z);
              const normal = Math.hypot(
                normals.getX(vertex),
                normals.getY(vertex),
                normals.getZ(vertex),
              );
              if (failure !== undefined) continue;
              if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
                failure = `${name} vertex ${vertex} in phase ${bucket} is not finite`;
              } else if (radius > EXTENT.radius) {
                failure = `${name} vertex ${vertex} in phase ${bucket} has radius ${radius}`;
              } else if (y < -EXTENT.down || y > EXTENT.up) {
                failure = `${name} vertex ${vertex} in phase ${bucket} has height ${y}`;
              } else if (Math.abs(normal - 1) > 1e-3) {
                failure = `${name} vertex ${vertex} in phase ${bucket} has normal length ${normal}`;
              }
            }
          }
        } finally {
          disposePhase(phase);
        }
      }
    }
    expect(failure).toBeUndefined();

    const detail = detailFor(0);
    const phase = createPhaseGeometry(detail, 0, instances);
    try {
      const bellIndex = phase.bell.index;
      expect(bellIndex).not.toBeNull();
      expect(componentCount(bellIndex!.array, phase.bell.getAttribute("position").count)).toBe(1);
      const armIndex = phase.arms.index;
      expect(armIndex).not.toBeNull();
      expect(componentCount(armIndex!.array, phase.arms.getAttribute("position").count)).toBe(4);
    } finally {
      disposePhase(phase);
    }
  });
});
