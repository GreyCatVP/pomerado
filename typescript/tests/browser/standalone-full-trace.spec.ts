import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { expect, test } from "@playwright/test";
import { Effect, Schema } from "effect";
import { makePomeradoMcp } from "pomerado/mcp";
import {
  call,
  execution,
  executionIdOf,
  html,
  message,
  objects,
  patch,
  quietReviewer,
  recordingGuardian,
  scripted,
  startSite,
  toolResult,
} from "./guardian-context-fixture.js";

const record = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const privateHeading = "SYNTHETIC_FULL_TRACE_PRIVATE_HEADING";
const privateStdout = "SYNTHETIC_FULL_TRACE_STDOUT";
const privateStderr = "SYNTHETIC_FULL_TRACE_STDERR";
const errorPrefix = "SYNTHETIC_FULL_TRACE_UNKNOWN_ERROR";
const errorText = `${errorPrefix} ${privateHeading}`;
const entrypoint = "src/full-trace.mjs";
const command = `printf '%s\\n' '${privateStdout}'; printf '%s\\n' '${privateStderr}' >&2; exit 7`;
const authoredSource = `import { Schema } from "effect";
import { defineOperation } from "../runtime/index.js";
export default defineOperation({name:"full_trace_fixture",input:Schema.Struct({}),output:Schema.Unknown},
async ({kernel,sessionId,errors}) => {
  const heading = await kernel.browsers.playwright.execute(sessionId,{code:"return await page.locator('h1').textContent();",timeout_sec:5});
  if (!heading.success || heading.result !== ${JSON.stringify(privateHeading)}) throw new Error("Fixture heading was not read");
  throw Object.assign(new errors.OperationFailure(${JSON.stringify(errorPrefix)} + " " + heading.result), {code:undefined,_tag:undefined});
});`;

const containsText = (value: unknown, text: string) =>
  objects(value).some((object) =>
    Object.values(object).some((field) => typeof field === "string" && field.includes(text)),
  );

const withTraceFixture = async (
  run: (fixture: { readonly traceDir: string; readonly site: Awaited<ReturnType<typeof startSite>> }) => Promise<void>,
) => {
  const temporaryDir = await mkdtemp(join(tmpdir(), "pomerado-full-trace-"));
  const traceDir = join(temporaryDir, "private-trace");
  const previous = process.env["POMERADO_TRACE_DIR"];
  process.env["POMERADO_TRACE_DIR"] = traceDir;
  try {
    const site = await startSite((_request, response) =>
      html(response, `<title>Full trace fixture</title><h1>${privateHeading}</h1>`),
    );
    try {
      await run({ traceDir, site });
    } finally {
      await site.close();
    }
  } finally {
    if (previous === undefined) delete process.env["POMERADO_TRACE_DIR"];
    else process.env["POMERADO_TRACE_DIR"] = previous;
    await rm(temporaryDir, { recursive: true, force: true });
  }
};

const finishedMint = async (url: string, turns: readonly ModelResponse["output"][]) => {
  const requests: ModelRequest[] = [];
  const guardian = recordingGuardian();
  const minter = scripted(
    (_request, index) => turns[index] ?? [message("Stopped after the synthetic failure.")],
    requests,
  );
  const { jobId, response } = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* makePomeradoMcp({
          pomerado: {
            minterProvider: minter,
            guardianProvider: guardian.provider,
            outcomeReviewerProvider: quietReviewer,
            timeoutMs: 60_000,
          },
          prepare: () => Effect.succeed(() => Effect.dieMessage("A failing build must not publish")),
        });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        yield* Effect.promise(() => server.connect(serverTransport));
        const client = new Client({ name: "full-trace-fixture", version: "1.0.0" });
        yield* Effect.acquireRelease(
          Effect.promise(() => client.connect(clientTransport)),
          () => Effect.promise(() => client.close()),
        );
        const started = yield* Effect.promise(() => client.callTool({
          name: "mint",
          arguments: {
            name: "full_trace_fixture",
            url,
            intent: "Read the synthetic fixture heading",
            effect: "read",
          },
        }));
        expect(started.isError).not.toBe(true);
        const { job_id: jobId } = Schema.decodeUnknownSync(Schema.Struct({ job_id: Schema.UUID }))(
          started.structuredContent,
        );
        for (let attempt = 0; attempt < 12; attempt++) {
          const response = yield* Effect.promise(() => client.callTool({
            name: "get_job",
            arguments: { job_id: jobId, wait_seconds: 5 },
          }));
          expect(response.isError).not.toBe(true);
          const view = Schema.decodeUnknownSync(record)(response.structuredContent);
          if (view["status"] === "completed") return { jobId, response };
          expect(view["status"], JSON.stringify(response)).toBe("running");
        }
        throw new Error("Scripted full-trace fixture did not complete within 60 seconds");
      }),
    ),
  );
  const view = Schema.decodeUnknownSync(record)(response.structuredContent);
  const output = Schema.decodeUnknownSync(record)(view["output"]);
  expect(output).toMatchObject({
    build: "incomplete",
    executionSummary: { total: 1, failed: 1, completed: 0 },
  });
  const publicText = JSON.stringify(response);
  for (const privateText of [privateHeading, privateStdout, privateStderr, errorPrefix, authoredSource, command])
    expect(publicText).not.toContain(privateText);
  return { jobId, output, requests };
};

const traceEvents = async (traceDir: string, jobId: string) => {
  const path = join(traceDir, `${jobId}.jsonl`);
  expect(existsSync(path), "POMERADO_TRACE_DIR must contain the MCP job's private JSONL after client and session cleanup").toBe(true);
  expect((await stat(traceDir)).mode & 0o777, "The logger must create its private trace directory with mode 0700").toBe(0o700);
  expect((await stat(path)).mode & 0o777, "The logger must create its private trace file with mode 0600").toBe(0o600);
  const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
  const events = lines.map((line) => Schema.decodeUnknownSync(Schema.parseJson(record))(line));
  expect(events.length, "A full trace must contain chronological execution events").toBeGreaterThan(1);
  return events;
};

test("private full trace retains a failed command and both output streams after MCP cleanup", async () => {
  test.setTimeout(90_000);
  await withTraceFixture(async ({ traceDir, site }) => {
    const callId = "full_trace_failed_command";
    const { jobId, output, requests } = await finishedMint(site.url, [
      [call("exec_command", { cmd: command }, callId)],
    ]);
    const receipt = toolResult(requests.at(-1), callId);
    const executionId = executionIdOf(requests.at(-1), callId);
    expect(receipt).toMatchObject({ status: "failed" });
    expect(objects(receipt?.["observations"])).toContainEqual(expect.objectContaining({
      exitCode: 7,
      stdout: `${privateStdout}\n`,
      stderr: `${privateStderr}\n`,
    }));
    expect(output["failedExecutions"]).toEqual([{
      executionId, purpose: "command", effect: "not_sent", source: "command", exitCode: 7,
    }]);

    const events = await traceEvents(traceDir, jobId);
    const commandIndex = events.findIndex((event) => containsText(event, command));
    expect(commandIndex, "The private trace must retain the full command").toBeGreaterThanOrEqual(0);
    const resultIndex = events.findIndex((event) =>
      containsText(event, executionId) && objects(event).some((object) =>
        object["exitCode"] === 7 && object["stdout"] === `${privateStdout}\n` && object["stderr"] === `${privateStderr}\n`,
      ),
    );
    expect(resultIndex, "The private trace must retain the actual command receipt with stdout, stderr, exit 7, and execution ID").toBeGreaterThanOrEqual(0);
    expect(commandIndex, "The command must precede its returned output in the trace").toBeLessThan(resultIndex);
  });
});

test("private full trace retains an unknown-code browser failure and authored context while MCP stays finite", async () => {
  test.setTimeout(90_000);
  await withTraceFixture(async ({ traceDir, site }) => {
    const callId = "full_trace_failed_browser";
    const { jobId, output, requests } = await finishedMint(site.url, [
      patch({ [entrypoint]: authoredSource }),
      [call("execute", execution("example", entrypoint), callId)],
    ]);
    const receipt = toolResult(requests.at(-1), callId);
    const executionId = executionIdOf(requests.at(-1), callId);
    expect(receipt).toMatchObject({ status: "failed" });
    expect(objects(receipt?.["observations"])).toContainEqual(expect.objectContaining({ message: errorText }));
    expect(site.requests).toContain("GET /");
    expect(output["failedExecutions"]).toEqual([{
      executionId, purpose: "example", effect: "possible", source: "script", code: "unknown",
    }]);

    const events = await traceEvents(traceDir, jobId);
    const sourceIndex = events.findIndex((event) => containsText(event, authoredSource));
    expect(sourceIndex, "The private trace must retain the complete authored source").toBeGreaterThanOrEqual(0);
    const errorIndex = events.findIndex((event) =>
      containsText(event, executionId) && objects(event).some((object) =>
        object["message"] === errorText || object["error"] === errorText,
      ),
    );
    expect(errorIndex, "The private trace must retain the runtime Error message in an actual error or receipt payload with its execution ID").toBeGreaterThanOrEqual(0);
    expect(sourceIndex, "Authored source must precede the failed execution receipt in the trace").toBeLessThan(errorIndex);
    expect(events.some((event) => containsText(event, executionId) && containsText(event, entrypoint)),
      "The private trace must correlate the execution ID with its authored entrypoint").toBe(true);
  });
});
