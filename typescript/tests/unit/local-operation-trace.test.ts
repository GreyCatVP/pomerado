import { Effect, Either } from "effect";
import { describe, expect, it } from "vitest";
import { LocalOperationFailure, runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

const entrypoint = "src/private-trace.mjs";
const source = (thrown: string) => `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({input:Schema.Struct({}),output:Schema.Unknown},async()=>{${thrown}});`;

const failureOf = async (text: string, enabled: boolean) => {
  const events: { kind: string; data: unknown }[] = [];
  const result = await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    return yield* Effect.either(runLocalOperation({ workspace, entrypoint, sources: [[entrypoint, source(text)]], input: {}, target: "pureFiles", ...(enabled ? { diagnostic: (kind: string, data: unknown) => { events.push({ kind, data }); } } : {}) }));
  })));
  if (Either.isRight(result)) throw new Error("Expected the synthetic operation failure");
  expect(result.left).toBeInstanceOf(LocalOperationFailure);
  if (!(result.left instanceof LocalOperationFailure)) throw result.left;
  expect(result.left).toMatchObject({ message: "synthetic original failure", reported: true, journal: { effect: "not_sent", commits: [] } });
  expect(result.left).not.toHaveProperty("privateDetail");
  return { error: result.left, events };
};

describe("optional child error trace detail", { timeout: 30_000 }, () => {
  it("preserves an oversized error's original receipt with a private limit marker", async () => {
    const text = 'throw Object.assign(new Error("synthetic original failure"), { blob: "x".repeat(2 * 1024 * 1024) });';
    const disabled = await failureOf(text, false);
    const enabled = await failureOf(text, true);
    expect(enabled.error.message).toBe(disabled.error.message);
    expect(enabled.events).toContainEqual({ kind: "operation.child.error", data: { error: { traceCapture: "exceeds_ipc_limit" }, frame: expect.stringContaining(entrypoint) } });
    expect(disabled.events).toEqual([]);
  });

  it("preserves a Proxy error's original receipt with a private unsafe-value marker", async () => {
    const text = 'throw new Proxy(new Error("synthetic original failure"), { ownKeys() { throw new Error("synthetic descriptor trap"); } });';
    const disabled = await failureOf(text, false);
    const enabled = await failureOf(text, true);
    expect(enabled.error.message).toBe(disabled.error.message);
    expect(enabled.events).toContainEqual({ kind: "operation.child.error", data: { error: expect.objectContaining({ message: "synthetic original failure", cause: "[proxy]" }), frame: disabled.error.frame } });
  });
});

describe("optional child result trace", { timeout: 30_000 }, () => {
  it("retains the raw result and both streams when an output file is refused", async () => {
    const events: { kind: string; data: unknown }[] = [];
    const output = { $file: { id: "uncollected", name: "synthetic.txt", media_type: "text/plain", size: 0, sha256: "0".repeat(64) } };
    const run = (enabled: boolean) => Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const workspace = yield* createLocalWorkspace();
      return yield* Effect.either(runLocalOperation({
        workspace, entrypoint, input: {}, target: "pureFiles",
        sources: [[entrypoint, source(`process.stdout.write("synthetic refused stdout"); process.stderr.write("synthetic refused stderr"); return ${JSON.stringify(output)};`)]],
        ...(enabled ? { diagnostic: (kind: string, data: unknown) => { events.push({ kind, data }); } } : {}),
      }));
    })));
    const disabled = await run(false);
    const enabled = await run(true);
    for (const result of [disabled, enabled]) {
      expect(Either.isLeft(result)).toBe(true);
      if (Either.isRight(result)) throw new Error("Expected the synthetic file refusal");
      expect(result.left).toMatchObject({ name: "LocalOperationFailure", code: "FileRefused", reported: true, journal: { effect: "not_sent", commits: [] } });
      expect(result.left).not.toHaveProperty("stdout");
    }
    expect(events).toContainEqual({ kind: "operation.result", data: expect.objectContaining({ kind: "result", output }) });
    expect(events).toContainEqual({ kind: "operation.process", data: expect.objectContaining({ _tag: "Right", right: expect.objectContaining({ stdout: "synthetic refused stdout", stderr: expect.stringContaining("synthetic refused stderr") }) }) });
    expect(events.findIndex((event) => event.kind === "operation.result")).toBeLessThan(events.findIndex((event) => event.kind === "operation.process"));
  });
});
