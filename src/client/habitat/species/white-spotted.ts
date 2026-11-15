import * as THREE from "three/webgpu";

import { createSpeciesMaterial } from "../materials.ts";
import { type SpeciesPart, type StudySpecies } from "./asset.ts";

const ORAL_Y = -0.38;
const PERIOD = 5.0;

interface BellRing {
  readonly y: number;
  readonly radius: number;
}

interface Spot {
  readonly u: number;
  readonly v: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly rotation: number;
}

interface LobePlacement {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly height: number;
  readonly width: number;
  readonly depth: number;
  readonly yaw: number;
  readonly lean: number;
}

const BELL_PROFILE: ReadonlyArray<BellRing> = [
  { y: 0.95, radius: 0 },
  { y: 0.86, radius: 0.36 },
  { y: 0.72, radius: 0.7 },
  { y: 0.5, radius: 0.92 },
  { y: 0.22, radius: 1.01 },
  { y: -0.06, radius: 0.99 },
  { y: -0.34, radius: 0.9 },
];
const BELL_SEGMENTS = 10;

const LOBE_SECTION = [
  { x: 0, z: 1.04 },
  { x: 0.88, z: 0.78 },
  { x: 1, z: 0.12 },
  { x: 0, z: -0.9 },
  { x: -1, z: 0.12 },
  { x: -0.88, z: 0.78 },
];
const LOBE_RINGS = [
  { t: 0, scale: 0.42 },
  { t: 0.16, scale: 0.72 },
  { t: 0.34, scale: 0.92 },
  { t: 0.52, scale: 1 },
  { t: 0.7, scale: 0.9 },
  { t: 0.85, scale: 0.68 },
  { t: 0.96, scale: 0.4 },
];

const LOBE_PLACEMENTS: ReadonlyArray<LobePlacement> = [
  { x: -0.13, y: -0.29, z: 0.12, height: 1.04, width: 0.52, depth: 0.54, yaw: -0.08, lean: -0.04 },
  { x: 0.13, y: -0.29, z: 0.128, height: 1.04, width: 0.52, depth: 0.54, yaw: 0.08, lean: 0.04 },
  { x: -0.3, y: -0.27, z: -0.1, height: 1.0, width: 0.68, depth: 0.5, yaw: -0.18, lean: -0.04 },
  { x: 0.3, y: -0.27, z: -0.1, height: 1.0, width: 0.68, depth: 0.5, yaw: 0.18, lean: 0.04 },
];

const TIP_RINGS = [
  { y: 0.05, radius: 0.09 },
  { y: 0.005, radius: 0.092 },
  { y: -0.035, radius: 0.082 },
  { y: -0.07, radius: 0.062 },
  { y: -0.1, radius: 0.038 },
];
const TIP_SEGMENTS = 6;

const BELL_ARC: Array<number> = [0];
let bellLength = 0;
for (let index = 1; index < BELL_PROFILE.length; index += 1) {
  bellLength += Math.hypot(
    BELL_PROFILE[index]!.radius - BELL_PROFILE[index - 1]!.radius,
    BELL_PROFILE[index]!.y - BELL_PROFILE[index - 1]!.y,
  );
  BELL_ARC.push(bellLength);
}
for (let index = 0; index < BELL_ARC.length; index += 1)
  BELL_ARC[index] = BELL_ARC[index]! / bellLength;

const bellRadiusAt = (v: number): number => {
  const clamped = THREE.MathUtils.clamp(v, 0, 1);
  let index = 1;
  while (index < BELL_ARC.length - 1 && BELL_ARC[index]! < clamped) index += 1;
  const span = BELL_ARC[index]! - BELL_ARC[index - 1]! || 1;
  const mix = (clamped - BELL_ARC[index - 1]!) / span;
  return THREE.MathUtils.lerp(BELL_PROFILE[index - 1]!.radius, BELL_PROFILE[index]!.radius, mix);
};

const makeSpots = (): ReadonlyArray<Spot> => {
  const random = ((): (() => number) => {
    let state = 0x2b17 >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  })();
  const spots: Array<Spot> = [];
  let attempts = 0;
  while (spots.length < 24 && attempts < 4000) {
    attempts += 1;
    const v = 0.12 + random() * 0.66;
    const u = random();
    const halfWidth = 0.08 + random() * 0.07;
    const halfHeight = halfWidth * (0.7 + random() * 0.35);
    if (v + halfHeight / bellLength > 0.94) continue;
    const circumference = Math.PI * 2 * Math.max(bellRadiusAt(v), 0.3);
    const clash = spots.some((spot) => {
      const du = Math.min(Math.abs(spot.u - u), 1 - Math.abs(spot.u - u));
      const dx = du * circumference;
      const dy = (spot.v - v) * bellLength;
      return (
        (dx / ((spot.halfWidth + halfWidth) * 1.12)) ** 2 +
          (dy / ((spot.halfHeight + halfHeight) * 1.12)) ** 2 <
        1
      );
    });
    if (clash) continue;
    spots.push({ u, v, halfWidth, halfHeight, rotation: (random() - 0.5) * 1.2 });
  }
  return spots;
};

export const createSpottedTexture = (): THREE.CanvasTexture => {
  const width = 2048;
  const height = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas is unavailable.");
  const image = context.createImageData(width, height);
  const lit = [0xd3, 0xdc, 0xe1];
  const shadow = [0xae, 0xbd, 0xc8];
  const rim = [0xdc, 0xe5, 0xe8];
  for (let row = 0; row < height; row += 1) {
    const v = 1 - row / (height - 1);
    const highlight =
      THREE.MathUtils.smoothstep(v, 0.36, 0.58) *
      (1 - 0.45 * THREE.MathUtils.smoothstep(v, 0.9, 1));
    const edge = THREE.MathUtils.smoothstep(v, 0.88, 1) * 0.65;
    for (let column = 0; column < width; column += 1) {
      const angle = (column / width) * Math.PI * 2;
      const front = THREE.MathUtils.smoothstep(Math.cos(angle + 0.22), 0.32, 0.98);
      const mix = front * highlight;
      const offset = (row * width + column) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const base = THREE.MathUtils.lerp(shadow[channel]!, lit[channel]!, mix);
        image.data[offset + channel] = Math.round(THREE.MathUtils.lerp(base, rim[channel]!, edge));
      }
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  context.fillStyle = "#ffffff";
  for (const spot of makeSpots()) {
    const circumference = Math.PI * 2 * Math.max(bellRadiusAt(spot.v), 0.3);
    const radiusX = (spot.halfWidth / circumference) * width;
    const radiusY = (spot.halfHeight / bellLength) * height;
    for (const shift of [-width, 0, width]) {
      context.save();
      context.translate(spot.u * width + shift, (1 - spot.v) * height);
      context.rotate(spot.rotation);
      context.beginPath();
      context.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
      context.fill();
      context.restore();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
};

const bellGeometry = (): THREE.BufferGeometry => {
  const columns = BELL_SEGMENTS + 1;
  const positions: Array<number> = [0, BELL_PROFILE[0]!.y, 0];
  const uvs: Array<number> = [0, 0];
  const indices: Array<number> = [];
  const step = (Math.PI * 2) / BELL_SEGMENTS;
  for (let ring = 1; ring < BELL_PROFILE.length; ring += 1) {
    const { y, radius } = BELL_PROFILE[ring]!;
    for (let column = 0; column < columns; column += 1) {
      const angle = (column % BELL_SEGMENTS) * step;
      positions.push(Math.sin(angle) * radius, y, Math.cos(angle) * radius);
      uvs.push(column / BELL_SEGMENTS, BELL_ARC[ring]!);
    }
  }
  for (let column = 0; column < BELL_SEGMENTS; column += 1) {
    indices.push(0, 1 + column, 2 + column);
  }
  for (let ring = 1; ring < BELL_PROFILE.length - 1; ring += 1) {
    const upper = 1 + (ring - 1) * columns;
    const lower = upper + columns;
    for (let column = 0; column < BELL_SEGMENTS; column += 1) {
      const a = upper + column;
      const b = a + 1;
      const c = lower + column;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

const lobeGeometry = (placement: LobePlacement): THREE.BufferGeometry => {
  const sides = LOBE_SECTION.length;
  const columns = sides + 1;
  const halfWidth = placement.width / 2;
  const halfDepth = placement.depth / 2;
  const positions: Array<number> = [0, placement.height / 2, 0];
  const colors: Array<number> = [0.9, 0.9, 0.9];
  const indices: Array<number> = [];
  for (const ring of LOBE_RINGS) {
    const sway = placement.lean * ring.t * ring.t;
    for (let column = 0; column < columns; column += 1) {
      const section = LOBE_SECTION[column % sides]!;
      positions.push(
        section.x * halfWidth * ring.scale + sway,
        placement.height * (0.5 - ring.t),
        section.z * halfDepth * ring.scale,
      );
      const shade = 0.87 + 0.13 * ((section.z + 0.9) / 1.94);
      colors.push(shade, shade, shade);
    }
  }
  const bottom = positions.length / 3;
  positions.push(placement.lean, -placement.height / 2 - 0.008 * placement.height, 0);
  colors.push(0.9, 0.9, 0.9);
  for (let column = 0; column < sides; column += 1) {
    indices.push(0, 1 + column, 2 + column);
  }
  for (let ring = 0; ring < LOBE_RINGS.length - 1; ring += 1) {
    const upper = 1 + ring * columns;
    const lower = upper + columns;
    for (let column = 0; column < sides; column += 1) {
      const a = upper + column;
      const b = a + 1;
      const c = lower + column;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const last = 1 + (LOBE_RINGS.length - 1) * columns;
  for (let column = 0; column < sides; column += 1) {
    indices.push(bottom, last + column + 1, last + column);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

const oralMassGeometry = (): THREE.BufferGeometry => {
  const sides = 8;
  const columns = sides + 1;
  const rings: ReadonlyArray<BellRing> = [
    { y: 0.3, radius: 0.2 },
    { y: 0.2, radius: 0.29 },
    { y: 0.08, radius: 0.33 },
    { y: -0.05, radius: 0.29 },
    { y: -0.16, radius: 0.2 },
  ];
  const positions: Array<number> = [0, rings[0]!.y, 0];
  const colors: Array<number> = [0.9, 0.9, 0.9];
  const indices: Array<number> = [];
  for (const ring of rings) {
    for (let column = 0; column < columns; column += 1) {
      const angle = ((column % sides) / sides) * Math.PI * 2;
      positions.push(Math.sin(angle) * ring.radius, ring.y, Math.cos(angle) * ring.radius * 0.62);
      colors.push(0.9, 0.9, 0.9);
    }
  }
  for (let column = 0; column < sides; column += 1) {
    indices.push(0, 1 + column, 2 + column);
  }
  for (let ring = 0; ring < rings.length - 1; ring += 1) {
    const upper = 1 + ring * columns;
    const lower = upper + columns;
    for (let column = 0; column < sides; column += 1) {
      const a = upper + column;
      const b = a + 1;
      const c = lower + column;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, rings[rings.length - 1]!.y, 0);
  const last = 1 + (rings.length - 1) * columns;
  for (let column = 0; column < sides; column += 1) {
    indices.push(bottom, last + column + 1, last + column);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

const tipGeometry = (): THREE.BufferGeometry => {
  const columns = TIP_SEGMENTS + 1;
  const positions: Array<number> = [0, TIP_RINGS[0]!.y + 0.002, 0];
  const indices: Array<number> = [];
  for (const ring of TIP_RINGS) {
    for (let column = 0; column < columns; column += 1) {
      const angle = ((column % TIP_SEGMENTS) / TIP_SEGMENTS) * Math.PI * 2;
      positions.push(Math.sin(angle) * ring.radius, ring.y, Math.cos(angle) * ring.radius);
    }
  }
  for (let column = 0; column < TIP_SEGMENTS; column += 1) {
    indices.push(0, 1 + column, 2 + column);
  }
  for (let ring = 0; ring < TIP_RINGS.length - 1; ring += 1) {
    const upper = 1 + ring * columns;
    const lower = upper + columns;
    for (let column = 0; column < TIP_SEGMENTS; column += 1) {
      const a = upper + column;
      const b = a + 1;
      const c = lower + column;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const bottom = positions.length / 3;
  positions.push(0, TIP_RINGS[TIP_RINGS.length - 1]!.y - 0.02, 0);
  const last = 1 + (TIP_RINGS.length - 1) * columns;
  for (let column = 0; column < TIP_SEGMENTS; column += 1) {
    indices.push(bottom, last + column + 1, last + column);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
};

export const createWhiteSpotted = (bucket: number, spotMap: THREE.Texture): StudySpecies => {
  const bellMaterial = createSpeciesMaterial({
    color: 0xffffff,
    map: spotMap,
    vertexColors: false,
    emissive: 0x8498a4,
    emissiveIntensity: 0.1,
    flatShading: true,
    opacity: 0.76,
  });
  const creamMaterial = createSpeciesMaterial({
    color: 0xf7ead9,
    vertexColors: true,
    emissive: 0x9a7f63,
    emissiveIntensity: 0.1,
    flatShading: true,
    opacity: 1,
  });
  const tanMaterial = createSpeciesMaterial({
    color: 0xd8a06c,
    vertexColors: false,
    emissive: 0x4a3320,
    emissiveIntensity: 0.08,
    flatShading: true,
    opacity: 1,
  });

  const bell = bellGeometry();
  const mass = oralMassGeometry();
  const lobes = LOBE_PLACEMENTS.map((placement) => lobeGeometry(placement));
  const tip = tipGeometry();

  const parts: ReadonlyArray<SpeciesPart> = [
    { geometry: mass, material: creamMaterial },
    ...lobes.map((geometry) => ({ geometry, material: creamMaterial })),
    ...LOBE_PLACEMENTS.map(() => ({ geometry: tip, material: tanMaterial })),
    { geometry: bell, material: bellMaterial },
  ];

  const oral = new THREE.Matrix4();
  const scratch = new THREE.Matrix4();

  const writeLobe = (out: ReadonlyArray<THREE.Matrix4>, index: number, seconds: number): void => {
    const placement = LOBE_PLACEMENTS[index]!;
    const wave = Math.sin((seconds / PERIOD) * Math.PI * 2);
    const lag = Math.sin(((seconds - 0.18) / PERIOD) * Math.PI * 2 + index * 0.7);
    out[1 + index]!.copy(oral.makeTranslation(0.07, ORAL_Y + wave * 0.012, 0.02))
      .multiply(scratch.makeTranslation(placement.x, placement.y, placement.z))
      .multiply(scratch.makeRotationX(lag * 0.012))
      .multiply(scratch.makeRotationY(placement.yaw));
  };

  const writeTip = (out: ReadonlyArray<THREE.Matrix4>, index: number): void => {
    const placement = LOBE_PLACEMENTS[index]!;
    out[5 + index]!.copy(out[1 + index]!)
      .multiply(scratch.makeTranslation(placement.lean, -placement.height / 2 - 0.05, 0))
      .multiply(scratch.makeRotationY(-placement.yaw));
  };

  return {
    bucket,
    parts,
    textures: [spotMap],
    period: PERIOD,
    bellPart: 9,
    restPose: (out) => {
      out[0]!.makeTranslation(0.07, ORAL_Y, 0.02);
      for (let index = 0; index < LOBE_PLACEMENTS.length; index += 1) {
        const placement = LOBE_PLACEMENTS[index]!;
        out[1 + index]!.makeTranslation(0.07, ORAL_Y, 0.02)
          .multiply(scratch.makeTranslation(placement.x, placement.y, placement.z))
          .multiply(scratch.makeRotationY(placement.yaw));
      }
      for (let index = 0; index < LOBE_PLACEMENTS.length; index += 1) {
        const placement = LOBE_PLACEMENTS[index]!;
        out[5 + index]!.copy(out[1 + index]!)
          .multiply(scratch.makeTranslation(placement.lean, -placement.height / 2 - 0.05, 0))
          .multiply(scratch.makeRotationY(-placement.yaw));
      }
      out[9]!.makeScale(1, 1, 1);
    },
    pose: (seconds, out) => {
      const wave = Math.sin((seconds / PERIOD) * Math.PI * 2);
      out[0]!.makeTranslation(0.07, ORAL_Y + wave * 0.012, 0.02);
      for (let index = 0; index < LOBE_PLACEMENTS.length; index += 1) {
        writeLobe(out, index, seconds);
      }
      for (let index = 0; index < LOBE_PLACEMENTS.length; index += 1) {
        writeTip(out, index);
      }
      out[9]!.makeScale(1 + wave * 0.012, 1 - wave * 0.02, 1 + wave * 0.012);
    },
  };
};
