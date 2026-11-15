import * as THREE from "three/webgpu";
import { expect, test } from "vitest";

import { BEAT_SECONDS } from "../src/client/habitat/constants.ts";
import { PHASE_BUCKETS } from "../src/client/habitat/geometry.ts";
import { detailFor } from "../src/client/habitat/geometry.ts";
import { Kreisel } from "../src/client/habitat/kreisel.ts";
import { projectFeed } from "../src/client/habitat/model.ts";
import { School } from "../src/client/habitat/school.ts";
import { Water } from "../src/client/habitat/water.ts";

test.each(["same bucket", "reentered phase buckets"])("picks published positions in %s", (mode) => {
  const scene = new THREE.Scene();
  const kreisel = new Kreisel(scene);
  const school = new School({
    scene,
    water: new Water(kreisel),
    capacity: 64,
    detail: detailFor(1),
    reduced: true,
    clover: new THREE.Texture(),
    spotted: new THREE.Texture(),
  });
  const key = "local:moving";
  try {
    school.applyModel(
      projectFeed([
        {
          id: "local",
          health: { kind: "connected" },
          sessions: [
            {
              id: "moving",
              title: "Moving animal",
              time: { created: 1, updated: 1 },
              location: { directory: "/project" },
              status: "idle",
              attention: { permissions: 0, questions: 0 },
            },
          ],
        },
      ]),
    );
    school.advance(1);
    const body = school.specimenOf(key);
    if (body === undefined) throw new Error("Expected the initial animal.");
    const steps = mode === "same bucket" ? 1 : PHASE_BUCKETS;
    const dt = mode === "same bucket" ? 0 : BEAT_SECONDS / PHASE_BUCKETS;
    for (const x of [-3, 3]) {
      for (let step = 0; step < steps; step++) {
        school.advance(dt);
        body.position.set(x, 0, 0);
        school.syncInstances();
        const raycaster = new THREE.Raycaster(
          new THREE.Vector3(x, 0, 10),
          new THREE.Vector3(0, 0, -1),
        );
        expect(school.pick(raycaster), `${mode}, x=${x}, phase=${step}`).toBe(key);
      }
    }
  } finally {
    school.dispose();
    kreisel.dispose();
  }
});

test.each(["iu", "mj"])("picks a %s body in its static species bucket", (source) => {
  const scene = new THREE.Scene();
  const kreisel = new Kreisel(scene);
  const school = new School({
    scene,
    water: new Water(kreisel),
    capacity: 64,
    detail: detailFor(1),
    reduced: true,
    clover: new THREE.Texture(),
    spotted: new THREE.Texture(),
  });
  const key = `${source}:moving`;
  try {
    const empties =
      source === "iu"
        ? [{ id: "empty", sessions: [] }]
        : [
            { id: "empty-a", sessions: [] },
            { id: "empty-b", sessions: [] },
          ];
    school.applyModel(
      projectFeed([
        ...empties.map((empty) => ({ ...empty, health: { kind: "connected" as const } })),
        {
          id: source,
          health: { kind: "connected" },
          sessions: [
            {
              id: "moving",
              title: "Moving animal",
              time: { created: 1, updated: 1 },
              location: { directory: "/project" },
              status: "idle",
              attention: { permissions: 0, questions: 0 },
            },
          ],
        },
      ]),
    );
    school.advance(1);
    const body = school.specimenOf(key);
    if (body === undefined) throw new Error("Expected the initial animal.");
    body.position.set(3, 0, 0);
    school.syncInstances();
    const raycaster = new THREE.Raycaster(new THREE.Vector3(3, 0, 10), new THREE.Vector3(0, 0, -1));
    expect(school.pick(raycaster)).toBe(key);
  } finally {
    school.dispose();
    kreisel.dispose();
  }
});
