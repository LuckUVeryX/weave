import * as THREE from "three/webgpu";

import { ORBIT_SECONDS, TAU } from "./constants.ts";

const FLOW = {
  referenceOrbitSeconds: 168,
  reversalSeconds: 2.8,
  vorticitySampleDistance: 0.14,
  coreSpeedFraction: 0.68,
  shoulderSpeedFraction: 0.32,
  shoulderStartRadiusFraction: 0.1,
  shoulderEndRadiusFraction: 0.5,
  rimSlowdown: 0.42,
  rimStartRadiusFraction: 0.78,
  wallMargin: 0.6,
  wallDamping: 0.35,
};
const EDDY = {
  amplitude: 0.04,
  xPhaseRadians: 0.4,
  yPhaseRadians: 1.7,
  zPhaseRadians: 0.9,
  xRadiansPerSecond: 0.017,
  yRadiansPerSecond: 0.013,
  zRadiansPerSecond: 0.011,
  xRadiansPerUnit: 0.62,
  yRadiansPerUnit: 0.57,
  zRadiansPerUnit: 0.73,
};
const RADIAL_BREATH = {
  speed: 0.008,
  lobes: 2,
  radiansPerSecond: 0.07,
  depthRadiansPerUnit: 0.35,
  coreFraction: 0.4,
  rimFraction: 0.6,
};
const DEPTH_DRIFT = {
  speed: 0.007,
  radiansPerSecond: 0.09,
  xRadiansPerUnit: 0.45,
  yRadiansPerUnit: 0.32,
  rimSlowdown: 0.5,
  rimStartRadiusFraction: 0.8,
};

export interface WallAt {
  (
    x: number,
    y: number,
    z: number,
    radialReach: number,
    depthReach: number,
    out: WallProbe,
  ): WallProbe;
}

export interface WallProbe {
  signed: number;
  nx: number;
  ny: number;
  nz: number;
}

export class Water {
  readonly radius: number;
  readonly halfDepth: number;
  readonly omega0: number;
  readonly flowScale: number;
  time = 0;
  flow = -1;
  target = -1;
  readonly kreisel: {
    readonly radius: number;
    readonly halfDepth: number;
    readonly wallAt: WallAt;
  };
  private readonly probe: WallProbe = { signed: 0, nx: 0, ny: 0, nz: 0 };
  private readonly bulk: THREE.Vector3 = new THREE.Vector3();
  private readonly perturbation: THREE.Vector3 = new THREE.Vector3();
  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly v4 = new THREE.Vector3();
  private readonly v5 = new THREE.Vector3();
  private readonly v6 = new THREE.Vector3();

  constructor(kreisel: {
    readonly radius: number;
    readonly halfDepth: number;
    readonly wallAt: WallAt;
  }) {
    this.kreisel = kreisel;
    this.radius = kreisel.radius;
    this.halfDepth = kreisel.halfDepth;
    this.omega0 = TAU / ORBIT_SECONDS;
    this.flowScale = FLOW.referenceOrbitSeconds / ORBIT_SECONDS;
  }

  vorticityAt(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const h = FLOW.vorticitySampleDistance;
    this.velocityAt(x, y + h, z, this.v1);
    this.velocityAt(x, y - h, z, this.v2);
    this.velocityAt(x, y, z + h, this.v3);
    this.velocityAt(x, y, z - h, this.v4);
    this.velocityAt(x + h, y, z, this.v5);
    this.velocityAt(x - h, y, z, this.v6);
    out.set(
      (this.v1.z - this.v2.z) / (2 * h) - (this.v3.y - this.v4.y) / (2 * h),
      (this.v3.x - this.v4.x) / (2 * h) - (this.v5.z - this.v6.z) / (2 * h),
      (this.v5.y - this.v6.y) / (2 * h) - (this.v1.x - this.v2.x) / (2 * h),
    );
    return out;
  }

  setFlow(name: "cw" | "ccw"): void {
    this.target = name === "ccw" ? 1 : -1;
  }

  advance(dt: number): void {
    this.time += dt;
    const ease = 1 - Math.exp(-dt / FLOW.reversalSeconds);
    this.flow += (this.target - this.flow) * ease;
    if (Math.abs(this.target - this.flow) < 1e-5) this.flow = this.target;
  }

  velocityAt(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    this.sample(x, y, z);
    out.copy(this.bulk).add(this.perturbation);
    return out;
  }

  splitAt(x: number, y: number, z: number, bulk: THREE.Vector3, perturbation: THREE.Vector3): void {
    this.sample(x, y, z);
    bulk.copy(this.bulk);
    perturbation.copy(this.perturbation);
  }

  private sample(x: number, y: number, z: number): void {
    const r = Math.hypot(x, y);
    const inv = r > 1e-5 ? 1 / r : 0;
    const tx = -y * inv;
    const ty = x * inv;
    const rr = r / this.radius;

    const profile =
      (FLOW.coreSpeedFraction +
        FLOW.shoulderSpeedFraction *
          smoothstep(FLOW.shoulderStartRadiusFraction, FLOW.shoulderEndRadiusFraction, rr)) *
      (1 - FLOW.rimSlowdown * smoothstep(FLOW.rimStartRadiusFraction, 1.0, rr));
    const speed = this.omega0 * this.flow * profile * r;

    let vx = tx * speed;
    let vy = ty * speed;

    const amp = EDDY.amplitude * this.flowScale * this.flow * profile;
    const p1 = EDDY.xPhaseRadians + this.time * EDDY.xRadiansPerSecond;
    const p2 = EDDY.yPhaseRadians - this.time * EDDY.yRadiansPerSecond;
    const p3 = EDDY.zPhaseRadians + this.time * EDDY.zRadiansPerSecond;
    const sx = Math.sin(EDDY.xRadiansPerUnit * x + p1);
    const cx = Math.cos(EDDY.xRadiansPerUnit * x + p1);
    const sy = Math.sin(EDDY.yRadiansPerUnit * y + p2);
    const cy = Math.cos(EDDY.yRadiansPerUnit * y + p2);
    const cz = Math.cos(EDDY.zRadiansPerUnit * z + p3);
    vx += amp * sx * cy * EDDY.yRadiansPerUnit * cz;
    vy += -amp * cx * EDDY.xRadiansPerUnit * sy * cz;

    const angle = Math.atan2(y, x);
    const breathScale =
      RADIAL_BREATH.speed *
      this.flowScale *
      Math.sin(
        RADIAL_BREATH.lobes * angle -
          this.time * RADIAL_BREATH.radiansPerSecond +
          z * RADIAL_BREATH.depthRadiansPerUnit,
      ) *
      (RADIAL_BREATH.coreFraction + RADIAL_BREATH.rimFraction * rr);
    vx += x * inv * breathScale;
    vy += y * inv * breathScale;

    let vz =
      DEPTH_DRIFT.speed *
      this.flowScale *
      Math.sin(
        this.time * DEPTH_DRIFT.radiansPerSecond +
          x * DEPTH_DRIFT.xRadiansPerUnit +
          y * DEPTH_DRIFT.yRadiansPerUnit,
      ) *
      (1 - DEPTH_DRIFT.rimSlowdown * smoothstep(DEPTH_DRIFT.rimStartRadiusFraction, 1, rr));

    const wall = this.kreisel.wallAt(x, y, z, 0, 0, this.probe);
    let damp = 1;
    if (wall.signed < FLOW.wallMargin) {
      const k = 1 - smoothstep(0, FLOW.wallMargin, Math.max(0, wall.signed));
      const outward = vx * wall.nx + vy * wall.ny + vz * wall.nz;
      if (outward > 0) {
        vx -= wall.nx * outward;
        vy -= wall.ny * outward;
        vz -= wall.nz * outward;
      }
      damp = 1 - FLOW.wallDamping * k;
    }

    const tangential = speed * damp;
    this.bulk.set(tx * tangential, ty * tangential, 0);
    vx -= tx * speed;
    vy -= ty * speed;
    this.perturbation.set(vx * damp, vy * damp, vz * damp);
  }
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
