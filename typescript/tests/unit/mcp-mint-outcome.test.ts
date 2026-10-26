import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { LocalMintOutcome } from "../../src/standalone/contracts.js";
import { makePomeradoMcp } from "../../src/standalone/mcp-server.js";

const state = vi.hoisted(() => ({ outcome: undefined as LocalMintOutcome | undefined }));
vi.mock("../../src/standalone/pomerado.js", () => ({
  createPomerado: () => Effect.succeed({ mint: () => Effect.succeed(state.outcome!) }),
}));

/** Exercise mint/get_job over MCP without a browser, model or website. */
const finished = (outcome: LocalMintOutcome) => {
  state.outcome = outcome;
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const server = yield* makePomeradoMcp({
      prepare: () => Effect.succeed(() => Effect.succeed({ directory: "/synthetic/integration" })),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    yield* Effect.promise(() => server.connect(serverTransport));
    const client = new Client({ name: "unit-outcome", version: "1.0.0" });
    yield* Effect.acquireRelease(
      Effect.promise(() => client.connect(clientTransport)),
      () => Effect.promise(() => client.close()),
    );
    const started = yield* Effect.promise(() => client.callTool({
      name: "mint", arguments: { name: "fixture", url: "https://example.com", intent: "Read a heading", effect: "read" },
    }));
    const jobId = (started.structuredContent as Record<string, unknown>)["job_id"];
    for (let i = 0; i < 10; i++) {
      const response = yield* Effect.promise(() => client.callTool({
        name: "get_job", arguments: { job_id: jobId, wait_seconds: 1 },
      }));
      const view = response.structuredContent as Record<string, unknown>;
      if (view["status"] === "completed") return view["output"];
    }
    throw new Error("Synthetic mint did not complete");
  })));
};

it("returns typed stop details and execution counts without private execution data", async () => {
  const output = await finished({
    build: "incomplete", summary: "The host could not finish.",
    stopReason: "host_unavailable", hostFailure: "review_unavailable",
    recoveryReason: "login_check_unavailable", possibleCommit: true,
    noResponse: { possibleCommit: true },
    publicationDenial: { reason: "host_owned", category: "confirmation", publicReason: "screened prose" },
    stopExplanation: "screened explanation",
    diagnostics: ["private diagnostic"],
    executions: [
      { executionId: "private-one", status: "completed", effect: "verified", authentication: { state: "authenticated", effect: "verified" }, observations: "private output", review: { reviewId: "private-review", outcome: "allow", rationale: "private rationale" } },
      { executionId: "private-two", status: "failed", effect: "possible", authentication: { state: "failed", effect: "possible" }, observations: "private login" },
      { executionId: "private-three", status: "unsupported", effect: "not_sent", observations: null },
      { executionId: "private-four", status: "needs_input", effect: "not_sent", observations: null },
    ],
  });
  expect(output).toEqual({
    build: "incomplete", summary: "The host could not finish.",
    stopReason: "host_unavailable", hostFailure: "review_unavailable",
    recoveryReason: "login_check_unavailable", possibleCommit: true,
    noResponse: { possibleCommit: true },
    publicationDenial: { reason: "host_owned", category: "confirmation" },
    executionSummary: {
      total: 4, completed: 1, failed: 1, unsupported: 1, needsInput: 1,
      authentication: { authenticated: 1, failed: 1 },
    },
    failedExecutions: [{ executionId: "unknown", purpose: "unknown", effect: "possible", source: "unknown" }],
  });
  expect(JSON.stringify(output)).not.toContain("private");
  expect(JSON.stringify(output)).not.toContain("screened");
});

it("does not invent a stop reason when the core supplied none", async () => {
  expect(await finished({ build: "incomplete", summary: "Stopped.", executions: [], diagnostics: [] }))
    .toEqual({ build: "incomplete", summary: "Stopped.", failedExecutions: [], executionSummary: {
      total: 0, completed: 0, failed: 0, unsupported: 0, needsInput: 0,
      authentication: { authenticated: 0, failed: 0 },
    } });
});

it("keeps a published integration's existing response", async () => {
  expect(await finished({
    build: "published", summary: "Published.", executions: [{
      executionId: randomUUID(), status: "failed", effect: "possible", observations: "private output",
    }], diagnostics: [],
    artifact: { entrypoint: "src/tool.mjs", files: [], inputSchema: {}, outputSchema: {} },
  })).toEqual({ build: "published", integration: { directory: "/synthetic/integration" } });
});

it("returns the newest twenty failures in ledger order without changing counts or inferring a stop reason", async () => {
  const executions = Array.from({ length: 24 }, (_, index) => ({
    executionId: randomUUID(), status: "failed", effect: index % 2 === 0 ? "possible" : "not_sent",
    observations: { stdout: "private stdout", message: "private message" },
    failure: { purpose: "command", source: "command", exitCode: index + 1 },
  } satisfies LocalMintOutcome["executions"][number]));
  const output = await finished({
    build: "incomplete", summary: "Stopped.", diagnostics: [],
    executions: [...executions, { executionId: randomUUID(), status: "completed", effect: "verified", observations: null }],
  });
  expect(output).toMatchObject({ executionSummary: { total: 25, failed: 24, completed: 1 } });
  expect(output).toHaveProperty("failedExecutions", executions.slice(4).map((entry) => ({
    executionId: entry.executionId, effect: entry.effect, purpose: "command", source: "command", exitCode: entry.failure.exitCode,
  })));
  expect(output).not.toHaveProperty("stopReason");
  expect(JSON.stringify(output)).not.toContain("private");
});

it("keeps missing metadata unknown and accepts only host execution ID formats", async () => {
  const executionId = randomUUID();
  const unresolvedId = `unresolved_${randomUUID()}`;
  expect(await finished({
    build: "incomplete", summary: "Stopped.", diagnostics: [],
    executions: [executionId, unresolvedId, "private-ref", `unresolved_${executionId}_private`, "00000000-0000-0000-0000-000000000000"].map((id) => ({
      executionId: id, status: "failed", effect: "verified", observations: { code: "OperationFailure" },
    })),
  })).toHaveProperty("failedExecutions", [executionId, unresolvedId, "unknown", "unknown", "unknown"].map((id) => ({
    executionId: id, purpose: "unknown", effect: "verified", source: "unknown",
  })));
});

it("projects only finite failure fields even when private extras accompany a valid code", async () => {
  const execution = { executionId: randomUUID(), status: "failed", effect: "possible", observations: null } satisfies LocalMintOutcome["executions"][number];
  Object.defineProperty(execution, "failure", { value: {
    purpose: "example", source: "script", code: "OperationFailure",
    tag: "sk_live_SYNTHETIC_FAILURE_TAG", message: "private message", frame: "private-frame",
    inputIssues: ["private issue"], stdout: "private stdout", stderr: "private stderr",
    failureDetail: "private cause", resultRef: "private reference", rationale: "private rationale",
  } });
  const output = await finished({ build: "incomplete", summary: "Stopped.", diagnostics: [], executions: [execution] });
  expect(output).toHaveProperty("failedExecutions", [{ executionId: execution.executionId, purpose: "example", effect: "possible", source: "script", code: "OperationFailure" }]);
  expect(JSON.stringify(output)).not.toContain("private");
  expect(JSON.stringify(output)).not.toContain("sk_live");
});

it.each([
  { purpose: "example", source: "script", code: "OperationFailure_DYNAMIC" },
  { purpose: "example", source: "script", code: "sk_live_SYNTHETIC_FAILURE_CODE" },
  { purpose: "private-purpose", source: "host", code: "Unavailable" },
  { purpose: "command", source: "command", exitCode: 256 },
])("does not serialize malformed failure metadata %j", async (failure) => {
  const execution = { executionId: randomUUID(), status: "failed", effect: "possible", observations: null } satisfies LocalMintOutcome["executions"][number];
  Object.defineProperty(execution, "failure", { value: failure });
  expect(await finished({ build: "incomplete", summary: "Stopped.", diagnostics: [], executions: [execution] }))
    .toHaveProperty("failedExecutions", [{ executionId: execution.executionId, purpose: "unknown", effect: "possible", source: "unknown" }]);
});
