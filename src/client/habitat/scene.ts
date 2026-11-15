import * as THREE from "three/webgpu";

import { createCloverTexture } from "./clover.ts";
import { createSpottedTexture } from "./species/index.ts";
import { TANK } from "./constants.ts";
import { CycleMeter } from "./cycle.ts";
import type { CycleStats } from "./cycle.ts";
import { detailFor } from "./geometry.ts";
import { Kreisel } from "./kreisel.ts";
import type { HabitatModel } from "./model.ts";
import { HabitatRender } from "./render.ts";
import { School } from "./school.ts";
import type { SchoolStats } from "./school.ts";
import { SpecimenView, type SpecimenWindow } from "./specimen.ts";
import { Water } from "./water.ts";

const FIXED_STEP = 1 / 60;
const MAX_FRAME_SECONDS = 0.1;
const MAX_ACCUMULATED_SECONDS = 0.25;
const MAX_STEPS_PER_FRAME = 8;
const MAX_PIXEL_RATIO = 1.5;
const INITIAL_INSTANCE_CAPACITY = 64;
const FRAME_TIME_SMOOTHING = 0.05;
const INITIAL_FRAME_INTERVAL_MS = 16.7;
const SPECIMEN_FRAME_SCALE = 1.5;
const CAMERA = {
  fieldOfViewDegrees: 40,
  near: 0.1,
  far: 120,
  viewportFraction: 0.96,
  minYawCosine: 0.6,
  minPitchCosine: 0.85,
};

/**
 * Engine-side resource counts. These are active three.js resources, not a
 * measurement of driver or OS memory, and they do not prove the absence of a
 * GPU leak on their own.
 */
export interface HabitatMemory {
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
  readonly attributes: number;
  readonly attributesSize: number;
  readonly programsSize: number;
  readonly total: number;
}

export interface HabitatStats {
  readonly backend: "webgpu";
  /** Cumulative renderer.render calls since mount. */
  readonly calls: number;
  /** Draw calls in the last completed frame. */
  readonly drawCalls: number;
  readonly triangles: number;
  readonly school: SchoolStats;
  readonly frameMilliseconds: number;
  readonly cycle: CycleStats;
  readonly memory: HabitatMemory;
}

export class HabitatScene {
  private readonly renderer: THREE.Renderer;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.PerspectiveCamera(
    CAMERA.fieldOfViewDegrees,
    1,
    CAMERA.near,
    CAMERA.far,
  );
  private readonly kreisel: Kreisel;
  private readonly water: Water;
  private readonly school: School;
  private readonly view: HabitatRender;
  private readonly cycle = new CycleMeter();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly canvas: HTMLCanvasElement;
  private observer: ResizeObserver | undefined;
  private accumulator = 0;
  private last = 0;
  private frameMilliseconds = INITIAL_FRAME_INTERVAL_MS;
  private anchor: ((point: { x: number; y: number } | undefined) => void) | undefined;
  private anchorKey: string | undefined;
  private stopped = true;
  private yaw = 0;
  private pitch = 0;
  private readonly projected = new THREE.Vector3();
  private specimenWindow: SpecimenWindow | undefined;
  private specimenView: SpecimenView | undefined;
  private aperture = new DOMRect();
  private canvasBounds = new DOMRect();
  private apertureObserver: ResizeObserver | undefined;
  private readonly onResize = (): void => this.resize();

  private constructor(
    canvas: HTMLCanvasElement,
    renderer: THREE.Renderer,
    scene: THREE.Scene,
    kreisel: Kreisel,
    water: Water,
    school: School,
  ) {
    this.canvas = canvas;
    this.renderer = renderer;
    this.scene = scene;
    this.kreisel = kreisel;
    this.water = water;
    this.school = school;
    this.view = new HabitatRender(renderer, this.scene, this.camera);
  }

  static async create(canvas: HTMLCanvasElement, model: () => HabitatModel): Promise<HabitatScene> {
    const parameters: THREE.RendererParameters & { canvas: HTMLCanvasElement } = {
      canvas,
      antialias: true,
      alpha: true,
      getFallback: null,
    };
    const renderer = new THREE.Renderer(new THREE.WebGPUBackend(parameters), parameters);
    renderer.library = new THREE.StandardNodeLibrary();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1.0;
    await renderer.init();

    const scene = new THREE.Scene();
    const kreisel = new Kreisel(scene);
    const water = new Water(kreisel);
    water.setFlow("cw");
    const school = new School({
      scene,
      water,
      capacity: INITIAL_INSTANCE_CAPACITY,
      detail: detailFor(0),
      reduced: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
      clover: createCloverTexture(),
      spotted: createSpottedTexture(),
    });

    const habitat = new HabitatScene(canvas, renderer, scene, kreisel, water, school);
    habitat.resize();
    try {
      habitat.setModel(model());
      school.syncInstances();
      habitat.specimenView = new SpecimenView(renderer, scene);
      await habitat.specimenView.prepare(habitat.camera);
      habitat.view.render();
    } catch (error) {
      await habitat.dispose();
      throw error;
    }
    habitat.observer = new ResizeObserver(habitat.onResize);
    habitat.observer.observe(canvas);
    window.addEventListener("resize", habitat.onResize);
    return habitat;
  }

  setModel(model: HabitatModel): void {
    this.school.applyModel(model);
  }

  setSelection(key: string | undefined): void {
    this.school.setSelection(key);
  }

  setSpecimenWindow(binding: SpecimenWindow | undefined): void {
    this.apertureObserver?.disconnect();
    this.specimenWindow = binding;
    if (binding === undefined) {
      this.specimenView?.releaseTarget();
      return;
    }
    this.apertureObserver = new ResizeObserver(() => this.measureAperture());
    this.apertureObserver.observe(binding.aperture);
    this.measureAperture();
  }

  private measureAperture(): void {
    const aperture = this.specimenWindow?.aperture;
    if (aperture !== undefined) this.aperture = aperture.getBoundingClientRect();
  }

  setAnchorListener(
    key: string | undefined,
    listener: (point: { x: number; y: number } | undefined) => void,
  ): void {
    this.anchorKey = key;
    this.anchor = listener;
  }

  pickAt(clientX: number, clientY: number): string | undefined {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    return this.school.pick(this.raycaster);
  }

  bodies() {
    return this.school.snapshotBodies();
  }

  cycleStats(): CycleStats {
    return this.cycle.stats();
  }

  stats(): HabitatStats {
    const memory = this.renderer.info.memory;
    return {
      backend: "webgpu",
      calls: this.renderer.info.render.calls,
      drawCalls: this.renderer.info.render.drawCalls,
      triangles: this.renderer.info.render.triangles,
      school: this.school.stats(),
      frameMilliseconds: this.frameMilliseconds,
      cycle: this.cycle.stats(),
      memory: {
        geometries: memory.geometries,
        textures: memory.textures,
        programs: memory.programs,
        attributes: memory.attributes,
        attributesSize: memory.attributesSize,
        programsSize: memory.programsSize,
        total: memory.total,
      },
    };
  }

  private resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    if (width === 0 || height === 0) return;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(width, height, false);
    this.canvasBounds = this.canvas.getBoundingClientRect();
    this.camera.aspect = width / height;
    this.fitCamera();
    this.measureAperture();
  }

  private fitCamera(): void {
    const aspect = this.camera.aspect;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5));
    const fraction = CAMERA.viewportFraction;
    const outer = TANK.aperture;
    let distance = TANK.halfDepth + outer / (fraction * tan * Math.min(1, aspect));
    distance /= Math.max(CAMERA.minYawCosine, Math.cos(this.yaw));
    distance /= Math.max(CAMERA.minPitchCosine, Math.cos(this.pitch));
    this.camera.position.set(
      distance * Math.sin(this.yaw),
      distance * Math.sin(this.pitch),
      distance * Math.cos(this.yaw) * Math.cos(this.pitch),
    );
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.last = performance.now();
    void this.renderer.setAnimationLoop((time) => this.frame(time));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.renderer.setAnimationLoop(null);
  }

  private frame(now: number): void {
    const dt = Math.min(MAX_FRAME_SECONDS, (now - this.last) / 1000);
    this.last = now;
    this.frameMilliseconds += (dt * 1000 - this.frameMilliseconds) * FRAME_TIME_SMOOTHING;

    this.accumulator = Math.min(this.accumulator + dt, MAX_ACCUMULATED_SECONDS);
    let steps = 0;
    while (this.accumulator >= FIXED_STEP && steps < MAX_STEPS_PER_FRAME) {
      this.kreisel.advance(FIXED_STEP);
      this.water.advance(FIXED_STEP);
      this.school.advance(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps += 1;
    }
    this.school.syncInstances();
    this.cycle.record(now, steps);
    this.renderer.info.reset();
    this.view.render();
    const specimenKey = this.updateSpecimen();
    if (specimenKey !== undefined) this.specimenView?.render(this.school, specimenKey);
    this.publishAnchor();
  }

  private updateSpecimen(): string | undefined {
    const binding = this.specimenWindow;
    const view = this.specimenView;
    if (binding === undefined || view === undefined) return undefined;
    const body = this.school.specimenOf(binding.key);
    const rect = this.canvasBounds;
    const aperture = this.aperture;
    let visible = false;
    if (
      body !== undefined &&
      rect.width > 0 &&
      rect.height > 0 &&
      aperture.width > 0 &&
      aperture.height > 0
    ) {
      const point = this.projected.copy(body.position).project(this.camera);
      visible = point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
      if (visible) {
        const x = point.x * 0.5 + 0.5;
        const y = 0.5 - point.y * 0.5;
        const depth = -this.projected
          .copy(body.position)
          .applyMatrix4(this.camera.matrixWorldInverse).z;
        const cropHeight =
          (body.size * SPECIMEN_FRAME_SCALE) /
          (2 * depth * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)));
        const cropWidth = (cropHeight * aperture.width) / aperture.height / this.camera.aspect;
        view.destination.value.set(
          (aperture.left - rect.left) / rect.width,
          (aperture.top - rect.top) / rect.height,
          aperture.width / rect.width,
          aperture.height / rect.height,
        );
        view.crop.value.set(x - cropWidth / 2, y - cropHeight / 2, cropWidth, cropHeight);
        const pixelRatio = this.renderer.getPixelRatio();
        view.frame(
          this.camera,
          rect.width * pixelRatio,
          rect.height * pixelRatio,
          aperture.width * pixelRatio,
          aperture.height * pixelRatio,
        );
        const anchorX = x * rect.width + rect.left;
        const anchorY = y * rect.height + rect.top;
        const endX = Math.min(Math.max(anchorX, aperture.left), aperture.right);
        const endY = Math.min(Math.max(anchorY, aperture.top), aperture.bottom);
        binding.tether.setAttribute("d", `M${anchorX} ${anchorY}L${endX} ${endY}`);
        binding.marker.setAttribute("cx", String(anchorX));
        binding.marker.setAttribute("cy", String(anchorY));
      }
    }
    binding.aperture.dataset.visible = String(visible);
    binding.tether.style.visibility = visible ? "visible" : "hidden";
    binding.marker.style.visibility = visible ? "visible" : "hidden";
    return visible ? binding.key : undefined;
  }

  private publishAnchor(): void {
    const key = this.anchorKey;
    const listener = this.anchor;
    if (key === undefined) {
      listener?.(undefined);
      return;
    }
    const body = this.school.specimenOf(key);
    if (body === undefined) {
      listener?.(undefined);
      return;
    }
    const projected = this.projected.copy(body.position).project(this.camera);
    if (
      projected.z < -1 ||
      projected.z > 1 ||
      Math.abs(projected.x) > 1 ||
      Math.abs(projected.y) > 1
    ) {
      listener?.(undefined);
      return;
    }
    const rect = this.canvas.getBoundingClientRect();
    listener?.({
      x: (projected.x * 0.5 + 0.5) * rect.width + rect.left,
      y: (0.5 - projected.y * 0.5) * rect.height + rect.top,
    });
  }

  async dispose(): Promise<void> {
    this.stop();
    this.observer?.disconnect();
    window.removeEventListener("resize", this.onResize);
    this.setSpecimenWindow(undefined);
    this.specimenView?.dispose();
    this.school.dispose();
    this.kreisel.dispose();
    this.view.dispose();
    await this.renderer.dispose();
  }
}
