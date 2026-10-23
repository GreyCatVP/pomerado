import { Usage } from "@openai/agents";
import type { ModelRequest, ModelResponse } from "@openai/agents";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { refused, withCheck } from "../../src/destinations/autofill-refusal.js";
import type {
  AutofillInspection,
  AutofillRefusal,
  AutofillSignedInCheck,
  AutofillStep,
} from "../../src/destinations/autofill-step.js";
import {
  hostAuthentication,
  MintHarnessSnapshot,
  type MintDependencies,
  type SignInStep,
} from "../../src/mint/contracts.js";
import { makeOpenAIMinter } from "../../src/mint/openai.js";
import { makeSignInRecorder } from "../../src/mint/sign-in-recorder.js";
import { mintError } from "../../src/standalone/errors.js";
import {
  makeMintContinuationFixture,
  makeMintHarnessFixture,
} from "../support/mint-fixtures.js";
import { portableJobSession } from "../support/portable-mint.js";

/*
 * The host types nothing into a sign-in screen whose field, form or submit would send the login
 * somewhere credentials may not go: its destination check refuses the screen before typing, and
 * the refusal comes back as the step's result, not as a failure. No change to the step's selectors
 * gets past that check, so a host_refused report stands on it and ends the build as the host's
 * refusal, instead of being refused while the minter tries recoveries that cannot pass it. A
 * refusal the minter can correct, such as a selector that found nothing, is no host refusal, and a
 * later screen that passed the check clears it. Each scenario runs the real minter loop on recorded
 * model responses, with the standalone host's sign-in recorder over a synthetic site.
 */

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const fixture = makeMintContinuationFixture(cleanups, portableJobSession, makeOpenAIMinter);

const origin = "https://member.example.test";
const login = { username: "synthetic-owner", password: "synthetic-password" };
const target = {
  ownerUrl: `${origin}/login`,
  documentOrigin: origin,
  actions: [`${origin}/session`],
  methods: ["post"],
  submitMethod: "post",
  editable: true,
  control: "text",
} as const;
const described = {
  tag: "input",
  role: null,
  formMethod: "post",
  type: "password",
  name: null,
  id: null,
  autocomplete: null,
  inputmode: null,
  label: "Password",
  placeholder: null,
  ariaLabel: null,
  text: null,
};

/** The site's sign-in form, whose form posts the login to another site's host. */
const outsideForm = "#outside-password";
/** A selector the page shows nothing for. */
const missingField = "#missing-password";

/** The host's inspection of a screen, by the password field the step names. */
const inspection = (step: AutofillStep): AutofillInspection | AutofillRefusal => {
  const passwordField = step.fields.find((field) => field.slot === "password")?.selector;
  if (passwordField === outsideForm)
    return withCheck(refused("credential_target_refused", 0), "destination", {
      part: "form_action",
    });
  if (passwordField === missingField) return withCheck(refused("not_found", 1), "not_found");
  return {
    url: `${origin}/login`,
    page: `${origin}/login`,
    targets: { fields: step.fields.map(() => target), submit: target },
    siteOrigin: origin,
    authenticationOrigins: [],
    screen: {
      origin,
      fields: step.fields.map((field) => ({ ...described, slot: field.slot })),
      submit: described,
      buttons: [],
    },
  };
};

/**
 * A synthetic site whose sign-in never completes: a screen that passes the host's inspection is
 * filled and submitted, and the page stays on its login screen. `fills` counts the fills that
 * reached the page.
 */
const signInSite = () => {
  let fills = 0;
  const recorder = makeSignInRecorder({
    browser: {
      inspect: (step: AutofillStep) => Effect.succeed(inspection(step)),
      fill: ({ step }) =>
        Effect.sync(() => {
          fills += 1;
          return {
            outcome: "filled" as const,
            fields: step.fields.map((field) => ({ slot: field.slot, status: "filled" as const })),
            submit: "clicked" as const,
            url: `${origin}/login`,
          };
        }),
      confirm: () =>
        Effect.succeed<AutofillSignedInCheck>({
          signedIn: false,
          failed: "indicator_not_visible",
          url: `${origin}/login`,
        }),
      authenticationOrigins: [],
      open: () => Effect.void,
      markerVisible: () => Effect.succeed(false),
    },
    login: {
      held: () => login,
      values: Effect.succeed(login),
      correct: () => Effect.succeed(login),
    },
    ask: () => Effect.dieMessage("The test asks the owner nothing"),
    secrets: { register: () => {}, assertAbsent: () => Effect.void },
    review: () => Effect.void,
    site: "member.example.test",
    signedOutPages: () => [],
  });
  let executions = 0;
  const reviewAndExecute: MintDependencies["reviewAndExecute"] = (
    execution,
    beforeDispatch = () => Effect.void,
  ) =>
    Effect.gen(function* () {
      executions += 1;
      const signIn = "signInStep" in execution ? execution.signInStep : undefined;
      if (signIn === undefined) return yield* Effect.die("The test signs in by autofill only");
      const step = yield* recorder.step(signIn, undefined, beforeDispatch(hostAuthentication));
      return {
        executionId: `sign_in_${executions}`,
        status: "completed" as const,
        // A screen refused before anything was typed sent nothing, as a hosted host reports it.
        effect: step.report?.outcome === "refused" ? ("not_sent" as const) : ("possible" as const),
        observations: { step: step.report, ...step.result },
      };
    }).pipe(Effect.mapError(mintError));
  return {
    fills: () => fills,
    dependencies: {
      autofillSignIn: true,
      reviewAndExecute,
      signInDestinationRefused: () => recorder.destinationRefused(),
    } satisfies Partial<MintDependencies>,
  };
};

const usage = () => new Usage({ requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 });
const call = (name: string, callId: string, input: object): ModelResponse => ({
  usage: usage(),
  output: [
    {
      type: "function_call",
      name,
      callId,
      arguments: JSON.stringify({ ...input, intent: `Synthetic ${name} purpose` }),
      status: "completed",
    },
  ],
});
/** A sign-in screen whose password field is `passwordField`. */
const screen = (passwordField: string): SignInStep => ({
  fields: [
    { selector: "#user", accepts: ["username"] },
    { selector: passwordField, slot: "password" },
  ],
  submit: "#sign-in",
});
const authenticateStep = {
  purpose: "authenticate",
  target: "liveBrowser",
  entrypoint: "src/tool.ts",
  fixtureRefs: [],
  caseFilter: [],
  maxWorkers: 1,
  timeoutSeconds: 30,
} as const;
const authenticate = (callId: string, passwordField: string) =>
  call("execute", callId, { ...authenticateStep, signInStep: screen(passwordField) });
const hostRefusedReport = {
  reason: "host_refused",
  explanation:
    "The host would not type the login into the site's sign-in form, because the form sends it to another site.",
} as const;
const hostRefused = (callId: string) => call("report_blocked", callId, hostRefusedReport);
const stop: ModelResponse = {
  usage: usage(),
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "Stopping." }],
    },
  ],
};

/** The tool answer the model read for `callId`. */
const answerTo = (request: ModelRequest | undefined, callId: string) => {
  const items = Array.isArray(request?.input) ? request.input : [];
  const item = items.find(
    (entry) => entry.type === "function_call_result" && entry.callId === callId,
  );
  const output = item?.type === "function_call_result" ? item.output : undefined;
  const text =
    typeof output === "string"
      ? output
      : output !== undefined && "text" in output
        ? output.text
        : "";
  return JSON.parse(text === "" ? "{}" : text) as Record<string, unknown>;
};
/** What a sign-in step's answer for `callId` observed: the screen's report and the next step. */
const stepAnswer = (request: ModelRequest | undefined, callId: string) => {
  const { observations } = answerTo(request, callId);
  return typeof observations === "string" ? (JSON.parse(observations) as unknown) : observations;
};

it("ends a host_refused report as the host's refusal once the host refused a screen at its destination check", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [authenticate("outside", outsideForm), hostRefused("report")][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  // The screen was refused before anything was typed, as a step result.
  expect(site.fills()).toBe(0);
  expect(stepAnswer(run.requests[1], "outside")).toMatchObject({
    step: { outcome: "refused", reason: "credential_target_refused" },
  });
  // The report ended the build at once, with no further model call.
  expect(run.requests).toHaveLength(2);
  expect(outcome).toMatchObject({
    build: "incomplete",
    blocked: { reason: "host_refused" },
    stopReason: "host_refused",
  });
});

it("refuses a host_refused report when the only refusal was a selector the minter can correct", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [authenticate("missing", missingField), hostRefused("report")][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(stepAnswer(run.requests[1], "missing")).toMatchObject({
    step: { outcome: "refused", reason: "not_found" },
  });
  expect(answerTo(run.requests[2], "report")).toMatchObject({
    status: "blocked_refused",
    reason: "host_not_refused",
  });
  expect(outcome).not.toHaveProperty("blocked");
});

// A selector that found nothing after the refused form leaves the refused form as it was, so the
// report still stands on it.
it("keeps a destination refusal through a later refusal the minter can correct", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("outside", outsideForm),
        authenticate("missing", missingField),
        hostRefused("report"),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(run.requests).toHaveLength(3);
  expect(outcome).toMatchObject({ blocked: { reason: "host_refused" } });
});

// The minter found another sign-in form on the site that passed the check, and the host typed into
// it: the refused form no longer stops the build.
it("refuses a host_refused report once a later screen passed the destination check", async () => {
  const site = signInSite();
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("outside", outsideForm),
        authenticate("own_form", "#password"),
        hostRefused("report"),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  expect(site.fills()).toBe(1);
  expect(answerTo(run.requests[3], "report")).toMatchObject({
    status: "blocked_refused",
    reason: "host_not_refused",
  });
  expect(outcome).not.toMatchObject({ blocked: { reason: "host_refused" } });
});

// A screen that takes no password or code, such as the site's own identifier screen, says nothing
// about where the login's password would go, so passing the check leaves the refused form standing.
it("keeps a destination refusal through a later identifier screen that passed the check", async () => {
  const site = signInSite();
  const identifierScreen: SignInStep = {
    fields: [{ selector: "#user", accepts: ["username"] }],
    submit: "#continue",
  };
  const run = await fixture(
    (_request, index) =>
      [
        authenticate("outside", outsideForm),
        call("execute", "identifier", { ...authenticateStep, signInStep: identifierScreen }),
        hostRefused("report"),
      ][index] ?? stop,
    site.dependencies,
    { effect: "read", siteOrigin: origin },
  );
  const outcome = await run.run();
  // The identifier screen passed and was sent; the report still stood on the refused form and
  // ended the build at once, as sign-in unavailable since the identifier went out unconfirmed.
  expect(site.fills()).toBe(1);
  expect(run.requests).toHaveLength(3);
  expect(outcome).toMatchObject({ build: "incomplete", recoveryReason: "sign_in_unavailable" });
});

const scripted = makeMintHarnessFixture(
  cleanups,
  { mode: "mint", intent: "Read the account page", businessInput: {}, observations: [] },
  portableJobSession,
);
const freshAgent = {
  version: 1,
  sdkVersion: "0.18.0",
  sdkState: "",
  modelCalls: 0,
  finalsWithoutTool: 0,
  tools: [],
} as const;

/**
 * The reply to a takeover's host_refused report after its predecessor's host refused a sign-in
 * screen at its destination check, from the predecessor's checkpoint as `edit` leaves it. The
 * takeover's host is new and has refused nothing.
 */
const hostRefusedAfterTakeover = async (edit: (checkpoint: Record<string, unknown>) => void) => {
  let capture: (() => MintHarnessSnapshot) | undefined;
  const site = signInSite();
  const first = await scripted(
    (turn) =>
      Effect.asVoid(
        turn.actions.execute({ ...authenticateStep, signInStep: screen(outsideForm) }),
      ),
    {
      ...site.dependencies,
      agentRecovery: {
        bindHarness: (bound) =>
          Effect.sync(() => {
            capture = bound;
          }),
        save: () => Effect.void,
      },
    },
  );
  await first.run();
  const checkpoint = JSON.parse(JSON.stringify(capture?.())) as Record<string, unknown>;
  edit(checkpoint);
  const harness = Schema.decodeUnknownSync(MintHarnessSnapshot)(checkpoint);
  const replies: unknown[] = [];
  const takeover = await scripted(
    (turn) =>
      Effect.gen(function* () {
        const reportBlocked = turn.actions.reportBlocked;
        if (reportBlocked === undefined) throw new Error("Missing report_blocked");
        replies.push(JSON.parse(yield* reportBlocked(hostRefusedReport)));
      }),
    {
      ...signInSite().dependencies,
      agentRecovery: { initial: { agent: freshAgent, harness }, save: () => Effect.void },
    },
  );
  await takeover.run();
  return replies;
};

// The checkpoint keeps the host's latest answer, so a successor whose host kept no record of the
// refusal still ends the build on it; a checkpoint from an older worker, which kept none, grants no
// host_refused ending.
it.each([
  { checkpoint: "this worker's", edit: () => undefined, status: "blocked" },
  {
    checkpoint: "an older worker's",
    edit: (checkpoint: Record<string, unknown>) => {
      delete checkpoint["signInDestinationRefused"];
    },
    status: "blocked_refused",
  },
])(
  "keeps a destination refusal across a takeover from $checkpoint checkpoint",
  async ({ edit, status }) => {
    expect(await hostRefusedAfterTakeover(edit)).toEqual([expect.objectContaining({ status })]);
  },
);
