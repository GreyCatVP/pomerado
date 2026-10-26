import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Effect, Exit, Scope } from "effect";
import { afterEach, expect, it } from "vitest";
import { createLocalProcess } from "../../src/execution/local-process.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "pomerado process spaces "));
  cleanup.push(() => rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const scope = await Effect.runPromise(Scope.make());
  const close = () => Effect.runPromise(Scope.close(scope, Exit.void));
  cleanup.push(close);
  const start = (code: string, ipc = false, outputLimit?: number) => Effect.runPromise(
    createLocalProcess({ command: process.execPath, args: ["-e", code], cwd,
      environment: { SYNTHETIC_VALUE: "provided" }, ipc,
      ...(outputLimit === undefined ? {} : { outputLimit }),
    }).pipe(Effect.provideService(Scope.Scope, scope)),
  );
  return { cwd, scope, close, start };
}

it("preserves output, exit status, explicit environment and paths with spaces", async () => {
  const { start } = await setup();
  const child = await start('console.log(process.env.SYNTHETIC_VALUE); console.error("stderr"); process.exitCode = 7;');
  expect(await Effect.runPromise(child.result)).toMatchObject({ exitCode: 7, stdout: "provided\n", stderr: "stderr\n" });
});

it("preserves advanced IPC messages", async () => {
  const { start } = await setup();
  const child = await start('process.on("message", value => process.send(value, () => process.disconnect()));', true);
  const reply = new Promise((resolve) => child.child.once("message", resolve));
  child.child.send?.({ bytes: new Uint8Array([1, 2]), value: 7n });
  expect(await reply).toEqual({ bytes: new Uint8Array([1, 2]), value: 7n });
  expect((await Effect.runPromise(child.result)).exitCode).toBe(0);
});

it.each([false, true])("scope cleanup stops descendants even after their parent exits: %s", async (exitEarly) => {
  const { cwd, start, close } = await setup();
  const grandchild = 'setInterval(() => {}, 1000)';
  const child = await start(`const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore', detached: true });
    require('node:fs').writeFileSync('descendant.pid', String(descendant.pid));
    ${exitEarly ? 'descendant.unref();' : 'setInterval(() => {}, 1000);'}`);
  let descendant = 0;
  await expect.poll(async () => {
    try { descendant = Number(await readFile(join(cwd, "descendant.pid"), "utf8")); return descendant > 0; }
    catch { return false; }
  }).toBe(true);
  cleanup.push(async () => { try { process.kill(descendant); } catch { /* already stopped */ } });
  if (exitEarly) expect((await Effect.runPromise(child.result)).exitCode).toBe(0);
  await close();
  await expect.poll(() => {
    try { process.kill(descendant, 0); return false; } catch { return true; }
  }).toBe(true);
});

it("fails bounded output and closes its process", async () => {
  const { start } = await setup();
  const child = await start('console.log("x".repeat(4096)); setInterval(() => {}, 1000);', false, 64);
  await expect(Effect.runPromise(child.result)).rejects.toThrow("exceeds output limit");
});

it.runIf(process.platform === "win32")("finishes when an exited command leaves a descendant holding its output pipe", async () => {
  const { start } = await setup();
  const child = await start(`const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }).unref();`);
  expect((await Effect.runPromise(child.result)).exitCode).toBe(0);
});

it("closing a job leaves unrelated processes running", async () => {
  const { start, close } = await setup();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  cleanup.push(async () => { unrelated.kill(); });
  await start("setInterval(() => {}, 1000)");
  await close();
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
});

it("reports an unavailable executable without hanging cleanup", async () => {
  const { cwd, scope } = await setup();
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const child = yield* createLocalProcess({ command: join(cwd, "does-not-exist"), args: [], cwd, environment: {} });
    const result = yield* child.result;
    expect(result.exitCode).not.toBe(0);
  })).pipe(Effect.provideService(Scope.Scope, scope), Effect.either));
  if (process.platform === "win32") expect(result._tag).toBe("Right");
  else expect(result._tag).toBe("Left");
});

it("executes the platform's default workspace shell", async () => {
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    return yield* Effect.promise(() => workspace.session.exec!({ cmd: "echo shell-ready", login: false }));
  })));
  expect(result).toMatchObject({ exitCode: 0 });
  expect(result.output).toContain("shell-ready");
});
