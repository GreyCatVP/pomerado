import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
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
  });
  expect(JSON.stringify(output)).not.toContain("private");
  expect(JSON.stringify(output)).not.toContain("screened");
});

it("does not invent a stop reason when the core supplied none", async () => {
  expect(await finished({ build: "incomplete", summary: "Stopped.", executions: [], diagnostics: [] }))
    .toEqual({ build: "incomplete", summary: "Stopped.", executionSummary: {
      total: 0, completed: 0, failed: 0, unsupported: 0, needsInput: 0,
      authentication: { authenticated: 0, failed: 0 },
    } });
});

it("keeps a published integration's existing response", async () => {
  expect(await finished({
    build: "published", summary: "Published.", executions: [], diagnostics: [],
    artifact: { entrypoint: "src/tool.mjs", files: [], inputSchema: {}, outputSchema: {} },
  })).toEqual({ build: "published", integration: { directory: "/synthetic/integration" } });
});
