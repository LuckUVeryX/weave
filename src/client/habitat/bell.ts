import { TAU } from "./constants.ts";

export interface BellDetail {
  readonly rows: number;
  readonly cols: number;
}

export interface Bell {
  readonly detail: BellDetail;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly profileRadius: Float64Array;
  readonly profileHeight: Float64Array;
}

const MOON_PROFILE = [
  [0.0, 0.76],
  [0.18, 0.752],
  [0.38, 0.716],
  [0.56, 0.648],
  [0.72, 0.556],
  [0.86, 0.437],
  [0.96, 0.303],
  [1.02, 0.178],
  [1.045, 0.055],
  [1.04, -0.015],
  [1.02, -0.075],
  [0.98, -0.125],
  [0.93, -0.155],
] as const;

const MOON_RADIUS = Math.max(...MOON_PROFILE.map(([radius]) => radius));
export const BELL_SCALE = 0.6 / MOON_RADIUS;
export const BELL_TOP = MOON_PROFILE[0]![1] * BELL_SCALE;
export const BELL_RIM = MOON_PROFILE[MOON_PROFILE.length - 1]![1] * BELL_SCALE;
export const BELL_FRINGE_START = 0.075 * BELL_SCALE;
export const BELL_FRINGE_END = -BELL_RIM;
const BELL_TEXTURE_SPAN = 1.56 * BELL_SCALE;

const WARP = {
  waves: 3,
  radial: 0.012,
  vertical: 0.02 * BELL_SCALE,
  phase: 0.4,
  from: 0.72,
};
const PULSE = { width: 0.02, height: 0.034 };

const profileLength = (() => {
  let length = 0;
  for (let index = 1; index < MOON_PROFILE.length; index += 1) {
    length += Math.hypot(
      (MOON_PROFILE[index]![0] - MOON_PROFILE[index - 1]![0]) * BELL_SCALE,
      (MOON_PROFILE[index]![1] - MOON_PROFILE[index - 1]![1]) * BELL_SCALE,
    );
  }
  return length;
})();

const smoothstep = (edge0: number, edge1: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

export const beat = (u: number): number => {
  const t = u - Math.floor(u);
  if (t < 0.34) return smoothstep(0, 1, t / 0.34);
  return 1 - smoothstep(0, 1, (t - 0.34) / 0.66);
};

const fillProfile = (bell: Bell): void => {
  const { rows } = bell.detail;
  const segmentAt = (index: number): number =>
    Math.hypot(
      (MOON_PROFILE[index]![0] - MOON_PROFILE[index - 1]![0]) * BELL_SCALE,
      (MOON_PROFILE[index]![1] - MOON_PROFILE[index - 1]![1]) * BELL_SCALE,
    );
  let segment = 1;
  let travelled = 0;
  let segmentLength = segmentAt(1);
  for (let index = 0; index < rows; index += 1) {
    const target = (index / (rows - 1)) * profileLength;
    while (segment < MOON_PROFILE.length - 1 && travelled + segmentLength < target) {
      travelled += segmentLength;
      segment += 1;
      segmentLength = segmentAt(segment);
    }
    const fraction = segmentLength === 0 ? 0 : (target - travelled) / segmentLength;
    bell.profileRadius[index] =
      (MOON_PROFILE[segment - 1]![0] +
        (MOON_PROFILE[segment]![0] - MOON_PROFILE[segment - 1]![0]) * fraction) *
      BELL_SCALE;
    bell.profileHeight[index] =
      (MOON_PROFILE[segment - 1]![1] +
        (MOON_PROFILE[segment]![1] - MOON_PROFILE[segment - 1]![1]) * fraction) *
      BELL_SCALE;
  }
};

export const createBell = (detail: BellDetail): Bell => {
  const bell: Bell = {
    detail,
    positions: new Float32Array(detail.rows * detail.cols * 3),
    normals: new Float32Array(detail.rows * detail.cols * 3),
    uvs: new Float32Array(detail.rows * detail.cols * 2),
    profileRadius: new Float64Array(detail.rows),
    profileHeight: new Float64Array(detail.rows),
  };
  fillProfile(bell);
  return bell;
};

const updateNormals = (bell: Bell): void => {
  const { rows, cols } = bell.detail;
  const positions = bell.positions;
  const normals = bell.normals;
  for (let row = 0; row < rows; row += 1) {
    const previousRow = Math.max(0, row - 1);
    const nextRow = Math.min(rows - 1, row + 1);
    for (let column = 0; column < cols; column += 1) {
      const previousColumn = (column - 1 + cols) % cols;
      const nextColumn = (column + 1) % cols;
      const a = (nextRow * cols + column) * 3;
      const b = (previousRow * cols + column) * 3;
      const c = (row * cols + nextColumn) * 3;
      const d = (row * cols + previousColumn) * 3;
      const ax = positions[a]! - positions[b]!;
      const ay = positions[a + 1]! - positions[b + 1]!;
      const az = positions[a + 2]! - positions[b + 2]!;
      const bx = positions[c]! - positions[d]!;
      const by = positions[c + 1]! - positions[d + 1]!;
      const bz = positions[c + 2]! - positions[d + 2]!;
      let nx = ay * bz - az * by;
      let ny = az * bx - ax * bz;
      let nz = ax * by - ay * bx;
      const length = Math.hypot(nx, ny, nz);
      if (length < 1e-9) {
        nx = 0;
        ny = 1;
        nz = 0;
      } else {
        nx /= length;
        ny /= length;
        nz /= length;
      }
      const at = (row * cols + column) * 3;
      normals[at] = nx;
      normals[at + 1] = ny;
      normals[at + 2] = nz;
    }
  }
};

export const updateBell = (bell: Bell, turns: number): void => {
  const { rows, cols } = bell.detail;
  const { positions, uvs } = bell;
  const wave = Math.sin(turns * TAU);
  const width = 1 + wave * PULSE.width;
  const height = 1 - wave * PULSE.height;
  for (let row = 0; row < rows; row += 1) {
    const v = rows === 1 ? 0 : row / (rows - 1);
    const strength = smoothstep(WARP.from, 1, v);
    const radius = bell.profileRadius[row]!;
    const y = bell.profileHeight[row]!;
    for (let column = 0; column < cols; column += 1) {
      const angle = (column / cols) * TAU;
      const waveOffset = Math.cos(angle * WARP.waves + WARP.phase);
      const scale = 1 + waveOffset * WARP.radial * strength;
      const x = Math.sin(angle) * radius * scale * width;
      const z = Math.cos(angle) * radius * scale * width;
      const lift = y + Math.cos(angle * WARP.waves + WARP.phase + 0.8) * WARP.vertical * strength;
      const at = (row * cols + column) * 3;
      positions[at] = x;
      positions[at + 1] = lift * height;
      positions[at + 2] = z;
      const uvAt = (row * cols + column) * 2;
      uvs[uvAt] = 0.5 + x / BELL_TEXTURE_SPAN;
      uvs[uvAt + 1] = 0.5 - z / BELL_TEXTURE_SPAN;
    }
  }
  updateNormals(bell);
};
