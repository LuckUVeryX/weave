export const SPECIMEN_LAYER = 1;

export const TANK = {
  aperture: 5.2,
  halfDepth: 2.5,
  softMargin: 0.55,
} as const;

export const BEAT_SECONDS = 4.8;

export const TAU = Math.PI * 2;

export const ORBIT_SECONDS = 480;

export const LIGHT_INTENSITY = {
  ambient: 0.035,
  hemisphere: 0.12,
  key: 1.4,
  rim: 0.35,
  fill: 0.08,
};
export const LIGHT_POSITION = { rim: [0, 4.5, -6], fill: [0, 0.8, 5] } as const;
