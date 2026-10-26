import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Agent, OpenAIProvider, Runner, Usage, setDefaultModelProvider, tool, type Model, type ModelProvider, type ModelRequest, type ModelResponse } from "@openai/agents";
import { Cause, Effect, Fiber, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRunSecrets } from "../../src/inputs/secrets.js";
import { traceValue } from "../../src/privacy/trace-value.js";
import { openJobTrace, tracedEffect, validateTraceDirectory, withJobTrace, type JobTrace } from "../../src/standalone/job-trace.js";
import { tracedProvider, traceObserverFactory } from "../../src/standalone/trace-model.js";
import { makePomeradoMcp } from "../../src/standalone/mcp-server.js";

const directories: string[] = [];
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), "pomerado-trace-unit-"));
  directories.push(path);
  return path;
};
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
const eventsIn = (path: string) => readFileSync(path, "utf8").trimEnd().split("\n").map((line) => Schema.decodeUnknownSync(Schema.parseJson(Schema.Unknown))(line));
const request: ModelRequest = { input: "synthetic input", modelSettings: {}, tools: [], outputType: "text", handoffs: [], tracing: false };
const response: ModelResponse = { usage: new Usage(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "synthetic response" }] }] };
const memoryTrace = () => {
  const events: { kind: string; data: unknown }[] = [];
  const trace: JobTrace = { secrets: makeRunSecrets(), event: (kind, data) => { events.push({ kind, data }); } };
  return { trace, events };
};

describe("private job trace", () => {
  it("writes complete private records immediately and opens each job exclusively", () => {
    const directory = join(temporary(), "traces");
    validateTraceDirectory(directory);
    const id = randomUUID();
    const sync = vi.fn();
    const trace = openJobTrace(directory, id, { write: (fd, data, offset, length, position) => writeSync(fd, data, offset, Math.min(length, 7), position), sync, notice: vi.fn() });
    const path = join(directory, `${id}.jsonl`);
    try {
      trace.event("test", "x".repeat(100_000));
      expect(eventsIn(path)).toEqual([expect.objectContaining({ seq: 1, job: id, kind: "test", data: "x".repeat(100_000) })]);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => openJobTrace(directory, id)).toThrow();
      expect(sync).toHaveBeenCalledTimes(1);
    } finally { trace.close(); }
    expect(eventsIn(path)).toHaveLength(1);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("marks one uncapturable event and continues with the next event", () => {
    const directory = temporary();
    const id = randomUUID();
    const notice = vi.fn();
    const trace = openJobTrace(directory, id, { notice });
    let deep: unknown = "synthetic leaf";
    for (let depth = 0; depth < 20_000; depth++) deep = { nested: deep };
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    try {
      trace.event("deep.result", deep, "synthetic-deep");
      trace.event("proxy.result", revoked.proxy, "synthetic-proxy");
      trace.event("valid.result", { retained: true }, "synthetic-valid");
    } finally { trace.close(); }
    expect(eventsIn(join(directory, `${id}.jsonl`))).toEqual([
      expect.objectContaining({ seq: 1, kind: "deep.result", ref: "synthetic-deep", data: { traceCapture: "failed" } }),
      expect.objectContaining({ seq: 2, kind: "proxy.result", ref: "synthetic-proxy", data: "[proxy]" }),
      expect.objectContaining({ seq: 3, kind: "valid.result", ref: "synthetic-valid", data: { retained: true } }),
    ]);
    expect(notice).not.toHaveBeenCalled();
  });

  it("continues after one JSON encoding failure without reporting a disk failure", () => {
    const directory = temporary();
    const id = randomUUID();
    const notice = vi.fn();
    const trace = openJobTrace(directory, id, { notice });
    const stringify = vi.spyOn(JSON, "stringify").mockImplementationOnce(() => { throw new TypeError("synthetic encoding failure"); });
    try { trace.event("encoding.result", {}, "synthetic-encoding"); }
    finally { stringify.mockRestore(); }
    try { trace.event("valid.result", { retained: true }); }
    finally { trace.close(); }
    expect(eventsIn(join(directory, `${id}.jsonl`))).toEqual([
      expect.objectContaining({ seq: 1, kind: "encoding.result", ref: "synthetic-encoding", data: { traceCapture: "failed" } }),
      expect.objectContaining({ seq: 2, kind: "valid.result", data: { retained: true } }),
    ]);
    expect(notice).not.toHaveBeenCalled();
  });

  it("rejects unsafe directories and a symlink before work", async () => {
    const directory = temporary();
    chmodSync(directory, 0o755);
    expect(() => validateTraceDirectory(directory)).toThrow();
    chmodSync(directory, 0o700);
    const link = join(temporary(), "link");
    symlinkSync(directory, link);
    expect(() => validateTraceDirectory(link)).toThrow();
    const work = vi.fn(() => Effect.succeed("ran"));
    await expect(Effect.runPromise(withJobTrace(join(directory, "missing"), randomUUID(), work))).rejects.toThrow("Could not open private job trace");
    expect(work).not.toHaveBeenCalled();
  });

  it("retains secrets through cleanup and final Exit then clears them", async () => {
    const directory = temporary();
    const id = randomUUID();
    let held: JobTrace | undefined;
    await Effect.runPromise(withJobTrace(directory, id, (trace) => Effect.gen(function* () {
      held = trace;
      trace.secrets.register("SYNTHETIC_REGISTERED_SECRET");
      yield* Effect.addFinalizer(() => Effect.sync(() => trace.event("cleanup", { "SYNTHETIC_REGISTERED_SECRET": "SYNTHETIC_REGISTERED_SECRET" })));
      trace.event("during", { value: "SYNTHETIC_REGISTERED_SECRET" });
      expect(eventsIn(join(directory, `${id}.jsonl`))).toHaveLength(2);
      return "SYNTHETIC_REGISTERED_SECRET";
    })));
    const text = readFileSync(join(directory, `${id}.jsonl`), "utf8");
    expect(text).not.toContain("SYNTHETIC_REGISTERED_SECRET");
    expect(text).toContain("[private]");
    expect(eventsIn(join(directory, `${id}.jsonl`)).at(-1)).toMatchObject({ kind: "job.end", data: { _tag: "Success", value: "[private]" } });
    expect(held?.secrets.redact("SYNTHETIC_REGISTERED_SECRET")).toBe("SYNTHETIC_REGISTERED_SECRET");
  });

  it("emits one value-free notice on a write failure and preserves the business result", async () => {
    const directory = temporary();
    const notice = vi.fn();
    const write = vi.fn(() => { throw new Error("SYNTHETIC_ERROR_PRIVATE_DETAIL"); });
    const trace = openJobTrace(directory, randomUUID(), { write, sync: vi.fn(), notice });
    try {
      const actual = await Effect.runPromise(tracedEffect(trace, "business", Effect.succeed("original result")));
      trace.event("again", { any: "payload" });
      expect(actual).toBe("original result");
      expect(write).toHaveBeenCalledTimes(1);
      expect(notice).toHaveBeenCalledExactlyOnceWith("Private job trace stopped after a write failure.\n");
    } finally { trace.close(); }
  });

  for (const phase of ["partial_write", "fsync"]) it(`preserves the run after a ${phase} failure`, async () => {
    const notice = vi.fn();
    let writes = 0;
    const write = vi.fn((fd: number, bytes: Uint8Array, offset: number, length: number, position: null) => {
      writes++;
      if (phase === "partial_write" && writes > 1) throw new Error("synthetic write failure");
      return writeSync(fd, bytes, offset, phase === "partial_write" ? Math.min(length, 7) : length, position);
    });
    const sync = vi.fn(() => { if (phase === "fsync") throw new Error("synthetic fsync failure"); });
    const trace = openJobTrace(temporary(), randomUUID(), { write, sync, notice });
    const result = await Effect.runPromise(tracedEffect(trace, "business", Effect.succeed("original result")));
    trace.event("later", {});
    trace.close();
    expect(result).toBe("original result");
    expect(write).toHaveBeenCalledTimes(phase === "partial_write" ? 2 : 1);
    expect(sync).toHaveBeenCalledTimes(phase === "partial_write" ? 0 : 1);
    expect(notice).toHaveBeenCalledExactlyOnceWith("Private job trace stopped after a write failure.\n");
  });

  for (const ending of ["interrupted", "finalizer_defect"]) it(`redacts secrets through ${ending} cleanup and job.end`, async () => {
    const directory = temporary();
    const id = randomUUID();
    const run = withJobTrace(directory, id, (trace) => Effect.gen(function* () {
      trace.secrets.register("SYNTHETIC_TERMINAL_SECRET");
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        trace.event("cleanup", { value: "SYNTHETIC_TERMINAL_SECRET" });
        if (ending === "finalizer_defect") throw new Error("SYNTHETIC_TERMINAL_SECRET");
      }));
      return yield* ending === "interrupted" ? Effect.never : Effect.succeed("original result");
    }));
    if (ending === "interrupted") {
      const fiber = Effect.runFork(run);
      const path = join(directory, `${id}.jsonl`);
      for (let attempt = 0; attempt < 20 && !existsSync(path); attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(existsSync(path)).toBe(true);
      await Effect.runPromise(Fiber.interrupt(fiber));
    } else {
      const exit = await Effect.runPromiseExit(run);
      expect(exit._tag).toBe("Failure");
    }
    const path = join(directory, `${id}.jsonl`);
    expect(readFileSync(path, "utf8")).not.toContain("SYNTHETIC_TERMINAL_SECRET");
    expect(eventsIn(path)).toContainEqual(expect.objectContaining({ kind: "cleanup", data: { value: "[private]" } }));
    expect(eventsIn(path).at(-1)).toMatchObject({ kind: "job.end", data: { _tag: "Failure" } });
  });

  it("keeps a closed stderr and a throwing notice from changing the run", () => {
    const directory = temporary();
    const script = `import { closeSync } from "node:fs";
      import { openJobTrace } from "./dist/typescript/src/standalone/job-trace.js";
      closeSync(2);
      const trace = openJobTrace(process.argv[1], process.argv[2], {write: () => { throw new Error("synthetic write failure"); }});
      trace.event("test", {});
      trace.close();
      process.stdout.write("business continued");`;
    expect(execFileSync(process.execPath, ["--input-type=module", "-e", script, directory, randomUUID()], { encoding: "utf8" })).toBe("business continued");
    const trace = openJobTrace(directory, randomUUID(), { write: () => { throw new Error("synthetic write failure"); }, notice: () => { throw new Error("synthetic notice failure"); } });
    expect(() => { trace.event("test", {}); trace.close(); }).not.toThrow();
  });

  it("captures an ordinary host Cause before finite wrapping without changing it", async () => {
    const { trace, events } = memoryTrace();
    const failure = new Error("synthetic host failure", { cause: new Error("synthetic inner") });
    const wrapped = new Error("finite wrapper");
    const exit = await Effect.runPromiseExit(tracedEffect(trace, "host", Effect.fail(failure)).pipe(Effect.mapError(() => wrapped)));
    expect(events[0]).toMatchObject({ kind: "host.error" });
    expect(JSON.stringify(traceValue(events[0]?.data, trace.secrets.redact))).toContain("synthetic inner");
    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") expect(Cause.squash(exit.cause)).toBe(wrapped);
  });

  it("does no trace I/O during disabled discovery and refuses an invalid enabled path", async () => {
    const before = process.env["POMERADO_TRACE_DIR"];
    delete process.env["POMERADO_TRACE_DIR"];
    const directory = join(temporary(), "unused");
    const prepare = vi.fn(() => Effect.succeed(() => Effect.succeed({})));
    try {
      await Effect.runPromise(Effect.scoped(makePomeradoMcp({ prepare })));
      expect(existsSync(directory)).toBe(false);
      const badDirectory = temporary();
      chmodSync(badDirectory, 0o755);
      await expect(Effect.runPromise(Effect.scoped(makePomeradoMcp({ prepare, traceDirectory: badDirectory })))).rejects.toThrow("Invalid private trace directory");
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      if (before === undefined) delete process.env["POMERADO_TRACE_DIR"];
      else process.env["POMERADO_TRACE_DIR"] = before;
    }
  });
});

describe("trace serialization", () => {
  it("preserves business fields while excluding nested SDK error transports and credential payloads", () => {
    const secrets = makeRunSecrets();
    secrets.register("SYNTHETIC_SECRET");
    const payload = { body: "business body", request: { value: "business request" }, response: "business response", options: { chosen: true } };
    expect(traceValue(payload, secrets.redact)).toEqual(payload);
    const getter = vi.fn(() => { throw new Error("getter must not run"); });
    const toJSON = vi.fn(() => { throw new Error("toJSON must not run"); });
    const error = Object.assign(new Error("complete message SYNTHETIC_SECRET", { cause: new Error("nested cause") }), {
      code: "synthetic_code", frame: "src/tool.mjs:12", toJSON,
      request: { headers: { Authorization: "UNREGISTERED_TRANSPORT_SECRET" } },
      other: { client: { config: "UNREGISTERED_CLIENT_SECRET" }, headers: new Map([["Authorization", "UNREGISTERED_HEADER_SECRET"]]) },
    });
    Object.defineProperty(error, "getter", { get: getter, enumerable: true });
    const data = traceValue({ payload, error, answer: { type: "credential", value: { username: "UNREGISTERED_ANSWER" } }, secret: { type: "secret", value: "UNREGISTERED_SECRET_ANSWER" }, headers: { whatever: "UNREGISTERED_HEADERS" } }, secrets.redact);
    const text = JSON.stringify(data);
    expect(text).toContain("complete message [private]");
    expect(text).toContain("nested cause");
    expect(data).toMatchObject({ error: { stack: expect.stringContaining("complete message") } });
    expect(text).toContain("src/tool.mjs:12");
    expect(text).toContain("synthetic_code");
    expect(text).not.toContain("UNREGISTERED_");
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    expect(data).toMatchObject({ payload });
  });

  it("never invokes a custom Error stack or name getter", () => {
    const getter = vi.fn(() => { throw new Error("getter must not run"); });
    const stackError = new Error("synthetic");
    Object.defineProperty(stackError, "stack", { get: getter });
    expect(traceValue(stackError, (text) => text)).toMatchObject({ stack: "[accessor]" });
    const nameError = new Error("synthetic");
    Object.defineProperty(nameError, "name", { get: getter });
    expect(traceValue(nameError, (text) => text)).toMatchObject({ stack: "[accessor]", name: "[accessor]" });
    expect(getter).not.toHaveBeenCalled();
  });

  it("marks live and revoked Proxies without invoking any traps", () => {
    const trap = vi.fn(() => { throw new Error("proxy trap must not run"); });
    const live = new Proxy({}, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(traceValue([live, revoked.proxy], (text) => text)).toEqual(["[proxy]", "[proxy]"]);
    expect(trap).not.toHaveBeenCalled();
  });

  for (const name of ["Error", "Map", "Set", "Uint8Array", "Buffer"] as const) it(`ignores replaced global ${name} constructors`, () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, name);
    if (original === undefined) throw new Error("Native global missing");
    const nativeBuffer = Buffer;
    const hook = vi.fn(() => { throw new Error("replacement constructor hook must not run"); });
    const replacement = new Proxy(function () {}, { get: hook, apply: hook, construct: hook });
    const error = new Error("synthetic original stack");
    const payload = { error, bytes: Buffer.from("synthetic bytes"), map: new Map([["retained", true]]), set: new Set(["retained"]) };
    let captured: unknown;
    try {
      Object.defineProperty(globalThis, name, { value: replacement, writable: true, enumerable: original.enumerable ?? false, configurable: true });
      captured = traceValue(payload, (text) => text);
    } finally { Object.defineProperty(globalThis, name, original); }
    expect(captured).toMatchObject({
      error: { message: "synthetic original stack", stack: name === "Error" ? "[accessor]" : expect.stringContaining("synthetic original stack") },
      bytes: { encoding: "base64", data: nativeBuffer.from("synthetic bytes").toString("base64") },
      map: { entries: [["retained", true]] }, set: { values: ["retained"] },
    });
    expect(hook).not.toHaveBeenCalled();
  });

  for (const constructor of [Error, Map, Set, Uint8Array]) it(`ignores ${constructor.name} Symbol.hasInstance hooks`, () => {
    const original = Object.getOwnPropertyDescriptor(constructor, Symbol.hasInstance);
    const hook = vi.fn(() => { throw new Error("hasInstance hook must not run"); });
    let captured: unknown;
    try {
      Object.defineProperty(constructor, Symbol.hasInstance, { value: hook, configurable: true });
      captured = traceValue({ retained: true }, (text) => text);
    } finally {
      if (original === undefined) Reflect.deleteProperty(constructor, Symbol.hasInstance);
      else Object.defineProperty(constructor, Symbol.hasInstance, original);
    }
    expect(captured).toEqual({ retained: true });
    expect(hook).not.toHaveBeenCalled();
  });

  it("does not read a replaced global Error accessor to prepare stacks", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "Error");
    if (original === undefined) throw new Error("Native Error missing");
    const hook = vi.fn(() => { throw new Error("global Error getter must not run"); });
    const error = new Error("synthetic original stack");
    let captured: unknown;
    try {
      Object.defineProperty(globalThis, "Error", { get: hook, configurable: true });
      captured = traceValue(error, (text) => text);
    } finally { Object.defineProperty(globalThis, "Error", original); }
    expect(captured).toMatchObject({ message: "synthetic original stack", stack: "[accessor]" });
    expect(hook).not.toHaveBeenCalled();
  });

  it("copies modified Buffers without invoking their attached getters", () => {
    const bytes = Buffer.from("synthetic bytes");
    const getter = vi.fn(() => { throw new Error("attached getter must not run"); });
    for (const key of ["length", "buffer", "byteOffset", "byteLength"]) Object.defineProperty(bytes, key, { get: getter });
    expect(traceValue(bytes, (text) => text)).toEqual({ encoding: "base64", data: Buffer.from("synthetic bytes").toString("base64") });
    expect(getter).not.toHaveBeenCalled();
  });

  it("uses captured descriptor, collection and Buffer conversion methods", () => {
    const bytes = Buffer.from("synthetic bytes");
    const expectedBytes = bytes.toString("base64");
    const payload = { bytes, map: new Map([["retained", true]]), set: new Set(["retained"]) };
    const hook = vi.fn(() => { throw new Error("replacement method must not run"); });
    const methods: readonly (readonly [object, string])[] = [
      [Object, "getOwnPropertyDescriptor"], [Object, "getOwnPropertyDescriptors"], [Object, "getPrototypeOf"],
      [Map.prototype, "entries"], [Set.prototype, "values"], [Buffer, "from"], [Buffer.prototype, "toString"],
    ];
    const originals = methods.map(([object, key]) => {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined) throw new Error("Native method missing");
      return { object, key, descriptor };
    });
    let captured: unknown;
    try {
      for (const { object, key, descriptor } of originals) Object.defineProperty(object, key, { ...descriptor, value: hook });
      captured = traceValue(payload, (text) => text);
    } finally {
      for (const { object, key, descriptor } of originals) Object.defineProperty(object, key, descriptor);
    }
    expect(captured).toEqual({ bytes: { encoding: "base64", data: expectedBytes }, map: { entries: [["retained", true]] }, set: { values: ["retained"] } });
    expect(hook).not.toHaveBeenCalled();
  });

  it("never coerces an object-valued Error name or message while capturing a stack", () => {
    const toString = vi.fn(() => "authored coercion");
    for (const key of ["name", "message"]) {
      const error = new Error("synthetic original");
      Object.defineProperty(error, key, { value: { toString }, configurable: true });
      expect(traceValue(error, (text) => text)).toMatchObject({ stack: "[accessor]" });
    }
    expect(toString).not.toHaveBeenCalled();
  });

  it("skips native stack capture after the trusted preparation descriptor changes", () => {
    const original = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
    const hook = vi.fn();
    try {
      Object.defineProperty(Error, "prepareStackTrace", { get: hook, configurable: true });
      expect(traceValue(new Error("synthetic"), (text) => text)).toMatchObject({ stack: "[accessor]" });
      expect(hook).not.toHaveBeenCalled();
      if (original !== undefined) {
        Object.defineProperty(Error, "prepareStackTrace", { ...original, enumerable: !original.enumerable });
        expect(traceValue(new Error("synthetic"), (text) => text)).toMatchObject({ stack: "[accessor]" });
      }
    } finally {
      if (original === undefined) Reflect.deleteProperty(Error, "prepareStackTrace");
      else Object.defineProperty(Error, "prepareStackTrace", original);
    }
  });

  it("expands nested errors, Effect Causes, maps, bytes and cycles without truncation", () => {
    const cyclic: Record<string, unknown> = { text: "x".repeat(100_000) };
    cyclic["self"] = cyclic;
    const error = new Error("outer", { cause: new Error("inner") });
    const value = traceValue({ cause: Cause.parallel(Cause.fail(error), Cause.die({ reason: "defect" })), map: new Map([["body", { response: "retained" }]]), bytes: Buffer.from("bytes"), cyclic }, (text) => text);
    expect(value).toMatchObject({ map: { entries: [["body", { response: "retained" }]] }, bytes: { encoding: "base64", data: Buffer.from("bytes").toString("base64") }, cyclic: { text: "x".repeat(100_000), self: "[circular]" } });
    const text = JSON.stringify(value);
    expect(text).toContain("inner");
    expect(text).toContain("stack");
    expect(text).toContain("defect");
  });
});

describe("model trace", () => {
  for (const role of ["minter", "guardian", "outcome"] as const) it(`preserves request and response identity for ${role}`, async () => {
    const { trace } = memoryTrace();
    const getResponse = vi.fn(async (sent: ModelRequest) => { expect(sent).toBe(request); return response; });
    const model = await tracedProvider(trace, role, { getModel: () => ({ getResponse, getStreamedResponse: async function* () {} }) }).getModel();
    expect(await model.getResponse(request)).toBe(response);
    expect(getResponse).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("preserves prototype retry advice and binds it to the original model", async () => {
    const { trace } = memoryTrace();
    class SyntheticModel implements Model {
      readonly #advice = { suggested: false };
      getResponse = async () => response;
      async *getStreamedResponse() {}
      getRetryAdvice() { return this.#advice; }
    }
    const original = new SyntheticModel();
    const model = await tracedProvider(trace, "minter", { getModel: () => original }).getModel();
    expect(model.getRetryAdvice).toBeTypeOf("function");
    expect(await model.getRetryAdvice?.({ request, error: new Error("synthetic failure"), stream: false, attempt: 1 })).toBe(original.getRetryAdvice());
    const plain = await tracedProvider(trace, "minter", { getModel: () => ({ getResponse: async () => response, getStreamedResponse: async function* () {} }) }).getModel();
    expect(plain.getRetryAdvice).toBeUndefined();
  });

  it("keeps the SDK's lazy default override and explicit provider selection", async () => {
    const { trace } = memoryTrace();
    const getModel = vi.fn(() => ({ getResponse: async () => response, getStreamedResponse: async function* () {} }));
    const provider: ModelProvider = { getModel };
    const wrapped = tracedProvider(trace, "minter");
    setDefaultModelProvider(provider);
    try {
      const model = await wrapped.getModel("synthetic-default");
      expect(await model.getResponse(request)).toBe(response);
      expect(getModel).toHaveBeenCalledExactlyOnceWith("synthetic-default");
      const explicit = { getModel: vi.fn((name?: string) => provider.getModel(name)) };
      await tracedProvider(trace, "guardian", explicit).getModel("synthetic-explicit");
      expect(explicit.getModel).toHaveBeenCalledExactlyOnceWith("synthetic-explicit");
    } finally { setDefaultModelProvider(new OpenAIProvider()); }
  });

  it("passes original requests and streamed events unchanged, including cancellation and errors", async () => {
    const { trace, events } = memoryTrace();
    const sent: ModelRequest[] = [];
    const started = { type: "response_started" as const };
    const chunk = { type: "output_text_delta" as const, delta: "synthetic delta" };
    const failure = new Error("synthetic stream failure");
    const closed = vi.fn();
    const provider: ModelProvider = { getModel: () => ({
      getResponse: async (value) => { sent.push(value); return response; },
      getStreamedResponse: async function* (value) { sent.push(value); try { yield started; yield chunk; throw failure; } finally { closed(); } },
    }) };
    const model = await tracedProvider(trace, "minter", provider).getModel();
    expect(await model.getResponse(request)).toBe(response);
    const iterator = model.getStreamedResponse(request)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(started);
    expect((await iterator.next()).value).toBe(chunk);
    await expect(iterator.next()).rejects.toBe(failure);
    const cancelled = model.getStreamedResponse(request)[Symbol.asyncIterator]();
    await cancelled.next();
    await cancelled.return?.();
    expect(closed).toHaveBeenCalledTimes(2);
    expect(sent).toEqual([request, request, request]);
    expect(sent.every((value) => value === request)).toBe(true);
    expect(events.some((event) => event.kind === "model.error" && event.data !== undefined)).toBe(true);
  });

  for (const name of ["read_source", "read_skill", "apply_patch"]) it(`retains a final ${name} result without another model request`, async () => {
    const { trace, events } = memoryTrace();
    const observed = traceObserverFactory(trace)(async () => {});
    const getResponse = vi.fn(async () => ({ usage: new Usage(), output: [{ type: "function_call" as const, name, callId: `final_${name}`, arguments: "{}", status: "completed" as const }] }));
    const runner = new Runner({ modelProvider: { getModel: () => ({ getResponse, getStreamedResponse: async function* () {} }) }, tracingDisabled: true });
    observed.attach(runner);
    const agent = new Agent({ name: "Synthetic final tool fixture", tools: [tool({ name, description: "synthetic fixture", parameters: { type: "object", properties: {}, required: [], additionalProperties: false }, execute: async () => `${name} final result` })], toolUseBehavior: "stop_on_first_tool" });
    const result = await runner.run(agent, "synthetic input");
    expect(result.finalOutput).toBe(`${name} final result`);
    expect(getResponse).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual({ kind: "tool.result", data: { name, result: `${name} final result` } });
    expect(observed.durabilityFailure()).toBeUndefined();
    await observed.flush();
  });
});
