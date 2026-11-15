import * as THREE from "three/webgpu";
import OITPassNode from "three/addons/tsl/display/OITPassNode.js";
import { cameraPosition, exp2, output, positionView } from "three/tsl";

class ViewPass extends OITPassNode {
  target: THREE.RenderTarget | undefined;

  override setSize(width: number, height: number): void {
    super.setSize(this.target?.width ?? width, this.target?.height ?? height);
  }
}

export class HabitatRender {
  private readonly renderer: THREE.Renderer;
  private readonly pass: ViewPass;
  private readonly pipeline: THREE.RenderPipeline;

  constructor(renderer: THREE.Renderer, scene: THREE.Scene, camera: THREE.Camera) {
    this.renderer = renderer;
    this.pass = new ViewPass(scene, camera, { samples: renderer.samples });
    this.pass.weightNode = exp2(cameraPosition.length().add(positionView.z).mul(2))
      .mul(16)
      .mul(output.a)
      .clamp(0.01, 3000);
    this.pipeline = new THREE.RenderPipeline(renderer, this.pass);
  }

  render(target?: THREE.RenderTarget): void {
    const renderer = this.renderer;
    const previous = renderer.getRenderTarget();
    const autoClear = renderer.autoClear;
    const outputColorTransform = target === undefined;
    if (this.pipeline.outputColorTransform !== outputColorTransform) {
      this.pipeline.outputColorTransform = outputColorTransform;
      this.pipeline.needsUpdate = true;
    }
    this.pass.target = target;
    try {
      renderer.setRenderTarget(target ?? null);
      renderer.autoClear = true;
      this.pipeline.render();
    } finally {
      renderer.setRenderTarget(previous);
      renderer.autoClear = autoClear;
    }
  }

  releaseTarget(): void {
    this.pass.target = undefined;
    this.pass.setSize(1, 1);
  }

  dispose(): void {
    this.pipeline.dispose();
    this.pass.dispose();
  }
}
