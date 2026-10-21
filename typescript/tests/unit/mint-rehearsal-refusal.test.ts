import { Effect } from "effect";
import { afterEach, expect, it } from "vitest";
import {
  MintFailure,
  type MintDependencies,
  type PublicationDecision,
} from "../../src/mint/contracts.js";
import { rehearsalFailedInstruction } from "../../src/mint/rehearsal.js";
import { makeMintHarnessFixture, portableJobSession } from "../support/mint-fixtures.js";

// A host may run a write repair's bundle once before it publishes, set to stop just before its
// first save request reaches the site, and refuse the publication when that run failed short of
// it. The minter reads the failure, screened, with the fixed instruction, fixes the source and
// asks again.
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
const request = {
  mode: "mint",
  intent: "Save a quote request",
  businessInput: { applicant: "A-1" },
  observations: [],
};
const fixture = makeMintHarnessFixture(cleanup, request, portableJobSession);
const example = {
  purpose: "example",
  target: "pureFiles",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
};
const publication = {
  entrypoint: "src/tool.ts",
  executionId: "execution_one",
  metadata: { name: "quote", description: "Save a quote request" },
  coverage: "One example ran.",
};
const rehearsalFailure = (message: string) =>
  new MintFailure({
    code: "PublicationUnavailable",
    reason: "rehearsal_failed",
    rehearsal: { errorClass: "OperationFailure", message, frame: "src/tool.mjs:88" },
  });

it("hands the minter a failed rehearsal, screened, and publishes once the fixed source passes it", async () => {
  const recorded: PublicationDecision[] = [];
  const publicationDecisions: MintDependencies["publicationDecisions"] = {
    record: (decision) =>
      Effect.sync(() => {
        recorded.push(decision);
      }),
    list: Effect.sync(() => recorded),
  };
  const answers: Record<string, unknown>[] = [];
  let publishes = 0;
  const f = await fixture(
    (turn) =>
      Effect.gen(function* () {
        yield* turn.actions.execute(example);
        for (let call = 0; call < 2; call++)
          answers.push(JSON.parse(yield* turn.actions.finish(publication)));
      }),
    {
      publicationDecisions,
      publish: () =>
        publishes++ === 0
          ? Effect.fail(rehearsalFailure("No option named secret-canary in Coverage"))
          : Effect.succeed({ publicationRef: "published-revision", diagnostics: [] }),
    },
  );
  const outcome = await f.run();
  expect(answers[0]).toMatchObject({
    status: "not_published",
    code: "PublicationUnavailable",
    reason: "rehearsal_failed",
    rehearsal: { errorClass: "OperationFailure", frame: "src/tool.mjs:88" },
    userInputRequired: false,
  });
  // A private value in the failure's message never reaches the minter.
  expect(JSON.stringify(answers[0])).not.toContain("secret-canary");
  expect(String(answers[0]?.["instruction"]).endsWith(rehearsalFailedInstruction)).toBe(true);
  // Not the end of the build: the same receipt publishes on the next call.
  expect(answers[1]).toMatchObject({ status: "published" });
  expect(recorded).toEqual([
    expect.objectContaining({
      outcome: "refused",
      reason: "rehearsal_failed",
      executionId: "execution_one",
      failedChecks: ["rehearsal_failed"],
      recovery: "correct_source",
    }),
    expect.objectContaining({ outcome: "published", executionId: "execution_one" }),
  ]);
  expect(outcome).toMatchObject({ build: "published", publicationRef: "published-revision" });
});
