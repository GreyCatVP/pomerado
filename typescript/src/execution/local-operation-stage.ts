import { existsSync, realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Effect } from "effect";
import {
  localError,
  localFilePath,
  localPromise,
  localPathKey,
  localRelativePath,
  localSourceBundleLimit,
  localSourceFileLimit,
} from "./local-path.js";
import { localRuntimeAssets } from "./local-runtime-assets.js";
import type { LocalOperationOptions } from "./local-operation.js";

const installedDependencies = Effect.try({
  try: () => {
    const effect = realpathSync(fileURLToPath(import.meta.resolve("effect/package.json")));
    let current = dirname(fileURLToPath(import.meta.url));
    while (true) {
      const dependencies = join(current, "node_modules");
      const candidate = join(dependencies, "effect", "package.json");
      if (existsSync(candidate) && realpathSync(candidate) === effect) return dependencies;
      const parent = dirname(current);
      if (parent === current)
        throw new Error("Installed local runtime dependencies are unavailable");
      current = parent;
    }
  },
  catch: localError,
});

/** The running package's public runtime, the module `pomerado/runtime` names. */
const runtimeEntry = new URL(
  import.meta.url.endsWith(".ts") ? "../browser/index.ts" : "../browser/index.js",
  import.meta.url,
);

/**
 * The staged `node_modules`: the installed dependencies, and in place of any installed `pomerado`
 * a package that exports only `./runtime`, which re-exports the running package's runtime. A tool
 * imports `pomerado/runtime` as the same modules the host runs, wherever the package is installed,
 * and an import of the package's internal modules fails to resolve.
 */
const stageDependencies = (directory: string) =>
  Effect.gen(function* () {
    const dependencies = yield* installedDependencies;
    const modules = join(directory, "node_modules");
    yield* localPromise(() => mkdir(modules));
    for (const entry of yield* localPromise(() => readdir(dependencies, { withFileTypes: true })))
      if (entry.name !== "pomerado")
        yield* localPromise(() => process.platform === "win32" && !entry.isDirectory() && !entry.isSymbolicLink()
          ? copyFile(join(dependencies, entry.name), join(modules, entry.name))
          : symlink(join(dependencies, entry.name), join(modules, entry.name), process.platform === "win32" ? "junction" : "dir"));
    const pomerado = join(modules, "pomerado");
    yield* localPromise(() => mkdir(pomerado));
    const manifest = { name: "pomerado", type: "module", exports: { "./runtime": "./runtime.js" } };
    yield* localPromise(() =>
      writeFile(join(pomerado, "package.json"), JSON.stringify(manifest), {
        flag: "wx",
        mode: 0o400,
      }),
    );
    yield* localPromise(() =>
      writeFile(
        join(pomerado, "runtime.js"),
        `export * from ${JSON.stringify(runtimeEntry.href)};\n`,
        { flag: "wx", mode: 0o400 },
      ),
    );
  });

/** Top-level names the host stages beside authored source, as a file or a folder. */
const reserved = new Set([
  "runtime",
  "browser",
  "filesystem",
  "privacy",
  "testing",
  "node_modules",
]);

export const stageSources = (options: LocalOperationOptions) =>
  Effect.gen(function* () {
    const directory = yield* localPromise(() => mkdtemp(join(tmpdir(), "pomerado-operation-")));
    yield* Effect.addFinalizer(() =>
      localPromise(() => rm(directory, { recursive: true, force: true })).pipe(Effect.orDie),
    );
    const seen = new Set<string>();
    let total = 0;
    const authored: Array<readonly [string, string]> = [];
    for (const [supplied, text] of options.sources) {
      const path = yield* Effect.try({ try: () => localRelativePath(supplied), catch: localError });
      if (seen.has(localPathKey(path)))
        return yield* Effect.fail(new Error(`Duplicate reviewed source: ${path}`));
      seen.add(localPathKey(path));
      if (reserved.has(localPathKey(path.split("/")[0] ?? path)))
        return yield* Effect.fail(new Error(`Reviewed source cannot replace trusted SDK: ${path}`));
      total += Buffer.byteLength(text);
      if (Buffer.byteLength(text) > localSourceFileLimit || total > localSourceBundleLimit)
        return yield* Effect.fail(new Error("Reviewed source exceeds local execution size limit"));
      authored.push([path, text]);
    }
    const entrypoint = yield* Effect.try({
      try: () => localRelativePath(options.entrypoint),
      catch: localError,
    });
    if (!seen.has(localPathKey(entrypoint)))
      return yield* Effect.fail(new Error("Entrypoint is absent from reviewed source snapshot"));
    // Authored source sits a level below the SDK, so src/ reaches it at ../../runtime/index.js.
    const operation = join(directory, "operation");
    yield* localPromise(() => mkdir(operation));
    for (const [path, text] of authored) {
      const destination = yield* localFilePath(operation, path, true);
      yield* localPromise(() => writeFile(destination, text, { flag: "wx", mode: 0o400 }));
    }
    const assets = yield* localRuntimeAssets;
    for (const [path, text] of assets) {
      const destination = yield* localFilePath(directory, path, true);
      if (path === "runtime/index.js")
        yield* localPromise(() => writeFile(destination, text, { flag: "wx", mode: 0o400 }));
      else {
        // Realpaths keep authored error classes identical to the child runner's installed SDK.
        const installed = import.meta.url.endsWith(".ts") ? path.replace(/\.js$/, ".ts") : path;
        const trusted = fileURLToPath(new URL(`../${installed}`, import.meta.url));
        yield* localPromise(() => process.platform === "win32"
          ? writeFile(destination, `export * from ${JSON.stringify(pathToFileURL(trusted).href)};\n`, { flag: "wx", mode: 0o400 })
          : symlink(trusted, destination, "file"));
      }
    }
    yield* localPromise(() =>
      writeFile(join(directory, "package.json"), '{"type":"module"}', {
        flag: "wx",
        mode: 0o400,
      }),
    );
    // Dependencies stay in the installed package; authored source bytes are copied unchanged.
    yield* stageDependencies(directory);
    // Source saved when authored files sat beside the SDK reaches it and node_modules one level up
    // from src/, and finds package.json in its working folder. The same entries appear in
    // operation/, so those paths load the same modules and read the same file.
    const sdk = assets.map(([path]) => path.split("/")[0] ?? path);
    for (const shared of new Set([...sdk, "node_modules"]))
      yield* localPromise(() => symlink(join(directory, shared), join(operation, shared), process.platform === "win32" ? "junction" : "dir"));
    if (!seen.has("package.json"))
      yield* localPromise(() =>
        process.platform === "win32"
          ? copyFile(join(directory, "package.json"), join(operation, "package.json"))
          : symlink(join("..", "package.json"), join(operation, "package.json"), "file"),
      );
    // The child runs from the authored root, so relative file paths resolve as they did before.
    return { directory: operation, entrypoint: join(operation, entrypoint) };
  });
