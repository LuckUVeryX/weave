#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { startWatcher, waitForFeed, withClient } from "./client.ts";

const chromePath =
  process.env.WEAVE_CHROME_PATH ??
  (process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "/usr/bin/chromium");
if (!existsSync(chromePath)) {
  throw new Error(`Chrome executable not found at ${chromePath}. Set WEAVE_CHROME_PATH.`);
}

interface Check {
  readonly feature: string;
  readonly scenario: string;
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
  readonly observed?: string | undefined;
}

interface HabitatBody {
  readonly key: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly presence: number;
  readonly present: boolean;
  readonly size: number;
  readonly status: "idle" | "running";
  readonly attention: boolean;
}

interface Habitat {
  readonly backend: string;
  readonly calls: number;
  readonly triangles: number;
  readonly school: {
    readonly creatures: number;
    readonly present: number;
    readonly departing: number;
    readonly capacity: number;
    readonly meshes: number;
  };
  readonly memory: {
    readonly geometries: number;
    readonly textures: number;
    readonly programs: number;
    readonly attributes: number;
    readonly attributesSize: number;
    readonly total: number;
  };
  readonly bodies: ReadonlyArray<HabitatBody>;
  readonly buttons: number;
  readonly debug: string | null;
  readonly caption: { readonly visible: boolean };
  readonly drawer: boolean;
  readonly notice: {
    readonly kind: string;
    readonly text: string;
    readonly role: string | null;
  } | null;
  readonly sourceControls: number;
}

interface Runner {
  proc: ReturnType<typeof Bun.spawn>;
  ui: string;
  control: string;
  rpc: string;
  fake: string;
  sourceFakes: ReadonlyArray<string>;
  log: string;
}

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

const worktree = resolve(arg("--worktree") ?? process.cwd());
const run = resolve(
  arg("--run") ?? join(tmpdir(), "weave-client-ui", `${Date.now()}-${process.pid}`),
);
mkdirSync(run, { recursive: true });
const screens = join(run, "screenshots");
mkdirSync(screens, { recursive: true });

const checks: Array<Check> = [];
const scenarios: Array<{ scenario: string; result: "PASS" | "FAIL"; error?: string }> = [];
const only = arg("--only");
const command = `bun .agents/skills/verify-weave/harness/client-ui.ts --worktree ${worktree} --run ${run}${only === undefined ? "" : ` --only ${only}`}`;

const writeJson = (name: string, value: unknown): void => {
  writeFileSync(join(run, name), `${JSON.stringify(value, null, 2)}\n`);
};

const assert = (
  scenario: string,
  name: string,
  pass: boolean,
  detail: string,
  observed?: string,
): void => {
  checks.push({ feature: "client-sessions-ui", scenario, name, pass, detail, observed });
};

const debugPattern = /^SPS \d+ · FPS \d+ · \d+\.\d ms$/;

const sameResources = (left: Habitat, right: Habitat): boolean =>
  JSON.stringify(left.memory) === JSON.stringify(right.memory) &&
  left.school.capacity === right.school.capacity &&
  left.school.meshes === right.school.meshes;

const sleep = (ms: number): Promise<void> => Bun.sleep(ms);

type CdpEvent = (method: string, params: any) => void;

class Cdp {
  readonly #ws: WebSocket;
  #id = 0;
  readonly #pending = new Map<number, (value: any) => void>();
  #onEvent: CdpEvent | null = null;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && this.#pending.has(message.id)) {
        this.#pending.get(message.id)?.(message);
        this.#pending.delete(message.id);
        return;
      }
      if (typeof message.method === "string") {
        this.#onEvent?.(message.method, message.params);
      }
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolveOpen, reject) => {
      ws.addEventListener("open", () => resolveOpen(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });
    return new Cdp(ws);
  }

  send(method: string, params: unknown = {}): Promise<any> {
    return new Promise((resolveSend) => {
      const id = ++this.#id;
      this.#pending.set(id, resolveSend);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(handler: CdpEvent): void {
    this.#onEvent = handler;
  }

  close(): void {
    this.#ws.close();
  }
}

const evaluate = async (cdp: Cdp, expression: string): Promise<any> => {
  const response = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.result?.exceptionDetails !== undefined) {
    throw new Error(response.result.exceptionDetails.text ?? "evaluation failed");
  }
  return response.result?.result?.value;
};

const habitatExpression = `(() => {
  const scene = window.__weaveHabitat;
  if (!scene) return undefined;
  const stats = scene.stats();
  const card = document.querySelector(".habitat-caption");
  const style = card ? getComputedStyle(card) : undefined;
  return {
    backend: stats.backend,
    calls: stats.calls,
    triangles: stats.triangles,
    school: {
      creatures: stats.school.creatures,
      present: stats.school.present,
      departing: stats.school.departing,
      capacity: stats.school.capacity,
      meshes: stats.school.meshes,
    },
    memory: stats.memory,
    bodies: scene.bodies(),
    buttons: document.querySelectorAll('[aria-label="Sessions"] li button').length,
    debug: document.querySelector('[data-debug="sps"]')?.textContent ?? null,
    caption: {
      visible: Boolean(card && style.visibility !== "hidden" && style.display !== "none"),
    },
    drawer: Boolean(document.querySelector("dialog[open]")),
    notice: (() => {
      const node = document.querySelector('.connection-notice');
      return node === null ? null : { kind: node.dataset.kind, text: node.textContent, role: node.getAttribute('role') };
    })(),
    sourceControls: document.querySelectorAll('.source-control').length,
  };
})()`;

const habitat = async (cdp: Cdp): Promise<Habitat | undefined> =>
  await evaluate(cdp, habitatExpression);

const waitFor = async (
  label: string,
  predicate: () => Promise<boolean>,
  timeoutMs = 15_000,
): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      if (await predicate()) return;
    } catch {}
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const navigate = async (cdp: Cdp, url: string): Promise<void> => {
  await cdp.send("Page.navigate", { url });
  await waitFor(
    "document ready",
    async () => (await evaluate(cdp, "document.readyState")) === "complete",
  );
};

const screenshot = async (cdp: Cdp, name: string): Promise<string> => {
  const shot = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  writeFileSync(join(screens, `${name}.png`), Buffer.from(shot.result.data, "base64"));
  return shot.result.data;
};

const overlapRegression = async (cdp: Cdp): Promise<void> => {
  await evaluate(
    cdp,
    `(async () => {
    const { vec3 } = await import('/node_modules/.vite/deps/three_tsl.js');
    const s = window.__weaveHabitat, school = s.school;
    s.stop();
    const entries = [...school.bodies.entries()];
    const saved = entries.map(([key, body]) => [body, Object.fromEntries(Object.entries(body).map(([name, value]) => [name, value?.clone ? value.clone() : value]))]);
    const camera = { position:s.camera.position.clone(), quaternion:s.camera.quaternion.clone() };
    const materials = school.partMeshes.map(parts => parts.map(mesh => mesh.material));
    const markers = [school.materials.bell.clone(), school.materials.bell.clone()];
    markers[0].colorNode = vec3(1, 0.04, 0.04);
    markers[1].colorNode = vec3(0.04, 0.04, 1);
    const bodies = entries.map(([,body]) => body).filter(body => body.model.species === 'moon');
    school.bodies.clear();
    for (const body of bodies) school.bodies.set(body.key, body);
    s.camera.position.set(0,0,6);
    s.camera.lookAt(0,0,0);
    s.camera.updateMatrixWorld(true);
    const restoreMaterials = () => school.partMeshes.forEach((parts,bucket) => parts.forEach((mesh,part) => mesh.material=materials[bucket][part]));
    const render = () => { s.renderer.info.reset(); s.view.render(); };
    window.__overlap = {
      setup(swapped, redNear, cameraDepth=6, tilt=0, presence=1) {
        restoreMaterials();
        s.camera.position.set(0,0,cameraDepth);s.camera.lookAt(0,0,0);s.camera.updateMatrixWorld(true);
        bodies.forEach((body,index) => {
          body.baseQuaternion.identity();body.homeQuaternion.identity();body.quaternion.identity();
          body.position.set(index ? 0.08 : -0.08,0,(index===0 ? 0.8 : -0.8)*(swapped ? -1 : 1));
          body.velocity.set(0,0,0);body.size=1.18;body.sizeTarget=1.18;
          body.presence=presence;body.energy=0;body.warm=0;
          body.turns=index===0 ? 1-2.5/(60*4.8) : 0.41;
        });
        bodies[1].baseQuaternion.setFromAxisAngle(bodies[1].axis.set(0,1,0),0.6);
        bodies[1].homeQuaternion.copy(bodies[1].baseQuaternion);
        bodies[1].quaternion.copy(bodies[1].baseQuaternion);
        if(tilt)for(const body of bodies){
          body.baseQuaternion.setFromAxisAngle(body.axis.set(1,0,0),tilt);
          body.homeQuaternion.copy(body.baseQuaternion);body.quaternion.copy(body.baseQuaternion);
        }
        school.advance(0);
        this.swapped=swapped;this.redNear=redNear;
      },
      async frame(index, marked) {
        await new Promise(requestAnimationFrame);
        restoreMaterials();
        if(index>0)school.advance(1/60);
        bodies.forEach((body,i)=>body.position.set(i?0.08:-0.08,0,(i===0?0.8:-0.8)*(this.swapped?-1:1)));
        school.stale=true;school.syncInstances();
        if(marked)for(const body of bodies){
          const near=body.position.z>0;
          school.partMeshes[body.bucket][1].material=markers[near===this.redNear?0:1];
        }
        render();
        return bodies.map(body=>({key:body.key,z:body.position.z,depth:-body.position.clone().applyMatrix4(s.camera.matrixWorldInverse).z,turns:body.turns,bucket:body.bucket}));
      },
      async solo(near) {
        await new Promise(requestAnimationFrame);
        const visibility=school.partMeshes.map(parts=>parts.map(mesh=>mesh.visible));
        const body=bodies.find(body=>(body.position.z>0)===near);
        school.partMeshes.forEach((parts,bucket)=>parts.forEach(mesh=>mesh.visible=mesh.visible&&bucket===body.bucket));
        render();
        school.partMeshes.forEach((parts,bucket)=>parts.forEach((mesh,part)=>mesh.visible=visibility[bucket][part]));
      },
      restore() {
        restoreMaterials();for(const marker of markers)marker.dispose();
        for(const [body,value] of saved)Object.assign(body,value);
        school.bodies.clear();for(const [key,body]of entries)school.bodies.set(key,body);
        s.camera.position.copy(camera.position);s.camera.quaternion.copy(camera.quaternion);s.camera.updateMatrixWorld(true);
        school.stale=true;school.syncInstances();s.start();delete window.__overlap;
      },
    };
  })()`,
  );
  const cases = [];
  try {
    for (const swapped of [false, true]) {
      await evaluate(cdp, `window.__overlap.setup(${swapped},true)`);
      const frames = [];
      for (let index = 0; index < 5; index++) {
        const bodies = await evaluate(cdp, `window.__overlap.frame(${index},false)`);
        const png = await screenshot(
          cdp,
          `moon-overlap-${swapped ? "swapped" : "original"}-${index}`,
        );
        frames.push({ bodies, png });
      }
      const differences = await evaluate(
        cdp,
        `(async () => {
        const decoded=[];
        for(const png of ${JSON.stringify(frames.map((frame) => frame.png))}){
          const image=await createImageBitmap(await(await fetch('data:image/png;base64,'+png)).blob());
          const canvas=new OffscreenCanvas(480,540),ctx=canvas.getContext('2d');
          ctx.drawImage(image,480,180,480,540,0,0,480,540);
          decoded.push(ctx.getImageData(0,0,480,540).data);
        }
        return decoded.slice(1).map((pixels,i)=>{
          let absolute=0,large=0;
          for(let p=0;p<pixels.length;p+=4){
            let changed=false;
            for(let c=0;c<3;c++){const delta=Math.abs(pixels[p+c]-decoded[i][p+c]);absolute+=delta;changed ||= delta>12;}
            large+=+changed;
          }
          return {from:i,to:i+1,mean:absolute/(480*540*3),large};
        });
      })()`,
      );
      const wrap = differences[2];
      const controls = [differences[1], differences[3]];
      assert(
        "jelly-variants",
        `overlap-wrap-${swapped ? "swapped" : "original"}`,
        frames.every((frame) =>
          frame.bodies.every(
            (body: { depth: number }) =>
              Math.abs(body.depth - 5.2) < 1e-6 || Math.abs(body.depth - 6.8) < 1e-6,
          ),
        ) &&
          frames[2]?.bodies[0]?.bucket === 7 &&
          frames[3]?.bodies[0]?.bucket === 0 &&
          wrap.mean < 0.5 &&
          wrap.large < Math.max(...controls.map((value) => value.large)) * 2,
        "fixed-depth moon overlap crosses phase 7 to 0 without the baseline's contour reversal; wrap pixel change stays near adjacent controls",
        JSON.stringify({ depths: frames.map((frame) => frame.bodies), differences }),
      );
      for (const config of [
        { name: "near", depth: 6, tilt: 0, presence: 1 },
        { name: "far", depth: 14, tilt: 0, presence: 1 },
        { name: "underside", depth: 6, tilt: Math.PI, presence: 1 },
        { name: "fading", depth: 14, tilt: Math.PI, presence: 0.65 },
      ])
        for (const redNear of [true, false])
          for (const markerStep of [2, 3]) {
            const bodies = await evaluate(
              cdp,
              `(async()=>{window.__overlap.setup(${swapped},${redNear},${config.depth},${config.tilt},${config.presence});let bodies;for(let i=0;i<=${markerStep};i++)bodies=await window.__overlap.frame(i,true);return bodies;})()`,
            );
            const pair = await screenshot(
              cdp,
              `moon-markers-${config.name}-${swapped}-${redNear}-${markerStep}-pair`,
            );
            await evaluate(cdp, `window.__overlap.solo(true)`);
            const near = await screenshot(
              cdp,
              `moon-markers-${config.name}-${swapped}-${redNear}-${markerStep}-near`,
            );
            await evaluate(cdp, `window.__overlap.solo(false)`);
            const rear = await screenshot(
              cdp,
              `moon-markers-${config.name}-${swapped}-${redNear}-${markerStep}-rear`,
            );
            const markers = await evaluate(
              cdp,
              `(async()=>{
          const decoded=[];
          for(const png of ${JSON.stringify([pair, near, rear])}){
            const image=await createImageBitmap(await(await fetch('data:image/png;base64,'+png)).blob());
            const canvas=new OffscreenCanvas(480,540),ctx=canvas.getContext('2d');
            ctx.drawImage(image,480,180,480,540,0,0,480,540);
            decoded.push(ctx.getImageData(0,0,480,540).data);
          }
          const [pair,near,rear]=decoded,frontChannel=${redNear ? 0 : 2},rearChannel=${redNear ? 2 : 0};
          let count=0,front=0,back=0,frontSolo=0,rearSolo=0,rough=0;
          for(let p=0;p<pair.length;p+=4){
            const a=near[p+frontChannel]-near[p+1],b=rear[p+rearChannel]-rear[p+1];
            const nextA=near[p+4+frontChannel]-near[p+5],nextB=rear[p+4+rearChannel]-rear[p+5];
            if(a<80||b<80||nextA<80||nextB<80||(p/4)%480===479)continue;
            count++;front+=pair[p+frontChannel]-pair[p+1];back+=pair[p+rearChannel]-pair[p+1];frontSolo+=a;rearSolo+=b;
            if(Math.max(...[0,1,2].map(c=>Math.abs(pair[p+c]-pair[p+4+c])))>30)rough++;
          }
          return {count,front:front/count,rear:back/count,frontFraction:front/frontSolo,rearFraction:back/rearSolo,dominance:front/back,grain:rough/count};
        })()`,
            );
            assert(
              "jelly-variants",
              `overlap-foreground-${config.name}-${swapped}-${redNear}-${markerStep}`,
              markers.count > 100 &&
                markers.dominance > 1.15 &&
                markers.rearFraction > 0.05 &&
                markers.grain < 0.02,
              "exchanging depth and marker color keeps the nearer bell identifiable with visible rear color and smooth tissue rather than hash grain",
              JSON.stringify(markers),
            );
            cases.push({ ...config, swapped, redNear, markerStep, bodies, markers });
          }
    }
    writeJson("moon-overlap-markers.json", cases);
  } finally {
    await evaluate(cdp, `window.__overlap.restore()`);
  }
};

const tetherInlineStyles = async (cdp: Cdp): Promise<Array<string>> =>
  (await evaluate(
    cdp,
    `[...document.querySelectorAll('.specimen-tether path, .specimen-tether circle')].map(node => node.style.visibility)`,
  )) as Array<string>;

const hideTether = (cdp: Cdp): Promise<void> =>
  evaluate(
    cdp,
    `(() => { for (const node of document.querySelectorAll('.specimen-tether path, .specimen-tether circle')) node.style.visibility = 'hidden'; })()`,
  );

const restoreTether = (cdp: Cdp, styles: ReadonlyArray<string>): Promise<void> =>
  evaluate(
    cdp,
    `(() => {
      const styles = ${JSON.stringify(styles)};
      [...document.querySelectorAll('.specimen-tether path, .specimen-tether circle')].forEach((node, index) => {
        if (styles[index]) node.style.visibility = styles[index];
        else node.style.visibility = '';
      });
    })()`,
  );

const startRunner = async (args: ReadonlyArray<string> = []): Promise<Runner> => {
  const logPath = join(run, `dev-mock-${Date.now()}.log`);
  const proc = Bun.spawn({
    cmd: ["bun", "run", "dev:mock", ...args],
    cwd: worktree,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WEAVE_DEV_HOST: "127.0.0.1" },
  });
  let log = "";
  let ready: Omit<Runner, "proc" | "log"> | undefined;
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      const text = decoder.decode(value, { stream: true });
      log += text;
      const match = /DEV_READY (\{.*\})/.exec(log);
      if (match?.[1] !== undefined) ready = JSON.parse(match[1]);
      writeFileSync(logPath, log);
    }
  };
  void consume(proc.stdout);
  void consume(proc.stderr);
  try {
    await waitFor("DEV_READY", async () => ready !== undefined, 40_000);
  } catch (error) {
    proc.kill("SIGTERM");
    await Promise.race([proc.exited, sleep(8_000)]);
    if (proc.exitCode === null) {
      proc.kill("SIGKILL");
      await proc.exited;
    }
    throw error;
  }
  if (ready === undefined) throw new Error(`dev:mock did not print DEV_READY.\n${log}`);
  return { proc, ...ready, log: logPath };
};

const httpOpen = async (url: string): Promise<boolean> => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
};

const stopRunner = async (runner: Runner): Promise<void> => {
  runner.proc.kill("SIGTERM");
  await Promise.race([runner.proc.exited, sleep(8_000)]);
  if (runner.proc.exitCode === null) runner.proc.kill("SIGKILL");
  await waitFor(
    "owned ports closed",
    async () => {
      const urls = [runner.ui, runner.control, runner.rpc, runner.fake, ...runner.sourceFakes];
      const open = await Promise.all(urls.map((url) => httpOpen(url)));
      return open.every((value) => !value);
    },
    10_000,
  );
};

const setCase = async (runner: Runner, name: string): Promise<void> => {
  const response = await fetch(`${runner.control}/case/${name}`, { method: "POST" });
  if (!response.ok) throw new Error(`case ${name} failed: ${await response.text()}`);
  await response.body?.cancel();
};

const click = (cdp: Cdp, selector: string): Promise<void> =>
  evaluate(cdp, `document.querySelector(${JSON.stringify(selector)}).click()`);

const escape = async (cdp: Cdp): Promise<void> => {
  for (const type of ["keyDown", "keyUp"]) {
    await cdp.send("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  }
};

const reservePort = async (): Promise<number> => {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("reserved"),
  });
  const port = reservation.port;
  await reservation.stop(true);
  if (port === undefined) throw new Error("The port reservation did not report a port.");
  return port;
};

interface Preview {
  readonly proc: ReturnType<typeof Bun.spawn>;
  readonly url: string;
  readonly port: number;
}

const startPreview = async (rpcUrl: string): Promise<Preview> => {
  const outDir = join(run, "built-client");
  const build = Bun.spawnSync(["bun", "run", "build", "--outDir", outDir], {
    cwd: worktree,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(`bun run build failed: ${build.stderr.toString()}`);
  }
  const port = await reservePort();
  const proc = Bun.spawn({
    cmd: [
      "bun",
      "run",
      "preview",
      "--",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
      "--outDir",
      outDir,
    ],
    cwd: worktree,
    env: { ...process.env, WEAVE_DEV_RPC_URL: rpcUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const preview: Preview = { proc, url: `http://127.0.0.1:${port}/`, port };
  try {
    await waitFor("preview UI", async () => httpOpen(preview.url), 30_000);
  } catch (error) {
    await stopPreview(preview);
    throw error;
  }
  return preview;
};

const stopPreview = async (preview: Preview): Promise<void> => {
  preview.proc.kill("SIGTERM");
  await Promise.race([preview.proc.exited, sleep(5_000)]);
  if (preview.proc.exitCode === null) preview.proc.kill("SIGKILL");
  await waitFor(
    "preview port closed",
    async () => !(await httpOpen(`http://127.0.0.1:${preview.port}/`)),
    5_000,
  );
};

let captureFailure: ((name: string) => Promise<void>) | undefined;

const scenario = async (name: string, body: () => Promise<void>): Promise<void> => {
  if (only !== undefined && !only.split(",").includes(name)) return;
  try {
    await body();
    scenarios.push({ scenario: name, result: "PASS" });
    console.log(`PASS scenario=${name}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await captureFailure?.(name);
    scenarios.push({ scenario: name, result: "FAIL", error: message });
    assert(name, "scenario-completed", false, message);
    console.log(`FAIL scenario=${name} error=${message}`);
  }
};

const runnerLog = async (runner: Runner): Promise<void> => {
  writeJson("dev-mock.json", {
    ui: runner.ui,
    control: runner.control,
    rpc: runner.rpc,
    fake: runner.fake,
    log: runner.log,
  });
};

let cleanupRun: (() => Promise<boolean>) | undefined;

const glContextProbe = `
  window.__glContextCalls = 0;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    if (String(type).startsWith("webgl")) {
      window.__glContextCalls += 1;
      document.documentElement?.setAttribute("data-gl-context-calls", String(window.__glContextCalls));
    }
    return getContext.call(this, type, ...args);
  };
  addEventListener("DOMContentLoaded", () => {
    document.documentElement.setAttribute("data-gl-context-calls", String(window.__glContextCalls));
  });
`;

const main = async (): Promise<number> => {
  const codeSHA = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: worktree })
    .stdout.toString()
    .trim();
  const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: worktree })
    .stdout.toString()
    .trimEnd();
  const sourceFiles =
    status.length === 0 ? [] : status.split("\n").map((line) => line.slice(3).trim());
  const runner = await startRunner();
  const profile = mkdtempSync(join(tmpdir(), "weave-client-ui-chrome-"));
  const chrome = Bun.spawn({
    cmd: [
      chromePath,
      "--headless=new",
      "--enable-unsafe-webgpu",
      "--enable-unsafe-swiftshader",
      `--unsafely-treat-insecure-origin-as-secure=${new URL(runner.ui).origin}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  let cleanupCdp: Cdp | undefined;
  cleanupRun = async () => {
    const cleanup: Record<string, unknown> = {};
    cleanup.runnerStarted = true;
    try {
      await stopRunner(runner);
      cleanup.runnerStopped = true;
    } catch (error) {
      cleanup.runnerStopped = false;
      cleanup.runnerError = String(error);
    }
    chrome.kill("SIGTERM");
    await Promise.race([chrome.exited, sleep(3_000)]);
    if (chrome.exitCode === null) chrome.kill("SIGKILL");
    cleanupCdp?.close();
    rmSync(profile, { recursive: true, force: true });
    cleanup.chromeStopped = true;
    const survivor = join(screens, "current-desktop.png");
    cleanup.evidenceReadable = (() => {
      try {
        return readFileSync(survivor).byteLength > 0;
      } catch {
        return false;
      }
    })();
    writeJson("cleanup.json", cleanup);
    const checksReadable = (() => {
      try {
        return JSON.parse(readFileSync(join(run, "checks.json"), "utf8")).length > 0;
      } catch {
        return false;
      }
    })();
    const pass =
      cleanup.runnerStopped === true && cleanup.evidenceReadable === true && checksReadable;
    writeJson("post-cleanup.json", {
      result: pass ? "PASS" : "FAIL",
      checksReadable,
      screenshotReadable: cleanup.evidenceReadable,
    });
    return pass;
  };
  const activePort = join(profile, "DevToolsActivePort");
  await waitFor(
    "Chrome DevTools port",
    async () => {
      try {
        readFileSync(activePort);
        return true;
      } catch {
        return false;
      }
    },
    20_000,
  );
  const port = readFileSync(activePort, "utf8").split("\n")[0];
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
    type: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find((target) => target.type === "page");
  if (page === undefined) throw new Error("Chrome has no page target.");
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl);
  cleanupCdp = cdp;
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });

  let rpcPosts = 0;
  const browserErrors: Array<unknown> = [];
  const browserConsole: Array<unknown> = [];
  captureFailure = async (name) => {
    writeJson(
      `${name}-failure.json`,
      await evaluate(cdp, `({text:document.body.innerText,habitat:(${habitatExpression})??null})`),
    );
    await screenshot(cdp, `${name}-failure`);
  };
  cdp.onEvent((method, params) => {
    if (method === "Runtime.exceptionThrown") {
      browserErrors.push(params);
      writeJson("browser-errors.json", browserErrors);
    }
    if (method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(params.type)) {
      browserConsole.push(params);
      writeJson("browser-console.json", browserConsole);
    }
    if (method !== "Network.requestWillBeSent") return;
    if (params?.request?.method !== "POST") return;
    if (new URL(String(params.request.url)).pathname === "/rpc/") rpcPosts += 1;
  });

  await runnerLog(runner);
  await navigate(cdp, runner.ui);
  await screenshot(cdp, "current-desktop");

  await scenario("live", async () => {
    await waitFor("empty habitat", async () => {
      const current = await habitat(cdp);
      return current !== undefined && current.school.creatures === 0;
    });
    const empty = await habitat(cdp);
    assert(
      "live",
      "empty-feed-is-quiet",
      empty !== undefined &&
        empty.caption.visible === false &&
        !empty.drawer &&
        empty.notice === null &&
        empty.sourceControls === 1 &&
        ["connected", "connecting"].includes(
          await evaluate(cdp, `document.querySelector('.source-control')?.dataset.health`),
        ),
      "an empty feed renders a quiet tank with one non-error source disclosure and no notice",
      JSON.stringify(empty),
    );
    assert(
      "live",
      "debug-hidden-by-default",
      empty !== undefined && empty.debug === null,
      "the debug counter is absent without the debug query",
      `debug=${empty?.debug ?? "null"}`,
    );

    await setCase(runner, "current");
    await waitFor("current feed", async () => {
      const current = await habitat(cdp);
      return (
        current !== undefined && current.school.creatures === 7 && current.school.present === 7
      );
    });
    const value = await habitat(cdp);
    assert(
      "live",
      "feed-connects",
      value !== undefined && value.backend === "webgpu" && value.calls >= 1 && value.triangles > 0,
      "the real feed renders one school on a live GPU backend",
      JSON.stringify({ backend: value?.backend, calls: value?.calls, triangles: value?.triangles }),
    );
    assert(
      "live",
      "every-session-is-an-animal",
      value !== undefined && value.school.creatures === 7 && value.buttons === 7,
      "each unarchived session becomes one animal and one hidden label",
      `creatures=${value?.school.creatures} buttons=${value?.buttons}`,
    );
    assert(
      "live",
      "details-hidden-at-rest",
      value !== undefined && !value.drawer && value.caption.visible === false,
      "the drawer and bare caption are hidden until interaction",
      `drawer=${value?.drawer}`,
    );
    assert(
      "live",
      "healthy-connection-is-quiet",
      value !== undefined &&
        value.notice === null &&
        value.sourceControls === 1 &&
        (await evaluate(
          cdp,
          `document.querySelector('.source-control')?.getAttribute('aria-label')`,
        )) === "Servers: Connected",
      "a healthy feed keeps one source disclosure and no persistent problem text",
      JSON.stringify({ notice: value?.notice, controls: value?.sourceControls }),
    );
    await screenshot(cdp, "current-desktop");
  });

  await scenario("specimen", async () => {
    await setCase(runner, "current");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor("specimen school", async () => (await habitat(cdp))?.school.present === 7);
    await sleep(3000);
    const worldGeometry = () =>
      evaluate(
        cdp,
        `(() => {const s=window.__weaveHabitat,c=document.querySelector('canvas');return {rect:c.getBoundingClientRect().toJSON(),draw:[c.width,c.height],projection:s.camera.projectionMatrix.elements,world:s.camera.matrixWorld.elements};})()`,
      );
    const beforeOpen = await worldGeometry();
    await evaluate(
      cdp,
      `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Trace slow card auth,'))).click()`,
    );
    await waitFor("visible same-scene crop", async () =>
      evaluate(cdp, `document.querySelector('.specimen-window')?.dataset.visible === 'true'`),
    );
    await evaluate(cdp, `window.__weaveHabitat.stop()`);
    assert(
      "specimen",
      "desktop-world-unchanged",
      JSON.stringify(beforeOpen) === JSON.stringify(await worldGeometry()),
      "opening the desktop crop leaves the main canvas, drawing buffer and camera matrices unchanged",
    );
    await screenshot(cdp, "current-desktop");
    const samples: Array<unknown> = [];
    let specimenAperture = { x: 0, y: 0, width: 1, height: 1 };
    for (const { width, dpr } of [
      { width: 1280, dpr: 1 },
      { width: 1440, dpr: 1 },
      { width: 1920, dpr: 1 },
      { width: 1440, dpr: 2 },
    ]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await waitFor("resized specimen buffer", async () =>
        evaluate(cdp, `document.querySelector('canvas').width === ${width * Math.min(dpr, 1.5)}`),
      );
      const frame = await evaluate(
        cdp,
        `(() => {
        const s = window.__weaveHabitat;
        s.frame(s.last);
        const b = s.school.specimenOf(s.specimenWindow.key), p = b.position.clone().project(s.camera);
        const marker = document.querySelector('.specimen-tether circle');
        const card = document.querySelector('dialog').getBoundingClientRect();
        return { stats:s.stats(), crop:s.specimenView.crop.value.toArray(), destination:s.specimenView.destination.value.toArray(), target:s.specimenView.targetSize(), aperture:s.aperture.toJSON(), card:card.toJSON(), viewport:[innerWidth,innerHeight,devicePixelRatio], canvas:[document.querySelector('canvas').width,document.querySelector('canvas').height], marker:[Number(marker.getAttribute('cx')),Number(marker.getAttribute('cy'))], expected:[(p.x*.5+.5)*innerWidth,(.5-p.y*.5)*innerHeight], family:document.querySelectorAll('.tree-row,.tree-toggle,.family-more,[aria-label="Session family"]').length };
      })()`,
      );
      samples.push(frame);
      const targetRatio = Math.min(dpr, 1.5);
      const expectedTarget = [
        Math.round(frame.aperture.width * targetRatio),
        Math.round(frame.aperture.height * targetRatio),
      ];
      const cropPixels = [frame.crop[2] * frame.canvas[0], frame.crop[3] * frame.canvas[1]];
      assert(
        "specimen",
        `desktop-${width}-${dpr}`,
        frame.card.width === 340 &&
          frame.card.top === 28 &&
          frame.card.right === width - 28 &&
          frame.aperture.top - frame.card.top === frame.aperture.left - frame.card.left &&
          frame.aperture.top - frame.card.top === frame.card.right - frame.aperture.right &&
          frame.family === 0 &&
          Math.abs(frame.marker[0] - frame.expected[0]) < 0.5 &&
          Math.abs(frame.marker[1] - frame.expected[1]) < 0.5 &&
          frame.stats.backend === "webgpu" &&
          frame.target[0] === expectedTarget[0]! &&
          frame.target[1] === expectedTarget[1]! &&
          frame.target[0] >= cropPixels[0]! &&
          frame.target[1] >= cropPixels[1]!,
        "a fixed 340px inset placard and its tether align on the actual renderer, and the isolated specimen target matches the aperture's device pixels instead of upscaling the crop",
        JSON.stringify({ ...frame, expectedTarget, cropPixels }),
      );
      await screenshot(cdp, `specimen-desktop-${width}-${dpr}`);
      if (width === 1440 && dpr === 1) {
        specimenAperture = frame.aperture;
        const tetherStyles = await tetherInlineStyles(cdp);
        await hideTether(cdp);
        const overlayShot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        const overlayPng = overlayShot.result.data;
        const cardInlineVisibility = await evaluate(
          cdp,
          `document.querySelector('dialog').style.visibility`,
        );
        await evaluate(cdp, `document.querySelector('dialog').style.visibility = 'hidden'`);
        const cardVisibilityDuringCapture: string = await evaluate(
          cdp,
          `(async () => { const s=window.__weaveHabitat; s.stop(); await new Promise(requestAnimationFrame); s.view.render(); return getComputedStyle(document.querySelector('dialog')).visibility; })()`,
        );
        const boardShot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        const boardPng = boardShot.result.data;
        writeFileSync(join(screens, "specimen-board.png"), Buffer.from(boardPng, "base64"));
        await evaluate(
          cdp,
          `(() => {
            const dialog = document.querySelector('dialog');
            if (${JSON.stringify(cardInlineVisibility)}) dialog.style.visibility = ${JSON.stringify(cardInlineVisibility)};
            else dialog.style.visibility = '';
          })()`,
        );
        await restoreTether(cdp, tetherStyles);
        const crop = frame.crop as [number, number, number, number];
        const canvas = frame.canvas as [number, number];
        const cropBounds = {
          left: crop[0] * canvas[0],
          top: crop[1] * canvas[1],
          right: (crop[0] + crop[2]) * canvas[0],
          bottom: (crop[1] + crop[3]) * canvas[1],
        };
        const card = frame.card as {
          left: number;
          top: number;
          right: number;
          bottom: number;
        };
        const boardGuard = {
          cropBounds,
          card,
          intersects:
            cropBounds.left < card.right &&
            cropBounds.right > card.left &&
            cropBounds.top < card.bottom &&
            cropBounds.bottom > card.top,
          cardVisibilityDuringCapture,
          cardVisibilityRestored:
            (await evaluate(
              cdp,
              `getComputedStyle(document.querySelector('dialog')).visibility`,
            )) !== "hidden",
          tetherRestored:
            (await evaluate(
              cdp,
              `getComputedStyle(document.querySelector('.specimen-tether path')).visibility`,
            )) === "visible",
        };
        writeJson("specimen-board-guard.json", boardGuard);
        await evaluate(cdp, `window.__weaveHabitat.frame(window.__weaveHabitat.last)`);
        const appearance = await evaluate(
          cdp,
          `(async () => {
          const decode = async (base64) => {
            const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + base64)).blob());
            const canvas = new OffscreenCanvas(image.width, image.height);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return { image, rgba: context.getImageData(0, 0, image.width, image.height).data };
          };
          const board = await decode(${JSON.stringify(boardPng)});
          const overlay = await decode(${JSON.stringify(overlayPng)});
          const crop = ${JSON.stringify(frame.crop)}, aperture = ${JSON.stringify(frame.aperture)};
          const grid = 12;
          const luminance = (rgba, image, x, y) => {
            const px = Math.max(0, Math.min(image.width - 1, Math.round(x)));
            const py = Math.max(0, Math.min(image.height - 1, Math.round(y)));
            const index = (py * image.width + px) * 4;
            return (rgba[index] + rgba[index + 1] + rgba[index + 2]) / 3;
          };
          const cells = (rgba, image, x, y, width, height) => {
            const values = [];
            for (let row = 0; row < grid; row += 1) for (let column = 0; column < grid; column += 1) {
              let total = 0, count = 0;
              for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) {
                total += luminance(rgba, image, x + (column + dx / 5 + 0.5) / grid * width, y + (row + dy / 5 + 0.5) / grid * height);
                count += 1;
              }
              values.push(total / count);
            }
            return values;
          };
          const card=${JSON.stringify(frame.card)};
          let samples=0,delta=0;
          for(let y=80;y<board.image.height-40;y+=8)for(let x=80;x<board.image.width-40;x+=8){
            if(x>=card.left-20&&x<=card.right+20&&y>=card.top-20&&y<=card.bottom+20)continue;
            const a=luminance(board.rgba,board.image,x,y),b=luminance(overlay.rgba,overlay.image,x,y);
            if(a>10){samples++;delta+=Math.abs(a-b);}
          }
          return {
            board: cells(board.rgba, board.image, crop[0] * board.image.width, crop[1] * board.image.height, crop[2] * board.image.width, crop[3] * board.image.height),
            specimen: cells(overlay.rgba, overlay.image, aperture.x, aperture.y, aperture.width, aperture.height),
            preservedBoard:{samples,meanAbsoluteError:delta/samples},
          };
        })()`,
        );
        assert(
          "specimen",
          "overlay-preserves-board",
          appearance.preservedBoard.samples > 100 &&
            appearance.preservedBoard.meanAbsoluteError < 1,
          "opening the linear specimen overlay preserves the already-composited board outside the placard instead of replacing it through an implicit fullscreen conversion",
          JSON.stringify(appearance.preservedBoard),
        );
        const mean = (values: ReadonlyArray<number>): number =>
          values.reduce((total, value) => total + value, 0) / values.length;
        const boardMean = mean(appearance.board);
        const specimenMean = mean(appearance.specimen);
        let covariance = 0;
        let boardVariance = 0;
        let specimenVariance = 0;
        for (let index = 0; index < appearance.board.length; index += 1) {
          const boardDelta = appearance.board[index] - boardMean;
          const specimenDelta = appearance.specimen[index] - specimenMean;
          covariance += boardDelta * specimenDelta;
          boardVariance += boardDelta * boardDelta;
          specimenVariance += specimenDelta * specimenDelta;
        }
        const correlation = covariance / Math.sqrt(boardVariance * specimenVariance);
        const meanAbsoluteError = mean(
          appearance.board.map((value: number, index: number) =>
            Math.abs(value - appearance.specimen[index]),
          ),
        );
        const centroid = (values: ReadonlyArray<number>): [number, number] => {
          const floor = Math.min(...values);
          let x = 0;
          let y = 0;
          let weight = 0;
          for (let index = 0; index < values.length; index += 1) {
            const value = Math.max(0, values[index]! - floor);
            x += value * (index % 12);
            y += value * Math.floor(index / 12);
            weight += value;
          }
          return [x / weight, y / weight];
        };
        const boardCentroid = centroid(appearance.board);
        const specimenCentroid = centroid(appearance.specimen);
        const poseShift = Math.hypot(
          boardCentroid[0] - specimenCentroid[0],
          boardCentroid[1] - specimenCentroid[1],
        );
        const bright = appearance.specimen.filter((value: number) => value > 90).length;
        const specimenMin = Math.min(...appearance.specimen);
        const specimenMax = Math.max(...appearance.specimen);
        const pixels = {
          correlation,
          meanAbsoluteError,
          poseShift,
          bright,
          specimenMin,
          specimenMax,
          boardMean,
          specimenMean,
        };
        writeJson("specimen-appearance.json", pixels);
        assert(
          "specimen",
          "downsampled-appearance-and-pose",
          correlation > 0.3 &&
            meanAbsoluteError < 20 &&
            poseShift < 1.5 &&
            specimenMax - specimenMin > 8 &&
            appearance.specimen.length === 144 &&
            boardGuard.cardVisibilityDuringCapture === "hidden" &&
            boardGuard.cardVisibilityRestored === true &&
            boardGuard.tetherRestored === true,
          "the isolated specimen keeps the board's downsampled pose and appearance without requiring identical pixels, with the card measured hidden for the board capture",
          JSON.stringify({ pixels, boardGuard }),
        );
        const closeup = await cdp.send("Page.captureScreenshot", {
          format: "png",
          clip: {
            x: frame.card.x,
            y: frame.card.y,
            width: frame.card.width,
            height: frame.card.height,
            scale: 1,
          },
        });
        writeFileSync(
          join(screens, "specimen-closeup.png"),
          Buffer.from(closeup.result.data, "base64"),
        );
      }
    }
    writeJson("specimen-desktops.json", samples);
    const work = async () =>
      evaluate(
        cdp,
        `(async () => {
      await new Promise(requestAnimationFrame);
      const s=window.__weaveHabitat, r=s.renderer, school=s.school;
      const beforeState={target:r.getRenderTarget(),autoClear:r.autoClear,toneMapping:r.toneMapping,color:r.outputColorSpace,viewport:r.getViewport(s.specimenView.previousViewport.clone()).toArray()};
      const render=r.render, sync=school.syncInstances, advance=school.advance;
      let sceneDraws=0, specimenDraws=0, overlayDraws=0, resolveDraws=0, specimenDrawCalls=0, renders=0, syncs=0, steps=0;
      r.render=function(current,...args){
        const camera=args[0], before=r.info.render.drawCalls;
        renders++;
        if(current===s.scene)sceneDraws++;else if(current===s.specimenView?.quad)overlayDraws++;else resolveDraws++;
        const result=render.call(this,current,...args);
        if(camera===s.specimenView?.camera){specimenDraws++;specimenDrawCalls+=r.info.render.drawCalls-before;}
        return result;
      };
      school.syncInstances=function(){syncs++;return sync.call(this)};
      school.advance=function(dt){steps++;return advance.call(this,dt)};
      try{
        s.frame(s.last);
        const layerObjects=s.scene.children.filter(object=>(object.layers.mask&2)!==0&&object.visible===true&&object.isMesh===true);
        let specimenMeshes=0, specimenBackgroundMeshes=0, specimenDoubleSided=0, specimenSingleSided=0, expectedSpecimenDrawCalls=0;
        for(const object of layerObjects){
          const material=object.material;
          if(material===undefined||material.visible===false)continue;
          const passes=material.transparent===true&&material.side===2&&material.forceSinglePass!==true?2:1;
          expectedSpecimenDrawCalls+=passes;
          if(object.isInstancedMesh===true){specimenMeshes++;if(passes===2)specimenDoubleSided++;else specimenSingleSided++;}
          else specimenBackgroundMeshes++;
        }
        if(!s.specimenWindow)expectedSpecimenDrawCalls=0;
        const pass=s.specimenView?.view.pass;
        const rendererRestored=r.getRenderTarget()===beforeState.target&&r.autoClear===beforeState.autoClear&&r.toneMapping===beforeState.toneMapping&&r.outputColorSpace===beforeState.color&&JSON.stringify(r.getViewport(s.specimenView.previousViewport.clone()).toArray())===JSON.stringify(beforeState.viewport);
        return {sceneDraws,specimenDraws,overlayDraws,resolveDraws,specimenMeshes,specimenBackgroundMeshes,specimenDoubleSided,specimenSingleSided,specimenDrawCalls,expectedSpecimenDrawCalls,renders,syncs,steps,target:s.specimenView?.targetSize(),compositorTarget:pass?[pass.renderTarget.width,pass.renderTarget.height]:null,linear:s.specimenView?.view.pipeline.outputColorTransform===false,rendererRestored,stats:s.stats(),selected:!!s.specimenWindow};
      }
      finally{r.render=render;school.syncInstances=sync;school.advance=advance;}
    })()`,
      );
    const selectedWork = await work();
    assert(
      "specimen",
      "one-board-one-specimen-one-overlay",
      selectedWork.sceneDraws === 4 &&
        selectedWork.specimenDraws === 2 &&
        selectedWork.overlayDraws === 1 &&
        selectedWork.resolveDraws === 2 &&
        selectedWork.renders === 7 &&
        selectedWork.syncs === 1 &&
        selectedWork.steps <= 2 &&
        selectedWork.specimenMeshes === 2 &&
        selectedWork.specimenBackgroundMeshes === 2 &&
        selectedWork.specimenDoubleSided === 2 &&
        selectedWork.specimenSingleSided === 0 &&
        selectedWork.specimenDrawCalls === selectedWork.expectedSpecimenDrawCalls &&
        selectedWork.target?.[0] > 0 &&
        selectedWork.linear &&
        selectedWork.rendererRestored &&
        JSON.stringify(selectedWork.compositorTarget) === JSON.stringify(selectedWork.target),
      "board and specimen each submit a default scene pass, an OIT accumulation pass, and a resolve; the aperture-sized linear specimen keeps derived double-sided hardware draws, one overlay, and one instance sync",
      JSON.stringify(selectedWork),
    );
    const motionBefore = await evaluate(
      cdp,
      `window.__weaveHabitat.specimenView.crop.value.toArray()`,
    );
    const motionAfter = await evaluate(
      cdp,
      `(() => {const s=window.__weaveHabitat;s.stop();for(let index=0;index<12;index+=1)s.frame(s.last+1000/60);const p=s.school.specimenOf(s.specimenWindow.key).position.clone().project(s.camera);return {crop:s.specimenView.crop.value.toArray(), expected:[p.x*.5+.5,.5-p.y*.5]};})()`,
    );
    assert(
      "specimen",
      "motion-stays-centered",
      JSON.stringify(motionBefore) !== JSON.stringify(motionAfter.crop) &&
        Math.abs(motionAfter.crop[0] + motionAfter.crop[2] / 2 - motionAfter.expected[0]) <
          0.00001 &&
        Math.abs(motionAfter.crop[1] + motionAfter.crop[3] / 2 - motionAfter.expected[1]) < 0.00001,
      "the crop moves with the actual selected body without a frame of lag",
      JSON.stringify({ motionBefore, motionAfter }),
    );
    const phaseTetherStyles = await tetherInlineStyles(cdp);
    const phaseFrames: Array<{ bucket: number; turns: number; data: string }> = [];
    await hideTether(cdp);
    try {
      for (let index = 0; index < 56; index += 1) {
        const meta = await evaluate(
          cdp,
          `(() => {const s=window.__weaveHabitat;s.frame(s.last+1000/60);const b=s.school.specimenOf(s.specimenWindow.key);return {bucket:b.bucket,turns:b.turns};})()`,
        );
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "png",
          clip: {
            x: specimenAperture.x,
            y: specimenAperture.y,
            width: specimenAperture.width,
            height: specimenAperture.height,
            scale: 1,
          },
        });
        phaseFrames.push({ bucket: meta.bucket, turns: meta.turns, data: shot.result.data });
      }
    } finally {
      await restoreTether(cdp, phaseTetherStyles);
    }
    const phaseDiff = await evaluate(
      cdp,
      `(async () => {
      const images = ${JSON.stringify(phaseFrames.map((frame) => frame.data))};
      const width = ${Math.round(specimenAperture.width)};
      const height = ${Math.round(specimenAperture.height)};
      const decode = async (base64) => {
        const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + base64)).blob());
        const canvas = new OffscreenCanvas(width, height);
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const rgba = context.getImageData(0, 0, width, height).data;
        const values = new Float32Array(width * height);
        for (let index = 0; index < values.length; index += 1) {
          const offset = index * 4;
          values[index] = (rgba[offset] + rgba[offset + 1] + rgba[offset + 2]) / 3;
        }
        return values;
      };
      const frames = [];
      for (const image of images) frames.push(await decode(image));
      const means = [], maxes = [];
      for (let index = 1; index < frames.length; index += 1) {
        const previous = frames[index - 1], current = frames[index];
        let total = 0, maximum = 0;
        for (let pixel = 0; pixel < current.length; pixel += 1) {
          const delta = Math.abs(current[pixel] - previous[pixel]);
          total += delta;
          if (delta > maximum) maximum = delta;
        }
        means.push(total / current.length);
        maxes.push(maximum);
      }
      return { means, maxes };
    })()`,
    );
    const boundaryDiffs: Array<{ index: number; mean: number; max: number }> = [];
    const ordinaryDiffs: Array<{ index: number; mean: number; max: number }> = [];
    for (let index = 1; index < phaseFrames.length; index += 1) {
      const diff = {
        index,
        mean: phaseDiff.means[index - 1]!,
        max: phaseDiff.maxes[index - 1]!,
      };
      if (phaseFrames[index]!.bucket !== phaseFrames[index - 1]!.bucket) boundaryDiffs.push(diff);
      else ordinaryDiffs.push(diff);
    }
    const average = (rows: ReadonlyArray<{ mean: number }>): number =>
      rows.reduce((total, row) => total + row.mean, 0) / Math.max(1, rows.length);
    const boundaryMean = average(boundaryDiffs);
    const ordinaryMean = average(ordinaryDiffs);
    const boundaryMax = Math.max(0, ...boundaryDiffs.map((row) => row.mean));
    const ordinaryMax = Math.max(0, ...ordinaryDiffs.map((row) => row.mean));
    writeJson("specimen-phase-motion.json", {
      boundaryMean,
      ordinaryMean,
      boundaryMax,
      ordinaryMax,
      boundaries: boundaryDiffs,
      frames: phaseFrames.map(({ bucket, turns }) => ({ bucket, turns })),
    });
    assert(
      "specimen",
      "continuous-phase-motion",
      boundaryDiffs.length > 0 &&
        ordinaryMean > 0.02 &&
        boundaryMean < ordinaryMean * 1.8 + 0.2 &&
        boundaryMax < ordinaryMax * 1.8 + 1 &&
        boundaryMean < 1.5,
      "a bucket boundary changes the specimen no more than ordinary per-frame motion, so the eight phase shapes blend continuously",
      JSON.stringify({
        boundaryMean,
        ordinaryMean,
        boundaryMax,
        ordinaryMax,
        boundaries: boundaryDiffs,
      }),
    );
    const target = await evaluate(
      cdp,
      `(() => {
      const s=window.__weaveHabitat;window.specimenDialog=document.querySelector('dialog');
      return s.bodies().filter(b=>b.key!==s.specimenWindow.key).map(b=>{const p=s.school.specimenOf(b.key).position.clone().project(s.camera);const x=(p.x*.5+.5)*innerWidth,y=(.5-p.y*.5)*innerHeight;return {key:b.key,x,y,hit:s.pickAt(x,y)}}).find(p=>p.key===p.hit);
    })()`,
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: target.x,
      y: target.y,
      button: "left",
      clickCount: 1,
    });
    await waitFor("another jelly updates placard", async () =>
      evaluate(cdp, `window.__weaveHabitat.specimenWindow.key === ${JSON.stringify(target.key)}`),
    );
    const switchedWork = await work();
    assert(
      "specimen",
      "one-nonmodal-placard",
      (await evaluate(
        cdp,
        `document.querySelector('dialog')===window.specimenDialog && document.querySelectorAll('dialog').length===1 && !document.querySelector('dialog').matches(':modal')`,
      )) &&
        switchedWork.specimenMeshes === 2 &&
        switchedWork.specimenDrawCalls === switchedWork.expectedSpecimenDrawCalls,
      "a real ray-hit on another jelly updates the existing nonmodal placard and leaves the two specimen layer meshes drawing their derived material passes",
      JSON.stringify({
        specimenMeshes: switchedWork.specimenMeshes,
        specimenDrawCalls: switchedWork.specimenDrawCalls,
        expectedSpecimenDrawCalls: switchedWork.expectedSpecimenDrawCalls,
      }),
    );
    const offscreen = await evaluate(
      cdp,
      `(() => {
      const s=window.__weaveHabitat,b=s.school.specimenOf(s.specimenWindow.key),old=b.position.clone();
      const read=()=>({visible:document.querySelector('.specimen-window').dataset.visible, tether:getComputedStyle(document.querySelector('.specimen-tether path')).visibility});
      const hidden=[];
      for(const position of [[100,0,0],[0,0,s.camera.position.z+1]]){b.position.set(...position);s.frame(s.last);hidden.push(read());}
      b.position.copy(old);s.frame(s.last);return {hidden,restored:read()};
    })()`,
    );
    assert(
      "specimen",
      "offscreen-and-behind-hidden",
      offscreen.hidden.every(
        (value: { visible: string; tether: string }) =>
          value.visible === "false" && value.tether === "hidden",
      ) &&
        offscreen.restored.visible === "true" &&
        offscreen.restored.tether === "visible",
      "an offscreen or behind-camera selection hides both crop and tether, and restoring the body shows them again",
      JSON.stringify(offscreen),
    );
    await evaluate(
      cdp,
      `window.retainedSpecimen=window.__weaveHabitat.specimenView;window.retainedSpecimenTitle=window.__weaveHabitat.school.bodies.get(window.__weaveHabitat.specimenWindow.key).model.session.title`,
    );
    await escape(cdp);
    await waitFor("crop closed", async () =>
      evaluate(cdp, `!window.__weaveHabitat.specimenWindow`),
    );
    const closedWork = await work();
    writeJson("specimen-work.json", { selectedWork, closedWork });
    assert(
      "specimen",
      "closed-has-no-crop-work",
      closedWork.sceneDraws === 2 &&
        closedWork.specimenDraws === 0 &&
        closedWork.overlayDraws === 0 &&
        closedWork.resolveDraws === 1 &&
        closedWork.renders === 3 &&
        closedWork.syncs === 1 &&
        closedWork.target?.[0] === 0 &&
        closedWork.specimenMeshes === 0 &&
        closedWork.specimenDrawCalls === 0 &&
        closedWork.expectedSpecimenDrawCalls === 0 &&
        !closedWork.selected &&
        closedWork.rendererRestored,
      "closing removes all specimen submissions and leaves only the board default, accumulation, and resolve with one instance sync",
      JSON.stringify(closedWork),
    );
    assert(
      "specimen",
      "closed-releases-attachments-retains-pipeline",
      closedWork.target?.[0] === 0 &&
        closedWork.target?.[1] === 0 &&
        JSON.stringify(closedWork.compositorTarget) === "[1,1]" &&
        (await evaluate(cdp, `window.__weaveHabitat.specimenView===window.retainedSpecimen`)),
      "closing releases the specimen output and shrinks compositor attachments to 1x1 without discarding the warmed view",
      JSON.stringify({ selectedTarget: selectedWork.target, closedTarget: closedWork.target }),
    );
    const reopens: Array<{
      reopened: Awaited<ReturnType<typeof work>>;
      closed: Awaited<ReturnType<typeof work>>;
    }> = [];
    for (let index = 0; index < 3; index++) {
      await evaluate(
        cdp,
        `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(button=>button.textContent.startsWith(window.retainedSpecimenTitle+','))).click()`,
      );
      await waitFor("reopened crop", async () =>
        evaluate(cdp, `!!window.__weaveHabitat.specimenWindow`),
      );
      const reopened = await work();
      await escape(cdp);
      await waitFor("reclosed crop", async () =>
        evaluate(cdp, `!window.__weaveHabitat.specimenWindow`),
      );
      const closed = await work();
      reopens.push({ reopened, closed });
    }
    writeJson("specimen-reopens.json", reopens);
    const releasedMemory = closedWork.stats.memory;
    assert(
      "specimen",
      "reopens-recreate-only-bounded-attachments",
      reopens.every(
        ({ reopened, closed }) =>
          reopened.renders === 7 &&
          reopened.specimenDraws === 2 &&
          reopened.overlayDraws === 1 &&
          reopened.specimenMeshes === 2 &&
          reopened.specimenDrawCalls === reopened.expectedSpecimenDrawCalls &&
          reopened.target?.[0] === selectedWork.target?.[0] &&
          reopened.stats.memory.textures > closed.stats.memory.textures &&
          reopened.stats.memory.textures === reopens[0]?.reopened.stats.memory.textures &&
          reopened.resolveDraws === 2 &&
          reopened.rendererRestored &&
          JSON.stringify(reopened.compositorTarget) === JSON.stringify(reopened.target) &&
          closed.renders === 3 &&
          closed.resolveDraws === 1 &&
          closed.rendererRestored &&
          closed.specimenDraws === 0 &&
          closed.overlayDraws === 0 &&
          closed.specimenMeshes === 0 &&
          closed.specimenDrawCalls === 0 &&
          closed.target?.[0] === 0 &&
          closed.target?.[1] === 0 &&
          JSON.stringify(closed.compositorTarget) === "[1,1]" &&
          JSON.stringify(closed.stats.memory) === JSON.stringify(releasedMemory),
      ) && (await evaluate(cdp, `window.__weaveHabitat.specimenView===window.retainedSpecimen`)),
      "three reopens rebuild the specimen target at the same size with the two layer meshes and their derived draws, then return to the released target and the exact pre-reopen renderer texture, geometry and total memory",
      JSON.stringify({ releasedMemory, reopens }),
    );
    await evaluate(cdp, `window.__weaveHabitat.start()`);
    await setCase(runner, "specimen-context");
    await waitFor("empty title fixture", async () =>
      evaluate(
        cdp,
        `Boolean([...document.querySelectorAll('[aria-label="Sessions"] button')].find(b=>b.textContent.startsWith('Untitled session,')))`,
      ),
    );
    await evaluate(
      cdp,
      `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(b=>b.textContent.startsWith('Untitled session,'))).click()`,
    );
    assert(
      "specimen",
      "empty-title",
      await evaluate(
        cdp,
        `document.querySelector('.sheet-title-button').textContent==='Untitled session'`,
      ),
      "an empty actual title has a useful fallback",
    );
    await evaluate(
      cdp,
      `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(b=>b.textContent.startsWith('Inspect the selected session'))).click()`,
    );
    assert(
      "specimen",
      "long-context-fits",
      await evaluate(
        cdp,
        `document.querySelector('dialog').getBoundingClientRect().width===340 && document.documentElement.scrollWidth===innerWidth && document.querySelector('.folder-tooltip').textContent==='/Users/mira/Code/a-project-with-a-long-directory-name/another-long-component/weave'`,
      ),
      "a long real title and path do not change the card width or overflow the viewport",
    );
    await screenshot(cdp, "specimen-long-context");
    await escape(cdp);
    await setCase(runner, "current");
    await waitFor("trace restored", async () =>
      evaluate(
        cdp,
        `Boolean([...document.querySelectorAll('[aria-label="Sessions"] button')].find(b=>b.textContent.startsWith('Trace slow card auth,')))`,
      ),
    );
    await evaluate(
      cdp,
      `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(b=>b.textContent.startsWith('Trace slow card auth,'))).click()`,
    );
    await setCase(runner, "delete");
    await waitFor("removed selection closes placard", async () =>
      evaluate(
        cdp,
        `!document.querySelector('dialog') && !window.__weaveHabitat.specimenWindow && !document.querySelector('.specimen-tether')`,
      ),
    );
    assert(
      "specimen",
      "removed-selection",
      true,
      "removing the selected session closes the placard, tether and crop pass",
    );
    await setCase(runner, "current");
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  });

  await scenario("debug", async () => {
    await navigate(cdp, `${runner.ui}?debug=1`);
    await waitFor("debug SPS sample", async () => {
      const current = await habitat(cdp);
      return (
        current !== undefined &&
        typeof current.debug === "string" &&
        debugPattern.test(current.debug)
      );
    });
    const value = await habitat(cdp);
    assert(
      "debug",
      "debug-counter-samples",
      value !== undefined && typeof value.debug === "string" && debugPattern.test(value.debug),
      "the debug query shows SPS, FPS and frame interval from a closed wall-clock sample",
      `debug=${value?.debug ?? "null"}`,
    );
    await screenshot(cdp, "debug-counter");

    await navigate(cdp, runner.ui);
    await waitFor("habitat without debug", async () => {
      const current = await habitat(cdp);
      return current !== undefined && current.debug === null;
    });
    const quiet = await habitat(cdp);
    assert(
      "debug",
      "debug-query-is-the-only-switch",
      quiet !== undefined && quiet.debug === null,
      "reloading without the debug query removes the detailed counter",
      `debug=${quiet?.debug ?? "null"}`,
    );
    await waitFor("default FPS sample", async () =>
      evaluate(
        cdp,
        `/^FPS \\d+$/.test(document.querySelector('[data-debug="fps"]')?.textContent ?? '')`,
      ),
    );
    assert(
      "debug",
      "default-fps-counter",
      await evaluate(
        cdp,
        `/^FPS \\d+$/.test(document.querySelector('[data-debug="fps"]')?.textContent ?? '')`,
      ),
      "the default view shows sampled FPS without simulation or frame interval details",
    );
  });

  await scenario("update", async () => {
    const traceOf = (current: Habitat | undefined) =>
      current?.bodies.find((body) => body.key === "local:ses_payments_trace");

    await setCase(runner, "idle");
    await waitFor("trace idle", async () => traceOf(await habitat(cdp))?.status === "idle");
    const before = await habitat(cdp);

    await setCase(runner, "running");
    await waitFor("trace running", async () => traceOf(await habitat(cdp))?.status === "running");
    const after = await habitat(cdp);

    assert(
      "update",
      "event-visible",
      before !== undefined &&
        after !== undefined &&
        traceOf(before)?.status === "idle" &&
        traceOf(after)?.status === "running" &&
        after.school.creatures === before.school.creatures,
      "a live event marks the same animal running without resetting the school",
      `creatures=${before?.school.creatures}->${after?.school.creatures} status=${traceOf(before)?.status}->${traceOf(after)?.status}`,
    );
  });

  await scenario("interaction", async () => {
    await evaluate(
      cdp,
      `(() => {
      const scene = window.__weaveHabitat;
      const canvas = document.querySelector('canvas');
      const buttons = [...document.querySelectorAll('[aria-label="Sessions"] button')];
      const bodies = scene.bodies();
      const rect = canvas.getBoundingClientRect();
      const target = bodies.map(body => {
        const point = scene.school.specimenOf(body.key).position.clone().project(scene.camera);
        const x = (point.x * .5 + .5) * rect.width + rect.left;
        const y = (.5 - point.y * .5) * rect.height + rect.top;
        return { x, y, key: scene.pickAt(x, y) };
      }).find(point => point.key !== undefined);
      const hoveredTitle = scene.school.bodies.get(target.key).model.session.title;
      const hoveredIndex = buttons.findIndex(button => button.textContent.split(',')[0] === hoveredTitle);
      const focusIndex = (hoveredIndex + 1) % buttons.length;
      window.interactionProbe = {
        target, focusIndex, picks: 0,
        focusedTitle: buttons[focusIndex].textContent.split(',')[0],
        hoveredTitle,
        pickAt: scene.pickAt.bind(scene),
      };
      scene.pickAt = (...args) => { window.interactionProbe.picks++; return window.interactionProbe.pickAt(...args); };
      buttons[focusIndex].focus();
    })()`,
    );
    await evaluate(
      cdp,
      `(() => {
      const {x, y} = window.interactionProbe.target;
      const canvas = document.querySelector('canvas');
      for (let i = 0; i < 2; i++) canvas.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'mouse', clientX:x, clientY:y}));
    })()`,
    );
    assert(
      "interaction",
      "keyboard-priority-and-pointer-throttle",
      await evaluate(
        cdp,
        `(() => {
      const card = document.querySelector('.habitat-caption');
      return card.textContent === window.interactionProbe.focusedTitle && card.dataset.focused === 'true' && window.interactionProbe.picks === 1 && getComputedStyle(document.querySelector('canvas')).cursor === 'pointer';
    })()`,
      ),
      "keyboard focus wins over a real pointer hit, which sets the pointer cursor; two immediate moves admit one raycast",
    );
    await evaluate(cdp, `document.activeElement.blur()`);
    await waitFor("pointer preview after blur", async () =>
      evaluate(
        cdp,
        `(() => {const card=document.querySelector('.habitat-caption'),style=getComputedStyle(card);return card.textContent === window.interactionProbe.hoveredTitle && style.visibility !== 'hidden' && style.display !== 'none';})()`,
      ),
    );
    assert(
      "interaction",
      "blur-falls-back-to-pointer",
      (await habitat(cdp))?.caption.visible === true,
      "blur reveals the retained pointer preview",
    );
    await evaluate(
      cdp,
      `document.querySelector('canvas').dispatchEvent(new PointerEvent('pointerout', {bubbles:true, pointerType:'mouse', relatedTarget:document.body}))`,
    );
    assert(
      "interaction",
      "leave-dismisses-preview-immediately",
      await evaluate(
        cdp,
        `document.querySelector('.habitat-caption').hidden && getComputedStyle(document.querySelector('canvas')).cursor !== 'pointer'`,
      ),
      "leaving the canvas clears pointer preview and cursor without a dismissal timer",
    );
    await sleep(100);
    const click = await evaluate(
      cdp,
      `(() => {
      const scene = window.__weaveHabitat;
      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const bodies = scene.bodies();
      const target = bodies.map(body => {
        const point = scene.school.specimenOf(body.key).position.clone().project(scene.camera);
        const x = (point.x * .5 + .5) * rect.width + rect.left;
        const y = (.5 - point.y * .5) * rect.height + rect.top;
        return {x, y, key: window.interactionProbe.pickAt(x, y)};
      }).find(point => point.key !== undefined);
      window.interactionProbe.hoveredTitle = scene.school.bodies.get(target.key).model.session.title;
      const {x, y} = target;
      canvas.dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'mouse', clientX:x, clientY:y}));
      const before = window.interactionProbe.picks;
      canvas.dispatchEvent(new MouseEvent('click', {bubbles:true, clientX:x, clientY:y}));
      return {before, after:window.interactionProbe.picks};
    })()`,
    );
    await waitFor("pointer click opens drawer", async () => (await habitat(cdp))?.drawer === true);
    assert(
      "interaction",
      "click-bypasses-pointer-throttle",
      click.after === click.before + 1,
      "an immediate click performs its own real raycast and opens the drawer",
      JSON.stringify(click),
    );
    await escape(cdp);
    await waitFor(
      "close reveals pointer preview",
      async () => (await habitat(cdp))?.caption.visible === true,
    );
    assert(
      "interaction",
      "close-retains-preview",
      await evaluate(
        cdp,
        `document.querySelector('.habitat-caption').textContent === window.interactionProbe.hoveredTitle`,
      ),
      "closing the drawer reveals the retained pointer preview",
    );
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await waitFor(
      "Escape clears preview",
      async () => (await habitat(cdp))?.caption.visible === false,
    );
    await evaluate(cdp, `document.querySelector('[aria-label="Sessions"] button').click()`);
    await waitFor("cursor with placard open", async () => (await habitat(cdp))?.drawer === true);
    await sleep(100);
    await evaluate(
      cdp,
      `(() => {
      const scene = window.__weaveHabitat;
      const target = scene.bodies().map(body => {
        const p = scene.school.specimenOf(body.key).position.clone().project(scene.camera);
        const x = (p.x * .5 + .5) * innerWidth;
        const y = (.5 - p.y * .5) * innerHeight;
        return {x, y, key:window.interactionProbe.pickAt(x, y)};
      }).find(point => point.key !== undefined);
      document.querySelector('canvas').dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'mouse', clientX:target.x, clientY:target.y}));
    })()`,
    );
    assert(
      "interaction",
      "selected-hover-cursor",
      await evaluate(
        cdp,
        `getComputedStyle(document.querySelector('canvas')).cursor === 'pointer' && !!document.querySelector('dialog[open]') && document.querySelector('.habitat-caption').hidden`,
      ),
      "a valid hover sets the pointer cursor without replacing the open placard with a preview",
    );
    await sleep(100);
    await evaluate(
      cdp,
      `document.querySelector('canvas').dispatchEvent(new PointerEvent('pointermove', {bubbles:true, pointerType:'mouse', clientX:1, clientY:1}))`,
    );
    assert(
      "interaction",
      "background-cursor",
      await evaluate(
        cdp,
        `window.interactionProbe.pickAt(1, 1) === undefined && getComputedStyle(document.querySelector('canvas')).cursor !== 'pointer'`,
      ),
      "a real background miss clears the pointer cursor while the placard stays open",
    );
    await escape(cdp);
    await evaluate(
      cdp,
      `window.__weaveHabitat.pickAt = window.interactionProbe.pickAt; delete window.interactionProbe`,
    );
  });

  await scenario("drawer", async () => {
    await waitFor("drawer feed", async () => (await habitat(cdp))?.school.present === 7);
    await cdp.send("Browser.grantPermissions", {
      origin: new URL(runner.ui).origin,
      permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
    });
    const openTrace = async () => {
      await evaluate(
        cdp,
        `(() => {
        const button = [...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Trace slow card auth,'));
        button.focus(); button.click();
      })()`,
      );
      await waitFor("open session drawer", async () =>
        evaluate(cdp, 'Boolean(document.querySelector("dialog[open]"))'),
      );
    };
    await openTrace();
    assert(
      "drawer",
      "no-close-control",
      await evaluate(cdp, `!document.querySelector('[aria-label="Close session details"]')`),
      "the open placard has no close control",
    );
    const openFocus = await evaluate(
      cdp,
      `(() => {
      const dialog = document.querySelector('dialog');
      const title = document.querySelector('.sheet-title-button');
      return { activeIsDialog: document.activeElement === dialog, titleFocused: document.activeElement === title, dialogOutlineStyle: getComputedStyle(dialog).outlineStyle };
    })()`,
    );
    assert(
      "drawer",
      "open-focuses-dialog",
      openFocus.activeIsDialog &&
        !openFocus.titleFocused &&
        openFocus.dialogOutlineStyle === "none",
      "opening the drawer focuses the non-editable dialog without a container focus ring, not its copy title",
      JSON.stringify(openFocus),
    );
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Tab",
      code: "Tab",
      windowsVirtualKeyCode: 9,
    });
    assert(
      "drawer",
      "tab-reaches-title",
      await evaluate(
        cdp,
        `(() => {
        const title = document.querySelector('.sheet-title-button');
        return document.activeElement === title && title.matches(':focus-visible') && getComputedStyle(title).outlineStyle !== 'none';
      })()`,
      ),
      "Tab moves from the dialog to the copy title with a visible focus outline",
    );
    const context = await evaluate(
      cdp,
      `(() => ({
      title: document.querySelector('.sheet-title-button').textContent,
      folder: document.querySelector('.folder-name').textContent,
      path: document.querySelector('.folder-tooltip').textContent,
      pathHidden: getComputedStyle(document.querySelector('.folder-tooltip')).visibility === 'hidden',
      source: document.querySelector('.context-source').textContent,
      family: document.querySelector('[aria-label="Session family"]'),
      status: document.querySelector('.status-dot').getAttribute('aria-label'),
    }))()`,
    );
    assert(
      "drawer",
      "typed-session-context",
      context.title === "Trace slow card auth" &&
        context.folder === "payments" &&
        context.path === "/Users/mira/Code/payments" &&
        context.pathHidden &&
        context.status === "Running" &&
        context.family === null &&
        context.source === "local",
      "selected child shows its actual source, basename and status without a family list",
      JSON.stringify(context),
    );
    const folderBounds = await evaluate(
      cdp,
      `document.querySelector('.context-folder').getBoundingClientRect().toJSON()`,
    );
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: folderBounds.x + 10,
      y: folderBounds.y + 10,
    });
    assert(
      "drawer",
      "path-on-hover",
      await evaluate(
        cdp,
        `getComputedStyle(document.querySelector('.folder-tooltip')).visibility === 'visible'`,
      ),
      "pointer hover reveals the full directory path",
    );
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 20 });
    await evaluate(cdp, `document.querySelector('.context-folder').focus()`);
    const theme = await evaluate(
      cdp,
      `(() => {
      const drawer = getComputedStyle(document.querySelector('.sheet-header'));
      const context = getComputedStyle(document.querySelector('.sheet-context'));
      const tooltip = getComputedStyle(document.querySelector('.folder-tooltip'));
      const luminance = value => value.match(/[\\d.]+/g).slice(0,3).map(Number).map(channel => {
        const s = channel / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
      }).reduce((sum, channel, index) => sum + channel * [.2126,.7152,.0722][index], 0);
      const contrast = (fg,bg) => { const a = luminance(fg), b = luminance(bg); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); };
      return { room: getComputedStyle(document.body).backgroundColor, card: drawer.backgroundColor, popover: tooltip.backgroundColor,
        text: contrast(drawer.color, drawer.backgroundColor), muted: contrast(context.color, drawer.backgroundColor),
        tooltip: contrast(tooltip.color, tooltip.backgroundColor) };
    })()`,
    );
    writeJson("theme-contrast.json", theme);
    assert(
      "drawer",
      "shared-neutral-theme-contrast",
      theme.room === "rgb(3, 4, 4)" &&
        theme.card === "rgb(12, 12, 11)" &&
        theme.popover === "rgb(17, 17, 16)" &&
        theme.text >= 4.5 &&
        theme.muted >= 4.5 &&
        theme.tooltip >= 4.5,
      "shared near-black and stone tokens keep text at 4.5:1 or better",
      JSON.stringify(theme),
    );
    assert(
      "drawer",
      "path-on-focus",
      await evaluate(
        cdp,
        `getComputedStyle(document.querySelector('.folder-tooltip')).visibility === 'visible'`,
      ),
      "keyboard focus reveals the full path without an expanded row",
    );
    await screenshot(cdp, "drawer-desktop");
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await waitFor("drawer closes", async () => !(await habitat(cdp))?.drawer);
    assert(
      "drawer",
      "escape-restores-focus",
      await evaluate(
        cdp,
        `document.activeElement?.textContent.startsWith('Trace slow card auth,')`,
      ),
      "Escape restores the original session control",
    );
    await openTrace();
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: 10,
      y: 10,
      button: "left",
      clickCount: 1,
    });
    await cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: 10,
      y: 10,
      button: "left",
      clickCount: 1,
    });
    await waitFor("desktop outside closes placard", async () => !(await habitat(cdp))?.drawer);
    assert(
      "drawer",
      "desktop-outside-dismisses",
      !(await habitat(cdp))?.drawer,
      "clicking empty water dismisses the desktop placard",
    );

    await evaluate(
      cdp,
      `(() => {
        const opener = [...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Collect changelog,'));
        opener.focus(); opener.click();
      })()`,
    );
    await waitFor("grandchild placard", async () =>
      evaluate(
        cdp,
        `document.querySelector('.sheet-parent-button')?.textContent === 'Draft changes'`,
      ),
    );
    await evaluate(cdp, `window.parentHopDialog = document.querySelector('dialog')`);
    await screenshot(cdp, "parent-child");
    for (const [key, title, parent] of [
      ["local:ses_harbor_mid", "Draft changes", "Release notes"],
      ["local:ses_harbor", "Release notes", null],
    ]) {
      if (parent !== null) {
        const bounds = await evaluate(
          cdp,
          `document.querySelector('.sheet-parent-button').getBoundingClientRect().toJSON()`,
        );
        for (const type of ["mousePressed", "mouseReleased"]) {
          await cdp.send("Input.dispatchMouseEvent", {
            type,
            x: bounds.x + bounds.width / 2,
            y: bounds.y + bounds.height / 2,
            button: "left",
            clickCount: 1,
          });
        }
      } else {
        await evaluate(cdp, `document.querySelector('.sheet-parent-button').focus()`);
        for (const type of ["keyDown", "keyUp"]) {
          await cdp.send("Input.dispatchKeyEvent", {
            type,
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            ...(type === "keyDown" ? { text: "\r", unmodifiedText: "\r" } : {}),
          });
        }
      }
      await waitFor(`parent specimen ${key}`, async () =>
        evaluate(
          cdp,
          `(() => {
            const scene = window.__weaveHabitat, school = scene.school;
            const selected = [...school.bodies.values()].filter(body => body.slot >= 0 && school.buckets[body.bucket].emphasis[body.slot] === 1).map(body => body.key);
            return scene.specimenWindow?.key === ${JSON.stringify(key)} && selected.join() === ${JSON.stringify(key)};
          })()`,
        ),
      );
      const state = await evaluate(
        cdp,
        `(() => {
          const scene = window.__weaveHabitat, school = scene.school, dialog = document.querySelector('dialog'), parent = document.querySelector('.sheet-parent-button');
          return {
            title: document.querySelector('.sheet-title-button')?.textContent,
            parent: parent?.textContent ?? null,
            label: parent?.getAttribute('aria-label'),
            underlined: parent && getComputedStyle(parent).textDecorationLine.includes('underline'),
            selected: [...school.bodies.values()].filter(body => body.slot >= 0 && school.buckets[body.bucket].emphasis[body.slot] === 1).map(body => body.key),
            focused: document.activeElement === dialog,
            retained: dialog === window.parentHopDialog
          };
        })()`,
      );
      assert(
        "drawer",
        parent === null
          ? "enter-selects-parent-and-root-omits-row"
          : "pointer-selects-immediate-parent",
        state.title === title &&
          state.parent === parent &&
          state.selected.join() === key &&
          state.focused &&
          state.retained &&
          (parent === null ||
            (state.label === `Go to parent session: ${parent}` && state.underlined)),
        "parent navigation updates the title, selection and specimen, retaining dialog focus",
        JSON.stringify(state),
      );
      if (parent !== null) await screenshot(cdp, "parent-selected");
    }
    await escape(cdp);
    await waitFor("parent navigation closes", async () => !(await habitat(cdp))?.drawer);
    assert(
      "drawer",
      "parent-hop-escape-restores-original-opener",
      await evaluate(cdp, `document.activeElement?.textContent.startsWith('Collect changelog,')`),
      "Escape after two parent hops restores the original grandchild opener",
    );

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(250);
    const geometry = () =>
      evaluate(
        cdp,
        `(() => {
      const canvas = document.querySelector('canvas');
      const scene = window.__weaveHabitat;
      return { rect: canvas.getBoundingClientRect().toJSON(), draw: [canvas.width, canvas.height], projection: scene.camera.projectionMatrix.elements, world: scene.camera.matrixWorld.elements };
    })()`,
      );
    const closed = await geometry();
    await screenshot(cdp, "drawer-mobile-closed");
    await openTrace();
    const opened = await geometry();
    await escape(cdp);
    await waitFor("mobile Escape closes sheet", async () => !(await habitat(cdp))?.drawer);
    assert(
      "drawer",
      "mobile-escape-dismisses-without-resize",
      JSON.stringify(closed) === JSON.stringify(await geometry()),
      "Escape dismisses the mobile sheet without changing the canvas or camera",
    );
    await openTrace();
    const before = await evaluate(
      cdp,
      `({ title: document.querySelector('.sheet-title-button').getBoundingClientRect().toJSON(), panel: document.querySelector('dialog').getBoundingClientRect().toJSON() })`,
    );
    await evaluate(cdp, `document.querySelector('.sheet-title-button').focus()`);
    await evaluate(
      cdp,
      `(() => {
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      window.clipboardWrites = 0;
      navigator.clipboard.writeText = (text) => { window.clipboardWrites += 1; return write(text); };
    })()`,
    );
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await waitFor(
      "copy toast",
      async () =>
        (await evaluate(cdp, `document.querySelector('.copy-toast')?.textContent`)) ===
        "Session context copied",
    );
    const copied = await evaluate(cdp, `navigator.clipboard.readText()`);
    const updated = await evaluate(cdp, `document.querySelector('.context-time time').dateTime`);
    const expected = `Title: Trace slow card auth\nSession ID: ses_payments_trace\nSource ID: local\nDirectory: /Users/mira/Code/payments\nParent ID: ses_payments\nStatus: Running\nUpdated: ${updated}`;
    assert(
      "drawer",
      "native-title-copies-context",
      copied === expected && (await evaluate(cdp, "window.clipboardWrites")) === 1,
      "Enter on the title copies the exact available typed fields and omits absent last run and outcome",
      JSON.stringify({ copied, expected }),
    );
    const after = await evaluate(
      cdp,
      `({ title: document.querySelector('.sheet-title-button').getBoundingClientRect().toJSON(), panel: document.querySelector('dialog').getBoundingClientRect().toJSON() })`,
    );
    assert(
      "drawer",
      "toast-has-no-layout-shift",
      JSON.stringify(before) === JSON.stringify(after),
      "copy confirmation leaves the title and panel bounds identical",
      JSON.stringify({ before, after }),
    );
    assert(
      "drawer",
      "mobile-projection-unchanged",
      JSON.stringify(closed) === JSON.stringify(opened) &&
        JSON.stringify(closed) === JSON.stringify(await geometry()),
      "opening, focus and copy leave the mobile canvas, drawing buffer and camera matrices unchanged",
    );
    assert(
      "drawer",
      "mobile-width-fits",
      await evaluate(
        cdp,
        `document.documentElement.scrollWidth === innerWidth && Math.abs(document.querySelector('dialog').getBoundingClientRect().height - innerHeight * .47) < 1`,
      ),
      "the fixed 47svh sheet causes no horizontal overflow",
    );
    await screenshot(cdp, "drawer-mobile-copy");
    await sleep(1400);
    await evaluate(cdp, `document.querySelector('.sheet-title-button').click()`);
    await waitFor("repeat copy", async () => (await evaluate(cdp, "window.clipboardWrites")) === 2);
    await sleep(1400);
    assert(
      "drawer",
      "repeat-copy-restarts-dismissal",
      await evaluate(
        cdp,
        `document.querySelector('.copy-toast')?.textContent === 'Session context copied'`,
      ),
      "an identical copy message remains visible past the first message's timeout",
    );
    await waitFor("repeated toast dismissed", async () =>
      evaluate(cdp, `!document.querySelector('.copy-toast')`),
    );
    assert(
      "drawer",
      "toast-auto-dismisses",
      await evaluate(cdp, `!document.querySelector('.copy-toast')`),
      "the replacement copy feedback dismisses after its own timeout",
    );
    await evaluate(
      cdp,
      `(() => {
      navigator.clipboard.writeText = async () => { throw new DOMException('Clipboard denied', 'NotAllowedError'); };
      document.querySelector('.sheet-title-button').click();
    })()`,
    );
    await waitFor(
      "clipboard failure toast",
      async () =>
        (await evaluate(cdp, `document.querySelector('.copy-toast')?.textContent`)) ===
        "Could not copy session context",
    );
    assert(
      "drawer",
      "clipboard-failure-is-honest",
      (await habitat(cdp))?.drawer === true,
      "clipboard denial shows a failure message and leaves the session drawer open",
    );
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: 10, y: 10 }],
    });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await waitFor("outside closes sheet", async () => !(await habitat(cdp))?.drawer);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    assert(
      "drawer",
      "outside-touch-closes-without-resize",
      JSON.stringify(closed) === JSON.stringify(await geometry()),
      "tapping empty water closes the sheet without changing the canvas or camera",
    );

    await setCase(runner, "specimen-context");
    await waitFor("long mobile title fixture", async () =>
      evaluate(
        cdp,
        `Boolean([...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Inspect the selected session')))`,
      ),
    );
    await evaluate(
      cdp,
      `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Inspect the selected session'))).click()`,
    );
    await waitFor("long mobile sheet open", async () => (await habitat(cdp))?.drawer === true);
    const sheetGeometry = () =>
      evaluate(
        cdp,
        `(() => {
        const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
        return { dialog: box('dialog'), title: box('.sheet-title-button'),
          provenance: box('.sheet-provenance'),
          tooltip: box('.folder-tooltip'), frame: getComputedStyle(document.querySelector('.specimen-frame')).display,
          overflowY: getComputedStyle(document.querySelector('dialog')).overflowY,
          viewport: [innerWidth, innerHeight] };
      })()`,
      );
    const titleGeometry = await sheetGeometry();
    assert(
      "drawer",
      "long-title-fits-sheet",
      titleGeometry.title.left >= 0 &&
        titleGeometry.title.right <= 390 &&
        titleGeometry.title.bottom <= titleGeometry.dialog.bottom,
      "a real long Latin title fits the mobile sheet without a reserved close target",
      JSON.stringify(titleGeometry),
    );
    await evaluate(
      cdp,
      `document.querySelector('.sheet-title-button').textContent = '接続状態の長いタイトルを確認するための非常に長い日本語の見出しです'`,
    );
    const cjkGeometry = await sheetGeometry();
    assert(
      "drawer",
      "cjk-title-fits-sheet",
      cjkGeometry.title.left >= 0 &&
        cjkGeometry.title.right <= 390 &&
        cjkGeometry.title.bottom <= cjkGeometry.dialog.bottom,
      "a long CJK title fits the mobile sheet",
      JSON.stringify(cjkGeometry),
    );
    await evaluate(
      cdp,
      `document.querySelector('.sheet-title-button').textContent = 'Inspect the selected session without losing its place in the shared tank, even when its real title runs across several lines'`,
    );
    await evaluate(cdp, `document.querySelector('.context-folder').focus()`);
    await waitFor("mobile folder tooltip", async () =>
      evaluate(
        cdp,
        `getComputedStyle(document.querySelector('.folder-tooltip')).visibility === 'visible'`,
      ),
    );
    const tooltipGeometry = await sheetGeometry();
    assert(
      "drawer",
      "tooltip-clears-provenance",
      tooltipGeometry.tooltip.top >= tooltipGeometry.provenance.bottom + 7.9 &&
        tooltipGeometry.tooltip.bottom <= tooltipGeometry.dialog.bottom &&
        tooltipGeometry.tooltip.left >= 0 &&
        tooltipGeometry.tooltip.right <= 390,
      "the folder path tooltip hangs below provenance with an 8px gap instead of covering source and time",
      JSON.stringify(tooltipGeometry),
    );
    await screenshot(cdp, "drawer-mobile-tooltip");

    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 844,
      height: 390,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(250);
    await evaluate(cdp, `document.querySelector('.context-folder').focus()`);
    const landscape = await sheetGeometry();
    assert(
      "drawer",
      "landscape-sheet-fits",
      landscape.frame === "none" &&
        landscape.overflowY === "visible" &&
        landscape.dialog.bottom <= 390 &&
        landscape.provenance.bottom <= 390 &&
        landscape.tooltip.bottom <= 390 &&
        landscape.title.left >= 0 &&
        landscape.title.right <= 844 &&
        landscape.title.bottom <= 390,
      "at 844x390 the hidden specimen and short placard keep provenance, title and tooltip inside the viewport",
      JSON.stringify(landscape),
    );
    await screenshot(cdp, "drawer-landscape");
    await escape(cdp);
    await waitFor("landscape sheet closed", async () => !(await habitat(cdp))?.drawer);
    await setCase(runner, "current");
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  });

  await scenario("palette-family-selection", async () => {
    await setCase(runner, "attention");
    await waitFor(
      "typed attention",
      async () => (await habitat(cdp))?.bodies.filter((body) => body.attention).length === 2,
    );
    await sleep(3500);
    await evaluate(
      cdp,
      `(() => {
      const button = [...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Collect changelog,'));
      button.focus(); button.click();
    })()`,
    );
    await waitFor("grandchild selected", async () =>
      evaluate(
        cdp,
        `document.querySelector('.sheet-title-button')?.textContent === 'Collect changelog'`,
      ),
    );

    const marks = (): Promise<
      ReadonlyArray<{ key: string; emphasis: number; warm: number; energy: number }>
    > =>
      evaluate(
        cdp,
        `(() => {
      const school = window.__weaveHabitat.school;
      return [...school.bodies.values()].map(body => {
        const slot = school.order[body.bucket].indexOf(body);
        return { key: body.key, emphasis: school.buckets[body.bucket].emphasis[slot], warm: school.buckets[body.bucket].warm[slot], energy: school.buckets[body.bucket].energy[slot] };
      });
    })()`,
      );
    await sleep(100);
    const selected = await marks();
    assert(
      "palette-family-selection",
      "selected-and-immediate-parent",
      selected.filter((body) => body.emphasis > 0).length === 2 &&
        selected.some((body) => body.key === "local:ses_harbor_grand" && body.emphasis === 1) &&
        selected.some(
          (body) => body.key === "local:ses_harbor_mid" && Math.abs(body.emphasis - 0.38) < 0.001,
        ),
      "only the selected grandchild and its immediate parent have instance emphasis",
      JSON.stringify(selected),
    );
    assert(
      "palette-family-selection",
      "typed-state-instance-controls",
      selected.some((body) => body.key === "local:ses_harbor_grand" && body.warm < -0.9) &&
        selected.some((body) => body.key === "local:ses_payments_trace" && body.warm > 0.9) &&
        selected.some((body) => body.key === "local:ses_design" && body.energy > 0.6) &&
        selected.some((body) => body.key === "local:ses_harbor" && body.energy === 0),
      "question, permission, active and idle retain separate instance controls from the typed feed",
    );

    await evaluate(cdp, `window.__weaveHabitat.stop()`);
    const poses = await evaluate(cdp, `JSON.stringify(window.__weaveHabitat.bodies())`);
    const palettes: Array<{
      name: string;
      tint: Array<number>;
      source: Array<number>;
      memory: Habitat["memory"];
    }> = [];
    for (const [name, seconds] of [
      ["cyan", 0],
      ["blue", 40],
      ["violet", 80],
      ["mint", 120],
    ] as const) {
      palettes.push(
        await evaluate(
          cdp,
          `(async () => {
        const scene = window.__weaveHabitat;
        scene.kreisel.lightSeconds = ${seconds}; scene.kreisel.advance(0);
        scene.frame(scene.last);
        const {habitatSource} = await import('/src/client/habitat/source.ts');
        return { name: '${name}', tint: habitatSource.tint.value.toArray(), source: habitatSource.white.value.toArray(), memory: scene.stats().memory };
      })()`,
        ),
      );
      await screenshot(cdp, `palette-${name}`);
    }
    assert(
      "palette-family-selection",
      "light-clock-independent",
      poses === (await evaluate(cdp, `JSON.stringify(window.__weaveHabitat.bodies())`)),
      "four palette phases redraw identical animal poses without advancing motion",
    );
    assert(
      "palette-family-selection",
      "four-colors-same-resources",
      new Set(palettes.map((value) => JSON.stringify(value.tint))).size === 4 &&
        palettes.every(
          (value) => JSON.stringify(value.memory) === JSON.stringify(palettes[0]?.memory),
        ),
      "water and source uniforms change without resource allocation",
      JSON.stringify(palettes),
    );
    writeJson("palette-samples.json", palettes);
    const wrappedTint = await evaluate(
      cdp,
      `(async () => {
      const scene = window.__weaveHabitat; scene.kreisel.advance(40);
      const {habitatSource} = await import('/src/client/habitat/source.ts');
      return habitatSource.tint.value.toArray();
    })()`,
    );
    assert(
      "palette-family-selection",
      "palette-wraps-to-cyan",
      JSON.stringify(wrappedTint) === JSON.stringify(palettes[0]?.tint),
      "the 160-second cycle returns to exactly the initial cyan without resetting the motion clock",
    );
    await evaluate(cdp, `window.__weaveHabitat.start()`);

    await evaluate(
      cdp,
      `delete navigator.clipboard.writeText; document.querySelector('.sheet-title-button').click()`,
    );
    await waitFor("grandchild context copied", async () =>
      evaluate(
        cdp,
        `document.querySelector('.copy-toast')?.textContent === 'Session context copied'`,
      ),
    );
    const grandchildCopy = await evaluate(cdp, `navigator.clipboard.readText()`);
    assert(
      "palette-family-selection",
      "related-selection-copy",
      grandchildCopy.includes("Title: Collect changelog\n") &&
        grandchildCopy.includes("Parent ID: ses_harbor_mid\n") &&
        grandchildCopy.includes("Attention: 1 question pending\n"),
      "the selected grandchild copies its own title, immediate parent and typed question count",
      grandchildCopy,
    );
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(250);
    const mobileGeometry = () =>
      evaluate(
        cdp,
        `(() => {
      const canvas = document.querySelector('canvas'); const scene = window.__weaveHabitat;
      return JSON.stringify({rect: canvas.getBoundingClientRect().toJSON(), draw: [canvas.width, canvas.height], projection: scene.camera.projectionMatrix.elements, world: scene.camera.matrixWorld.elements});
    })()`,
      );
    const mobileBefore = await mobileGeometry();
    await screenshot(cdp, "family-mobile");

    await evaluate(
      cdp,
      `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Release notes,'))).click()`,
    );
    await waitFor("root selected", async () =>
      evaluate(
        cdp,
        `document.querySelector('.sheet-title-button').textContent === 'Release notes'`,
      ),
    );
    await sleep(100);
    const rootMarks = await marks();
    assert(
      "palette-family-selection",
      "root-has-no-parent",
      rootMarks.filter((body) => body.emphasis > 0).length === 1 &&
        rootMarks.some((body) => body.key === "local:ses_harbor" && body.emphasis === 1),
      "selecting another session updates the actual instance and clears the old child and parent marks",
      JSON.stringify(rootMarks),
    );
    await escape(cdp);
    await sleep(100);
    assert(
      "palette-family-selection",
      "close-clears-emphasis",
      (await marks()).every((body) => body.emphasis === 0),
      "closing the drawer clears selection and parent together",
    );
    assert(
      "palette-family-selection",
      "mobile-selection-does-not-resize-world",
      mobileBefore === (await mobileGeometry()),
      "related selection and close leave mobile canvas and camera unchanged",
    );
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await setCase(runner, "current");
    await sleep(2500);
  });

  await scenario("lifecycle", async () => {
    await setCase(runner, "current");
    await waitFor("lifecycle settled", async () => (await habitat(cdp))?.school.present === 7);

    await setCase(runner, "delete");
    await waitFor("animal departs", async () => (await habitat(cdp))?.school.departing !== 0);
    await waitFor("animal gone", async () => (await habitat(cdp))?.school.creatures === 6);
    const gone = await habitat(cdp);
    assert(
      "lifecycle",
      "departure-only-on-absence",
      gone !== undefined && gone.school.creatures === 6 && gone.school.departing === 0,
      "an animal leaves only after the authoritative feed drops its key",
      JSON.stringify(gone?.school),
    );
    await screenshot(cdp, "one-departed");

    await setCase(runner, "current");
    await waitFor("animal arrives", async () => (await habitat(cdp))?.school.present === 7);
    const returned = await habitat(cdp);

    const goneKeys = new Set(gone?.bodies.map((body) => body.key) ?? []);
    let compared = 0;
    let maxDrift = 0;
    for (const body of returned?.bodies ?? []) {
      if (!goneKeys.has(body.key)) continue;
      const prior = gone?.bodies.find((candidate) => candidate.key === body.key);
      if (prior === undefined) continue;
      compared += 1;
      maxDrift = Math.max(
        maxDrift,
        Math.hypot(
          body.position.x - prior.position.x,
          body.position.y - prior.position.y,
          body.position.z - prior.position.z,
        ),
      );
    }
    assert(
      "lifecycle",
      "retained-identities-keep-pose",
      compared >= 5 && maxDrift < 0.6,
      "animals that stayed keep their pose across a replacement feed",
      `compared=${compared} maxDrift=${maxDrift.toFixed(3)}`,
    );
    assert(
      "lifecycle",
      "returned-animal-is-a-new-body",
      returned !== undefined &&
        returned.bodies.some((body) => !goneKeys.has(body.key)) &&
        returned.school.present === 7,
      "the returned key arrives as one animal, not a duplicate",
      `creatures=${returned?.school.creatures} present=${returned?.school.present}`,
    );

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await setCase(runner, "delete");
      await waitFor("repeated departure", async () => (await habitat(cdp))?.school.creatures === 6);
      await setCase(runner, "current");
      await waitFor("repeated return", async () => (await habitat(cdp))?.school.present === 7);
    }
    const cycled = await habitat(cdp);
    assert(
      "lifecycle",
      "repeated-cycles-hold-resources",
      returned !== undefined && cycled !== undefined && sameResources(returned, cycled),
      "two more departure and return cycles leave renderer and school resources unchanged",
      JSON.stringify({
        before: returned?.memory,
        after: cycled?.memory,
        capacity: cycled?.school.capacity,
        meshes: cycled?.school.meshes,
      }),
    );
    await screenshot(cdp, "returned");
  });

  await scenario("crowded-family", async () => {
    await setCase(runner, "crowded-family");
    await waitFor("700 live animals", async () => (await habitat(cdp))?.school.present === 700);
    await sleep(3500);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1450,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await navigate(cdp, runner.ui);
    await waitFor("balanced drawing buffer", async () =>
      evaluate(
        cdp,
        `window.__weaveHabitat?.stats().school.present === 700 && document.querySelector('canvas').width === 2175`,
      ),
    );
    const quality = await evaluate(
      cdp,
      `(() => { const s = window.__weaveHabitat, c = document.querySelector('canvas'); return {detail: s.stats().school.detail, css: [c.clientWidth,c.clientHeight], drawing: [c.width,c.height]}; })()`,
    );
    assert(
      "crowded-family",
      "balanced-quality",
      JSON.stringify(quality) ===
        JSON.stringify({
          detail: {
            rows: 12,
            cols: 36,
            armStations: 6,
            armColumns: 7,
          },
          css: [1450, 900],
          drawing: [2175, 1350],
        }),
      "700 animals use the approved Balanced A anatomy and a 1.5 pixel-ratio cap on a 2x display",
      JSON.stringify(quality),
    );
    await screenshot(cdp, "balanced-desktop");
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await evaluate(
      cdp,
      `(() => {
      const button = [...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Family grandchild,'));
      button.focus(); button.click();
    })()`,
    );
    await waitFor("crowded specimen selected", async () =>
      evaluate(
        cdp,
        `document.querySelector('.sheet-title-button')?.textContent === 'Family grandchild'`,
      ),
    );
    const crowdedPlacard = await evaluate(
      cdp,
      `({width:document.querySelector('dialog').getBoundingClientRect().width, family:document.querySelectorAll('.tree-row, .tree-toggle, .family-more').length})`,
    );
    assert(
      "crowded-family",
      "bounded-specimen-ui",
      crowdedPlacard.width === 340 && crowdedPlacard.family === 0,
      "700 animals retain one fixed-width placard without family rows or paging",
      JSON.stringify(crowdedPlacard),
    );
    await escape(cdp);
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(250);
    const worldGeometry = `(() => { const c = document.querySelector('canvas'), s = window.__weaveHabitat; return JSON.stringify({ rect: c.getBoundingClientRect().toJSON(), draw: [c.width,c.height], projection: s.camera.projectionMatrix.elements, world: s.camera.matrixWorld.elements, page: [scrollX, scrollY] }); })()`;
    const beforeOpen = await evaluate(cdp, worldGeometry);
    await evaluate(
      cdp,
      `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith('Family grandchild,'))).click()`,
    );
    await waitFor("mobile selected specimen", async () =>
      evaluate(cdp, `Boolean(document.querySelector('dialog[open]'))`),
    );
    assert(
      "crowded-family",
      "selected-specimen-mobile",
      beforeOpen === (await evaluate(cdp, worldGeometry)),
      "mobile selection keeps the page, canvas and camera unchanged",
    );
    await screenshot(cdp, "crowded-family-mobile");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor("desktop specimen restored", async () =>
      evaluate(cdp, `document.querySelector('.specimen-window')?.dataset.visible === 'true'`),
    );
    await screenshot(cdp, "crowded-family");
    const sampleFrames = () =>
      evaluate(
        cdp,
        `new Promise(resolve => {
      const scene = window.__weaveHabitat, school = scene.school;
      let memoryBefore;
      const frame = scene.frame, advance = school.advance, sync = school.syncInstances;
      const render = scene.renderer.render;
      const samples = []; let frames = 0, schoolMs = 0, instanceMs = 0;
      let sceneDraws=0, specimenDraws=0, overlayDraws=0, resolveDraws=0, syncs=0;
      scene.renderer.render = function(current,...args) {
        const camera=args[0];
        if(current===scene.scene)sceneDraws++;else if(current===scene.specimenView?.quad)overlayDraws++;else resolveDraws++;
        if(camera===scene.specimenView?.camera)specimenDraws++;
        return render.call(this,current,...args);
      };
      school.advance = function(dt) { const start = performance.now(); advance.call(this, dt); schoolMs += performance.now() - start; };
      school.syncInstances = function() { syncs++; const start = performance.now(); sync.call(this); instanceMs += performance.now() - start; };
      scene.frame = function(now) {
        schoolMs = 0; instanceMs = 0; sceneDraws=0; specimenDraws=0; overlayDraws=0; resolveDraws=0; syncs=0;
        const start = performance.now(); frame.call(this, now);
        const frameMs = performance.now() - start;
        if (++frames === 60) memoryBefore=scene.stats().memory;
        if (frames > 60) samples.push({ frameMs, schoolMs, instanceMs, sceneDraws, specimenDraws, overlayDraws, resolveDraws, syncs });
        if (samples.length < 240) return;
        scene.frame = frame; school.advance = advance; school.syncInstances = sync; scene.renderer.render = render;
        const p95 = key => samples.map(row => row[key]).sort((a,b) => a-b)[Math.floor(samples.length * .95)];
        const distinct = key => [...new Set(samples.map(row=>row[key]))];
        resolve({ frames: samples.length, sceneDraws:distinct('sceneDraws'), specimenDraws:distinct('specimenDraws'), overlayDraws:distinct('overlayDraws'), resolveDraws:distinct('resolveDraws'), syncs:distinct('syncs'), selected:!!scene.specimenWindow, frameCpuP95: p95('frameMs'), schoolCpuP95: p95('schoolMs'), instanceCpuP95: p95('instanceMs'),
          stats: scene.stats(), memoryBefore, browser: navigator.userAgent, viewport: [innerWidth,innerHeight,devicePixelRatio] });
      };
    })`,
      );
    const selectedSample = await sampleFrames();
    await escape(cdp);
    const sample = await sampleFrames();
    writeJson("crowded-frame-sample.json", { selectedSample, closedSample: sample });
    assert(
      "crowded-family",
      "700-rendered-with-bounded-meshes",
      sample.stats.backend === "webgpu" &&
        sample.stats.school.present === 700 &&
        sample.stats.school.creatures === 700 &&
        sample.stats.school.meshes === 29 &&
        JSON.stringify(sample.stats.school.buckets.slice(8)) === "[0,0]" &&
        sample.stats.drawCalls > 0 &&
        sample.stats.triangles > 0,
      "a 240-frame post-warmup CPU submission sample renders all 700 fixture animals through 29 meshes, with both static species cells empty, on WebGPU",
      JSON.stringify(sample),
    );
    assert(
      "crowded-family",
      "flat-sampled-resources",
      JSON.stringify(sample.memoryBefore) === JSON.stringify(sample.stats.memory),
      "engine resource counters stay flat during the bounded 240-frame sample",
    );
    assert(
      "crowded-family",
      "selected-view-is-bounded",
      selectedSample.selected &&
        !sample.selected &&
        selectedSample.stats.school.present === 700 &&
        JSON.stringify(selectedSample.sceneDraws) === "[4]" &&
        JSON.stringify(selectedSample.specimenDraws) === "[2]" &&
        JSON.stringify(selectedSample.overlayDraws) === "[1]" &&
        JSON.stringify(selectedSample.syncs) === "[1]" &&
        JSON.stringify(selectedSample.resolveDraws) === "[2]" &&
        JSON.stringify(sample.sceneDraws) === "[2]" &&
        JSON.stringify(sample.specimenDraws) === "[0]" &&
        JSON.stringify(sample.overlayDraws) === "[0]" &&
        JSON.stringify(sample.resolveDraws) === "[1]" &&
        JSON.stringify(sample.syncs) === "[1]" &&
        JSON.stringify(selectedSample.memoryBefore) === JSON.stringify(selectedSample.stats.memory),
      "selected 700-animal frames add one isolated default/accumulation/resolve sequence and one overlay, closed frames retain only the board sequence, and both sync once with flat resources",
      JSON.stringify({ selectedSample, closedSample: sample }),
    );
    await setCase(runner, "current");
    const started = Date.now();
    const restoration: Array<{ elapsedMs: number; school: Habitat["school"] | undefined }> = [];
    try {
      await waitFor(
        "small school restored",
        async () => {
          const value = await habitat(cdp);
          restoration.push({ elapsedMs: Date.now() - started, school: value?.school });
          return value?.school.creatures === 7;
        },
        60_000,
      );
    } finally {
      writeJson("crowded-restoration.json", restoration);
    }
  });

  await scenario("reduced-palette", async () => {
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    await navigate(cdp, runner.ui);
    await waitFor("reduced-motion school", async () => (await habitat(cdp))?.school.present === 7);
    const fixed = await evaluate(
      cdp,
      `(async () => {
      const scene = window.__weaveHabitat; scene.stop();
      const {habitatSource} = await import('/src/client/habitat/source.ts');
      const before = habitatSource.tint.value.toArray(); scene.kreisel.advance(80);
      const after = habitatSource.tint.value.toArray(); scene.start(); return {before, after};
    })()`,
    );
    assert(
      "reduced-palette",
      "stationary-palette",
      JSON.stringify(fixed.before) === JSON.stringify(fixed.after),
      "prefers-reduced-motion keeps the palette stationary while the simulation can continue",
      JSON.stringify(fixed),
    );
    await cdp.send("Emulation.setEmulatedMedia", { features: [] });
  });

  await scenario("preview", async () => {
    const preview = await startPreview(runner.rpc);
    try {
      await navigate(cdp, preview.url);
      await waitFor("preview canvas", async () =>
        evaluate(
          cdp,
          `(() => {
            const canvas = document.querySelector("canvas");
            return Boolean(canvas && canvas.width > 0 && canvas.height > 0);
          })()`,
        ),
      );
      const built = await evaluate(
        cdp,
        `(() => ({
          assets: [...document.scripts].some((script) => script.src.includes("/assets/")),
          devClient: [...document.scripts].some((script) => script.src.includes("/@vite/client")),
          devHook: Boolean(window.__weaveHabitat),
          debug: document.querySelector('[data-debug="sps"]')?.textContent ?? null,
          title: document.title,
          canvas: (() => { const canvas = document.querySelector("canvas"); return canvas ? [canvas.width, canvas.height] : null; })(),
        }))()`,
      );
      assert(
        "preview",
        "serves-built-habitat",
        built.assets === true &&
          built.devClient === false &&
          built.devHook === false &&
          built.debug === null &&
          built.title === "Weave" &&
          Array.isArray(built.canvas) &&
          built.canvas[0] > 0,
        "the built preview mounts the habitat without the dev inspection hook or debug counter",
        JSON.stringify(built),
      );
      await screenshot(cdp, "preview-desktop");

      await navigate(cdp, `${preview.url}?debug=1`);
      await waitFor("preview debug sample", async () => {
        const text = await evaluate(
          cdp,
          `document.querySelector('[data-debug="sps"]')?.textContent ?? null`,
        );
        return typeof text === "string" && debugPattern.test(text);
      });
      const previewDebug = await evaluate(
        cdp,
        `(() => ({
          debug: document.querySelector('[data-debug="sps"]')?.textContent ?? null,
          devHook: Boolean(window.__weaveHabitat),
        }))()`,
      );
      assert(
        "preview",
        "preview-debug-counter",
        typeof previewDebug.debug === "string" &&
          debugPattern.test(previewDebug.debug) &&
          previewDebug.devHook === false,
        "the built preview shows primitive SPS and FPS stats with the debug query and keeps the dev hook absent",
        JSON.stringify(previewDebug),
      );
      await screenshot(cdp, "preview-debug");
    } finally {
      await stopPreview(preview);
    }
  });

  await scenario("webgpu-required", async () => {
    const injection = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        Object.defineProperty(navigator, "gpu", { configurable: true, get: () => undefined });
        ${glContextProbe}
      })()`,
    });
    try {
      await navigate(cdp, runner.ui);
      await waitFor(
        "connected feed without WebGPU",
        async () =>
          (await evaluate(
            cdp,
            `document.querySelector(".source-control")?.dataset.health === "connected"`,
          )) === true,
      );
      await sleep(1000);
      const state = await evaluate(
        cdp,
        `(() => ({
          habitat: window.__weaveHabitat !== undefined,
          glContextCalls: window.__glContextCalls,
          glDomSentinel: document.documentElement.dataset.glContextCalls,
          notice: document.querySelector('[data-renderer="unavailable"]') !== null,
        }))()`,
      );
      assert(
        "webgpu-required",
        "no-webgl-fallback",
        state.habitat === false &&
          state.glContextCalls === 0 &&
          state.glDomSentinel === "0" &&
          state.notice === true,
        "without navigator.gpu the app creates no habitat, requests no WebGL or WebGL2 context, and shows the renderer notice",
        JSON.stringify(state),
      );
    } finally {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: injection.result.identifier,
      });
    }
  });

  await scenario("webgpu-init-failed", async () => {
    const injection = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        Object.defineProperty(navigator, "gpu", {
          configurable: true,
          get: () => ({ requestAdapter: async () => null }),
        });
        ${glContextProbe}
      })()`,
    });
    try {
      await navigate(cdp, runner.ui);
      await waitFor(
        "connected feed with a failing WebGPU adapter",
        async () =>
          (await evaluate(
            cdp,
            `document.querySelector(".source-control")?.dataset.health === "connected"`,
          )) === true,
      );
      await sleep(1000);
      const state = await evaluate(
        cdp,
        `(() => ({
          habitat: window.__weaveHabitat !== undefined,
          glContextCalls: window.__glContextCalls,
          glDomSentinel: document.documentElement.dataset.glContextCalls,
          notice: document.querySelector('[data-renderer="unavailable"]') !== null,
        }))()`,
      );
      assert(
        "webgpu-init-failed",
        "no-webgl-fallback",
        state.habitat === false &&
          state.glContextCalls === 0 &&
          state.glDomSentinel === "0" &&
          state.notice === true,
        "a null WebGPU adapter creates no habitat, requests no WebGL or WebGL2 context, and shows the renderer notice",
        JSON.stringify(state),
      );
    } finally {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
        identifier: injection.result.identifier,
      });
    }
  });

  await scenario("scene", async () => {
    await cdp.send("Network.enable");
    rpcPosts = 0;
    const instrumentation = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        window.__devices = [];
        window.__glContextCalls = 0;
        window.__adapterInfo = null;
        const getContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function(type, ...args) {
          if (String(type).startsWith("webgl")) window.__glContextCalls += 1;
          return getContext.call(this, type, ...args);
        };
        const requestAdapter = GPU.prototype.requestAdapter;
        GPU.prototype.requestAdapter = async function(...args) {
          const adapter = await requestAdapter.apply(this, args);
          const info = adapter?.info ?? {};
          window.__adapterInfo = adapter === null ? null : {
            vendor: info.vendor ?? "",
            architecture: info.architecture ?? "",
            device: info.device ?? "",
            description: info.description ?? "",
          };
          return adapter;
        };
        const requestDevice = GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice = async function(...args) {
          const device = await requestDevice.apply(this, args);
          const record = { lost: null, destroys: 0 };
          window.__devices.push(record);
          const destroy = device.destroy.bind(device);
          device.destroy = () => { record.destroys++; return destroy(); };
          device.lost.then(info => record.lost = info.reason);
          return device;
        };
      })()`,
    });
    await navigate(cdp, new URL("/test/harness/scene.html", runner.ui).toString());
    await waitFor("scene settles", async () => {
      const value = await habitat(cdp);
      return (
        value !== undefined &&
        value.backend === "webgpu" &&
        value.school.present === 7 &&
        value.calls > 3
      );
    });
    await evaluate(cdp, `window.__retained = window.__weaveHabitat`);
    const canvasSize = `(() => { const c = document.querySelector('canvas'); return { width: c.width, height: c.height, clientWidth: c.clientWidth, clientHeight: c.clientHeight, ratio: Math.min(devicePixelRatio, 1.5), aspect: window.__weaveHabitat.camera.aspect }; })()`;
    const settledCanvas = await evaluate(cdp, canvasSize);
    await evaluate(cdp, `document.querySelector('.stage').style.width = '448px'`);
    await waitFor("scene resize", async () => {
      const canvas = await evaluate(cdp, canvasSize);
      return canvas.clientWidth === 448 && canvas.width === Math.round(448 * canvas.ratio);
    });
    const resizedCanvas = await evaluate(cdp, canvasSize);
    assert(
      "scene",
      "scene-render-resize",
      settledCanvas.width > 0 &&
        resizedCanvas.width !== settledCanvas.width &&
        resizedCanvas.height === Math.round(resizedCanvas.clientHeight * resizedCanvas.ratio) &&
        Math.abs(resizedCanvas.aspect - resizedCanvas.clientWidth / resizedCanvas.clientHeight) <
          1e-8,
      "the actual App renders WebGPU and tracks CSS dimensions and camera aspect",
      JSON.stringify({ settledCanvas, resizedCanvas }),
    );
    const glRequestCount = await evaluate(cdp, "window.__glContextCalls");
    assert(
      "scene",
      "no-webgl-request",
      glRequestCount === 0,
      "the App requests no WebGL or WebGL2 context while rendering WebGPU",
      `requests=${glRequestCount}`,
    );
    const glContexts = await evaluate(
      cdp,
      `(() => { const canvas = document.querySelector('canvas'); return { webgl: canvas.getContext('webgl') === null, webgl2: canvas.getContext('webgl2') === null }; })()`,
    );
    assert(
      "scene",
      "no-webgl-context",
      glContexts.webgl && glContexts.webgl2,
      "the App's WebGPU canvas has no WebGL or WebGL2 context",
      JSON.stringify(glContexts),
    );
    writeJson("adapter-info.json", await evaluate(cdp, "window.__adapterInfo ?? null"));
    const deviceCount = await evaluate(cdp, "window.__devices.length");
    await setCase(runner, "idle");
    await waitFor("scene model update", async () => {
      const value = await habitat(cdp);
      return (
        value !== undefined &&
        value.bodies.filter((body) => body.present && body.status === "running").length === 2
      );
    });
    assert(
      "scene",
      "scene-model-update",
      await evaluate(
        cdp,
        `window.__retained === window.__weaveHabitat && window.__devices.length === ${deviceCount}`,
      ),
      "a real feed replacement retains the App scene and GPU device",
    );
    for (let cycle = 0; cycle < 3; cycle += 1) {
      if (cycle > 0) {
        await click(cdp, "[data-toggle-consumers]");
        await waitFor("App remount", async () => ((await habitat(cdp))?.calls ?? 0) > 3);
      }
      await evaluate(
        cdp,
        `(() => {
        const scene = window.__weaveHabitat;
        window.__retained = scene; window.__renderCalls = 0;
        const render = scene.renderer.render;
        scene.renderer.render = function(...args) { window.__renderCalls++; return render.apply(this, args); };
        const resources = new Set();
        scene.scene.traverse(object => {
          if (object.geometry) resources.add(object.geometry);
          if (object.material) for (const material of Array.isArray(object.material) ? object.material : [object.material]) resources.add(material);
        });
        window.__resources = [...resources].map(resource => {
          const record = { disposed: false };
          resource.addEventListener('dispose', () => record.disposed = true);
          return record;
        });
      })()`,
      );
      await click(cdp, "[data-toggle-consumers]");
      await waitFor(
        "owned GPU devices destroyed",
        async () =>
          await evaluate(
            cdp,
            `!window.__weaveHabitat && !document.querySelector('canvas') && window.__devices.every(d => d.lost === 'destroyed')`,
          ),
      );
      const calls = await evaluate(cdp, "window.__renderCalls");
      await sleep(400);
      const teardown = await evaluate(
        cdp,
        `({
        stopped: window.__renderCalls === ${calls} && window.__retained.renderer.getAnimationLoop() === null,
        memory: window.__retained.stats().memory,
        resources: window.__resources,
        devices: window.__devices,
      })`,
      );
      assert(
        "scene",
        `scene-unmount-disposes-${cycle + 1}`,
        teardown.stopped &&
          teardown.resources.length > 0 &&
          teardown.resources.every((resource: { disposed: boolean }) => resource.disposed) &&
          Object.values(teardown.memory).every((value) => value === 0) &&
          teardown.devices.every(
            (device: { destroys: number; lost: string }) =>
              device.destroys === 1 && device.lost === "destroyed",
          ),
        "actual App unmount stops rendering, removes its canvas, releases engine resources and destroys owned GPU devices",
        JSON.stringify(teardown),
      );
    }
    assert(
      "scene",
      "scene-one-rpc-connection",
      rpcPosts === 1 && (await evaluate(cdp, "window.__devices.length >= 3")),
      "one RPC POST stays alive across three StrictMode App mount/unmount cycles, with every owned device destroyed",
      `posts=${rpcPosts}`,
    );
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: instrumentation.result.identifier,
    });
  });

  await scenario("disconnect", async () => {
    await navigate(cdp, runner.ui);
    await setCase(runner, "current");
    await waitFor(
      "school before disconnect",
      async () => (await habitat(cdp))?.school.creatures === 7,
    );

    await withClient(runner.rpc, (client) =>
      Effect.gen(function* () {
        const watcher = yield* startWatcher(client);
        yield* waitForFeed(
          watcher,
          "connected source",
          (feed) => feed[0]?.health.kind === "connected",
        );
        yield* Effect.promise(() => setCase(runner, "disconnect"));
        yield* waitForFeed(
          watcher,
          "reconnecting source",
          (feed) => feed[0]?.health.kind === "reconnecting",
        );
        yield* waitForFeed(
          watcher,
          "recovered source",
          (feed) => feed[0]?.health.kind === "connected",
        );
      }),
    );
    const value = await habitat(cdp);
    assert(
      "disconnect",
      "recovery-keeps-school",
      value !== undefined && value.notice === null && value.school.creatures === 7,
      "source recovery keeps the school without a global transport failure",
      JSON.stringify({ creatures: value?.school.creatures, notice: value?.notice }),
    );
    await screenshot(cdp, "disconnect-desktop");
  });

  await scenario("source-controls", async () => {
    const sources = await startRunner(["--source-health"]);
    try {
      await navigate(cdp, sources.ui);
      const readControls = () =>
        evaluate(
          cdp,
          `(() => ({
          controls: [...document.querySelectorAll('.source-control')].map(button => {
            const rect = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            return { label: button.getAttribute('aria-label'), health: button.dataset.health,
              color: style.color, mark: button.querySelector('svg').innerHTML,
              x: rect.x, y: rect.y, width: rect.width, height: rect.height,
              focused: button.matches(':focus-visible'), outline: style.outlineStyle };
          }),
          details: [...document.querySelectorAll('.source-details:popover-open')].map(node => {
            const rect = node.getBoundingClientRect();
            return { text: node.textContent, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
          }),
          rows: [...document.querySelectorAll('.source-row')].map(node => ({
            text: node.textContent, label: node.getAttribute('aria-label'), health: node.dataset.health,
            color: getComputedStyle(node.querySelector('svg')).color,
            mark: node.querySelector('svg').innerHTML,
            glyphX: node.querySelector('svg').getBoundingClientRect().x,
            glyphY: node.querySelector('svg').getBoundingClientRect().y,
          })),
          notice: (() => {
            const node = document.querySelector('.connection-notice');
            return node === null ? null : { kind: node.dataset.kind, text: node.textContent,
              role: node.getAttribute('role'), buttons: node.querySelectorAll('button').length,
              visibility: getComputedStyle(node).visibility };
          })(),
          hud: (() => {
            const box = node => {
              if (!node) return null;
              const rect = node.getBoundingClientRect();
              return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
            };
            const hud = document.querySelector('.habitat-hud');
            const fps = document.querySelector('.habitat-debug');
            const button = document.querySelector('.source-control');
            const notice = document.querySelector('.connection-notice');
            return { hud: box(hud), fps: box(fps), button: box(button), notice: box(notice),
              fpsText: fps?.textContent ?? null, buttonGlyph: box(button?.querySelector('svg')),
              noticeGlyph: box(notice?.querySelector('svg')) };
          })(),
          transportLost: document.querySelector('.connection-notice')?.dataset.kind === 'transport-lost',
          sheet: (() => {
            const node = document.querySelector('dialog[open]');
            if (!node) return null;
            const rect = node.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
          })(),
          text: document.body.innerText,
          controlText: document.querySelector('.source-control')?.innerText ?? '',
          width: innerWidth, height: innerHeight,
        }))()`,
        );
      const move = (x: number, y: number) =>
        cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      const key = async (name: string, code: string, virtualKey: number, text?: string) => {
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: name,
          code,
          windowsVirtualKeyCode: virtualKey,
          ...(text === undefined ? {} : { text }),
        });
        await cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: name,
          code,
          windowsVirtualKeyCode: virtualKey,
        });
      };
      await waitFor(
        "four initial source states",
        async () => {
          const value = await readControls();
          return (
            value.rows.map((row: { health: string }) => row.health).join() ===
            "connected,connecting,connected,unavailable"
          );
        },
        250_000,
      );
      await setCase(sources, "source-health");
      await waitFor(
        "source retry icon",
        async () => (await readControls()).rows[2]?.health === "reconnecting",
      );
      const resting = await readControls();
      assert(
        "source-controls",
        "ordered-empty-sources",
        resting.controls.length === 1 &&
          resting.controls[0]?.x === 16 &&
          resting.controls[0]?.y === 46 &&
          resting.controls[0]?.health === "unavailable" &&
          JSON.stringify(resting.rows.map((row: { label: string }) => row.label)) ===
            JSON.stringify([
              "local: Connected",
              "starting: Connecting",
              "recovering: Reconnecting",
              "offline: Unavailable",
            ]),
        "one aggregate warning icon contains all four zero-session sources in configuration order",
        JSON.stringify(resting),
      );
      assert(
        "source-controls",
        "notice-and-distinct-icons",
        resting.controlText.trim() === "" &&
          resting.details.length === 0 &&
          !resting.transportLost &&
          resting.notice?.kind === "source-unavailable" &&
          resting.notice?.text === "offline unavailable. Restart Weave." &&
          resting.notice?.role === "status" &&
          resting.notice?.buttons === 0 &&
          new Set(resting.rows.map((row: { color: string }) => row.color)).size === 3 &&
          new Set(resting.rows.map((row: { mark: string }) => row.mark)).size === 4,
        "terminal unavailable wins over the retrying sibling, with one persistent interactive-free notice and four distinct row glyphs",
        JSON.stringify(resting),
      );
      assert(
        "source-controls",
        "hud-gutter-alignment",
        resting.hud.hud?.x === 16 &&
          resting.hud.hud?.y === 16 &&
          resting.hud.fps?.x === 16 &&
          resting.hud.fps?.y === 16 &&
          resting.hud.button?.x === 16 &&
          resting.hud.button?.y === 46 &&
          resting.hud.notice?.x === 16 &&
          resting.hud.notice?.y === 98 &&
          resting.hud.buttonGlyph?.x === 24 &&
          resting.hud.noticeGlyph?.x === 24 &&
          /^FPS \d+$/.test(resting.hud.fpsText ?? ""),
        "FPS, source control and notice share one 16px HUD gutter with an 8px row gap and one 24px inner content edge",
        JSON.stringify(resting.hud),
      );
      await screenshot(cdp, "source-states-desktop");

      const retry = resting.controls[0];
      await move(retry.x + 22, retry.y + 22);
      await waitFor(
        "hover source details",
        async () => (await readControls()).details[0]?.text === "localstartingrecoveringoffline",
      );
      await screenshot(cdp, "source-hover-desktop");
      const hovered = (await readControls()).details[0];
      assert(
        "source-controls",
        "labels-only-popup",
        hovered.text === "localstartingrecoveringoffline" &&
          resting.rows.every((row: { text: string; label: string }) =>
            row.label.startsWith(`${row.text}: `),
          ),
        "visible popup text contains only source IDs; status is available through accessible names",
        JSON.stringify(hovered),
      );
      const openDetails = await readControls();
      assert(
        "source-controls",
        "popover-anchor-and-row-alignment",
        hovered.x === resting.hud.button?.x &&
          hovered.y === resting.hud.button?.bottom &&
          openDetails.rows.every(
            (row: { glyphX: number }) => row.glyphX === resting.hud.buttonGlyph?.x,
          ) &&
          openDetails.notice?.visibility === "hidden",
        "the source popover starts at its trigger's 16px gutter, its row glyphs share the button glyph's 24px inner edge, and it temporarily hides the redundant summary",
        JSON.stringify({
          hovered,
          button: resting.hud.button,
          buttonGlyph: resting.hud.buttonGlyph,
        }),
      );
      await move(retry.x + 22, hovered.bottom - 2);
      await waitFor("hoverable details", async () => (await readControls()).details.length === 1);
      await move(10, 10);
      await waitFor("hover dismissal", async () => (await readControls()).details.length === 0);
      assert(
        "source-controls",
        "notice-returns-after-details",
        (await readControls()).notice?.visibility === "visible",
        "closing the source details restores the persistent problem notice",
      );
      await key("Tab", "Tab", 9);
      await waitFor(
        "keyboard source preview",
        async () => (await readControls()).details[0]?.text === "localstartingrecoveringoffline",
      );
      const focused = await readControls();
      assert(
        "source-controls",
        "visible-keyboard-focus",
        focused.controls[0]?.focused && focused.controls[0]?.outline !== "none",
        "Tab reveals source details with a visible focus outline",
        JSON.stringify(focused),
      );
      await key("Enter", "Enter", 13, "\r");
      await key("Enter", "Enter", 13, "\r");
      await waitFor(
        "Enter toggles pinned details",
        async () => (await readControls()).details.length === 0,
      );
      await key(" ", "Space", 32, " ");
      await waitFor("Space opens details", async () => (await readControls()).details.length === 1);
      await key("Escape", "Escape", 27);
      await waitFor(
        "Escape closes focused details",
        async () => (await readControls()).details.length === 0,
      );
      await key(" ", "Space", 32, " ");
      await waitFor(
        "Space opens pinned details",
        async () => (await readControls()).details[0]?.text === "localstartingrecoveringoffline",
      );
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: 10,
        y: 10,
        button: "left",
        clickCount: 1,
      });
      await cdp.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: 10,
        y: 10,
        button: "left",
        clickCount: 1,
      });
      await waitFor(
        "outside click dismisses",
        async () => (await readControls()).details.length === 0,
      );
      assert(
        "source-controls",
        "keyboard-dismissal",
        true,
        "Enter pins, Escape dismisses, Space reopens, and an outside click dismisses",
      );

      const clickRetry = async () => {
        await move(retry.x + 22, retry.y + 22);
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: retry.x + 22,
          y: retry.y + 22,
          button: "left",
          clickCount: 1,
        });
        await cdp.send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: retry.x + 22,
          y: retry.y + 22,
          button: "left",
          clickCount: 1,
        });
      };
      await clickRetry();
      await move(10, 10);
      await waitFor(
        "click pins beyond hover",
        async () => (await readControls()).details.length === 1,
      );
      await clickRetry();
      await waitFor("second click closes", async () => (await readControls()).details.length === 0);
      await move(10, 10);
      assert(
        "source-controls",
        "click-toggle",
        true,
        "a real pointer click pins details after pointer leave and a second click closes them",
      );

      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const mobile = await readControls();
      const offline = mobile.controls[0];
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: offline.x + 22, y: offline.y + 22 }],
      });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await waitFor(
        "tap source details",
        async () => (await readControls()).details[0]?.text === "localstartingrecoveringoffline",
      );
      const tapped = await readControls();
      assert(
        "source-controls",
        "mobile-targets-and-details",
        tapped.controls.every(
          (control: { x: number; y: number; width: number; height: number }) =>
            control.width >= 44 &&
            control.height >= 44 &&
            control.x >= 0 &&
            control.y >= 0 &&
            control.x + control.width <= 390 &&
            control.y + control.height <= 844,
        ) &&
          tapped.details.every(
            (detail: { x: number; y: number; right: number; bottom: number }) =>
              detail.x >= 0 && detail.y >= 0 && detail.right <= 390 && detail.bottom <= 844,
          ),
        "44px touch controls and the tapped details fit 390x844",
        JSON.stringify(tapped),
      );
      await screenshot(cdp, "source-tap-mobile");
      await key("Escape", "Escape", 27);

      await setCase(sources, "current");
      await waitFor(
        "mobile sheet source fixture",
        async () => (await habitat(cdp))?.school.present === 7,
      );
      await evaluate(cdp, `document.querySelector('[aria-label="Sessions"] button').click()`);
      await waitFor("mobile sheet open", async () => (await readControls()).sheet !== null);
      const sheetState = await readControls();
      assert(
        "source-controls",
        "problem-notice-above-mobile-sheet",
        sheetState.notice?.kind === "source-unavailable" &&
          sheetState.notice !== null &&
          sheetState.hud?.notice?.bottom < sheetState.sheet.y &&
          sheetState.hud?.button?.bottom < sheetState.sheet.y &&
          Math.abs(sheetState.sheet.height - 844 * 0.47) < 1,
        "the persistent source notice and the source trigger stay above the 47svh mobile sheet",
        JSON.stringify({
          notice: sheetState.notice,
          button: sheetState.hud?.button,
          sheet: sheetState.sheet,
        }),
      );
      await click(cdp, ".source-control");
      await waitFor(
        "mobile source details over sheet",
        async () => (await readControls()).details.length === 1,
      );
      const sheetDetails = await readControls();
      assert(
        "source-controls",
        "source-popover-clears-mobile-sheet",
        sheetDetails.details.every(
          (detail: { x: number; y: number; right: number; bottom: number }) =>
            detail.x === 16 && detail.bottom < sheetDetails.sheet.y && detail.right <= 390,
        ),
        "the source popover stays anchored under its trigger and ends above the mobile sheet",
        JSON.stringify({ details: sheetDetails.details, sheet: sheetDetails.sheet }),
      );
      await screenshot(cdp, "source-sheet-mobile");
      await click(cdp, ".source-control");
      await waitFor(
        "mobile source details closed",
        async () => (await readControls()).details.length === 0,
      );
      await escape(cdp);
      await waitFor("mobile sheet closed", async () => (await readControls()).sheet === null);

      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 640,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await sleep(250);
      await evaluate(cdp, `document.querySelector('[aria-label="Sessions"] button').click()`);
      await waitFor("narrow desktop sheet open", async () => (await readControls()).sheet !== null);
      const narrow = await readControls();
      await click(cdp, ".source-control");
      await waitFor(
        "narrow source details",
        async () => (await readControls()).details.length === 1,
      );
      const narrowDetails = await readControls();
      assert(
        "source-controls",
        "narrow-desktop-clears-placard",
        narrow.hud.notice.right + 16 <= narrow.sheet.x &&
          narrow.hud.button.right <= narrow.sheet.x &&
          narrowDetails.details.every(
            (detail: { right: number }) => detail.right + 16 <= narrow.sheet.x,
          ),
        "at 640px the notice, trigger and source popover keep a 16px gap before the 340px inset placard",
        JSON.stringify({
          notice: narrow.hud.notice,
          button: narrow.hud.button,
          details: narrowDetails.details,
          sheet: narrow.sheet,
        }),
      );
      await click(cdp, ".source-control");
      await escape(cdp);
      await waitFor("narrow sheet closed", async () => (await readControls()).sheet === null);
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await sleep(250);

      await click(cdp, ".source-control");
      await waitFor(
        "pinned retry details",
        async () => (await readControls()).details[0]?.text === "localstartingrecoveringoffline",
      );
      await setCase(sources, "sources-recovered");
      await waitFor("health-only feed updates open details", async () => {
        const value = await readControls();
        return (
          value.details[0]?.text === "localstartingrecoveringoffline" &&
          value.rows.map((row: { health: string }) => row.health).join() ===
            "connected,connected,connected,unavailable"
        );
      });
      assert(
        "source-controls",
        "live-source-details",
        true,
        "a source-only update replaces pinned row glyphs without reordering or adding text",
      );
      await key("Escape", "Escape", 27);
      await cdp.send("Page.stopLoading");
      await waitFor("transport failure notice", async () => (await readControls()).transportLost);
      const failed = await readControls();
      assert(
        "source-controls",
        "transport-lost-replaces-stale-health",
        failed.controls.length === 0 &&
          failed.rows.length === 0 &&
          failed.details.length === 0 &&
          failed.notice?.kind === "transport-lost" &&
          failed.notice?.text === "Disconnected. Refresh the page." &&
          failed.notice?.role === "status" &&
          failed.notice?.buttons === 0,
        "a lost browser stream removes the stale source trigger and popover, leaving one noninteractive persistent refresh notice",
        JSON.stringify(failed),
      );
      assert(
        "source-controls",
        "secret-free-details",
        !JSON.stringify(failed).includes("weave-controlled-test-password") &&
          !failed.text.includes("http"),
        "source controls disclose only source IDs and status",
      );
      await screenshot(cdp, "source-transport-mobile");
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
      await cdp.send("Emulation.clearDeviceMetricsOverride");

      const aggregates = await evaluate(
        cdp,
        `(async () => {
          const { default: { createElement } } = await import('/node_modules/.vite/deps/react.js');
          const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
          const { default: { flushSync } } = await import('/node_modules/.vite/deps/react-dom.js');
          const { SourceControls } = await import('/src/client/habitat/SourceControls.tsx');
          const host = document.createElement('div');
          document.body.append(host);
          const root = createRoot(host);
          const states = [];
          try {
            for (const kind of ['connected', 'connecting', 'unavailable']) {
              const feed = ['alpha', 'beta'].map(id => ({ id, health: { kind }, sessions: [] }));
              flushSync(() => root.render(createElement(SourceControls, { feed })));
              const button = host.querySelector('button');
              states.push({ kind, count: host.querySelectorAll('button').length,
                health: button.dataset.health, color: getComputedStyle(button).color,
                mark: button.querySelector('svg').innerHTML });
            }
            flushSync(() => root.render(createElement(SourceControls, { feed: [] })));
            return { states, empty: host.childElementCount === 0 };
          } finally {
            root.unmount();
            host.remove();
          }
        })()`,
      );
      assert(
        "source-controls",
        "aggregate-states-and-empty",
        aggregates.empty &&
          aggregates.states.every(
            (state: { kind: string; health: string; count: number }) =>
              state.count === 1 && state.kind === state.health,
          ) &&
          new Set(aggregates.states.map((state: { color: string }) => state.color)).size === 3 &&
          new Set(aggregates.states.map((state: { mark: string }) => state.mark)).size === 3,
        "the real component renders distinct green, amber and red aggregate glyphs and hides for zero sources",
        JSON.stringify(aggregates),
      );
      writeJson("source-controls.json", {
        resting,
        focused,
        tapped,
        sheetState,
        sheetDetails,
        failed,
        aggregates,
      });
    } finally {
      await stopRunner(sources);
    }
  });

  await scenario("jelly-variants", async () => {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const sources = await startRunner(["--variant-sources"]);
    try {
      await navigate(cdp, sources.ui);
      await waitFor(
        "three sources with six bodies",
        async () => {
          const value = await habitat(cdp);
          return value !== undefined && value.school.present === 6 && value.bodies.length === 6;
        },
        30_000,
      );
      await sleep(1500);
      const mixed = await habitat(cdp);
      const perSource = (mixed?.bodies ?? []).reduce<Record<string, number>>((total, body) => {
        const source = body.key.slice(0, body.key.indexOf(":"));
        total[source] = (total[source] ?? 0) + 1;
        return total;
      }, {});
      const ordered = Object.keys(perSource).sort();
      assert(
        "jelly-variants",
        "six-bodies-three-sources",
        mixed !== undefined &&
          mixed.school.meshes === 29 &&
          JSON.stringify(ordered) === JSON.stringify(["iu", "local", "mj"]) &&
          ordered.every((source) => perSource[source] === 2),
        "the mixed school renders two sessions from each ordered source on 29 instanced meshes",
        JSON.stringify({ school: mixed?.school, perSource }),
      );
      const board = await screenshot(cdp, "jelly-variants-desktop");
      const pixels = await evaluate(
        cdp,
        `(async () => {
          const image = await createImageBitmap(await (await fetch('data:image/png;base64,' + ${JSON.stringify(board)})).blob());
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          context.drawImage(image, 0, 0);
          const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let lit = 0, total = 0, sum = 0, sumSq = 0;
          for (let y = Math.floor(canvas.height * 0.15); y < canvas.height * 0.85; y += 4) {
            for (let x = Math.floor(canvas.width * 0.15); x < canvas.width * 0.85; x += 4) {
              const offset = (y * canvas.width + x) * 4;
              const luma = (data[offset] + data[offset + 1] + data[offset + 2]) / 3;
              total += 1;
              sum += luma;
              sumSq += luma * luma;
              if (luma > 18) lit += 1;
            }
          }
          const mean = sum / total;
          return { width: canvas.width, height: canvas.height, total, litFraction: lit / total, mean, variance: sumSq / total - mean * mean };
        })()`,
      );
      assert(
        "jelly-variants",
        "board-not-black",
        pixels.total > 0 && pixels.litFraction > 0.01 && pixels.variance > 4,
        "the board capture contains lit, varied pixels outside the HUD rather than a black frame; this is not anatomy proof",
        JSON.stringify(pixels),
      );

      const mapping = await evaluate(
        cdp,
        `(() => {
          const school = window.__weaveHabitat.school;
          return { fried: school.keyAt(8, 0) ?? null, white: school.keyAt(9, 0) ?? null,
            buckets: window.__weaveHabitat.stats().school.buckets };
        })()`,
      );
      assert(
        "jelly-variants",
        "species-buckets",
        mapping.buckets[8] === 2 &&
          mapping.buckets[9] === 2 &&
          String(mapping.fried).startsWith("iu:") &&
          String(mapping.white).startsWith("mj:"),
        "the iu source occupies the fried-egg bucket and the mj source the white-spotted bucket",
        JSON.stringify(mapping),
      );
      assert(
        "jelly-variants",
        "renderer-backend",
        mixed?.backend === "webgpu",
        "the renderer reports its native WebGPU backend",
        String(mixed?.backend),
      );

      await overlapRegression(cdp);
      writeJson(
        "overlap-restored.json",
        await evaluate(
          cdp,
          `(() => {const s=window.__weaveHabitat;return {bodies:s.bodies(),camera:{position:s.camera.position.toArray(),quaternion:s.camera.quaternion.toArray(),layers:s.camera.layers.mask},target:s.renderer.getRenderTarget()?.texture.name??null,autoClear:s.renderer.autoClear,opaque:s.renderer.opaque,transparent:s.renderer.transparent,callback:String(s.renderer.getRenderObjectFunction()),stopped:s.stopped,objects:s.scene.children.map(o=>({type:o.type,visible:o.visible,layers:o.layers.mask,count:o.count})),stats:s.stats()};})()`,
        ),
      );
      await screenshot(cdp, "overlap-restored-school");
      const specimens = [
        { title: "local root", name: "jelly-moon-specimen" },
        { title: "iu root", name: "jelly-fried-egg-specimen" },
        { title: "mj root", name: "jelly-white-spotted-specimen" },
      ];
      for (const specimen of specimens) {
        await evaluate(
          cdp,
          `([...document.querySelectorAll('[aria-label="Sessions"] button')].find(button => button.textContent.startsWith(${JSON.stringify(`${specimen.title},`)})))?.click()`,
        );
        await waitFor(
          `${specimen.title} specimen`,
          async () =>
            (await evaluate(
              cdp,
              `document.querySelector('.specimen-window')?.dataset.visible === 'true'`,
            )) === true,
          30_000,
        );
        await sleep(400);
        await screenshot(cdp, specimen.name);
        writeJson(
          `${specimen.name}-state.json`,
          await evaluate(
            cdp,
            `(() => {const s=window.__weaveHabitat;return {opaque:s.renderer.opaque,transparent:s.renderer.transparent,callback:String(s.renderer.getRenderObjectFunction()),target:s.renderer.getRenderTarget()?.texture.name??null,autoClear:s.renderer.autoClear,stats:s.stats()};})()`,
          ),
        );
      }
    } finally {
      await stopRunner(sources);
    }
  });

  writeJson("checks.json", checks);
  const failed = checks.filter((entry) => !entry.pass);
  const cleanupPassed = await cleanupRun();
  cleanupRun = undefined;
  const result = checks.length > 0 && failed.length === 0 && cleanupPassed ? "PASS" : "FAIL";
  writeJson("manifest.json", {
    codeSHA,
    sourceDirty: sourceFiles.length > 0,
    sourceFiles,
    worktree,
    run,
    command,
    result,
    scenarios,
    checks: checks.length,
    failed: failed.length,
  });

  console.log(`${result} client-ui run=${run} checks=${checks.length} failed=${failed.length}`);
  return result === "PASS" ? 0 : 1;
};

try {
  process.exitCode = await main();
} catch (error) {
  writeJson("manifest.json", {
    worktree,
    run,
    command,
    result: "BLOCKED",
    error: error instanceof Error ? error.message : String(error),
  });
  console.error(`BLOCKED client-ui run=${run} error=${String(error)}`);
  process.exitCode = 1;
} finally {
  if ((await cleanupRun?.()) === false) process.exitCode = 1;
}
