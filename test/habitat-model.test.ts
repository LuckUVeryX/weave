import { describe, expect, test } from "vitest";

import { projectFeed, scaleFactor } from "../src/client/habitat/model.ts";
import type { CreatureModel, HabitatModel } from "../src/client/habitat/model.ts";
import type {
  SessionFeed,
  SessionView,
  SourceHealth,
  SourceSessions,
} from "../src/shared/session.ts";

const session = (id: string, overrides: Partial<SessionView> = {}): SessionView => ({
  id,
  title: `Session ${id}`,
  time: { created: 1_700_000_000_000, updated: 1_700_000_100_000 },
  location: { directory: `/Users/mira/Code/${id}` },
  status: "idle",
  attention: { permissions: 0, questions: 0 },
  ...overrides,
});

const group = (
  id: string,
  sessions: ReadonlyArray<SessionView>,
  health: SourceHealth = { kind: "connected" },
): SourceSessions => ({ id, health, sessions });

const feed = (sessions: ReadonlyArray<SessionView>, source = "local"): SessionFeed => [
  group(source, sessions),
];

const byKey = (creatures: ReadonlyArray<CreatureModel>): Map<string, CreatureModel> =>
  new Map(creatures.map((creature) => [creature.key, creature]));

describe("habitat model", () => {
  test("keys are source plus session id and idle sessions are included", () => {
    const model = projectFeed(
      feed([
        session("ses_root", { title: "Root" }),
        session("ses_child", { parentID: "ses_root", status: "idle" }),
        session("ses_orphan", { parentID: "ses_missing", status: "running" }),
      ]),
    );

    expect(model.creatures.map((creature) => creature.key)).toEqual([
      "local:ses_child",
      "local:ses_orphan",
      "local:ses_root",
    ]);
    expect(byKey(model.creatures).get("local:ses_child")?.parentKey).toBe("local:ses_root");
    expect(byKey(model.creatures).get("local:ses_orphan")?.parentKey).toBeUndefined();
    expect(byKey(model.creatures).get("local:ses_root")?.parentKey).toBeUndefined();
    expect(byKey(model.creatures).get("local:ses_child")?.session.status).toBe("idle");
  });

  test("a same-id session in another source is not the parent", () => {
    const model = projectFeed([
      {
        id: "one",
        health: { kind: "connected" },
        sessions: [session("root"), session("child", { parentID: "root" })],
      },
      {
        id: "two",
        health: { kind: "connected" },
        sessions: [session("child", { parentID: "root" })],
      },
    ]);
    const creatures = byKey(model.creatures);
    expect(creatures.get("one:child")?.parentKey).toBe("one:root");
    expect(creatures.get("two:child")?.parentKey).toBeUndefined();
    expect(creatures.size).toBe(3);
  });

  test("a root stays larger than its own children", () => {
    const model = projectFeed(
      feed([
        session("ses_root"),
        session("ses_child_a", { parentID: "ses_root" }),
        session("ses_child_b", { parentID: "ses_root" }),
      ]),
    );
    const root = byKey(model.creatures).get("local:ses_root");
    const children = model.creatures.filter((creature) => creature.parentKey !== undefined);

    if (root === undefined) throw new Error("Expected the root in the projected model.");
    for (const child of children) {
      expect(scaleFactor(root)).toBeGreaterThan(scaleFactor(child));
    }
  });

  test("crowded schools shrink to a bounded scale", () => {
    const scaleFor = (count: number) =>
      projectFeed(feed(Array.from({ length: count }, (_, index) => session(`ses_${index}`))))
        .densityScale;

    expect(scaleFor(48)).toBe(1);
    expect(scaleFor(300)).toBeLessThan(1);
    expect(scaleFor(5000)).toBe(0.34);
  });
});

describe("jelly species", () => {
  test("six feed positions cycle through the three species", () => {
    const ids = ["a", "b", "c", "d", "e", "f"];
    const model = projectFeed(ids.map((id) => group(id, [session("ses")])));
    const creatures = byKey(model.creatures);

    expect(creatures.size).toBe(6);
    expect(ids.map((id) => creatures.get(`${id}:ses`)?.species)).toEqual([
      "moon",
      "fried-egg",
      "white-spotted",
      "moon",
      "fried-egg",
      "white-spotted",
    ]);
  });

  test("a root and its children share the source species", () => {
    const model = projectFeed([
      group("one", [session("root"), session("child", { parentID: "root" })]),
      group("two", [session("root"), session("child", { parentID: "root" })]),
    ]);
    const creatures = byKey(model.creatures);

    expect(creatures.get("one:root")?.species).toBe("moon");
    expect(creatures.get("one:child")?.species).toBe("moon");
    expect(creatures.get("two:root")?.species).toBe("fried-egg");
    expect(creatures.get("two:child")?.species).toBe("fried-egg");
  });

  test("an empty or unavailable source keeps its feed position", () => {
    const model = projectFeed([
      group("empty", []),
      group("offline", [], { kind: "unavailable" }),
      group("iu", [session("ses")]),
    ]);

    expect(model.creatures).toHaveLength(1);
    expect(byKey(model.creatures).get("iu:ses")?.species).toBe("white-spotted");
  });

  test("a lone source at position zero is the moon jelly regardless of its id", () => {
    const model = projectFeed(feed([session("ses")], "iu"));

    expect(byKey(model.creatures).get("iu:ses")?.species).toBe("moon");
  });

  test("reordering sources changes species without changing creature keys", () => {
    const zed = group("zed", [session("ses")]);
    const alpha = group("alpha", [session("ses")]);
    const keysOf = (model: HabitatModel): ReadonlyArray<string> =>
      model.creatures.map((creature) => creature.key);

    const forward = projectFeed([zed, alpha]);
    const reversed = projectFeed([alpha, zed]);

    expect(keysOf(reversed)).toEqual(keysOf(forward));
    expect(byKey(forward.creatures).get("zed:ses")?.species).toBe("moon");
    expect(byKey(forward.creatures).get("alpha:ses")?.species).toBe("fried-egg");
    expect(byKey(reversed.creatures).get("alpha:ses")?.species).toBe("moon");
    expect(byKey(reversed.creatures).get("zed:ses")?.species).toBe("fried-egg");
  });
});
