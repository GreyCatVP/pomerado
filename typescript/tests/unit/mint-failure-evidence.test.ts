import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { ExecutionEvidence, MintFailure, MintHarnessSnapshot } from "../../src/mint/contracts.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";
import { failureDetail } from "../../src/runtime/failure-detail.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const fixture = makeMintHarnessFixture(cleanup, { mode: "mint", intent: "Read a synthetic result", businessInput: {}, observations: [] }, portableJobSession);
const execution = { purpose: "example", target: "pureFiles", entrypoint: "src/tool.ts", fixtureRefs: [], caseFilter: [], maxWorkers: 1, timeoutSeconds: 30 };
const receipt = { executionId: randomUUID(), status: "failed", effect: "possible", observations: "private message" } satisfies ExecutionEvidence;

it.each([
  { purpose: "example", source: "script", code: "OperationFailure" },
  { purpose: "test", source: "script", code: "unclassified" },
  { purpose: "inspect", source: "script", code: "unknown" },
  { purpose: "command", source: "command", exitCode: 0 },
  { purpose: "command", source: "command", exitCode: 255 },
  { purpose: "command", source: "command", exitCode: "unknown" },
  { purpose: "act", source: "host", code: "ScopeDenied" },
  { purpose: "act", source: "host", code: "unclassified" },
  { purpose: "authenticate", source: "host", code: "unknown" },
])("preserves finite failure metadata through the journal receipt codec and harness checkpoint %j", async (failure) => {
  const journalReceipt = Schema.decodeUnknownSync(ExecutionEvidence)({ ...receipt, failure });
  const restored = Schema.decodeUnknownSync(Schema.parseJson(ExecutionEvidence))(
    Schema.encodeSync(Schema.parseJson(ExecutionEvidence))(journalReceipt),
  );
  expect(restored).toHaveProperty("failure", failure);
  let capture: (() => MintHarnessSnapshot) | undefined;
  const f = await fixture((turn) => Effect.asVoid(turn.actions.execute(execution)), {
    reviewAndExecute: () => Effect.succeed(restored),
    agentRecovery: { bindHarness: (bound) => Effect.sync(() => { capture = bound; }), save: () => Effect.void },
  });
  const outcome = await f.run();
  expect(outcome.executions).toMatchObject([{ effect: "possible", failure }]);
  expect(outcome.executions[0]?.observations).not.toBe("private message");
  const snapshot = capture?.();
  if (snapshot === undefined) throw new Error("The harness did not expose a checkpoint");
  const checkpoint = Schema.decodeUnknownSync(Schema.parseJson(MintHarnessSnapshot))(
    Schema.encodeSync(Schema.parseJson(MintHarnessSnapshot))(snapshot),
  );
  expect(checkpoint.executions).toMatchObject([{ effect: "possible", failure }]);
});

it.each([
  { purpose: "example", source: "script", code: "OperationFailure_DYNAMIC" },
  { purpose: "example", source: "script", code: "sk_live_SYNTHETIC_CODE_CANARY" },
  { purpose: "example", source: "script", code: "NoResponse" },
  { purpose: "example", source: "script", code: "FileRefused" },
  { purpose: "example", source: "script", code: 17 },
  { purpose: "example", source: "script" },
  { purpose: "example", code: "OperationFailure" },
  { purpose: "example", source: "host", code: "private-provider-code" },
  { purpose: "private-purpose", source: "script", code: "OperationFailure" },
  { purpose: "command", source: "command", exitCode: -1 },
  { purpose: "command", source: "command", exitCode: 256 },
  { purpose: "command", source: "command", exitCode: 2.5 },
  { purpose: "command", source: "command", exitCode: "7" },
  { purpose: "command", source: "command", exitCode: null },
  { purpose: "command", source: "command", exitCode: Number.POSITIVE_INFINITY },
  { purpose: "example", source: "command", exitCode: 7 },
])("rejects nonfinite metadata in the receipt codec %j", (failure) => {
  expect(Schema.decodeUnknownEither(ExecutionEvidence)({ ...receipt, failure })._tag).toBe("Left");
});

it("strips arbitrary tag and message fields and keeps older receipts without metadata readable", () => {
  const failure = { purpose: "example", source: "script", code: "OperationFailure", tag: "sk_live_SYNTHETIC_TAG_CANARY", message: "private message" };
  expect(Schema.decodeUnknownSync(ExecutionEvidence)({ ...receipt, failure })).toHaveProperty("failure", {
    purpose: "example", source: "script", code: "OperationFailure",
  });
  expect(Schema.decodeUnknownSync(ExecutionEvidence)(receipt)).not.toHaveProperty("failure");
});

it.each([
  { name: "typed host refusal", run: () => Effect.fail(new MintFailure({ code: "ScopeDenied", failureDetail: failureDetail("mint_host_dependency_failed", { operation: "synthetic", error: new Error("private defect canary") }) })), code: "ScopeDenied" },
  { name: "typed host outage", run: () => Effect.fail(new MintFailure({ code: "Unavailable" })), code: "Unavailable" },
  { name: "defect", run: () => Effect.die(new Error("private defect canary")), code: "unknown" },
  { name: "interruption", run: () => Effect.interrupt, code: "unknown" },
])("records only finite metadata for an actual core lost-result $name", async ({ run, code }) => {
  const f = await fixture((turn) => Effect.asVoid(Effect.exit(turn.actions.execute(execution))), { reviewAndExecute: run });
  const outcome = await f.run();
  expect(outcome.executions).toMatchObject([{ status: "failed", effect: "possible", failure: { purpose: "example", source: "host", code } }]);
  expect(outcome.executions).toHaveLength(1);
  expect(outcome.executions[0]?.executionId).toMatch(/^unresolved_[0-9a-f-]{36}$/u);
  expect(JSON.stringify(outcome.executions)).not.toContain("private defect canary");
});

it.each(["test", "inspect", "explore", "command"])("preserves the existing absence of a receipt when %s throws", async (purpose) => {
  const f = await fixture((turn) => Effect.asVoid(Effect.exit(turn.actions.execute(
    purpose === "command" ? { purpose, command: "exit 7" } : { ...execution, purpose },
  ))), { reviewAndExecute: () => Effect.fail(new MintFailure({ code: "Unavailable" })) });
  expect((await f.run()).executions).toEqual([]);
});

it("keeps diagnostic failure metadata out of the outcome reviewer's read_record tool", async () => {
  const id = randomUUID();
  const failure = { purpose: "act", source: "script", code: "OperationFailure" } satisfies NonNullable<ExecutionEvidence["failure"]>;
  const records: string[] = [];
  const f = await fixture((turn) => Effect.asVoid(turn.actions.execute({
    ...execution, purpose: "act", target: "liveBrowser",
  })), {
    reviewAndExecute: () => Effect.succeed({ ...receipt, executionId: id, failure }),
    outcomeReview: {
      model: { turn: (turn) => Effect.gen(function* () {
        records.push(yield* turn.tools.readRecord({ ref: `execution:${id}`, offset: 0, limit: 65_536 }));
        yield* turn.tools.submitAssessment({
          executionId: id, outcome: "unknown", explanation: "The synthetic result is unresolved.",
          evidence: [`execution:${id}`],
        });
      }) },
      save: () => Effect.void,
      recordAssessment: () => Effect.void,
    },
  });
  const outcome = await f.run();
  expect(records.length).toBeGreaterThan(0);
  for (const record of records) {
    const chunk = Schema.decodeUnknownSync(Schema.parseJson(Schema.Struct({ status: Schema.Literal("ok"), text: Schema.String })))(record);
    const evidence = Schema.decodeUnknownSync(Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })))(chunk.text);
    expect(evidence).toMatchObject({ executionId: id, status: "failed", effect: "possible", purpose: "act" });
    expect(evidence).not.toHaveProperty("failure");
  }
  expect(outcome.executions).toMatchObject([{ executionId: id, failure }]);
});
