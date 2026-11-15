import * as THREE from "three/webgpu";

import { BELL_SCALE, createBell, updateBell } from "./bell.ts";
import type { Bell } from "./bell.ts";
import { TAU } from "./constants.ts";

export interface JellyDetail {
  readonly rows: number;
  readonly cols: number;
  readonly armStations: number;
  readonly armColumns: number;
}

const DETAIL_SESSION_LIMITS = { high: 40, medium: 120, low: 280 };

export const detailFor = (count: number): JellyDetail => {
  if (count <= DETAIL_SESSION_LIMITS.high) {
    return { rows: 48, cols: 192, armStations: 18, armColumns: 21 };
  }
  if (count <= DETAIL_SESSION_LIMITS.medium) {
    return { rows: 32, cols: 120, armStations: 14, armColumns: 15 };
  }
  if (count <= DETAIL_SESSION_LIMITS.low) {
    return { rows: 20, cols: 84, armStations: 11, armColumns: 11 };
  }
  return { rows: 12, cols: 36, armStations: 6, armColumns: 7 };
};

export interface Extent {
  readonly radius: number;
  readonly up: number;
  readonly down: number;
}

export const EXTENT: Extent = {
  radius: 0.62,
  up: 0.46,
  down: 0.46,
};

export const PHASE_BUCKETS = 8;

export interface PhaseGeometry {
  readonly bell: THREE.BufferGeometry;
  readonly arms: THREE.BufferGeometry;
}

const ARM_LAYOUT = [
  { angle: 0.3, length: 0.7, width: 0.2, radius: 0.29, seed: 1 },
  { angle: 1.87, length: 0.64, width: 0.19, radius: 0.29, seed: 2 },
  { angle: 3.44, length: 0.68, width: 0.2, radius: 0.29, seed: 3 },
  { angle: 5.01, length: 0.62, width: 0.19, radius: 0.29, seed: 4 },
] as const;
const ARM_DEPTH = 0.064;
const ARM_ORIGIN_Y = -0.08;
const ARM_PULSE = { lift: 0.018, tilt: 0.028, swing: 0.035, roll: 0.025, lag: 0.05 };

const shellIndex = (rows: number, cols: number): Array<number> => {
  const index: Array<number> = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const nextColumn = (column + 1) % cols;
      const a = row * cols + column;
      const b = row * cols + nextColumn;
      const c = (row + 1) * cols + column;
      const d = (row + 1) * cols + nextColumn;
      index.push(a, c, b, b, c, d);
    }
  }
  return index;
};

const attribute = (array: Float32Array, size: number): THREE.BufferAttribute =>
  new THREE.BufferAttribute(array, size);

const buildArms = (detail: JellyDetail, turns: number): THREE.BufferGeometry => {
  const columns = detail.armColumns - 1;
  const stations = detail.armStations - 1;
  const lobe = new THREE.SphereGeometry(1, columns, stations);
  const lobePositions = lobe.getAttribute("position");
  const lobeIndex = lobe.index!;
  const perLobe = lobePositions.count;
  const vertices = ARM_LAYOUT.length * perLobe;
  const positions = new Float32Array(vertices * 3);
  const along = new Float32Array(vertices);
  const index = new Uint16Array(ARM_LAYOUT.length * lobeIndex.count);
  const wave = Math.sin(turns * TAU);
  const group = new THREE.Matrix4()
    .makeRotationX(wave * ARM_PULSE.tilt)
    .setPosition(0, wave * ARM_PULSE.lift * BELL_SCALE, 0);
  const scratch = new THREE.Vector3();
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3(1, 1, 1);
  const translation = new THREE.Vector3();
  const euler = new THREE.Euler();

  for (let armIndex = 0; armIndex < ARM_LAYOUT.length; armIndex += 1) {
    const arm = ARM_LAYOUT[armIndex]!;
    const lag = Math.sin((turns - ARM_PULSE.lag) * TAU);
    const rootX = Math.cos(arm.angle) * arm.radius;
    const rootZ = Math.sin(arm.angle) * arm.radius;
    const baseX = rootZ * 0.18;
    const baseZ = -rootX * 0.18;
    translation.set(rootX * BELL_SCALE, ARM_ORIGIN_Y * BELL_SCALE, rootZ * BELL_SCALE);
    euler.set(
      baseX + lag * ARM_PULSE.swing,
      -arm.angle,
      baseZ + lag * ARM_PULSE.roll * (armIndex % 2 === 0 ? 1 : -1),
    );
    quaternion.setFromEuler(euler);
    matrix.compose(translation, quaternion, scale).premultiply(group);
    const offset = armIndex * perLobe;
    for (let vertex = 0; vertex < perLobe; vertex += 1) {
      const x = lobePositions.getX(vertex);
      const y = lobePositions.getY(vertex);
      const z = lobePositions.getZ(vertex);
      const t = (1 - y) / 2;
      const envelope = Math.sin(t * Math.PI);
      const fold = Math.sin(x * 4.2 + t * 4.5 + arm.seed) * 0.055 * envelope;
      const curl = 0.1 * t * t;
      scratch.set(
        (x * arm.width * (0.84 + 0.16 * t) + Math.sin(t * Math.PI * 1.2) * 0.035) * BELL_SCALE,
        (-t * arm.length + Math.sin(x * Math.PI) * 0.025 * envelope) * BELL_SCALE,
        (z * ARM_DEPTH + fold + curl) * BELL_SCALE,
      );
      scratch.applyMatrix4(matrix);
      const at = offset + vertex;
      positions[at * 3] = scratch.x;
      positions[at * 3 + 1] = scratch.y;
      positions[at * 3 + 2] = scratch.z;
      along[at] = t;
    }
    for (let triangle = 0; triangle < lobeIndex.count; triangle += 1) {
      index[armIndex * lobeIndex.count + triangle] = lobeIndex.getX(triangle) + offset;
    }
  }
  lobe.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", attribute(positions, 3));
  geometry.setAttribute("along", attribute(along, 1));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  geometry.computeVertexNormals();
  const normals = geometry.getAttribute("normal");
  for (let vertex = 0; vertex < vertices; vertex += 1) {
    if (Math.hypot(normals.getX(vertex), normals.getY(vertex), normals.getZ(vertex)) > 0.5) {
      continue;
    }
    normals.setXYZ(vertex, 0, along[vertex]! < 0.5 ? 1 : -1, 0);
  }
  normals.needsUpdate = true;
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 0.62);
  return geometry;
};

export interface InstanceAttributes {
  readonly fade: Float32Array;
  readonly energy: Float32Array;
  readonly warm: Float32Array;
  readonly emphasis: Float32Array;
}

export const createInstanceAttributes = (capacity: number): InstanceAttributes => ({
  fade: new Float32Array(capacity),
  energy: new Float32Array(capacity),
  warm: new Float32Array(capacity),
  emphasis: new Float32Array(capacity),
});

export const attachInstances = (
  geometry: THREE.BufferGeometry,
  instances: InstanceAttributes,
): THREE.BufferGeometry => {
  geometry.setAttribute("fade", new THREE.InstancedBufferAttribute(instances.fade, 1));
  geometry.setAttribute("energy", new THREE.InstancedBufferAttribute(instances.energy, 1));
  geometry.setAttribute("warm", new THREE.InstancedBufferAttribute(instances.warm, 1));
  geometry.setAttribute("emphasis", new THREE.InstancedBufferAttribute(instances.emphasis, 1));
  return geometry;
};

const buildBellGeometry = (
  bell: Bell,
  detail: JellyDetail,
  instances: InstanceAttributes,
): THREE.BufferGeometry => {
  const geometry = attachInstances(
    new THREE.BufferGeometry().setIndex(shellIndex(detail.rows, detail.cols)),
    instances,
  );
  geometry.setAttribute("position", attribute(bell.positions, 3));
  geometry.setAttribute("normal", attribute(bell.normals, 3));
  geometry.setAttribute("uv", attribute(bell.uvs, 2));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0.17, 0), 0.68);
  return geometry;
};

export const createPhaseGeometry = (
  detail: JellyDetail,
  turns: number,
  instances: InstanceAttributes,
): PhaseGeometry => {
  const bell = createBell(detail);
  updateBell(bell, turns);
  return {
    bell: buildBellGeometry(bell, detail, instances),
    arms: attachInstances(buildArms(detail, turns), instances),
  };
};

const PHASE_PARTS = ["bell", "arms"] as const;

export const linkPhaseMorph = (current: PhaseGeometry, next: PhaseGeometry): void => {
  for (const part of PHASE_PARTS) {
    const geometry = current[part];
    const base = geometry.getAttribute("position");
    const target = next[part].getAttribute("position");
    const from = base.array;
    const to = target.array;
    const delta = new Float32Array(from.length);
    for (let index = 0; index < delta.length; index += 1) delta[index] = to[index]! - from[index]!;
    geometry.morphAttributes.position = [new THREE.BufferAttribute(delta, 3)];
    geometry.morphTargetsRelative = true;
  }
};

export const disposePhase = (phase: PhaseGeometry): void => {
  phase.bell.dispose();
  phase.arms.dispose();
};
