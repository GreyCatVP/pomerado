import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import { answersForReview } from "../../src/guardian/question.js";
import {
  guardianPublicationPolicy,
  nativePublicationHost,
  publicationDecisionPolicy,
  publicationLiveTestsPolicy,
  publicationOutputPolicy,
  publicationPolicyFor,
  publicationReferencePolicy,
  publicationSafetyDefaultPolicy,
} from "../../src/guardian/publication.js";
import {
  makeGuardian,
  ReviewFailure,
  type GuardianDiagnostics,
  type PendingExecution,
  type Reviewer,
} from "../../src/guardian/review.js";
import { makeSourceInspector } from "../../src/guardian/source.js";

afterEach(() => setDefaultModelProvider(new OpenAIProvider()));

const native = { executionEnvironment: nativeExecutionEnvironment };

const files = new Map([
  ["operation/src/tool.mjs", 'export const city = "Paris"; // synthetic é'],
  [
    "publication/definition.json",
    JSON.stringify({
      description: "Read reports",
      inputSchema: { examples: ["Synthetic example"] },
    }),
  ],
  ["publication/example-output.json", JSON.stringify({ output: { reports: [] } })],
]);
const pending: PendingExecution = {
  invocationId: "invocation_a",
  attemptId: "attempt_a",
  entrypoint: "operation/src/tool.mjs",
  screenedIntent: "Read public reports",
  screenedInput: "{}",
  screenedObservations: "Prior example completed; publication does not repeat it.",
  accountScope: "account_a",
  allowedOrigins: [],
  allowedEffects: ["Publish current package only"],
  publication: {
    files: [...files].map(([path, source]) => ({
      path,
      byteLength: Buffer.byteLength(source),
      published: true,
      current: true,
      owner: path.startsWith("publication/") ? ("host" as const) : ("minter" as const),
    })),
  },
};
const explanation =
  "The city output is a constant; read it from the page. Evidence: src/tool.mjs sets it.";
const entrypointLength = Buffer.byteLength(files.get("operation/src/tool.mjs") ?? "");
const sourcesOf = (sources: ReadonlyMap<string, string>) =>
  makeSourceInspector(
    (path) =>
      Effect.suspend(() => {
        const text = sources.get(path);
        return text === undefined
          ? Effect.fail(new ReviewFailure({ code: "SourceUnavailable" }))
          : Effect.succeed(new TextEncoder().encode(text));
      }),
    (_path, bytes) => Effect.succeed(new TextDecoder().decode(bytes)),
  );
const allow = {
  outcome: "allow",
  reason: "approved",
  rationale: "The reviewed evidence supports this publication decision",
  findings: [],
};
const inspectAll: Reviewer["run"] = (turn) =>
  Effect.gen(function* () {
    for (const file of turn.pending.publication?.files ?? []) {
      let offset = 0;
      while (true) {
        const raw: unknown = JSON.parse(yield* turn.readSource(file.path, offset));
        if (
          raw === null ||
          typeof raw !== "object" ||
          !("nextOffset" in raw) ||
          typeof raw.nextOffset !== "number" ||
          !("hasMore" in raw)
        )
          throw new Error("Invalid chunk");
        if (!raw.hasMore) break;
        offset = raw.nextOffset;
      }
    }
    return allow;
  });

describe("a publication decision", () => {
  // A host that decodes publication decisions itself keeps its own decoder.
  it("is decoded by a host's own decoder when the host gives one", async () => {
    const scopes: unknown[] = [];
    const reviewer: Reviewer = {
      run: (turn) =>
        inspectAll(turn).pipe(
          Effect.as({ outcome: "deny", reason: "host_specific", rationale: "Host raw." }),
        ),
    };
    const result = await Effect.runPromise(
      makeGuardian(
        reviewer,
        undefined,
        {},
        {
          decodePublication: (scope, raw) =>
            Effect.sync(() => {
              scopes.push(scope);
              return {
                outcome: "allow" as const,
                rationale: `Host decoded: ${(raw as { rationale: string }).rationale}`,
              };
            }),
        },
      ).review(pending, sourcesOf(files)),
    );
    expect(result.decision).toEqual({ outcome: "allow", rationale: "Host decoded: Host raw." });
    expect(scopes).toEqual([pending.publication]);
  });

  it("returns corrective locations for publication/definition.json and records them in the completion diagnostic", async () => {
    const path = "publication/definition.json";
    const findings = [{ path, byteStart: 0, byteEnd: 12, category: "private_literal", explanation }];
    const persisted: { name: string; details: unknown }[] = [];
    const diagnostics: GuardianDiagnostics = {
      emit: (name, details) =>
        Effect.sync(() => {
          persisted.push({ name, details });
        }),
      retainScreenedSource: () => Effect.void,
      retainModelTranscript: () => Effect.void,
    };
    const reviewer: Reviewer = {
      run: (turn) =>
        inspectAll(turn).pipe(
          Effect.as({
            outcome: "deny",
            reason: "privacy",
            findings,
            rationale: "Remove the literal",
          }),
        ),
    };
    const result = await Effect.runPromise(
      makeGuardian(reviewer, diagnostics).review(pending, sourcesOf(files)),
    );
    expect(result.decision).toEqual({
      outcome: "deny",
      reason: "privacy",
      rationale: "Remove the literal",
      findings,
    });
    expect(
      JSON.stringify(persisted.find((event) => event.name === "guardian.completed")),
    ).toContain(JSON.stringify(findings));
  });

  it.each([
    { path: "unknown", byteStart: 0, byteEnd: 1, category: "private_literal", explanation },
    { path: pending.entrypoint, byteStart: 0, byteEnd: 1, category: "PRIVATE_CANARY", explanation },
    { path: pending.entrypoint, byteStart: 0, byteEnd: 1, category: "private_literal" },
    {
      path: pending.entrypoint,
      byteStart: 0,
      byteEnd: 1,
      category: "private_literal",
      explanation: "",
    },
  ])("rejects invalid finding metadata: %j", async (finding) => {
    const reviewer: Reviewer = {
      run: () =>
        Effect.succeed({
          outcome: "deny",
          reason: "privacy",
          rationale: "The reviewed evidence supports this publication decision",
          findings: [finding],
        }),
    };
    expect(
      await Effect.runPromise(
        Effect.either(makeGuardian(reviewer).review(pending, sourcesOf(files))),
      ),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  // A denial is a verdict: a finding whose range runs past its file or is empty still reaches the
  // minter, with its explanation, at the part of the file the range can name.
  it.each([
    { byteStart: 3, byteEnd: 9000, kept: { byteStart: 3, byteEnd: entrypointLength } },
    { byteStart: 5, byteEnd: 1, kept: { byteStart: 0, byteEnd: entrypointLength } },
  ])("keeps a denial whose only fault is a finding's byte range: %j", async (range) => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({
            outcome: "deny",
            reason: "source_correction",
            rationale: "One output is a constant.",
            findings: [
              {
                path: pending.entrypoint,
                byteStart: range.byteStart,
                byteEnd: range.byteEnd,
                category: "schema_mismatch",
                explanation,
              },
            ],
          }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision).toEqual({
      outcome: "deny",
      reason: "source_correction",
      rationale: "One output is a constant.",
      findings: [
        { path: pending.entrypoint, ...range.kept, category: "schema_mismatch", explanation },
      ],
    });
  });

  // A denial that names every problem keeps its findings and its rationale's first 4,000
  // characters, rather than failing as InvalidDecision and losing them.
  it("keeps a denial whose rationale is too long, cut to 4,000 characters", async () => {
    const rationale = "The source hard-codes a private value. ".repeat(120);
    const finding = {
      path: pending.entrypoint,
      byteStart: 0,
      byteEnd: 1,
      category: "private_literal",
      explanation,
    };
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({ outcome: "deny", reason: "privacy", rationale, findings: [finding] }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision).toMatchObject({ outcome: "deny", reason: "privacy", findings: [finding] });
    expect(decision.rationale).toBe(`${rationale.slice(0, 3999)}…`);
  });

  // An explanation longer than a finding may hold keeps its start rather than failing the denial,
  // and never ends on half of a character.
  it.each([
    { text: "x".repeat(900), kept: `${"x".repeat(799)}…` },
    { text: `${"x".repeat(798)}😀${"x".repeat(50)}`, kept: `${"x".repeat(798)}…` },
  ])("cuts an overlong explanation to 800 characters: $kept.length", async ({ text, kept }) => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({
            outcome: "deny",
            reason: "source_correction",
            rationale: "One output is a constant.",
            findings: [
              {
                path: pending.entrypoint,
                byteStart: 0,
                byteEnd: 1,
                category: "schema_mismatch",
                explanation: text,
              },
            ],
          }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision.findings?.[0]?.explanation).toBe(kept);
  });

  // A denial's short public reason is the caller's, apart from the private rationale; an allow
  // has none to give.
  it.each([
    { outcome: "deny", reason: "privacy", kept: "The tool could not be published safely." },
    { outcome: "allow", reason: "approved", kept: undefined },
  ])("keeps a public reason only on a denial: $outcome", async ({ outcome, reason, kept }) => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({
            outcome,
            reason,
            rationale: "The source hard-codes a private value.",
            findings:
              outcome === "deny"
                ? [
                    {
                      path: pending.entrypoint,
                      byteStart: 0,
                      byteEnd: 1,
                      category: "private_literal",
                      explanation,
                    },
                  ]
                : [],
            publicReason: " The tool could not be published safely. ",
          }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision.publicReason).toBe(kept);
  });

  // Guardian's shared output format sends null for a field a kind does not use.
  it("reads a null findings list as none and an allow without a reason as approved", async () => {
    const { decision } = await Effect.runPromise(
      makeGuardian({
        run: () =>
          Effect.succeed({ outcome: "allow", reason: null, rationale: "Fine.", findings: null }),
      }).review(pending, sourcesOf(files)),
    );
    expect(decision).toEqual({
      outcome: "allow",
      reason: "approved",
      rationale: "Fine.",
      findings: [],
    });
  });

  const definitionFinding = (category: string) => ({
    path: "publication/definition.json",
    byteStart: 0,
    byteEnd: 1,
    category,
    explanation,
  });
  const decide = (decision: Record<string, unknown>) =>
    Effect.runPromise(
      Effect.either(
        makeGuardian({
          run: (turn) =>
            inspectAll(turn).pipe(
              Effect.as({ rationale: "The source needs the indicated correction", ...decision }),
            ),
        }).review(pending, sourcesOf(files)),
      ),
    );

  it("requires an in-index unsupported_claim finding for an unsupported-claim denial", async () => {
    expect(
      await decide({
        outcome: "deny",
        reason: "unsupported_claim",
        findings: [definitionFinding("schema_mismatch")],
      }),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  it("cannot approve with an unsupported-claim reason", async () => {
    expect(
      await decide({ outcome: "allow", reason: "unsupported_claim", findings: [] }),
    ).toMatchObject({ _tag: "Left", left: { code: "InvalidDecision" } });
  });

  it("returns input feedback made only of input findings with its reason", async () => {
    const findings = ["account_specific_enum", "input_option", "example_input"].map(
      definitionFinding,
    );
    expect(
      await decide({
        outcome: "escalate",
        reason: "input_feedback",
        rationale: "Expose the account-specific choice as caller input",
        findings,
      }),
    ).toMatchObject({
      _tag: "Right",
      right: {
        decision: {
          outcome: "escalate",
          reason: "input_feedback",
          rationale: "Expose the account-specific choice as caller input",
          findings,
        },
      },
    });
  });

  it.each([
    { outcome: "escalate", reason: "input_feedback", findings: [] },
    {
      outcome: "escalate",
      reason: "input_feedback",
      findings: [definitionFinding("account_specific_enum"), definitionFinding("private_literal")],
    },
    {
      outcome: "escalate",
      reason: "input_feedback",
      findings: [definitionFinding("input_option"), definitionFinding("private_literal")],
    },
    // An input narrowed to the example's value blocks publication; it is never input feedback.
    { outcome: "deny", reason: "input_feedback", findings: [definitionFinding("example_value")] },
    { outcome: "allow", reason: "input_feedback", findings: [definitionFinding("input_option")] },
  ])("rejects input feedback that is empty, blocking or approving: %j", async (decision) => {
    expect(await decide(decision)).toMatchObject({
      _tag: "Left",
      left: { code: "InvalidDecision" },
    });
  });

  it("keeps an input finding beside a blocking reason, which still decides", async () => {
    const findings = [
      definitionFinding("private_literal"),
      definitionFinding("account_specific_enum"),
    ];
    expect(await decide({ outcome: "deny", reason: "privacy", findings })).toMatchObject({
      _tag: "Right",
      right: { decision: { outcome: "deny", reason: "privacy", findings } },
    });
  });

  // A host_owned denial tells the minter it cannot fix the findings, so none may be in its files
  // or in the public definition, which follows from its source and build metadata.
  it.each([
    { path: "publication/example-output.json", decided: "Right" },
    { path: "publication/definition.json", decided: "Left" },
    { path: "operation/src/tool.mjs", decided: "Left" },
  ])("decides a host_owned denial with a finding in $path: $decided", async ({ path, decided }) => {
    const findings = [{ path, byteStart: 0, byteEnd: 1, category: "private_literal", explanation }];
    expect(await decide({ outcome: "deny", reason: "host_owned", findings })).toMatchObject(
      decided === "Right"
        ? { _tag: "Right", right: { decision: { reason: "host_owned", findings } } }
        : { _tag: "Left", left: { code: "InvalidDecision" } },
    );
  });

  // The live test record is the host's copy of the minter's cases and their results on its
  // source: the minter fixes a finding there through its cases or source, so it goes back as a
  // correction, never as a host fault that ends the build.
  it("decides a finding in the live test record as the minter's, never host_owned", async () => {
    const record = JSON.stringify({ kind: "host_live_tests", cases: [], retired: [] });
    const withRecord = new Map([...files, ["publication/tests.json", record]]);
    const recordPending: PendingExecution = {
      ...pending,
      publication: {
        files: [
          ...(pending.publication?.files ?? []),
          {
            path: "publication/tests.json",
            byteLength: Buffer.byteLength(record),
            published: false,
            current: true,
            owner: "host",
          },
        ],
      },
    };
    const findings = [
      {
        path: "publication/tests.json",
        byteStart: 0,
        byteEnd: 1,
        category: "unsupported_claim",
        explanation,
      },
    ];
    const decideOnRecord = (reason: string) =>
      Effect.runPromise(
        Effect.either(
          makeGuardian({
            run: (turn) =>
              inspectAll(turn).pipe(
                Effect.as({ outcome: "deny", reason, rationale: "No case tests it", findings }),
              ),
          }).review(recordPending, sourcesOf(withRecord)),
        ),
      );
    expect(await decideOnRecord("host_owned")).toMatchObject({
      _tag: "Left",
      left: { code: "InvalidDecision" },
    });
    expect(await decideOnRecord("evidence")).toMatchObject({
      _tag: "Right",
      right: { decision: { reason: "evidence", findings } },
    });
  });

  it("accepts a confirmation finding as a source correction", async () => {
    const findings = [definitionFinding("confirmation")];
    expect(await decide({ outcome: "deny", reason: "source_correction", findings })).toMatchObject({
      _tag: "Right",
      right: { decision: { reason: "source_correction", findings } },
    });
  });
});

describe("the publication policy", () => {
  it("is the core text, naming the files the host writes", () => {
    const policy = guardianPublicationPolicy;
    expect(policy.split("\n")).toHaveLength(18);
    expect(
      policy.startsWith("This is the existing publication review, not an execution request.\n"),
    ).toBe(true);
    expect(policy).toContain(
      "Every owner: host file is written by the host, which the minter cannot edit: any entry file the host adds to the bundle and every publication/ file (the definition, the example or session output, the session steps and the live test record). No file must be read in full:",
    );
    expect(policy).toContain(
      "never ask for a source correction or another run for it. When such a file shows a problem the minter's source causes, the finding keeps its ordinary reason and the rationale names the source to change.",
    );
    expect(policy).not.toContain("  ");
  });

  // A caller's place, venue or company name matches in its usual forms, so neither the review of
  // a live step nor the publication review asks a tool to require an exact match.
  it("gives the execution and publication reviews the same fuzzy proper-noun rule", () => {
    const rule =
      "A tool matches the caller's proper nouns, such as places, venues and company names, with a fuzzy match that accepts the usual forms of the same name. Never ask a tool to require an exact match. When more than one option matches, the tool lists them for the caller instead of picking one.";
    expect(guardianPublicationPolicy.split(rule)).toHaveLength(2);
    expect(guardianExecutionPolicy(nativeExecutionEnvironment)).toContain(`\n${rule}\n`);
  });

  // A repair is judged on what it changed: an unchanged line is denied only when a failing run or
  // example shows it broken. Hosts with their own publication policy get it with the live tests.
  it("judges a repair on the lines it changed, beside the maintenance rule for live tests", () => {
    const rule =
      "In a repair, prefer denying only for lines the repair changed, or for unchanged lines that a failing run or example shows broken. Note other doubts about unchanged lines without denying, except a privacy or credential finding.";
    expect(publicationLiveTestsPolicy).toContain(
      `A claim that run's output, source or captures contradict is still a finding. ${rule}`,
    );
    expect(guardianPublicationPolicy).toContain(`\n${publicationLiveTestsPolicy}\n`);
  });

  // One case that uses an input covers it, so the review asks for no case per option value.
  // Hosts with their own publication policy get it with the live tests.
  it("counts an input as tested by one case that uses it, not one per value", () => {
    expect(publicationLiveTestsPolicy).toContain(
      "a declared input when no case uses it, or changes it from its default,",
    );
    expect(publicationLiveTestsPolicy).toContain(
      "its other values, such as each option of a sort, need no case of their own and no notTested entry",
    );
  });

  // A list whose site rarely shows an empty state can still publish: its untested empty result is
  // no gap, while its next page still is.
  it("counts a list's next page as a gap, not its empty result", () => {
    expect(publicationLiveTestsPolicy).toContain(", a list's next page, another record,");
    expect(publicationLiveTestsPolicy).not.toContain("a list's empty result");
  });

  // A site's own "Remember me" choice left at its default keeps the owner's session for later
  // runs. It is not a safety default, so neither review denies the host's sign-in step over it.
  it("leaves a site's own Remember me choice at its default in both reviews", () => {
    const rule =
      "Prefer leaving a site's own \"Remember me\" or \"Keep me signed in\" choice at its default on the tool's own sign-in. It keeps the account owner's session, which later runs rely on, and it is not a safety default. Never deny the host's own sign-in step over that choice.";
    expect(publicationSafetyDefaultPolicy.endsWith(` ${rule}`)).toBe(true);
    expect(guardianExecutionPolicy(nativeExecutionEnvironment)).toContain(`\n${rule}\n`);
  });

  // An edit that drops a tool's unchecking of a preselected partner comparison box is not a fix,
  // and the box is never an input of the tool.
  it("keeps a safety default the source sets, and never asks for it as an input", () => {
    expect(guardianPublicationPolicy).toContain(`\n${publicationSafetyDefaultPolicy}\n`);
    expect(guardianPublicationPolicy).toContain(
      "must be an input of the tool (required when the site requires a choice, optional otherwise), except a safety default, which is never an input.",
    );
  });

  // The local host's precheck screens only the build's own caller-supplied values and secret
  // handles, so the policy never tells Guardian the files passed a credential check: Guardian
  // looks for hard-coded keys, tokens and passwords itself.
  it("names no data-vendor exception the local host cannot evidence", () => {
    expect(guardianPublicationPolicy).not.toContain("except the data-vendor read");
    expect(guardianPublicationPolicy).toContain(
      "sending it to any other off-site origin escalates, with no data-vendor exception on this host.",
    );
  });

  it("credits no credential precheck the local host does not run", () => {
    const policy = guardianPublicationPolicy;
    expect(policy).not.toContain("passed a deterministic credential precheck");
    expect(policy).toContain(
      "The local precheck covered only this build's own caller-supplied values and secret handles; it did not screen for provider credentials or other secrets, so inspect every published file for hard-coded API keys, tokens and passwords. Inspect the published files for hardcoded customer/private data,",
    );
  });

  // A composed write that confirms from its own commit request's response, checked, is
  // confirming; one that takes any request, any status or an unread error body is not.
  it("accepts a write confirmed from its own commit request, and refuses a loose check", () => {
    const policy = guardianPublicationPolicy;
    expect(policy).toContain(
      "perform and return the confirmation or read-back it declares, and never resubmit or commit twice. A script that confirms from its commit request is confirming, not missing a read-back: in the same call as the final commit click it waits for the site's response on the route the session's commit used, requires a 2xx or 3xx status and no error in a body it can read, checks the page for an error or validation message (a 201 whose Location names the new record needs no page check), and only then calls verified(). A 200 whose body reports an error, as GraphQL can, did not go through. A 202, or a 2xx whose body says the work is queued, counts, with the site's own status word for it in the output. It is a confirmation finding when the script accepts any request or any status, takes a 200 from an endpoint that can report errors in its body without checking that body, or skips the page's error check.",
    );
    expect(policy).toContain(
      "'unverifiable' is valid only if the session evidence shows the site offered no commit response the script can check, no confirmation and no read-back.",
    );
  });

  // A write may refuse before its first commit mark with a refusal its output schema declares. Every
  // host judges it. The writes skill, not this policy, says where a check that can refuse runs.
  it("judges a declared write refusal before its first commit mark", () => {
    for (const policy of [
      guardianPublicationPolicy,
      publicationPolicyFor({ hostFiles: "Synthetic.", precheck: "Synthetic.", dataVendor: "synthetic" }),
    ]) {
      expect(policy).toContain(
        "skips the page's error check. Apart from a declared refusal returned before its first commit mark (below), it is a confirmation finding when a path of the script can return before its last commit step or, unless it declares `unverifiable`, without `verified()`.",
      );
      expect(policy).toContain(
        "'unverifiable' is valid only if the session evidence shows the site offered no commit response the script can check, no confirmation and no read-back. A write may declare refusals in its output schema: a branch that requires status \"refused\" and a reason from a listed set of stable lowercase codes, with the values the caller needs, such as the total and the limit it exceeded. Returned before the script enters its first commit mark, a declared refusal reports the write not applied. The script must return one only for the condition its reason names, from values it read on the page and compared with its input, and before enteringCommit; a declared refusal returned after a commit mark, for a condition the script never checks, or without the values its reason compares, is a confirmation finding, and so is a refusal returned in an output shape the schema does not declare as one. The composed script must report each confirm popup to decideDialog under the same literal step name as the session step, so runs accept the same popups without asking.",
      );
      expect(policy).toContain(
        "An unavailable session output limits the claims it can support; it never calls for another run of the write.\n",
      );
      expect(policy).not.toContain("every check that can refuse");
      expect(policy).not.toContain("the commit it guards");
    }
  });

  // The input_option finding is the shared one sentence, with no further list of its own.
  it("names what a write settles on its own as input_option", () => {
    expect(guardianPublicationPolicy).toContain(
      "except a safety default, which is never an input. An input_option finding, at that source or schema text, is only an add-on, a pre-selected paid option or a saved payment the composed script sets, keeps or clears on its own; an optional input left unset keeps the page's default and is no finding. On every tool,",
    );
  });

  // Every host gets one publication policy. A host fills only the places that describe its own
  // evidence, and each lands where it belongs.
  it("puts each host's own text in its place in the one policy", () => {
    const host = {
      hostFiles: "Synthetic host files.",
      references: "Synthetic references.",
      precheck: "Synthetic precheck.",
      hostFileExample: "such as a synthetic host file",
      recordedRequests: "Synthetic recorded requests.",
      dataVendor: "with a synthetic data-vendor rule",
      recordedTraffic: "Synthetic recorded traffic.",
      httpSource: "Synthetic HTTP source.",
    };
    const policy = publicationPolicyFor(host);
    expect(policy.split("\n")).toHaveLength(18);
    expect(policy).not.toContain("  ");
    for (const placed of [
      "together with the build metadata from which the host writes publication/definition.json. Synthetic host files. No file must be read in full:",
      `${publicationReferencePolicy} Synthetic references.\nStart with the exact current paths,`,
      "\nSynthetic precheck. Inspect the published files for hardcoded customer/private data,",
      "When such a file shows a problem the minter's source causes, such as a synthetic host file, the finding keeps its ordinary reason",
      "\nSynthetic recorded requests. The site's own page traffic is the website's behavior:",
      "sending it to any other off-site origin escalates, with a synthetic data-vendor rule. Any other value is fine off the site",
      "say so in the rationale. Synthetic recorded traffic. Put every finding on the source to change,",
      `${publicationOutputPolicy} Synthetic HTTP source.\n`,
    ])
      expect(policy).toContain(placed);
    const required = publicationPolicyFor({
      hostFiles: host.hostFiles,
      precheck: host.precheck,
      dataVendor: host.dataVendor,
    });
    expect(required.split("\n")).toHaveLength(18);
    expect(required).not.toContain("  ");
    expect(required).toContain(`${publicationReferencePolicy}\nStart with the exact current paths,`);
    expect(required).toContain(
      "When such a file shows a problem the minter's source causes, the finding keeps its ordinary reason",
    );
    expect(required).toContain("\nThe site's own page traffic is the website's behavior:");
    expect(required).toContain("say so in the rationale. Put every finding on the source to change,");
    expect(required).toContain(`${publicationOutputPolicy}\n`);
  });

  // The local host's policy is the one policy with its own text, so it never names evidence only
  // another host keeps: recorded requests, an HTTP version or an index of references.
  it("gives the local host the one policy with only its own evidence", () => {
    expect(guardianPublicationPolicy).toBe(publicationPolicyFor(nativePublicationHost));
    for (const hosted of [
      "recorded-requests.json",
      "recorded requests",
      "operation-http.mjs",
      "auth-http.json",
      "HTTP source",
      "secretEgress",
      "trusted_publication.references",
    ])
      expect(guardianPublicationPolicy).not.toContain(hosted);
    expect(guardianPublicationPolicy).toContain(
      "The files the host adds to the operation bundle, such as operation/operation.mjs, are within the publication's authority.",
    );
    expect(guardianPublicationPolicy).toContain(
      "An option whose results the output can't carry, such as a cabin choice with only an economy fare field, is an Unapplied input finding.",
    );
  });
});

const message = (value: unknown): ModelResponse["output"][number] => ({
  type: "message",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: JSON.stringify(value) }],
});
const read = (path: string, offset = 0, callId = `read_${path}_${offset}`) => ({
  type: "function_call" as const,
  callId,
  name: "read_source",
  status: "completed" as const,
  arguments: JSON.stringify({ path, offset }),
});
const scripted = (respond: (index: number) => ModelResponse["output"]) => {
  const requests: ModelRequest[] = [];
  setDefaultModelProvider({
    getModel: () => ({
      getResponse: async (request) => {
        requests.push(request);
        return { usage: new Usage(), output: respond(requests.length - 1) };
      },
      getStreamedResponse: () => {
        throw new Error("Unused stream");
      },
    }),
  });
  return requests;
};
/** The review request the host sent: the first user message that is one. */
const reviewRequest = (request: ModelRequest | undefined): Record<string, unknown> => {
  const input = request?.input;
  const items = typeof input === "string" ? [{ role: "user", content: input }] : (input ?? []);
  for (const item of items) {
    const content = "role" in item && item.role === "user" ? item.content : undefined;
    if (typeof content === "string" && content.startsWith("{"))
      return JSON.parse(content) as Record<string, unknown>;
  }
  throw new Error("No review request");
};
const policyOf = (request: ModelRequest | undefined) =>
  (reviewRequest(request)["trusted_review"] as { readonly policy: string }).policy;

describe("the OpenAI publication reviewer", () => {
  it.each([
    ["the local host, with no specialize", undefined, ["trusted_publication"]],
    [
      "a host that adds input but no policy",
      () => ({ input: { trusted_host_record: { synthetic: true } } }),
      ["trusted_host_record", "trusted_publication"],
    ],
  ])(
    "gives %s the outcome policy and the core publication policy, and the index before the environment",
    async (_host, specialize, fields) => {
      const requests = scripted(() => [message(allow)]);
      await Effect.runPromise(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
            ...native,
            ...(specialize === undefined ? {} : { specialize }),
          }),
        ).review(pending, sourcesOf(files)),
      );
      const policy = policyOf(requests[0]);
      expect(policy.startsWith("Return the structured outcome allow, deny or escalate")).toBe(true);
      expect(policy.endsWith(`\n\n${guardianPublicationPolicy}`)).toBe(true);
      const request = reviewRequest(requests[0]);
      const keys = Object.keys(request);
      const at = keys.indexOf("trusted_authority");
      expect(keys.slice(at, at + fields.length + 2)).toEqual([
        "trusted_authority",
        ...fields,
        "trusted_execution_environment",
      ]);
      expect(request["trusted_publication"]).toEqual(pending.publication);
    },
  );

  // A host that sends its own publication policy keeps exactly what it sends: no core policy,
  // file index or turn limit is added to its review.
  it("keeps a host's own publication policy, input and turn limit as it sends them", async () => {
    const requests = scripted((index) => [read(pending.entrypoint, 0, `read_${index}`)]);
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
            ...native,
            specialize: (turn) =>
              turn.pending.publication === undefined
                ? {}
                : {
                    policy: "Synthetic host publication policy.",
                    input: { trusted_host_record: { synthetic: true } },
                  },
          }),
        ).review(pending, sourcesOf(files)),
      ),
    );
    const policy = policyOf(requests[0]);
    expect(policy.startsWith("Return the structured outcome allow, deny or escalate")).toBe(true);
    expect(policy.split("\n\n").at(-1)).toBe("Synthetic host publication policy.");
    expect(policy).not.toContain("This is the existing publication review");
    const request = reviewRequest(requests[0]);
    const keys = Object.keys(request);
    const at = keys.indexOf("trusted_authority");
    expect(keys.slice(at, at + 3)).toEqual([
      "trusted_authority",
      "trusted_host_record",
      "trusted_execution_environment",
    ]);
    expect(request).not.toHaveProperty("trusted_publication");
    expect(result).toMatchObject({ _tag: "Left", left: { code: "TurnLimitExceeded" } });
    // Its 12 turns, then the one final turn that must decide.
    expect(requests).toHaveLength(13);
  });

  // Guardian lets a "By design:" input, a limited use such as a postal code that only lists
  // nearby stores, count as applied on two facts the host alone controls: the caller's answer to
  // the input's design question, bound to it by the question's id, and on a repair the host's
  // record of the published revision's inputs. The review gets the answer under its id and the
  // record exactly when the host supplies one, beside the shared rule that reads them.
  it.each([
    [
      "a repair whose host supplies the published revision's inputs",
      [
        {
          name: "postalCode",
          description: "By design: used only to find nearby stores; it does not change the selected store.",
        },
        { name: "query" },
      ],
    ],
    ["a build whose host supplies none", undefined],
  ])(
    "gives %s the caller's design answer by its id, and the published inputs only as supplied",
    async (_case, publishedInputs) => {
      const prompt = "Should the postal code set the store, or only list nearby stores?";
      const answeredQuestions = await Effect.runPromise(
        answersForReview(
          {
            questions: [
              {
                id: "input_use_postal_code",
                type: "choice",
                prompt,
                options: [
                  { id: "set_store", label: "Set the store from it" },
                  { id: "nearby_only", label: "Only list nearby stores" },
                ],
              },
            ],
          },
          { input_use_postal_code: { type: "choice", value: "nearby_only" } },
          Effect.succeed,
        ),
      );
      const publication = {
        files: pending.publication?.files ?? [],
        ...(publishedInputs === undefined ? {} : { publishedInputs }),
      };
      const requests = scripted(() => [message(allow)]);
      await Effect.runPromise(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
        ).review({ ...pending, answeredQuestions, publication }, sourcesOf(files)),
      );
      const request = reviewRequest(requests[0]);
      expect(request["trusted_authority"]).toMatchObject({
        answeredQuestions: [
          { id: "input_use_postal_code", question: prompt, answer: "Only list nearby stores" },
        ],
      });
      expect(request["trusted_publication"]).toEqual(publication);
      if (publishedInputs === undefined)
        expect(request["trusted_publication"]).not.toHaveProperty("publishedInputs");
      expect(policyOf(requests[0])).toContain(publicationOutputPolicy);
    },
  );

  it("gives an execution review no publication policy or index", async () => {
    const requests = scripted((index) =>
      index === 0
        ? [read(pending.entrypoint)]
        : [message({ outcome: "allow", rationale: "Fine.", action: "read" })],
    );
    const { publication: _publication, ...execution } = pending;
    await Effect.runPromise(
      makeGuardian(
        makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
      ).review(execution, sourcesOf(files)),
    );
    expect(policyOf(requests[0])).not.toContain("publication review");
    expect(reviewRequest(requests[0])).not.toHaveProperty("trusted_publication");
  });

  it.each([false, true])(
    "finishes a multi-file publication review or reports its 32-turn limit, repeatUnavailable=%s",
    async (repeatUnavailable) => {
      const source = 'export const value = "PRIVATE_SOURCE_CANARY";';
      const manifest = Array.from({ length: 13 }, (_, index) => ({
        path: `operation/src/file-${index}.mjs`,
        byteLength: Buffer.byteLength(source),
        published: true,
        current: true,
        owner: "minter" as const,
      }));
      const request: PendingExecution = {
        ...pending,
        entrypoint: manifest[0]?.path ?? "missing",
        publication: { files: manifest },
      };
      const requests = scripted((index) => {
        const file = manifest[index];
        return repeatUnavailable || file !== undefined
          ? [
              read(
                repeatUnavailable ? "operation/src/unavailable.mjs" : (file?.path ?? ""),
                0,
                `read_${index}`,
              ),
            ]
          : [message(allow)];
      });
      const events: { name: string; details: unknown }[] = [];
      const diagnostics: GuardianDiagnostics = {
        emit: (name, details) =>
          Effect.sync(() => {
            events.push({ name, details });
          }),
        retainScreenedSource: () => Effect.void,
        retainModelTranscript: () => Effect.void,
      };
      const result = await Effect.runPromise(
        Effect.either(
          makeGuardian(
            makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
            diagnostics,
          ).review(request, sourcesOf(new Map(manifest.map((file) => [file.path, source])))),
        ),
      );
      expect(result).toMatchObject(
        repeatUnavailable
          ? { _tag: "Left", left: { code: "TurnLimitExceeded" } }
          : { _tag: "Right", right: { decision: { outcome: "allow" } } },
      );
      // A review that never decides gets its 32 turns and the one final turn.
      expect(requests).toHaveLength(repeatUnavailable ? 33 : 14);
      expect(events.find((event) => event.name === "guardian.started")).toMatchObject({
        details: { details: { manifestFiles: 13 } },
      });
    },
  );

  // A host can require a site name and summary on a site's first publication, even for a tool
  // that never opens the site, such as a parser that only transforms its input. That naming files
  // the tool under the site and is no claim that the tool uses it; a description that promises
  // site behavior the source lacks is still an unsupported claim.
  it("tells the review that host-required site naming is no claim the tool uses the site", async () => {
    const offline = new Map([
      [
        "operation/src/tool.mjs",
        "export const parse = (text) => ({ lines: text.split(/\\n/u) });",
      ],
      [
        "publication/definition.json",
        JSON.stringify({
          name: "parse_receipt_text",
          description: "Split pasted receipt text into lines",
          site: {
            name: "Example Store",
            summary: "An online store that sells synthetic household goods.",
          },
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        }),
      ],
    ]);
    const requests = scripted(() => [message(allow)]);
    await Effect.runPromise(
      makeGuardian(
        makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
      ).review(
        {
          ...pending,
          publication: {
            files: [...offline].map(([path, source]) => ({
              path,
              byteLength: Buffer.byteLength(source),
              published: true,
              current: true,
              owner: path.startsWith("publication/") ? ("host" as const) : ("minter" as const),
            })),
          },
        },
        sourcesOf(offline),
      ),
    );
    const naming =
      "is no unsupported_claim for its site naming alone. The tool's own name, description or a declared variant that promises site behavior the source lacks still is.";
    // A host with its own publication policy composes the same decision policy.
    expect(publicationDecisionPolicy).toContain(naming);
    const policy = policyOf(requests[0]);
    expect(policy).toContain(naming);
    expect(policy).toContain(
      "unsupported_claim with an in-manifest unsupported_claim finding at the overclaiming definition text when the name, description or a declared variant promises what the source does not do,",
    );
  });

  it("keeps a host's own turn limit for a publication review", async () => {
    const requests = scripted((index) => [read(pending.entrypoint, 0, `read_${index}`)]);
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, {
            ...native,
            specialize: () => ({ maxTurns: 3 }),
          }),
        ).review(pending, sourcesOf(files)),
      ),
    );
    expect(result).toMatchObject({ _tag: "Left", left: { code: "TurnLimitExceeded" } });
    expect(requests).toHaveLength(4);
  });

  it.each([
    { reason: "unsupported_claim", category: "unsupported_claim" },
    { reason: "input_feedback", category: "account_specific_enum" },
    { reason: "source_correction", category: "example_value" },
    { reason: "privacy", category: "safety_default" },
  ])(
    "accepts a $reason decision with a $category finding through the reviewer output schema",
    async ({ reason, category }) => {
      const requests = scripted(() => [
        message({
          outcome: "deny",
          reason,
          rationale: "The schema encodes a private account-specific choice",
          findings: [
            { path: "publication/definition.json", byteStart: 0, byteEnd: 1, category, explanation },
          ],
        }),
      ]);
      const result = await Effect.runPromise(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
        ).review(pending, sourcesOf(files)),
      );
      expect(result.decision).toMatchObject({
        outcome: "deny",
        reason,
        findings: [{ path: "publication/definition.json", category }],
      });
      expect(JSON.stringify(requests[0]?.outputType)).toContain(category);
    },
  );

  it("completes a review whose model reads one chunk past the end of a large file", async () => {
    const source = `export const value = "${"x".repeat(70_000)}";`;
    const path = "operation/src/large.mjs";
    const request: PendingExecution = {
      ...pending,
      entrypoint: path,
      publication: {
        files: [
          {
            path,
            byteLength: Buffer.byteLength(source),
            published: true,
            current: true,
            owner: "minter",
          },
        ],
      },
    };
    const reads = [[0], [65_536, 131_072]];
    const requests = scripted((index) => {
      const offsets = reads[index];
      return offsets === undefined
        ? [message(allow)]
        : offsets.map((offset, at) => read(path, offset, `read_${index}_${at}`));
    });
    const result = await Effect.runPromise(
      Effect.either(
        makeGuardian(
          makeOpenAIReviewer("Synthetic policy {{ tenant_policy_config }}", false, native),
        ).review(request, sourcesOf(new Map([[path, source]]))),
      ),
    );
    expect(result).toMatchObject({ _tag: "Right", right: { decision: { outcome: "allow" } } });
    expect(requests).toHaveLength(3);
  });
});
