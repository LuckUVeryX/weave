import * as THREE from "three/webgpu";

import type { Extent } from "../geometry.ts";

export interface SpeciesPart {
  readonly geometry: THREE.BufferGeometry;
  readonly material: THREE.Material;
}

export interface SpeciesAsset {
  readonly bucket: number;
  readonly parts: ReadonlyArray<SpeciesPart>;
  readonly extent: Extent;
  /** Local matrix for each part: normalize and centre the study pose for this instant. */
  readonly pose: (seconds: number, out: ReadonlyArray<THREE.Matrix4>) => void;
  dispose(): void;
}

export interface StudySpecies {
  readonly bucket: number;
  readonly parts: ReadonlyArray<SpeciesPart>;
  readonly textures: ReadonlyArray<THREE.Texture>;
  readonly period: number;
  /** The bell geometry that sets the normalized size, in `parts` order. */
  readonly bellPart: number;
  /** Study part transforms at rest, before the pulse. */
  readonly restPose: (out: ReadonlyArray<THREE.Matrix4>) => void;
  /** Study part transforms at `seconds`, including the pulse. */
  readonly pose: (seconds: number, out: ReadonlyArray<THREE.Matrix4>) => void;
}

const TARGET_BELL_RADIUS = 0.6;
const POSE_SAMPLES = 32;
const ENVELOPE_CLEARANCE = { radial: 0.006, vertical: 0.009 };

const point = new THREE.Vector3();

const visitVertices = (
  parts: ReadonlyArray<SpeciesPart>,
  matrices: ReadonlyArray<THREE.Matrix4>,
  visit: (x: number, y: number, z: number) => void,
): void => {
  for (let part = 0; part < parts.length; part += 1) {
    const positions = parts[part]!.geometry.getAttribute("position");
    const matrix = matrices[part]!;
    for (let vertex = 0; vertex < positions.count; vertex += 1) {
      point
        .set(positions.getX(vertex), positions.getY(vertex), positions.getZ(vertex))
        .applyMatrix4(matrix);
      visit(point.x, point.y, point.z);
    }
  }
};

const measureBounds = (
  parts: ReadonlyArray<SpeciesPart>,
  matrices: ReadonlyArray<THREE.Matrix4>,
): { readonly up: number; readonly down: number } => {
  let up = Number.NEGATIVE_INFINITY;
  let down = Number.NEGATIVE_INFINITY;
  visitVertices(parts, matrices, (_x, y) => {
    up = Math.max(up, y);
    down = Math.max(down, -y);
  });
  return { up, down };
};

export const createSpeciesAsset = (species: StudySpecies): SpeciesAsset => {
  const { bellPart, parts, period, pose, restPose, textures } = species;
  const matrices = Array.from({ length: parts.length }, () => new THREE.Matrix4());
  const rest = Array.from({ length: parts.length }, () => new THREE.Matrix4());

  restPose(rest);
  const restBounds = measureBounds(parts, rest);
  const centre = (restBounds.up - restBounds.down) / 2;
  const bellPositions = parts[bellPart]!.geometry.getAttribute("position");
  let bellRadius = 0;
  for (let vertex = 0; vertex < bellPositions.count; vertex += 1) {
    point
      .set(bellPositions.getX(vertex), bellPositions.getY(vertex), bellPositions.getZ(vertex))
      .applyMatrix4(rest[bellPart]!);
    bellRadius = Math.max(bellRadius, Math.hypot(point.x, point.z));
  }
  const scale = TARGET_BELL_RADIUS / bellRadius;
  const normalize = new THREE.Matrix4()
    .makeScale(scale, scale, scale)
    .multiply(new THREE.Matrix4().makeTranslation(0, -centre, 0));

  const wrap = (out: ReadonlyArray<THREE.Matrix4>): void => {
    for (let part = 0; part < parts.length; part += 1) {
      out[part]!.premultiply(normalize);
    }
  };

  let radius = 0;
  let up = Number.NEGATIVE_INFINITY;
  let down = Number.NEGATIVE_INFINITY;
  for (let sample = 0; sample <= POSE_SAMPLES; sample += 1) {
    pose((sample / POSE_SAMPLES) * period, matrices);
    wrap(matrices);
    visitVertices(parts, matrices, (x, y, z) => {
      radius = Math.max(radius, Math.hypot(x, z));
      up = Math.max(up, y);
      down = Math.max(down, -y);
    });
  }

  return {
    bucket: species.bucket,
    parts,
    extent: {
      radius: radius + ENVELOPE_CLEARANCE.radial,
      up: up + ENVELOPE_CLEARANCE.vertical,
      down: down + ENVELOPE_CLEARANCE.vertical,
    },
    pose: (seconds, out) => {
      pose(seconds, out);
      wrap(out);
    },
    dispose: () => {
      for (const geometry of new Set(parts.map((part) => part.geometry))) geometry.dispose();
      for (const material of new Set(parts.map((part) => part.material))) material.dispose();
      for (const texture of textures) texture.dispose();
    },
  };
};

export const arcProfile = (
  points: ReadonlyArray<readonly [number, number]>,
): ReadonlyArray<number> => {
  const cumulative = [0];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1]!;
    const [x1, y1] = points[index]!;
    total += Math.hypot(x1 - x0, y1 - y0);
    cumulative.push(total);
  }
  return cumulative.map((value) => value / (total === 0 ? 1 : total));
};

export const latheGeometry = (
  points: ReadonlyArray<readonly [number, number]>,
  arc: ReadonlyArray<number>,
  segments: number,
): THREE.LatheGeometry => {
  const geometry = new THREE.LatheGeometry(
    points.map(([x, y]) => new THREE.Vector2(x, y)),
    segments,
  );
  const uv = geometry.getAttribute("uv");
  const rows = points.length;
  for (let index = 0; index < uv.count; index += 1) {
    uv.setY(index, arc[index % rows]!);
  }
  uv.needsUpdate = true;
  return geometry;
};

export const warpRim = (
  geometry: THREE.BufferGeometry,
  options: { waves: number; radial: number; vertical: number; phase?: number; from?: number },
): void => {
  const { waves, radial, vertical, phase = 0, from = 0.7 } = options;
  const positions = geometry.getAttribute("position");
  const uvs = geometry.getAttribute("uv");
  for (let index = 0; index < positions.count; index += 1) {
    point.fromBufferAttribute(positions, index);
    const strength = THREE.MathUtils.smoothstep(uvs.getY(index), from, 1);
    const angle = Math.atan2(point.x, point.z);
    const scale = 1 + Math.cos(angle * waves + phase) * radial * strength;
    positions.setXYZ(
      index,
      point.x * scale,
      point.y + Math.cos(angle * waves + phase + 0.8) * vertical * strength,
      point.z * scale,
    );
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
};

export const applyVertexColors = (
  geometry: THREE.BufferGeometry,
  colorAt: (position: THREE.Vector3, target: THREE.Color) => void,
): void => {
  const positions = geometry.getAttribute("position");
  const colors = new Float32Array(positions.count * 3);
  const color = new THREE.Color();
  for (let index = 0; index < positions.count; index += 1) {
    point.fromBufferAttribute(positions, index);
    colorAt(point, color);
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
};
