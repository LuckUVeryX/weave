import * as THREE from "three/webgpu";
import { renderOutput, texture, uniform, uv, vec4 } from "three/tsl";

import { SPECIMEN_LAYER } from "./constants.ts";
import { HabitatRender } from "./render.ts";
import type { School } from "./school.ts";

export interface SpecimenWindow {
  readonly key: string;
  readonly aperture: HTMLDivElement;
  readonly tether: SVGPathElement;
  readonly marker: SVGCircleElement;
}

const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
placeholder.minFilter = THREE.LinearFilter;
placeholder.magFilter = THREE.LinearFilter;
placeholder.generateMipmaps = false;
placeholder.needsUpdate = true;

export class SpecimenView {
  readonly destination = uniform(new THREE.Vector4(0, 0, 1, 1));
  readonly crop = uniform(new THREE.Vector4(0, 0, 1, 1));
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 120);
  private readonly renderer: THREE.Renderer;
  private readonly view: HabitatRender;
  private readonly image = texture(placeholder);
  private readonly viewport = new THREE.Vector4();
  private readonly previousViewport = new THREE.Vector4();
  private readonly quad: THREE.QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private target: THREE.RenderTarget | undefined;
  private width = 0;
  private height = 0;

  constructor(renderer: THREE.Renderer, scene: THREE.Scene) {
    this.renderer = renderer;
    this.view = new HabitatRender(renderer, scene, this.camera);
    this.camera.layers.set(SPECIMEN_LAYER);
    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
    });
    this.material.fragmentNode = renderOutput(
      vec4(this.image.sample(uv()).rgb, 1),
      renderer.toneMapping,
      renderer.outputColorSpace,
    );
    this.quad = new THREE.QuadMesh(this.material);
  }

  targetSize(): readonly [number, number] {
    return [this.width, this.height];
  }

  frame(
    main: THREE.PerspectiveCamera,
    fullWidth: number,
    fullHeight: number,
    targetWidth: number,
    targetHeight: number,
  ): void {
    const crop = this.crop.value;
    this.camera.fov = main.fov;
    this.camera.near = main.near;
    this.camera.far = main.far;
    this.camera.aspect = main.aspect;
    this.camera.position.copy(main.position);
    this.camera.quaternion.copy(main.quaternion);
    this.camera.setViewOffset(
      fullWidth,
      fullHeight,
      crop.x * fullWidth,
      crop.y * fullHeight,
      crop.z * fullWidth,
      crop.w * fullHeight,
    );
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld(true);
    this.ensureTarget(targetWidth, targetHeight);
    const destination = this.destination.value;
    const pixelRatio = this.renderer.getPixelRatio();
    this.viewport.set(
      (destination.x * fullWidth) / pixelRatio,
      (destination.y * fullHeight) / pixelRatio,
      (destination.z * fullWidth) / pixelRatio,
      (destination.w * fullHeight) / pixelRatio,
    );
  }

  private ensureTarget(width: number, height: number): void {
    const targetWidth = Math.max(1, Math.round(width));
    const targetHeight = Math.max(1, Math.round(height));
    if (this.target !== undefined && targetWidth === this.width && targetHeight === this.height) {
      return;
    }
    this.releaseTarget();
    const target = new THREE.RenderTarget(targetWidth, targetHeight, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: this.renderer.samples,
    });
    target.texture.minFilter = THREE.LinearFilter;
    target.texture.magFilter = THREE.LinearFilter;
    target.texture.generateMipmaps = false;
    this.target = target;
    this.width = targetWidth;
    this.height = targetHeight;
    this.image.value = target.texture;
  }

  render(school: School, key: string): void {
    const target = this.target;
    if (target === undefined) return;
    const renderer = this.renderer;
    const previousTarget = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const toneMapping = renderer.toneMapping;
    const outputColorSpace = renderer.outputColorSpace;
    renderer.getViewport(this.previousViewport);
    try {
      const isolated = school.isolate(key, () => this.view.render(target));
      if (!isolated) return;
      renderer.autoClear = false;
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      renderer.setViewport(this.viewport);
      this.quad.render(renderer);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.autoClear = autoClear;
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
      renderer.setViewport(this.previousViewport);
    }
  }

  async prepare(main: THREE.PerspectiveCamera): Promise<void> {
    await this.renderer.compileAsync(this.quad, this.quad.camera);
    const warm = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: this.renderer.samples,
    });
    this.camera.copy(main);
    this.camera.layers.enable(0);
    try {
      this.view.render(warm);
    } finally {
      this.camera.layers.set(SPECIMEN_LAYER);
      this.view.releaseTarget();
      warm.dispose();
    }
  }

  releaseTarget(): void {
    this.target?.dispose();
    this.view.releaseTarget();
    this.target = undefined;
    this.width = 0;
    this.height = 0;
    this.image.value = placeholder;
  }

  dispose(): void {
    this.releaseTarget();
    this.view.dispose();
    this.material.dispose();
  }
}
