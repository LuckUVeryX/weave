import * as THREE from "three/webgpu";
import { describe, expect, test } from "vitest";

import { SPECIMEN_LAYER, TANK } from "../src/client/habitat/constants.ts";
import {
  createInstanceAttributes,
  createPhaseGeometry,
  detailFor,
  linkPhaseMorph,
} from "../src/client/habitat/geometry.ts";
import { projectFeed } from "../src/client/habitat/model.ts";
import { School } from "../src/client/habitat/school.ts";
import { Water } from "../src/client/habitat/water.ts";
import type { WallAt } from "../src/client/habitat/water.ts";
import type { SessionFeed, SessionView } from "../src/shared/session.ts";

const session = (id: string, overrides: Partial<SessionView> = {}): SessionView => ({
  id,
  title: `Session ${id}`,
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  location: { directory: `/tmp/${id}` },
  status: "idle",
  attention: { permissions: 0, questions: 0 },
  ...overrides,
});

const feed = (sessions: ReadonlyArray<SessionView>): SessionFeed => [
  { id: "local", health: { kind: "connected" }, sessions },
];

const wallAt: WallAt = (x, y, z, radialReach, depthReach, out) => {
  const radius = Math.hypot(x, y);
  const radial = TANK.aperture - radius - radialReach;
  const depth = TANK.halfDepth - Math.abs(z) - depthReach;
  if (radial <= depth) {
    out.signed = radial;
    out.nx = radius > 1e-6 ? x / radius : 1;
    out.ny = radius > 1e-6 ? y / radius : 0;
    out.nz = 0;
  } else {
    out.signed = depth;
    out.nx = 0;
    out.ny = 0;
    out.nz = z >= 0 ? 1 : -1;
  }
  return out;
};

const parts = (scene: THREE.Scene): Array<THREE.InstancedMesh> =>
  scene.children.filter(
    (child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh,
  );

const BUCKET_PARTS = [2, 2, 2, 2, 2, 2, 2, 2, 3, 10] as const;

const bucketStart = (bucket: number): number =>
  BUCKET_PARTS.slice(0, bucket).reduce((total, count) => total + count, 0);

const bucketParts = (scene: THREE.Scene, bucket: number): Array<THREE.InstancedMesh> =>
  parts(scene).slice(bucketStart(bucket), bucketStart(bucket) + BUCKET_PARTS[bucket]!);

const schoolWith = (spotted: THREE.Texture = new THREE.Texture()) => {
  const scene = new THREE.Scene();
  const water = new Water({ radius: TANK.aperture, halfDepth: TANK.halfDepth, wallAt });
  return {
    scene,
    spotted,
    school: new School({
      scene,
      water,
      capacity: 64,
      detail: detailFor(0),
      reduced: true,
      clover: new THREE.Texture(),
      spotted,
    }),
  };
};

const rowIsZeroScale = (array: Float32Array, row: number): boolean => {
  for (let index = row * 16; index < row * 16 + 16; index += 1) {
    const expected = index === row * 16 + 15 ? 1 : 0;
    if (array[index] !== expected) return false;
  }
  return true;
};

const rowOf = (array: Float32Array, row: number): Array<number> =>
  Array.from(array.slice(row * 16, row * 16 + 16));

const attribute = (mesh: THREE.InstancedMesh, name: string): THREE.InstancedBufferAttribute =>
  mesh.geometry.getAttribute(name) as THREE.InstancedBufferAttribute;

const isSpecimen = (mesh: THREE.InstancedMesh): boolean => mesh.layers.isEnabled(SPECIMEN_LAYER);

const specimenParts = (scene: THREE.Scene): Array<THREE.InstancedMesh> =>
  parts(scene).filter(isSpecimen);

describe("school phase morph", () => {
  test("a full influence lands exactly on the next bucket geometry", () => {
    const detail = detailFor(1000);
    const instances = createInstanceAttributes(1);
    const first = createPhaseGeometry(detail, 0, instances);
    const second = createPhaseGeometry(detail, 1 / 8, instances);
    linkPhaseMorph(first, second);

    for (const name of ["bell", "arms"] as const) {
      const geometry = first[name];
      const base = geometry.getAttribute("position");
      const target = second[name].getAttribute("position");
      const delta = geometry.morphAttributes.position?.[0];
      expect(geometry.morphTargetsRelative).toBe(true);
      expect(delta).toBeDefined();
      const from = base.array;
      const to = target.array;
      const morph = delta!.array;
      for (let index = 0; index < from.length; index += 1) {
        expect(from[index]! + morph[index]!).toBeCloseTo(to[index]!, 5);
      }
    }

    const wrap = createPhaseGeometry(detail, 7 / 8, instances);
    linkPhaseMorph(wrap, first);
    const base = wrap.arms.getAttribute("position");
    const target = first.arms.getAttribute("position");
    const delta = wrap.arms.morphAttributes.position![0]!.array;
    const from = base.array;
    const to = target.array;
    expect(from.some((value, index) => Math.abs(value - to[index]!) > 1e-4)).toBe(true);
    for (let index = 0; index < from.length; index += 1) {
      expect(from[index]! + delta[index]!).toBeCloseTo(to[index]!, 5);
    }
  });

  test("influence closes on the next bucket before the bucket advances", () => {
    const { school, scene } = schoolWith();
    school.applyModel(projectFeed(feed([session("one")])));
    school.syncInstances();

    const phaseBucket = (): number => school.stats().buckets.findIndex((count) => count === 1);
    const influence = (): number => {
      const texture = bucketParts(scene, phaseBucket())[0]!.morphTexture;
      if (texture === null) throw new Error("Expected a morph texture.");
      return (texture.source.data.data as Float32Array)[1]!;
    };

    let bucket = phaseBucket();
    let last = influence();
    let transitions = 0;
    for (let step = 0; step < 200 && transitions < 2; step += 1) {
      school.advance(1 / 60);
      school.syncInstances();
      const next = phaseBucket();
      const value = influence();
      if (next === bucket) {
        expect(value).toBeGreaterThanOrEqual(last);
      } else {
        expect(last).toBeGreaterThan(0.9);
        expect(value).toBeLessThan(0.1);
        transitions += 1;
      }
      bucket = next;
      last = value;
    }
    expect(transitions).toBe(2);

    school.dispose();
  });
});

describe("school instance lifecycle", () => {
  test("empty, single, and multiple buckets keep render counts and ownership exact", () => {
    const { school, scene } = schoolWith();

    school.applyModel(projectFeed(feed([])));
    school.syncInstances();
    expect(school.stats().buckets).toEqual(Array.from({ length: 10 }, () => 0));
    expect(school.stats().renderCounts).toEqual(Array.from({ length: 10 }, () => 0));
    expect(parts(scene)).toHaveLength(29);

    school.applyModel(projectFeed(feed([session("one")])));
    school.syncInstances();
    const single = school.stats();
    const singleBucket = single.buckets.findIndex((count) => count === 1);
    expect(singleBucket).toBeGreaterThanOrEqual(0);
    expect(single.renderCounts[singleBucket]).toBe(2);
    for (const [bucket, count] of single.buckets.entries()) {
      if (bucket === singleBucket) continue;
      expect(count).toBe(0);
      expect(single.renderCounts[bucket]).toBe(0);
    }
    const singleParts = bucketParts(scene, singleBucket);
    for (const mesh of singleParts) {
      expect(mesh.count).toBe(2);
      expect(mesh.visible).toBe(true);
      expect(rowIsZeroScale(mesh.instanceMatrix.array as Float32Array, 1)).toBe(true);
      const fade = mesh.geometry.getAttribute("fade") as THREE.InstancedBufferAttribute;
      expect(fade.array[1]).toBe(0);
      const morph = mesh.morphTexture?.source.data.data as Float32Array;
      expect([morph[2], morph[3]]).toEqual([1, 0]);
    }

    const many = Array.from({ length: 50 }, (_, index) => session(`many-${index}`));
    school.applyModel(projectFeed(feed(many)));
    school.advance(0.3);
    school.advance(0.3);
    school.syncInstances();
    const crowded = school.stats();
    expect(crowded.buckets.reduce((total, count) => total + count, 0)).toBe(50);
    for (const [bucket, count] of crowded.buckets.entries()) {
      const renderCount = bucket < 8 && count === 1 ? 2 : count;
      expect(crowded.renderCounts[bucket]).toBe(renderCount);
      for (const mesh of bucketParts(scene, bucket)) expect(mesh.count).toBe(renderCount);
    }

    const busy = crowded.buckets.findIndex((count) => count >= 2);
    expect(busy).toBeGreaterThanOrEqual(0);
    const key = school.keyAt(busy, 0);
    expect(key).toBeDefined();
    const meshes = parts(scene);
    const before = meshes.map((mesh) =>
      Float32Array.from(mesh.instanceMatrix.array as Float32Array),
    );
    let isolated = false;
    expect(
      school.isolate(key!, () => {
        isolated = bucketParts(scene, busy).every((mesh) => {
          const array = mesh.instanceMatrix.array as Float32Array;
          return !rowIsZeroScale(array, 0) && rowIsZeroScale(array, 1);
        });
      }),
    ).toBe(true);
    expect(isolated).toBe(true);
    meshes.forEach((mesh, index) => {
      expect(mesh.instanceMatrix.array).toEqual(before[index]);
    });

    const textures = new Set<THREE.Texture>();
    for (const mesh of meshes) {
      if (mesh.morphTexture !== null) textures.add(mesh.morphTexture);
    }
    expect(textures.size).toBe(8);
    const disposed = new Map<THREE.Texture, number>();
    for (const texture of textures) {
      disposed.set(texture, 0);
      texture.addEventListener("dispose", () => {
        disposed.set(texture, (disposed.get(texture) ?? 0) + 1);
      });
    }
    school.dispose();
    expect(parts(scene)).toHaveLength(0);
    for (const count of disposed.values()) expect(count).toBe(1);
  });
});

describe("school selection layers", () => {
  test("selection moves the specimen layer between buckets and deselection clears it", () => {
    const { school, scene } = schoolWith();
    school.applyModel(projectFeed(feed([session("one"), session("two")])));
    school.syncInstances();

    const buckets = school.stats().buckets.flatMap((count, bucket) => (count > 0 ? [bucket] : []));
    const [firstBucket, secondBucket] = buckets;
    expect(firstBucket).toBeDefined();
    expect(secondBucket).toBeDefined();
    expect(secondBucket).not.toBe(firstBucket);
    const firstKey = school.keyAt(firstBucket!, 0);
    const secondKey = school.keyAt(secondBucket!, 0);
    expect(firstKey).toBeDefined();
    expect(secondKey).toBeDefined();

    expect(specimenParts(scene)).toHaveLength(0);

    school.setSelection(firstKey!);
    school.syncInstances();
    expect(bucketParts(scene, firstBucket!).every(isSpecimen)).toBe(true);
    expect(specimenParts(scene)).toHaveLength(2);

    school.setSelection(secondKey!);
    school.syncInstances();
    expect(bucketParts(scene, firstBucket!).some(isSpecimen)).toBe(false);
    expect(bucketParts(scene, secondBucket!).every(isSpecimen)).toBe(true);
    expect(specimenParts(scene)).toHaveLength(2);

    school.setSelection(undefined);
    school.syncInstances();
    expect(specimenParts(scene)).toHaveLength(0);

    school.dispose();
  });
});

describe("school singleton isolate", () => {
  test("isolating a lone body keeps slot zero and leaves the sentinel slot empty", () => {
    const { school, scene } = schoolWith();
    school.applyModel(projectFeed(feed([session("one")])));
    school.syncInstances();

    const bucket = school.stats().buckets.findIndex((count) => count === 1);
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(school.stats().renderCounts[bucket]).toBe(2);
    const key = school.keyAt(bucket, 0);
    expect(key).toBeDefined();

    const meshes = bucketParts(scene, bucket);
    const before = meshes.map((mesh) =>
      Float32Array.from(mesh.instanceMatrix.array as Float32Array),
    );
    for (const array of before) expect(rowIsZeroScale(array, 1)).toBe(true);

    let drawn = false;
    expect(
      school.isolate(key!, () => {
        drawn = true;
        meshes.forEach((mesh, index) => {
          const array = mesh.instanceMatrix.array as Float32Array;
          expect(rowOf(array, 0)).toEqual(rowOf(before[index]!, 0));
          expect(rowIsZeroScale(array, 1)).toBe(true);
        });
      }),
    ).toBe(true);
    expect(drawn).toBe(true);

    meshes.forEach((mesh, index) => {
      const array = mesh.instanceMatrix.array as Float32Array;
      expect(array).toEqual(before[index]);
      expect(rowIsZeroScale(array, 1)).toBe(true);
    });

    school.dispose();
  });
});

describe("school placement", () => {
  const populations = (counts: ReadonlyArray<number>): SessionFeed =>
    ["local", "iu", "mj"].map((id, source) => ({
      id,
      health: { kind: "connected" },
      sessions: Array.from({ length: counts[source] ?? 0 }, (_, index) =>
        session(`radial-${String(index).padStart(3, "0")}`),
      ),
    }));

  test.each([
    { counts: [48, 48, 48], refill: false },
    { counts: [48, 48, 48], refill: true },
    { counts: [96, 32, 16], refill: false },
    { counts: [96, 32, 16], refill: true },
  ])("sources span the tank with $counts sessions, refill $refill", ({ counts, refill }) => {
    const { school } = schoolWith();
    try {
      if (refill) {
        school.applyModel(projectFeed(feed([session("departing")])));
        school.advance(0.3);
        school.applyModel(projectFeed(feed([])));
        school.advance(0.3);
        school.advance(0);
        expect(school.snapshotBodies()).toHaveLength(0);
      }
      const sources = populations(counts);
      school.applyModel(projectFeed(sources));
      const bodies = school.snapshotBodies();
      expect(bodies).toHaveLength(counts.reduce((total, count) => total + count, 0));
      const outerRadiusSquared = Math.max(
        ...bodies.map(({ position }) => position.x ** 2 + position.y ** 2),
      );
      const sourceByKey = new Map(
        projectFeed(sources).creatures.map((creature) => [creature.key, creature.sourceID]),
      );
      for (const source of sources) {
        const sourceBodies = bodies.filter((body) => sourceByKey.get(body.key) === source.id);
        const areas = sourceBodies.map(
          ({ position }) => (position.x ** 2 + position.y ** 2) / outerRadiusSquared,
        );
        const occupiedThirds = new Set(areas.map((area) => Math.min(2, Math.floor(area * 3))));
        expect(occupiedThirds, source.id).toEqual(new Set([0, 1, 2]));
        const quadrants = new Set(
          sourceBodies.map(({ position }) => (position.x >= 0 ? 1 : 0) + (position.y >= 0 ? 2 : 0)),
        );
        expect(quadrants, source.id).toEqual(new Set([0, 1, 2, 3]));
      }
    } finally {
      school.dispose();
    }
  });

  test("source reorder keeps retained body positions", () => {
    const { school } = schoolWith();
    try {
      const sources = populations([48, 48, 48]);
      school.applyModel(projectFeed(sources));
      school.advance(0.4);
      const before = new Map(school.snapshotBodies().map((body) => [body.key, body.position]));

      school.applyModel(projectFeed([...sources].reverse()));

      const after = new Map(school.snapshotBodies().map((body) => [body.key, body.position]));
      expect(after).toEqual(before);
    } finally {
      school.dispose();
    }
  });

  test("initial creature order does not change placement", () => {
    const first = schoolWith();
    const second = schoolWith();
    try {
      const model = projectFeed(populations([48, 48, 48]));
      first.school.applyModel(model);
      second.school.applyModel({ ...model, creatures: [...model.creatures].reverse() });
      const positions = (school: School) =>
        new Map(school.snapshotBodies().map((body) => [body.key, body.position]));
      expect(positions(second.school)).toEqual(positions(first.school));
    } finally {
      first.school.dispose();
      second.school.dispose();
    }
  });

  test("a later source spans the tank without relocating retained bodies", () => {
    const { school } = schoolWith();
    try {
      school.applyModel(projectFeed(populations([48, 48, 0])));
      const before = new Map(school.snapshotBodies().map((body) => [body.key, body.position]));

      const sources = populations([48, 48, 48]);
      const model = projectFeed(sources);
      school.applyModel(model);

      const bodies = school.snapshotBodies();
      const retained = new Map(
        bodies.filter((body) => before.has(body.key)).map((body) => [body.key, body.position]),
      );
      expect(retained).toEqual(before);
      const sourceByKey = new Map(
        model.creatures.map((creature) => [creature.key, creature.sourceID]),
      );
      const arrivals = bodies.filter((body) => sourceByKey.get(body.key) === "mj");
      expect(arrivals).toHaveLength(48);
      const outerRadiusSquared = Math.max(
        ...bodies.map(({ position }) => position.x ** 2 + position.y ** 2),
      );
      const occupiedQuarters = new Set(
        arrivals.map(({ position }) =>
          Math.min(3, Math.floor(((position.x ** 2 + position.y ** 2) / outerRadiusSquared) * 4)),
        ),
      );
      const quadrants = new Set(
        arrivals.map(({ position }) => (position.x >= 0 ? 1 : 0) + (position.y >= 0 ? 2 : 0)),
      );
      expect(quadrants).toEqual(new Set([0, 1, 2, 3]));
      expect(occupiedQuarters).toEqual(new Set([0, 1, 2, 3]));
    } finally {
      school.dispose();
    }
  });
});

describe("school species buckets", () => {
  const speciesFeed = (): SessionFeed => [
    { id: "local", health: { kind: "connected" }, sessions: [session("a"), session("b")] },
    {
      id: "iu",
      health: { kind: "connected" },
      sessions: [
        session("a", { status: "running", attention: { permissions: 1, questions: 0 } }),
        session("b"),
      ],
    },
    { id: "mj", health: { kind: "connected" }, sessions: [session("a"), session("b")] },
  ];

  test("sources land in their species bucket with state and isolation", () => {
    const { school, scene } = schoolWith();
    school.applyModel(projectFeed(speciesFeed()));
    school.advance(0.4);
    school.syncInstances();

    const stats = school.stats();
    expect(stats.meshes).toBe(29);
    expect(stats.buckets.reduce((total, count) => total + count, 0)).toBe(6);
    expect(stats.buckets[8]).toBe(2);
    expect(stats.buckets[9]).toBe(2);
    expect(parts(scene)).toHaveLength(29);

    const friedKeys = Array.from({ length: 2 }, (_, slot) => school.keyAt(8, slot));
    const whiteKeys = Array.from({ length: 2 }, (_, slot) => school.keyAt(9, slot));
    expect(new Set(friedKeys)).toEqual(new Set(["iu:a", "iu:b"]));
    expect(new Set(whiteKeys)).toEqual(new Set(["mj:a", "mj:b"]));
    const fried = "iu:a";
    const white = "mj:a";
    const friedSlot = friedKeys.indexOf(fried);
    const whiteSlot = whiteKeys.indexOf(white);

    const friedMeshes = bucketParts(scene, 8);
    const friedState = attribute(friedMeshes[0]!, "fade");
    expect(friedState.array[friedSlot]).toBeGreaterThan(0);
    expect(attribute(friedMeshes[0]!, "energy").array[friedSlot]).toBeGreaterThan(0);
    expect(attribute(friedMeshes[0]!, "warm").array[friedSlot]).toBeGreaterThan(0);
    expect(attribute(friedMeshes[0]!, "emphasis").array[friedSlot]).toBe(0);
    expect(attribute(bucketParts(scene, 9)[0]!, "fade").array[whiteSlot]).toBeGreaterThan(0);

    const before = friedMeshes.map((mesh) =>
      Float32Array.from(mesh.instanceMatrix.array as Float32Array),
    );
    expect(
      school.isolate(fried, () => {
        for (const mesh of friedMeshes) {
          const array = mesh.instanceMatrix.array as Float32Array;
          expect(rowIsZeroScale(array, friedSlot)).toBe(false);
          expect(rowIsZeroScale(array, 1 - friedSlot)).toBe(true);
        }
      }),
    ).toBe(true);
    friedMeshes.forEach((mesh, index) => {
      expect(mesh.instanceMatrix.array).toEqual(before[index]);
    });

    school.setSelection(fried);
    school.syncInstances();
    expect(attribute(friedMeshes[0]!, "emphasis").array[friedSlot]).toBe(1);
    expect(specimenParts(scene)).toHaveLength(3);
    school.setSelection(white);
    school.syncInstances();
    expect(specimenParts(scene)).toHaveLength(10);
    school.setSelection(undefined);
    school.syncInstances();
    expect(specimenParts(scene)).toHaveLength(0);

    school.dispose();
  });

  test("a lone static body keeps one slot without a moon morph sentinel", () => {
    const { school, scene } = schoolWith();
    school.applyModel(
      projectFeed([
        { id: "empty", health: { kind: "connected" }, sessions: [] },
        { id: "empty-two", health: { kind: "connected" }, sessions: [] },
        { id: "mj", health: { kind: "connected" }, sessions: [session("only")] },
      ]),
    );
    school.advance(0.4);
    school.syncInstances();

    expect(school.stats().buckets[9]).toBe(1);
    expect(school.stats().renderCounts[9]).toBe(1);
    for (const mesh of bucketParts(scene, 9)) {
      expect(mesh.count).toBe(1);
      expect(mesh.morphTexture).toBeNull();
    }
    expect(attribute(bucketParts(scene, 9)[0]!, "fade").array[0]).toBeGreaterThan(0);

    school.dispose();
  });

  test("species assets and attributes survive resize, retiring attributes once", () => {
    const spotted = new THREE.Texture();
    const counts = new Map<object, number>();
    const track = (
      resource: THREE.BufferGeometry | THREE.Material | THREE.Texture | THREE.BufferAttribute,
    ): void => {
      if (counts.has(resource)) return;
      counts.set(resource, 0);
      resource.addEventListener("dispose", () => {
        counts.set(resource, (counts.get(resource) ?? 0) + 1);
      });
    };
    const { school, scene } = schoolWith(spotted);
    school.applyModel(projectFeed(speciesFeed()));
    school.advance(0.4);
    school.syncInstances();

    const fried = bucketParts(scene, 8)[0]!;
    const geometry = fried.geometry;
    const material = Array.isArray(fried.material) ? fried.material[0]! : fried.material;
    const firstAttribute = attribute(fried, "fade");
    track(geometry);
    track(material);
    track(firstAttribute);
    track(spotted);

    const many = Array.from({ length: 200 }, (_, index) => session(`many-${index}`));
    school.applyModel(projectFeed(feed(many)));
    school.syncInstances();
    expect(school.stats().meshes).toBe(29);
    expect(counts.get(firstAttribute)).toBe(1);
    expect(counts.get(geometry)).toBe(0);
    expect(counts.get(material)).toBe(0);
    expect(counts.get(spotted)).toBe(0);

    const secondAttribute = attribute(bucketParts(scene, 8)[0]!, "fade");
    expect(secondAttribute).not.toBe(firstAttribute);
    track(secondAttribute);
    const crowded = Array.from({ length: 600 }, (_, index) => session(`crowded-${index}`));
    school.applyModel(projectFeed(feed(crowded)));
    school.syncInstances();
    expect(counts.get(secondAttribute)).toBe(1);
    expect(counts.get(geometry)).toBe(0);
    expect(counts.get(material)).toBe(0);

    school.dispose();
    expect(counts.get(geometry)).toBe(1);
    expect(counts.get(material)).toBe(1);
    expect(counts.get(spotted)).toBe(1);
    for (const count of counts.values()) expect(count).toBe(1);
  });
});
