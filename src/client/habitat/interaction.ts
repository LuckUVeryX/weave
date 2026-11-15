import type { CreatureModel } from "./model.ts";

interface Interaction {
  readonly openedKey: string | undefined;
  readonly focusedKey: string | undefined;
  readonly hoveredKey: string | undefined;
}

type Action =
  | { readonly kind: "focus" | "blur"; readonly key: string }
  | { readonly kind: "hover" | "toggle"; readonly key: string | undefined }
  | { readonly kind: "close" | "escape" }
  | { readonly kind: "reconcile"; readonly creatures: ReadonlyMap<string, CreatureModel> };

type Presentation =
  | { readonly kind: "idle" }
  | {
      readonly kind: "preview";
      readonly creature: CreatureModel;
      readonly source: "keyboard" | "pointer";
    }
  | { readonly kind: "inspecting"; readonly creature: CreatureModel };

export const initialInteraction: Interaction = {
  openedKey: undefined,
  focusedKey: undefined,
  hoveredKey: undefined,
};

export function reduceInteraction(state: Interaction, action: Action): Interaction {
  switch (action.kind) {
    case "focus":
      return { ...state, focusedKey: action.key };
    case "blur":
      return state.focusedKey === action.key ? { ...state, focusedKey: undefined } : state;
    case "hover":
      return { ...state, hoveredKey: action.key };
    case "toggle":
      return { ...state, openedKey: state.openedKey === action.key ? undefined : action.key };
    case "close":
      return { ...state, openedKey: undefined };
    case "escape":
      return { ...state, focusedKey: undefined, hoveredKey: undefined };
    case "reconcile":
      return {
        openedKey:
          state.openedKey !== undefined && action.creatures.has(state.openedKey)
            ? state.openedKey
            : undefined,
        focusedKey:
          state.focusedKey !== undefined && action.creatures.has(state.focusedKey)
            ? state.focusedKey
            : undefined,
        hoveredKey:
          state.hoveredKey !== undefined && action.creatures.has(state.hoveredKey)
            ? state.hoveredKey
            : undefined,
      };
  }
}

export function presentation(
  interaction: Interaction,
  creatures: ReadonlyMap<string, CreatureModel>,
): Presentation {
  const opened =
    interaction.openedKey === undefined ? undefined : creatures.get(interaction.openedKey);
  if (opened !== undefined) return { kind: "inspecting", creature: opened };
  const focused =
    interaction.focusedKey === undefined ? undefined : creatures.get(interaction.focusedKey);
  if (focused !== undefined) return { kind: "preview", creature: focused, source: "keyboard" };
  const hovered =
    interaction.hoveredKey === undefined ? undefined : creatures.get(interaction.hoveredKey);
  return hovered === undefined
    ? { kind: "idle" }
    : { kind: "preview", creature: hovered, source: "pointer" };
}
