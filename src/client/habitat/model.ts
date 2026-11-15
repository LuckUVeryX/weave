import type { SessionFeed, SessionView } from "../../shared/session.ts";

const FULL_SIZE_SESSION_COUNT = 48;
const MIN_DENSITY_SCALE = 0.34;
const SPECIES_CYCLE_LENGTH = 3;
const SIZE = {
  rootScaleMin: 1.15,
  rootScaleVariation: 0.04,
  childDivisorMin: 1.15,
  childDivisorVariation: 0.05,
};

export type JellySpecies = "moon" | "fried-egg" | "white-spotted";

const speciesForSource = (sourceIndex: number): JellySpecies => {
  const position = sourceIndex % SPECIES_CYCLE_LENGTH;
  if (position === 0) return "moon";
  if (position === 1) return "fried-egg";
  return "white-spotted";
};

export interface CreatureModel {
  readonly key: string;
  readonly sourceID: string;
  readonly species: JellySpecies;
  readonly session: SessionView;
  readonly parentKey: string | undefined;
  readonly seed: number;
}

export interface HabitatModel {
  readonly creatures: ReadonlyArray<CreatureModel>;
  readonly densityScale: number;
}

const creatureKey = (sourceID: string, sessionID: string): string => `${sourceID}:${sessionID}`;

const fnv1a = (value: string): number => {
  let state = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return state >>> 0;
};

const seedOf = (key: string): number => fnv1a(key) / 0xffffffff;

export const scaleFactor = (creature: Pick<CreatureModel, "key" | "parentKey">): number => {
  const root = SIZE.rootScaleMin + seedOf(`${creature.key}:root`) * SIZE.rootScaleVariation;
  return creature.parentKey === undefined
    ? root
    : root / (SIZE.childDivisorMin + seedOf(`${creature.key}:child`) * SIZE.childDivisorVariation);
};

const densityScaleFor = (count: number): number =>
  count <= FULL_SIZE_SESSION_COUNT
    ? 1
    : Math.max(MIN_DENSITY_SCALE, Math.sqrt(FULL_SIZE_SESSION_COUNT / count));

const compare = (left: CreatureModel, right: CreatureModel): number =>
  left.key < right.key ? -1 : left.key > right.key ? 1 : 0;

export const projectFeed = (feed: SessionFeed): HabitatModel => {
  const creatures: Array<CreatureModel> = [];

  for (const [sourceIndex, source] of feed.entries()) {
    const species = speciesForSource(sourceIndex);
    const present = new Set(source.sessions.map((session) => session.id));

    for (const session of source.sessions) {
      const key = creatureKey(source.id, session.id);
      const parentPresent = session.parentID !== undefined && present.has(session.parentID);

      creatures.push({
        key,
        sourceID: source.id,
        species,
        session,
        parentKey: parentPresent ? creatureKey(source.id, session.parentID) : undefined,
        seed: seedOf(key),
      });
    }
  }

  creatures.sort(compare);

  return {
    creatures,
    densityScale: densityScaleFor(creatures.length),
  };
};

export interface ModelDiff {
  readonly added: ReadonlyArray<CreatureModel>;
  readonly removed: ReadonlyArray<string>;
  readonly retained: ReadonlyArray<CreatureModel>;
}

export const diffModel = (
  previous: ReadonlyMap<string, CreatureModel>,
  next: HabitatModel,
): ModelDiff => {
  const added: Array<CreatureModel> = [];
  const retained: Array<CreatureModel> = [];
  const nextKeys = new Set<string>();

  for (const creature of next.creatures) {
    nextKeys.add(creature.key);
    if (previous.has(creature.key)) retained.push(creature);
    else added.push(creature);
  }

  const removed: Array<string> = [];
  for (const key of previous.keys()) if (!nextKeys.has(key)) removed.push(key);

  return { added, removed, retained };
};
