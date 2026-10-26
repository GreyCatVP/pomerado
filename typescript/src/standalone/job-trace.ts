import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Effect, Exit, type Scope } from "effect";
import { makeRunSecrets, type RunSecrets } from "../inputs/secrets.js";
import { traceValue } from "../privacy/trace-value.js";

export interface JobTrace {
  readonly event: (kind: string, data: unknown, ref?: string) => void;
  readonly secrets: RunSecrets;
}
export const validateTraceDirectory = (directory: string) => {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o700)
    throw new Error("Trace directory must be an owned directory with mode 0700.");
};

const stderrNotice = (text: string) => {
  try { writeSync(2, text); } catch {}
};

export const openJobTrace = (
  directory: string,
  jobId: string,
  io: {
    readonly write?: (fd: number, bytes: Uint8Array, offset: number, length: number, position: null) => number;
    readonly sync?: (fd: number) => void;
    readonly notice?: (text: string) => unknown;
  } = {},
) => {
  const { write = writeSync, sync = fsyncSync, notice = stderrNotice } = io;
  if (!/^[0-9a-f-]{36}$/u.test(jobId)) throw new Error("Invalid trace job ID.");
  const fd = openSync(join(directory, `${jobId}.jsonl`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const secrets = makeRunSecrets();
  let state: "open" | "broken" | "closed" = "open";
  let seq = 0;
  const stopped = () => {
    if (state !== "open") return;
    state = "broken";
    try { notice("Private job trace stopped after a write failure.\n"); } catch {}
  };
  const trace: JobTrace = {
    secrets,
    event: (kind, data, ref) => {
      if (state !== "open") return;
      const event = { seq: ++seq, at: new Date().toISOString(), job: jobId, kind, ...(ref === undefined ? {} : { ref }) };
      let line: Buffer;
      try {
        line = Buffer.from(JSON.stringify(traceValue({ ...event, data }, secrets.redact)) + "\n");
      } catch {
        line = Buffer.from(JSON.stringify(traceValue({ ...event, data: { traceCapture: "failed" } }, secrets.redact)) + "\n");
      }
      try {
        let offset = 0;
        while (offset < line.length) {
          const written = write(fd, line, offset, line.length - offset, null);
          if (written <= 0) throw new Error("Incomplete trace write.");
          offset += written;
        }
        sync(fd);
      } catch { stopped(); }
    },
  };
  const close = () => {
    if (state === "closed") return;
    try { if (state === "open") sync(fd); } catch { stopped(); }
    try { closeSync(fd); } catch { stopped(); }
    state = "closed";
    secrets.clear();
  };
  return { ...trace, close };
};

export const tracedEffect = <A, E, R>(trace: JobTrace | undefined, kind: string, effect: Effect.Effect<A, E, R>, ref?: string) =>
  trace === undefined ? effect : effect.pipe(
    Effect.tap((result) => Effect.sync(() => trace.event(`${kind}.result`, result, ref))),
    Effect.tapErrorCause((cause) => Effect.sync(() => trace.event(`${kind}.error`, cause, ref))),
  );

export const withJobTrace = <A>(directory: string, jobId: string, work: (trace: JobTrace) => Effect.Effect<A, Error, Scope.Scope>) =>
  Effect.acquireUseRelease(
    Effect.try({ try: () => openJobTrace(directory, jobId), catch: (cause) => new Error("Could not open private job trace.", { cause }) }),
    (trace) => Effect.scoped(Effect.suspend(() => {
      trace.event("job.start", { jobId });
      return work(trace);
    })),
    (trace, exit) => Effect.sync(() => { trace.event("job.end", Exit.isSuccess(exit) ? { _tag: "Success", value: exit.value } : { _tag: "Failure", cause: exit.cause }); trace.close(); }),
  );
