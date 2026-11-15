import * as THREE from "three/webgpu";

import { beat } from "./bell.ts";
import { BEAT_SECONDS, SPECIMEN_LAYER, TANK, TAU } from "./constants.ts";
import {
  EXTENT,
  PHASE_BUCKETS,
  attachInstances,
  createInstanceAttributes,
  createPhaseGeometry,
  detailFor,
  disposePhase,
  linkPhaseMorph,
} from "./geometry.ts";
import type { Extent, InstanceAttributes, JellyDetail, PhaseGeometry } from "./geometry.ts";
import { createJellyMaterials, disposeMaterials } from "./materials.ts";
import type { JellyMaterials } from "./materials.ts";
import { diffModel, scaleFactor } from "./model.ts";
import type { CreatureModel, HabitatModel, JellySpecies } from "./model.ts";
import { CELL_COUNT, assetFor, createSpeciesAssets } from "./species/index.ts";
import type { SpeciesAssets } from "./species/index.ts";
import type { Water } from "./water.ts";
import type { SessionView } from "../../shared/session.ts";
const ARRIVE_SECONDS = 2.4;
const DEPART_SECONDS = 2.4;
const INITIAL_FADE_SECONDS = 0.9;
const REDUCED_SECONDS = 0.25;
const MIN_INSTANCE_CAPACITY = 64;
const RESPONSE_SECONDS = { size: 1.1, status: 1.4, heading: 600, velocity: 5 };
const ORIENTATION = {
  rollRadians: 0.32,
  tumbleRadiansPerSecond: 0.014,
  tumbleVariationRadiansPerSecond: 0.01,
  secondaryTumbleRadiansPerSecond: 0.0048,
  secondaryTumbleVariationRadiansPerSecond: 0.0048,
  rollRadiansPerSecond: 0.018,
  rollVariationRadiansPerSecond: 0.022,
  vorticityCoupling: 0.5,
  maxVorticityRadiansPerSecond: 0.018,
};
const PLACEMENT = {
  minRadius: 0.2,
  radialMargin: 0.4,
  minDepth: 0.1,
  depthMargin: 0.25,
  arrivalRadiusFractionMin: 0.08,
  arrivalRadiusFractionRange: 0.84,
  goldenAngleRadians: 2.39996323,
  angleJitterRadians: 0.9,
  depthFraction: 0.9,
};
const DRIFT = {
  xSpeed: 0.005,
  xRadiansPerSecond: 0.13,
  xSeedRadians: 9.1,
  zSpeed: 0.004,
  zRadiansPerSecond: 0.11,
  zSeedRadians: 6.2,
};
const WALL = { inwardAcceleration: 1.1, dampingPerSecond: 1.8 };
const PRESENCE = { scaleMin: 0.86, scaleRange: 0.14 };
const ACTIVITY = {
  scaleAmplitude: 0.018,
  radiansPerSecond: 1.7,
  energyMin: 0.85,
  energyAmplitude: 0.15,
};
const PARENT_EMPHASIS = 0.38;
const ZERO_MATRIX = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
const PULSE_THRUST = 0.0042;

const UP = new THREE.Vector3(0, 1, 0);
const scratch = new THREE.Vector3();
const bulk = new THREE.Vector3();
const perturbation = new THREE.Vector3();
const scratchQuaternion = new THREE.Quaternion();
const scratchMatrix = new THREE.Matrix4();
const scratchScale = new THREE.Vector3();

interface Body {
  readonly key: string;
  model: CreatureModel;
  readonly position: THREE.Vector3;
  readonly velocity: THREE.Vector3;
  readonly axis: THREE.Vector3;
  readonly baseQuaternion: THREE.Quaternion;
  readonly homeQuaternion: THREE.Quaternion;
  readonly quaternion: THREE.Quaternion;
  readonly tumbleAxis: THREE.Vector3;
  readonly tumbleAxisB: THREE.Vector3;
  readonly tumbleRate: number;
  readonly tumbleRateB: number;
  readonly rollPhase: number;
  readonly rollRate: number;
  turns: number;
  time: number;
  size: number;
  sizeTarget: number;
  presence: number;
  present: boolean;
  presenceRate: number;
  energy: number;
  warm: number;
  reachRadial: number;
  reachDepth: number;
  bucket: number;
  slot: number;
}

export interface SchoolStats {
  readonly creatures: number;
  readonly present: number;
  readonly departing: number;
  readonly capacity: number;
  readonly buckets: ReadonlyArray<number>;
  readonly renderCounts: ReadonlyArray<number>;
  readonly detail: JellyDetail;
  readonly meshes: number;
  /** CPU-side instance bytes held by the per-cell attribute arrays. */
  readonly instanceBytes: number;
}

interface PhaseSlot {
  bucket: number;
  influence: number;
}

const phaseSlot = (turns: number, out: PhaseSlot): PhaseSlot => {
  const phase = turns - Math.floor(turns);
  const scaled = phase * PHASE_BUCKETS;
  out.bucket = Math.min(PHASE_BUCKETS - 1, Math.floor(scaled));
  out.influence = scaled - out.bucket;
  return out;
};

export class School {
  readonly scene: THREE.Scene;
  private readonly water: Water;
  private readonly materials: JellyMaterials;
  private readonly reduced: boolean;
  private readonly probe = { signed: 0, nx: 0, ny: 0, nz: 0 };
  private readonly bodies = new Map<string, Body>();
  private readonly phase: PhaseSlot = { bucket: 0, influence: 0 };
  private buckets: Array<InstanceAttributes>;
  private order: Array<Array<Body | undefined>>;
  private matrices: Array<Array<Float32Array>>;
  private morphData: Array<Float32Array>;
  private morphTextures: Array<THREE.DataTexture>;
  private partMeshes: Array<Array<THREE.InstancedMesh>>;
  private partAttributes: Array<Array<THREE.InstancedBufferAttribute>>;
  private phaseGeometry: Array<PhaseGeometry> = [];
  private readonly counts = Array.from({ length: CELL_COUNT }, () => 0);
  private readonly renderCounts = Array.from({ length: CELL_COUNT }, () => 0);
  private readonly assets: SpeciesAssets;
  private readonly pose: Array<THREE.Matrix4>;
  private readonly partMatrix = new THREE.Matrix4();
  private detail: JellyDetail;
  private capacity: number;
  private slots: number;
  private first = true;
  private stale = true;
  private selectedKey: string | undefined;
  private selectedBucket = -1;

  setSelection(key: string | undefined): void {
    this.selectedKey = key;
    this.stale = true;
  }

  constructor({
    scene,
    water,
    capacity,
    detail,
    reduced,
    clover,
    spotted,
  }: {
    readonly scene: THREE.Scene;
    readonly water: Water;
    readonly capacity: number;
    readonly detail: JellyDetail;
    readonly reduced: boolean;
    readonly clover: THREE.Texture;
    readonly spotted: THREE.Texture;
  }) {
    this.scene = scene;
    this.water = water;
    this.reduced = reduced;
    this.detail = detail;
    this.capacity = capacity;
    this.slots = capacity + 1;
    this.buckets = Array.from({ length: CELL_COUNT }, () => createInstanceAttributes(this.slots));
    this.order = this.makeOrder(this.slots);
    this.matrices = [];
    this.morphData = [];
    this.morphTextures = [];
    this.partMeshes = [];
    this.partAttributes = [];
    this.materials = createJellyMaterials(clover);
    this.assets = createSpeciesAssets(spotted);
    this.pose = Array.from(
      { length: Math.max(...this.assets.list.map((asset) => asset.parts.length)) },
      () => new THREE.Matrix4(),
    );
    this.build(detail);
  }

  private makeOrder(slots: number): Array<Array<Body | undefined>> {
    return Array.from({ length: CELL_COUNT }, () =>
      Array.from<Body | undefined>({ length: slots }),
    );
  }

  private build(detail: JellyDetail): void {
    this.partMeshes = Array.from({ length: CELL_COUNT }, () => []);
    this.partAttributes = Array.from({ length: CELL_COUNT }, () => []);
    this.matrices = Array.from({ length: CELL_COUNT }, () => []);

    for (let bucket = 0; bucket < PHASE_BUCKETS; bucket += 1) {
      const instances = this.buckets[bucket]!;
      const phase = createPhaseGeometry(detail, bucket / PHASE_BUCKETS, instances);
      this.phaseGeometry.push(phase);

      const data = new Float32Array(this.slots * 2);
      for (let row = 0; row < this.slots; row += 1) data[row * 2] = 1;
      const morph = new THREE.DataTexture(data, 2, this.slots, THREE.RedFormat, THREE.FloatType);
      morph.minFilter = THREE.NearestFilter;
      morph.magFilter = THREE.NearestFilter;
      morph.generateMipmaps = false;
      morph.needsUpdate = true;
      this.morphData.push(data);
      this.morphTextures.push(morph);

      const parts: ReadonlyArray<[THREE.BufferGeometry, THREE.Material]> = [
        [phase.arms, this.materials.arm],
        [phase.bell, this.materials.bell],
      ];
      for (let index = 0; index < parts.length; index += 1) {
        const [geometry, material] = parts[index]!;
        this.addMesh(bucket, geometry, material, index, morph);
      }
      this.collectAttributes(
        bucket,
        parts.map(([geometry]) => geometry),
      );
      this.matrices[bucket] = parts.map(() => new Float32Array(this.slots * 16));
    }

    for (const asset of this.assets.list) {
      const instances = this.buckets[asset.bucket]!;
      for (const geometry of new Set(asset.parts.map((part) => part.geometry))) {
        attachInstances(geometry, instances);
      }
      for (let index = 0; index < asset.parts.length; index += 1) {
        const part = asset.parts[index]!;
        this.addMesh(asset.bucket, part.geometry, part.material, index, null);
      }
      this.collectAttributes(
        asset.bucket,
        asset.parts.map((part) => part.geometry),
      );
      this.matrices[asset.bucket] = asset.parts.map(() => new Float32Array(this.slots * 16));
    }

    for (let bucket = 0; bucket < PHASE_BUCKETS; bucket += 1) {
      linkPhaseMorph(
        this.phaseGeometry[bucket]!,
        this.phaseGeometry[(bucket + 1) % PHASE_BUCKETS]!,
      );
    }
  }

  private addMesh(
    bucket: number,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    index: number,
    morph: THREE.DataTexture | null,
  ): void {
    const mesh = new THREE.InstancedMesh(geometry, material, this.slots);
    mesh.count = 0;
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = index + 1;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.morphTexture = morph;
    this.scene.add(mesh);
    this.partMeshes[bucket]!.push(mesh);
  }

  private collectAttributes(bucket: number, geometries: ReadonlyArray<THREE.BufferGeometry>): void {
    const seen = new Set<THREE.BufferGeometry>();
    for (const geometry of geometries) {
      if (seen.has(geometry)) continue;
      seen.add(geometry);
      for (const name of ["fade", "energy", "warm", "emphasis"]) {
        const attribute = geometry.getAttribute(name);
        if (attribute instanceof THREE.InstancedBufferAttribute) {
          this.partAttributes[bucket]!.push(attribute);
        }
      }
    }
  }

  private teardownGeometry(): void {
    for (const phase of this.phaseGeometry) disposePhase(phase);
    this.phaseGeometry = [];
    for (let bucket = PHASE_BUCKETS; bucket < CELL_COUNT; bucket += 1) {
      for (const attribute of this.partAttributes[bucket]!) attribute.dispose();
    }
    for (const bucket of this.partMeshes) {
      for (const mesh of bucket) {
        mesh.morphTexture = null;
        this.scene.remove(mesh);
        mesh.dispose();
      }
    }
    for (const texture of this.morphTextures) texture.dispose();
    this.morphTextures = [];
    this.morphData = [];
    this.matrices = [];
    this.partMeshes = [];
    this.partAttributes = [];
  }

  private resize(capacity: number, detail: JellyDetail): void {
    if (capacity === this.capacity && sameDetail(this.detail, detail)) return;
    this.teardownGeometry();
    this.capacity = capacity;
    this.slots = capacity + 1;
    this.detail = detail;
    this.buckets = Array.from({ length: CELL_COUNT }, () => createInstanceAttributes(this.slots));
    this.order = this.makeOrder(this.slots);
    this.selectedBucket = -1;
    this.build(detail);
  }

  applyModel(model: HabitatModel): void {
    const previous = new Map<string, CreatureModel>();
    for (const [key, body] of this.bodies) previous.set(key, body.model);

    const needed = Math.max(1, model.creatures.length);
    const capacity = Math.max(MIN_INSTANCE_CAPACITY, 2 ** Math.ceil(Math.log2(needed)));
    this.resize(capacity, detailFor(model.creatures.length));

    const diff = diffModel(previous, model);
    const first = this.first;
    this.first = false;

    const total = model.creatures.length;
    const spread = first || this.bodies.size === 0;
    const added = spread
      ? [...diff.added].sort((left, right) => {
          const priority = placementPriority(left.key) - placementPriority(right.key);
          return priority || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
        })
      : diff.added;
    for (const creature of added) {
      this.bodies.set(
        creature.key,
        this.createBody(creature, model.densityScale, first, spread, this.bodies.size, total),
      );
    }

    for (const creature of diff.retained) {
      const body = this.bodies.get(creature.key);
      if (body === undefined) continue;
      body.model = creature;
      body.present = true;
      body.sizeTarget = model.densityScale * scaleFactor(creature);
      if (body.presence < 1) {
        body.presenceRate = 1 / (this.reduced ? REDUCED_SECONDS : ARRIVE_SECONDS);
      }
    }

    for (const key of diff.removed) {
      const body = this.bodies.get(key);
      if (body === undefined) continue;
      body.present = false;
      body.presenceRate = 1 / (this.reduced ? REDUCED_SECONDS : DEPART_SECONDS);
    }
    this.stale = true;
  }

  private createBody(
    creature: CreatureModel,
    densityScale: number,
    first: boolean,
    spread: boolean,
    index: number,
    total: number,
  ): Body {
    const random = mulberry32(fnv1a(creature.key));
    const size = densityScale * scaleFactor(creature);
    const mouth = sampleMouth(random);
    const axis = mouth.clone().multiplyScalar(-1).normalize();
    const baseQuaternion = new THREE.Quaternion();
    if (axis.y < -0.99999) {
      baseQuaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    } else {
      baseQuaternion.setFromUnitVectors(UP, axis);
    }
    const roll = ORIENTATION.rollRadians * Math.sin(creature.seed * TAU);
    const extent = this.extentFor(creature.species);
    const position = this.place(creature, size, random, spread, index, total, extent);

    const body: Body = {
      key: creature.key,
      model: creature,
      position,
      velocity: new THREE.Vector3(),
      axis,
      baseQuaternion,
      homeQuaternion: baseQuaternion.clone(),
      quaternion: baseQuaternion.clone().multiply(scratchQuaternion.setFromAxisAngle(UP, roll)),
      tumbleAxis: randomUnit(random),
      tumbleAxisB: randomUnit(random),
      tumbleRate:
        (ORIENTATION.tumbleRadiansPerSecond +
          random() * ORIENTATION.tumbleVariationRadiansPerSecond) *
        (random() < 0.5 ? 1 : -1),
      tumbleRateB:
        (ORIENTATION.secondaryTumbleRadiansPerSecond +
          random() * ORIENTATION.secondaryTumbleVariationRadiansPerSecond) *
        (random() < 0.5 ? 1 : -1),
      rollPhase: creature.seed * TAU,
      rollRate:
        ORIENTATION.rollRadiansPerSecond +
        creature.seed * ORIENTATION.rollVariationRadiansPerSecond,
      turns: random(),
      time: 0,
      size,
      sizeTarget: size,
      presence: 0,
      present: true,
      presenceRate:
        1 / (this.reduced ? REDUCED_SECONDS : first ? INITIAL_FADE_SECONDS : ARRIVE_SECONDS),
      energy: creature.session.status === "running" ? 1 : 0,
      warm: warmthOf(creature.session.attention),
      reachRadial: 0,
      reachDepth: 0,
      bucket: 0,
      slot: -1,
    };
    this.water.splitAt(position.x, position.y, position.z, bulk, perturbation);
    body.velocity.copy(perturbation);
    this.measureReach(body, extent);
    return body;
  }

  private place(
    creature: CreatureModel,
    size: number,
    random: () => number,
    spread: boolean,
    index: number,
    total: number,
    extent: Extent,
  ): THREE.Vector3 {
    const reach = extent.radius * size;
    const depthReach = extent.up * size;
    const radiusLimit = Math.max(
      PLACEMENT.minRadius,
      TANK.aperture - reach - PLACEMENT.radialMargin,
    );
    const depthLimit = Math.max(
      PLACEMENT.minDepth,
      TANK.halfDepth - depthReach - PLACEMENT.depthMargin,
    );
    const fraction = spread
      ? (index + 0.5) / Math.max(1, total)
      : PLACEMENT.arrivalRadiusFractionMin +
        PLACEMENT.arrivalRadiusFractionRange * placementPriority(creature.key);
    const radius = radiusLimit * Math.sqrt(fraction);
    const angle =
      index * PLACEMENT.goldenAngleRadians + (creature.seed - 0.5) * PLACEMENT.angleJitterRadians;
    const position = new THREE.Vector3(
      Math.cos(angle) * radius,
      Math.sin(angle) * radius,
      (random() * 2 - 1) * depthLimit * PLACEMENT.depthFraction,
    );
    this.clampInside(position, reach, depthReach);
    return position;
  }

  private clampInside(position: THREE.Vector3, reach: number, depthReach: number): void {
    const wall = this.water.kreisel.wallAt(
      position.x,
      position.y,
      position.z,
      reach,
      depthReach,
      this.probe,
    );
    if (wall.signed < 0) {
      position.x += wall.nx * wall.signed;
      position.y += wall.ny * wall.signed;
      position.z += wall.nz * wall.signed;
    }
  }

  private measureReach(body: Body, extent: Extent): void {
    scratch.set(body.position.x, body.position.y, 0);
    if (scratch.lengthSq() < 1e-8) scratch.set(1, 0, 0);
    else scratch.normalize();
    body.reachRadial = support(extent, body.axis, scratch, body.size);
    scratch.set(0, 0, 1);
    body.reachDepth = support(extent, body.axis, scratch, body.size);
  }

  private extentFor(species: JellySpecies): Extent {
    const asset = assetFor(this.assets, species);
    return asset === undefined ? EXTENT : asset.extent;
  }

  advance(dt: number): void {
    for (const body of this.bodies.values()) {
      if (!body.present && body.presence <= 0) {
        this.bodies.delete(body.key);
        continue;
      }

      const target = body.present ? 1 : 0;
      const delta = body.presenceRate * dt;
      body.presence =
        target > body.presence
          ? Math.min(1, body.presence + delta)
          : Math.max(0, body.presence - delta);
      body.size += (body.sizeTarget - body.size) * (1 - Math.exp(-dt / RESPONSE_SECONDS.size));
      body.energy +=
        ((body.model.session.status === "running" ? 1 : 0) - body.energy) *
        (1 - Math.exp(-dt / RESPONSE_SECONDS.status));
      const warmth = warmthOf(body.model.session.attention);
      body.warm += (warmth - body.warm) * (1 - Math.exp(-dt / RESPONSE_SECONDS.status));

      body.time += dt;
      body.turns += dt / BEAT_SECONDS;
      this.water.vorticityAt(body.position.x, body.position.y, body.position.z, scratch);
      const spin = scratch.length();
      if (spin > 1e-5) {
        scratch.multiplyScalar(1 / spin);
        const angle =
          Math.min(spin * ORIENTATION.vorticityCoupling, ORIENTATION.maxVorticityRadiansPerSecond) *
          dt;
        body.baseQuaternion.premultiply(scratchQuaternion.setFromAxisAngle(scratch, angle));
      }
      body.baseQuaternion.premultiply(
        scratchQuaternion.setFromAxisAngle(body.tumbleAxis, body.tumbleRate * dt),
      );
      body.baseQuaternion.premultiply(
        scratchQuaternion.setFromAxisAngle(body.tumbleAxisB, body.tumbleRateB * dt),
      );
      body.baseQuaternion
        .slerp(body.homeQuaternion, 1 - Math.exp(-dt / RESPONSE_SECONDS.heading))
        .normalize();
      body.axis.set(0, 1, 0).applyQuaternion(body.baseQuaternion).normalize();
      const roll = ORIENTATION.rollRadians * Math.sin(body.time * body.rollRate + body.rollPhase);
      body.quaternion
        .copy(body.baseQuaternion)
        .multiply(scratchQuaternion.setFromAxisAngle(UP, roll));

      this.water.splitAt(body.position.x, body.position.y, body.position.z, bulk, perturbation);
      const radiusSquared = body.position.x ** 2 + body.position.y ** 2;
      const bulkTurn =
        radiusSquared > 1e-8
          ? ((body.position.x * bulk.y - body.position.y * bulk.x) / radiusSquared) * dt
          : 0;
      const cos = Math.cos(bulkTurn);
      const sin = Math.sin(bulkTurn);
      const x = body.position.x;
      const y = body.position.y;
      body.position.x = x * cos - y * sin;
      body.position.y = x * sin + y * cos;

      perturbation.addScaledVector(body.axis, PULSE_THRUST * beat(body.turns));
      perturbation.x +=
        DRIFT.xSpeed *
        Math.sin(body.time * DRIFT.xRadiansPerSecond + body.model.seed * DRIFT.xSeedRadians);
      perturbation.z +=
        DRIFT.zSpeed *
        Math.cos(body.time * DRIFT.zRadiansPerSecond + body.model.seed * DRIFT.zSeedRadians);
      body.velocity.lerp(perturbation, 1 - Math.exp(-dt / RESPONSE_SECONDS.velocity));
      body.position.addScaledVector(body.velocity, dt);
    }

    for (const body of this.bodies.values()) {
      const extent = this.extentFor(body.model.species);
      this.measureReach(body, extent);
      const wall = this.water.kreisel.wallAt(
        body.position.x,
        body.position.y,
        body.position.z,
        body.reachRadial,
        body.reachDepth,
        this.probe,
      );
      if (wall.signed < TANK.softMargin) {
        const press = 1 - Math.max(0, wall.signed) / TANK.softMargin;
        const inward = WALL.inwardAcceleration * press * press;
        body.velocity.x -= wall.nx * inward * dt;
        body.velocity.y -= wall.ny * inward * dt;
        body.velocity.z -= wall.nz * inward * dt;
        const outward =
          body.velocity.x * wall.nx + body.velocity.y * wall.ny + body.velocity.z * wall.nz;
        if (outward > 0) {
          const loss = 1 - Math.exp(-dt * WALL.dampingPerSecond);
          body.velocity.x -= wall.nx * outward * loss;
          body.velocity.y -= wall.ny * outward * loss;
          body.velocity.z -= wall.nz * outward * loss;
        }
      }
      if (wall.signed < 0) {
        body.position.x += wall.nx * wall.signed;
        body.position.y += wall.ny * wall.signed;
        body.position.z += wall.nz * wall.signed;
        const outward =
          body.velocity.x * wall.nx + body.velocity.y * wall.ny + body.velocity.z * wall.nz;
        if (outward > 0) {
          body.velocity.x -= wall.nx * outward;
          body.velocity.y -= wall.ny * outward;
          body.velocity.z -= wall.nz * outward;
        }
        this.measureReach(body, extent);
      }
    }

    this.stale = true;
  }

  syncInstances(): void {
    if (!this.stale) return;
    this.stale = false;
    this.writeInstances();
  }

  private writeInstances(): void {
    const selected = this.selectedKey === undefined ? undefined : this.bodies.get(this.selectedKey);
    const parentKey = selected?.present === true ? selected.model.parentKey : undefined;
    this.counts.fill(0);
    for (const bucket of this.order) bucket.fill(undefined);

    for (const body of this.bodies.values()) {
      const asset = assetFor(this.assets, body.model.species);
      let bucket: number;
      let influence = 0;
      if (asset === undefined) {
        const phase = phaseSlot(body.turns, this.phase);
        bucket = phase.bucket;
        influence = phase.influence;
      } else {
        bucket = asset.bucket;
      }
      body.bucket = bucket;
      body.slot = -1;
      const slot = this.counts[bucket]!;
      if (slot >= this.capacity) continue;
      this.counts[bucket] = slot + 1;
      body.slot = slot;
      this.order[bucket]![slot] = body;

      const fade = this.reduced ? body.presence : smoothstep(body.presence);
      const grow = this.reduced
        ? 1
        : PRESENCE.scaleMin + PRESENCE.scaleRange * smoothstep(body.presence);
      const work = this.reduced
        ? 0
        : body.energy *
          ACTIVITY.scaleAmplitude *
          (0.5 + 0.5 * Math.sin(body.time * ACTIVITY.radiansPerSecond + body.model.seed * TAU));
      scratchScale.setScalar(body.size * grow * (1 + work));
      scratchMatrix.compose(body.position, body.quaternion, scratchScale);

      const matrices = this.matrices[bucket]!;
      if (asset === undefined) {
        for (const target of matrices) scratchMatrix.toArray(target, slot * 16);
        this.morphData[bucket]![slot * 2 + 1] = influence;
      } else {
        asset.pose(body.turns * BEAT_SECONDS, this.pose);
        for (let part = 0; part < matrices.length; part += 1) {
          this.partMatrix.multiplyMatrices(scratchMatrix, this.pose[part]!);
          this.partMatrix.toArray(matrices[part]!, slot * 16);
        }
      }

      const instances = this.buckets[bucket]!;
      instances.fade[slot] = fade;
      instances.energy[slot] =
        body.energy *
        (this.reduced
          ? 1
          : ACTIVITY.energyMin +
            ACTIVITY.energyAmplitude * Math.sin(body.time * ACTIVITY.radiansPerSecond));
      instances.warm[slot] = body.warm;
      instances.emphasis[slot] = !body.present
        ? 0
        : body.key === this.selectedKey
          ? 1
          : body.key === parentKey
            ? PARENT_EMPHASIS
            : 0;
    }

    for (let bucket = 0; bucket < CELL_COUNT; bucket += 1) {
      const count = this.counts[bucket]!;
      const morphs = bucket < PHASE_BUCKETS;
      // three's InstancedMesh morph path reads per-instance influence only when
      // count > 1 (nodes/accessors/Morph.js), so a lone morph body gets a
      // zero-scale slot. Static species have no morph texture and need none.
      const renderCount = morphs && count === 1 ? 2 : count;
      this.renderCounts[bucket] = renderCount;
      if (morphs && count === 1) {
        for (const matrix of this.matrices[bucket]!) matrix.set(ZERO_MATRIX, 16);
        const data = this.morphData[bucket]!;
        data[2] = 1;
        data[3] = 0;
        const instances = this.buckets[bucket]!;
        instances.fade[1] = 0;
        instances.energy[1] = 0;
        instances.warm[1] = 0;
        instances.emphasis[1] = 0;
      }

      const used = renderCount * 16;
      const attributes = this.partAttributes[bucket]!;
      for (const attribute of attributes) {
        attribute.clearUpdateRanges();
        if (renderCount > 0) {
          attribute.addUpdateRange(0, renderCount);
          attribute.needsUpdate = true;
        }
      }
      const matrices = this.matrices[bucket]!;
      const meshes = this.partMeshes[bucket]!;
      for (let part = 0; part < meshes.length; part += 1) {
        const mesh = meshes[part]!;
        const matrix = matrices[part]!;
        const array = mesh.instanceMatrix.array as Float32Array;
        for (let index = 0; index < used; index += 1) array[index] = matrix[index]!;
        mesh.count = renderCount;
        mesh.visible = renderCount > 0;
        mesh.boundingSphere = null;
        markMatrixRange(mesh, renderCount);
      }
      if (morphs && renderCount > 0) this.morphTextures[bucket]!.needsUpdate = true;
    }

    const selectedBucket =
      selected !== undefined && selected.present && selected.slot >= 0 ? selected.bucket : -1;
    if (selectedBucket !== this.selectedBucket) {
      if (this.selectedBucket >= 0) {
        for (const mesh of this.partMeshes[this.selectedBucket]!) {
          mesh.layers.disable(SPECIMEN_LAYER);
        }
      }
      if (selectedBucket >= 0) {
        for (const mesh of this.partMeshes[selectedBucket]!) mesh.layers.enable(SPECIMEN_LAYER);
      }
      this.selectedBucket = selectedBucket;
    }
  }

  isolate(key: string, draw: () => void): boolean {
    const body = this.bodies.get(key);
    if (body === undefined || body.slot < 0) return false;
    const bucket = body.bucket;
    const slot = body.slot;
    const used = this.renderCounts[bucket]!;
    const meshes = this.partMeshes[bucket]!;
    const matrices = this.matrices[bucket]!;
    try {
      for (const mesh of meshes) {
        const array = mesh.instanceMatrix.array as Float32Array;
        for (let index = 0; index < used; index += 1) {
          if (index !== slot) array.set(ZERO_MATRIX, index * 16);
        }
        markMatrixRange(mesh, used);
      }
      draw();
    } finally {
      const length = used * 16;
      for (let part = 0; part < meshes.length; part += 1) {
        const mesh = meshes[part]!;
        const matrix = matrices[part]!;
        const array = mesh.instanceMatrix.array as Float32Array;
        for (let index = 0; index < length; index += 1) array[index] = matrix[index]!;
        markMatrixRange(mesh, used);
      }
    }
    return true;
  }

  keyAt(bucket: number, instance: number): string | undefined {
    return this.order[bucket]?.[instance]?.key;
  }

  specimenOf(key: string): Pick<Body, "position" | "size"> | undefined {
    const body = this.bodies.get(key);
    if (body === undefined || body.presence <= 0) return undefined;
    return body;
  }

  snapshotBodies(): ReadonlyArray<{
    readonly key: string;
    readonly position: { readonly x: number; readonly y: number; readonly z: number };
    readonly presence: number;
    readonly present: boolean;
    readonly size: number;
    readonly status: SessionView["status"];
    readonly attention: boolean;
  }> {
    return Array.from(this.bodies.values(), (body) => ({
      key: body.key,
      position: { x: body.position.x, y: body.position.y, z: body.position.z },
      presence: body.presence,
      present: body.present,
      size: body.size,
      status: body.model.session.status,
      attention:
        body.model.session.attention.permissions + body.model.session.attention.questions > 0,
    }));
  }

  pick(raycaster: THREE.Raycaster): string | undefined {
    let nearest: { key: string; distance: number } | undefined;
    for (let bucket = 0; bucket < CELL_COUNT; bucket += 1) {
      if (this.counts[bucket] === 0) continue;
      for (const mesh of this.partMeshes[bucket]!) {
        const hit = raycaster.intersectObject(mesh, false)[0];
        if (hit === undefined || hit.instanceId === undefined) continue;
        if (nearest === undefined || hit.distance < nearest.distance) {
          const key = this.keyAt(bucket, hit.instanceId);
          if (key !== undefined) nearest = { key, distance: hit.distance };
        }
      }
    }
    return nearest?.key;
  }

  stats(): SchoolStats {
    let present = 0;
    let departing = 0;
    for (const body of this.bodies.values()) {
      if (body.present) present += 1;
      else departing += 1;
    }
    let meshes = 0;
    for (const bucket of this.partMeshes) meshes += bucket.length;
    return {
      creatures: this.bodies.size,
      present,
      departing,
      capacity: this.capacity,
      buckets: [...this.counts],
      renderCounts: [...this.renderCounts],
      detail: this.detail,
      meshes,
      instanceBytes: this.slots * CELL_COUNT * 4 * Float32Array.BYTES_PER_ELEMENT,
    };
  }

  dispose(): void {
    this.teardownGeometry();
    disposeMaterials(this.materials);
    this.assets.dispose();
  }
}

const warmthOf = ({ permissions, questions }: SessionView["attention"]): -1 | 0 | 1 =>
  permissions > 0 ? 1 : permissions + questions > 0 ? -1 : 0;

const markMatrixRange = (mesh: THREE.InstancedMesh, instances: number): void => {
  const attribute = mesh.instanceMatrix;
  attribute.clearUpdateRanges();
  if (instances === 0) return;
  // BufferAttribute update ranges count scalar components, not instances.
  attribute.addUpdateRange(0, instances * 16);
  attribute.needsUpdate = true;
};

const sameDetail = (left: JellyDetail, right: JellyDetail): boolean =>
  left.rows === right.rows &&
  left.cols === right.cols &&
  left.armStations === right.armStations &&
  left.armColumns === right.armColumns;

const support = (
  extent: Extent,
  axis: THREE.Vector3,
  direction: THREE.Vector3,
  size: number,
): number => {
  const along = axis.dot(direction);
  const lateral = Math.sqrt(Math.max(0, 1 - along * along));
  const end = along >= 0 ? extent.up : extent.down;
  return size * (extent.radius * lateral + end * Math.abs(along));
};

const smoothstep = (value: number): number => {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
};

const fnv1a = (key: string): number => {
  let state = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    state ^= key.charCodeAt(index);
    state = Math.imul(state, 16777619);
  }
  return state >>> 0;
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const placementPriority = (key: string): number => mulberry32(fnv1a(`placement:${key}`))();

const randomUnit = (random: () => number): THREE.Vector3 => {
  const vector = new THREE.Vector3(random() - 0.5, random() - 0.5, random() - 0.5);
  if (vector.lengthSq() < 1e-6) vector.set(1, 0, 0);
  return vector.normalize();
};

const sampleMouth = (random: () => number): THREE.Vector3 => {
  const beta = Math.acos(1 - 2 * random());
  const phi = random() * TAU;
  return new THREE.Vector3(
    Math.sin(beta) * Math.cos(phi),
    Math.sin(beta) * Math.sin(phi),
    Math.cos(beta),
  ).normalize();
};
