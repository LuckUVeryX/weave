const SAMPLE_WINDOW_SECONDS = 1;

export interface CycleStats {
  readonly sps: number;
  readonly fps: number;
  readonly frameMilliseconds: number;
  readonly seconds: number;
  readonly steps: number;
  readonly frames: number;
}

const empty: CycleStats = {
  sps: 0,
  fps: 0,
  frameMilliseconds: 0,
  seconds: 0,
  steps: 0,
  frames: 0,
};

export class CycleMeter {
  private windowStart: number | undefined;
  private steps = 0;
  private frames = 0;
  private sample: CycleStats = empty;

  record(now: number, steps: number): void {
    if (this.windowStart === undefined) {
      this.windowStart = now;
      this.steps = 0;
      this.frames = 0;
      return;
    }

    this.steps += steps;
    this.frames += 1;
    const seconds = (now - this.windowStart) / 1000;
    if (seconds < SAMPLE_WINDOW_SECONDS) return;

    this.sample = {
      sps: this.steps / seconds,
      fps: this.frames / seconds,
      frameMilliseconds: (seconds * 1000) / this.frames,
      seconds,
      steps: this.steps,
      frames: this.frames,
    };
    this.windowStart = now;
    this.steps = 0;
    this.frames = 0;
  }

  stats(): CycleStats {
    return this.sample;
  }
}
