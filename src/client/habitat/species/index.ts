import type * as THREE from "three/webgpu";

import { PHASE_BUCKETS } from "../geometry.ts";
import type { JellySpecies } from "../model.ts";
import { createSpeciesAsset } from "./asset.ts";
import type { SpeciesAsset } from "./asset.ts";
import { createFriedEgg } from "./fried-egg.ts";
import { createWhiteSpotted } from "./white-spotted.ts";

export { createSpottedTexture } from "./white-spotted.ts";

const FRIED_BUCKET = PHASE_BUCKETS;
const WHITE_BUCKET = PHASE_BUCKETS + 1;
export const CELL_COUNT = PHASE_BUCKETS + 2;

export interface SpeciesAssets {
  readonly friedEgg: SpeciesAsset;
  readonly whiteSpotted: SpeciesAsset;
  readonly list: ReadonlyArray<SpeciesAsset>;
  dispose(): void;
}

export const createSpeciesAssets = (spotMap: THREE.Texture): SpeciesAssets => {
  const friedEgg = createSpeciesAsset(createFriedEgg(FRIED_BUCKET));
  const whiteSpotted = createSpeciesAsset(createWhiteSpotted(WHITE_BUCKET, spotMap));
  return {
    friedEgg,
    whiteSpotted,
    list: [friedEgg, whiteSpotted],
    dispose: () => {
      friedEgg.dispose();
      whiteSpotted.dispose();
    },
  };
};

export const assetFor = (
  assets: SpeciesAssets,
  species: JellySpecies,
): SpeciesAsset | undefined => {
  if (species === "fried-egg") return assets.friedEgg;
  if (species === "white-spotted") return assets.whiteSpotted;
  return undefined;
};
