import * as THREE from "three/webgpu";
import { Fn, exp, length, oneMinus, pow, positionWorld, smoothstep, uv, vec3 } from "three/tsl";

import { LIGHT_INTENSITY, LIGHT_POSITION, SPECIMEN_LAYER, TANK } from "./constants.ts";
import { waterFog } from "./materials.ts";
import type { WallAt } from "./water.ts";
import { habitatSource, waterScatter } from "./source.ts";

const WATER_COLORS = [0x00cfff, 0x2448e8, 0x655cf0, 0xb9e3ce].map((hex) => new THREE.Color(hex));
const WHITE = new THREE.Color(0xffffff);
const VIOLET = new THREE.Color(0x655cf0);
const BLUE = new THREE.Color(0x2448e8);
const PALETTE_SECONDS = 160;
const PALETTE_STOP_SECONDS = 40;
const PALETTE = {
  luminance: 0.18,
  whiteTintMix: 0.12,
  surroundVioletMix: 0.45,
  surroundTintMix: 0.28,
  fogStrength: 0.16,
};
const SOURCE_GLOW = {
  shoulderWidth: 0.85,
  shoulderHeight: 0.6,
  overheadOffset: 2.4,
  indirectWidth: 2.4,
  indirectHeight: 2.5,
  indirectFalloff: 1.3,
  shoulderXFalloff: 0.16,
  shoulderYFalloff: 0.06,
  wallFadeStartRadiusFraction: 0.84,
  wallFadeExponent: 0.5,
  scatterStrength: 0.38,
  shoulderStrength: 0.28,
  indirectStrength: 0.45,
  segments: 160,
};
const HAZE = {
  brightness: 0.65,
  fadeStartRadiusFraction: 0.65,
  opacity: 0.12,
  radiusFraction: 0.97,
  segments: 128,
  curvatureDepth: 0.55,
  depthFraction: 0.92,
};

export class Kreisel {
  readonly radius = TANK.aperture;
  readonly halfDepth = TANK.halfDepth;
  readonly scene: THREE.Scene;
  readonly ambient: THREE.AmbientLight;
  readonly hemisphere: THREE.HemisphereLight;
  readonly keyLight: THREE.DirectionalLight;
  readonly rimLight: THREE.DirectionalLight;
  readonly fillLight: THREE.DirectionalLight;
  readonly fill: THREE.Mesh;
  readonly haze: THREE.Mesh;
  private lightSeconds = 0;
  private readonly reduced =
    typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.ambient = new THREE.AmbientLight(0x9590ef, LIGHT_INTENSITY.ambient);
    this.hemisphere = new THREE.HemisphereLight(0x9590ef, 0x010108, LIGHT_INTENSITY.hemisphere);
    this.keyLight = new THREE.DirectionalLight(0xf1f3ff, LIGHT_INTENSITY.key);
    this.keyLight.position.copy(habitatSource.position.value);
    this.rimLight = new THREE.DirectionalLight(0xdcdfff, LIGHT_INTENSITY.rim);
    this.rimLight.position.set(...LIGHT_POSITION.rim);
    this.fillLight = new THREE.DirectionalLight(0x9590ef, LIGHT_INTENSITY.fill);
    this.fillLight.position.set(...LIGHT_POSITION.fill);
    for (const light of [
      this.ambient,
      this.hemisphere,
      this.keyLight,
      this.rimLight,
      this.fillLight,
    ]) {
      light.layers.enable(SPECIMEN_LAYER);
    }
    scene.add(this.ambient, this.hemisphere, this.keyLight, this.rimLight, this.fillLight);
    this.setPalette();

    const fillMaterial = new THREE.MeshBasicNodeMaterial({
      transparent: false,
      depthWrite: false,
      side: THREE.FrontSide,
    });
    fillMaterial.colorNode = Fn(() => {
      const p = uv().sub(0.5).mul(2);
      const r = length(p);
      const scatter = waterScatter();
      const dx = positionWorld.x.sub(habitatSource.position.x).div(SOURCE_GLOW.shoulderWidth);
      const dy = positionWorld.y.sub(habitatSource.position.y).div(SOURCE_GLOW.shoulderHeight);
      const indirectX = positionWorld.x
        .sub(habitatSource.position.x)
        .div(SOURCE_GLOW.indirectWidth);
      const indirectY = positionWorld.y
        .sub(habitatSource.position.y.add(SOURCE_GLOW.overheadOffset))
        .div(SOURCE_GLOW.indirectHeight);
      const indirect = exp(
        indirectX.mul(indirectX).add(indirectY.mul(indirectY)).mul(-SOURCE_GLOW.indirectFalloff),
      );
      const shoulder = exp(
        dx
          .mul(dx)
          .mul(-SOURCE_GLOW.shoulderXFalloff)
          .add(dy.mul(dy).mul(-SOURCE_GLOW.shoulderYFalloff)),
      );
      const wall = pow(
        oneMinus(smoothstep(SOURCE_GLOW.wallFadeStartRadiusFraction, 1, r)),
        SOURCE_GLOW.wallFadeExponent,
      );
      return vec3(0.00015, 0.0002, 0.0012)
        .add(habitatSource.tint.mul(SOURCE_GLOW.scatterStrength).mul(scatter).mul(wall))
        .add(habitatSource.surround.mul(shoulder).mul(SOURCE_GLOW.shoulderStrength).mul(wall))
        .add(habitatSource.white.mul(SOURCE_GLOW.indirectStrength).mul(indirect).mul(wall));
    })();
    this.fill = new THREE.Mesh(
      new THREE.CircleGeometry(this.radius, SOURCE_GLOW.segments),
      fillMaterial,
    );
    this.fill.position.z = this.halfDepth;
    this.fill.renderOrder = 1;
    this.fill.layers.enable(SPECIMEN_LAYER);
    scene.add(this.fill);

    const hazeMaterial = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.FrontSide,
    });
    hazeMaterial.colorNode = Fn(() =>
      habitatSource.surround.mul(HAZE.brightness).mul(waterScatter()),
    )();
    hazeMaterial.opacityNode = Fn(() => {
      const r = length(uv().sub(0.5).mul(2));
      return oneMinus(smoothstep(HAZE.fadeStartRadiusFraction, 1.0, r)).mul(HAZE.opacity);
    })();
    this.haze = new THREE.Mesh(
      new THREE.CircleGeometry(this.radius * HAZE.radiusFraction, HAZE.segments),
      hazeMaterial,
    );
    const positions = this.haze.geometry.getAttribute("position");
    for (let index = 0; index < positions.count; index += 1) {
      const radiusSquared = positions.getX(index) ** 2 + positions.getY(index) ** 2;
      positions.setZ(index, (radiusSquared / this.radius ** 2) * HAZE.curvatureDepth);
    }
    positions.needsUpdate = true;
    this.haze.geometry.computeVertexNormals();
    this.haze.position.z = -this.halfDepth * HAZE.depthFraction;
    this.haze.renderOrder = 2;
    this.haze.layers.enable(SPECIMEN_LAYER);
    scene.add(this.haze);
  }

  private setPalette(): void {
    const phase =
      (((this.lightSeconds % PALETTE_SECONDS) + PALETTE_SECONDS) % PALETTE_SECONDS) /
      PALETTE_STOP_SECONDS;
    const index = Math.floor(phase);
    const blend = phase - index;
    const eased = blend * blend * (3 - 2 * blend);
    habitatSource.tint.value.copy(WATER_COLORS[index]!).lerp(WATER_COLORS[(index + 1) % 4]!, eased);
    const tint = habitatSource.tint.value;
    const luminance = tint.r * 0.2126 + tint.g * 0.7152 + tint.b * 0.0722;
    tint.multiplyScalar(PALETTE.luminance / luminance);
    habitatSource.white.value.copy(WHITE).lerp(tint, PALETTE.whiteTintMix);
    habitatSource.surround.value
      .copy(BLUE)
      .lerp(VIOLET, PALETTE.surroundVioletMix)
      .lerp(tint, PALETTE.surroundTintMix);
    waterFog.tint.value.copy(habitatSource.surround.value).multiplyScalar(PALETTE.fogStrength);
    this.keyLight.color.copy(habitatSource.white.value);
    this.rimLight.color.copy(habitatSource.white.value);
    this.fillLight.color.copy(habitatSource.surround.value);
  }

  readonly wallAt: WallAt = (x, y, z, radialReach, depthReach, out) => {
    const r = Math.hypot(x, y);
    const radialSigned = this.radius - r - radialReach;
    const depthSigned = this.halfDepth - Math.abs(z) - depthReach;
    if (radialSigned <= depthSigned) {
      out.signed = radialSigned;
      out.nx = r > 1e-6 ? x / r : 1;
      out.ny = r > 1e-6 ? y / r : 0;
      out.nz = 0;
    } else {
      out.signed = depthSigned;
      out.nx = 0;
      out.ny = 0;
      out.nz = z >= 0 ? 1 : -1;
    }
    return out;
  };

  advance(dt: number): void {
    if (!this.reduced) this.lightSeconds += dt;
    this.setPalette();
  }

  dispose(): void {
    for (const object of [this.fill, this.haze]) {
      object.geometry.dispose();
      const material = object.material;
      if (Array.isArray(material)) for (const item of material) item.dispose();
      else material.dispose();
      object.dispose();
    }
    this.scene.remove(this.ambient, this.hemisphere, this.keyLight, this.rimLight, this.fillLight);
  }
}
