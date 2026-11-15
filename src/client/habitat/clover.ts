import * as THREE from "three/webgpu";

const TEXTURE_SIZE = 1024;
const CENTRE = TEXTURE_SIZE / 2;
const ORBIT = 180;
const LOOP_RADIUS = 86;
const STROKE_WIDTH = 60;
const OPENING = Math.PI * 0.4;
const GEL = "#f8f1ec";
const PINK = "#c58fa8";
const HALO = "rgba(188, 132, 154, 0.8)";
const HALO_BLUR = 10;

export interface CloverMark {
  readonly angle: number;
  readonly centreX: number;
  readonly centreY: number;
  readonly radius: number;
  readonly start: number;
  readonly end: number;
}

export const CLOVER_MARKS: ReadonlyArray<CloverMark> = Array.from({ length: 4 }, (_, index) => {
  const angle = Math.PI / 4 + (index * Math.PI) / 2;
  const half = OPENING / 2;
  return {
    angle,
    centreX: CENTRE + Math.cos(angle) * ORBIT,
    centreY: CENTRE + Math.sin(angle) * ORBIT,
    radius: LOOP_RADIUS,
    start: angle + Math.PI + half,
    end: angle + Math.PI * 3 - half,
  };
});

export const createCloverTexture = (): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("2D canvas is unavailable.");
  context.fillStyle = GEL;
  context.fillRect(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  context.lineCap = "round";
  context.lineWidth = STROKE_WIDTH;
  context.strokeStyle = PINK;
  context.shadowColor = HALO;
  context.shadowBlur = HALO_BLUR;
  for (const mark of CLOVER_MARKS) {
    context.beginPath();
    context.arc(mark.centreX, mark.centreY, mark.radius, mark.start, mark.end);
    context.stroke();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
};
