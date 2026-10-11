import { OpenAIProvider, setDefaultModelProvider, Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  guardianExecutionPolicy,
  nativeExecutionEnvironment,
} from "../../src/guardian/execution-policy.js";
import { makeOpenAIReviewer } from "../../src/guardian/openai.js";
import {
  guardianPublicationPolicy,
  publicationDecisionPolicy,
  publicationLiveTestsPolicy,
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
      "perform and return the confirmation or read-back it declares, and never resubmit or commit twice. A script that confirms from its commit request is confirming, not missing a read-back: in the same call as the final commit click it waits for the site's response on the route the session's commit used, requires a 2xx or 3xx status and no error in a body it can read, checks the page for an error or validation message (a 201 whose Location names the new record needs no page check), and only then calls verified(). It is a confirmation finding when the script accepts any request or any status, takes a 200 from an endpoint that can report errors in its body without checking that body, or skips the page's error check.",
    );
    expect(policy).toContain(
      "'unverifiable' is valid only if the session evidence shows the site offered no commit response the script can check, no confirmation and no read-back.",
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
    expect(requests).toHaveLength(12);
  });

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
      expect(requests).toHaveLength(repeatUnavailable ? 32 : 14);
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
    expect(requests).toHaveLength(3);
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
