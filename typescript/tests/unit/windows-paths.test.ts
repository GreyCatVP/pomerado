import { Effect } from "effect";
import { expect, it } from "vitest";
import { localRelativePath } from "../../src/execution/local-path.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { stageSources } from "../../src/execution/local-operation-stage.js";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

it.runIf(process.platform === "win32").each(["NUL", "con.txt", "src/COM1.js", "src/name.", "src/file:stream"])(
  "rejects Windows device and alias paths: %s", (path) => {
    expect(() => localRelativePath(path)).toThrow("plain relative");
  },
);

it.runIf(process.platform === "win32")("cannot edit or publish a case alias of installed runtime source", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    yield* workspace.install("runtime/index.js", "trusted");
    const editing = yield* Effect.either(workspace.write("RUNTIME/INDEX.JS", "changed"));
    expect(editing._tag).toBe("Left");
    expect(yield* workspace.read("runtime/index.js")).toBe("trusted");
    expect(yield* workspace.snapshot).toEqual([]);
    for (const sources of [
      [["src/tool.mjs", ""], ["SRC/TOOL.MJS", ""]],
      [["Runtime/index.js", ""]],
    ] as const) {
      const result = yield* Effect.either(runLocalOperation({ workspace, entrypoint: sources[0][0], sources, input: {} }));
      expect(result._tag).toBe("Left");
      if (result._tag === "Left") expect(result.left.message).toMatch(/Duplicate reviewed source|cannot replace trusted SDK/);
    }
  })));
});

it.runIf(process.platform === "win32")("preserves a reviewed package manifest with different casing", async () => {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const workspace = yield* createLocalWorkspace();
    const manifest = '{"type":"module","synthetic":true}';
    const staged = yield* stageSources({ workspace, entrypoint: "src/tool.mjs",
      sources: [["src/tool.mjs", ""], ["Package.JSON", manifest]], input: {} });
    expect(yield* Effect.promise(() => readFile(join(staged.directory, "Package.JSON"), "utf8"))).toBe(manifest);
    expect((yield* Effect.promise(() => readdir(staged.directory))).filter((path) => path.toLowerCase() === "package.json"))
      .toEqual(["Package.JSON"]);
  })));
});
