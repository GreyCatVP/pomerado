import type { MintReportContext } from "./diagnostics.js";
import type { RunnerResultDefect } from "../execution/boundary.js";
import { destinationPrivateCandidateMetadata } from "../destinations/private-candidate.js";
import { policyFailureMetadata } from "../runtime/policy-metadata.js";
import {
  failureDetail,
  failureDetailMetadata,
  failureRootCause,
} from "../runtime/failure-detail.js";
import {
  maximumHostRefusals,
  signInAnswer,
  signInFailureFeedback,
  signInFeedbackOf,
  signInRootCode,
  signInUnavailableSummary,
  unresolvedSignInGuidance,
} from "./sign-in-failure.js";
import type { SignInDiagnostic } from "../execution/sign-in-diagnostics.js";
import { type HostRefusal, sameHostRefusal } from "../destinations/autofill-refusal.js";
import { authorityCheckMetadata } from "../auth/authority-metadata.js";
import {
  diagnosticRetentionReason,
  diagnosticScreeningReason,
  diagnosticStorageFailure,
} from "../models/model-diagnostic-failure.js";
import { createHash, randomUUID } from "node:crypto";
import {
  Cause,
  Clock,
  Deferred,
  Effect,
  Either,
  Exit,
  FiberSet,
  Option,
  Schema,
  Scope,
} from "effect";
import {
  AgentRequest,
  blockedExplanationLimit,
  BlockedReport,
  BuildBlocked,
  CaptureRequest,
  ExecutionRefusal,
  ExecutionRequest,
  isReadOrWriteChoice,
  LiveTestsRequest,
  MintFailure,
  MintRequest,
  MintServices,
  PublicationRequest,
  SignedInMarkerCheckRequest,
  TaskUpdateRequest,
  withOwnWords,
} from "./contracts.js";
import { answersForReview, type AnsweredQuestion } from "../guardian/question.js";
import { correctablePublicationReason } from "../guardian/review-contracts.js";
import type { PublicationFinding } from "../guardian/review-contracts.js";
import {
  taskUpdateForReview,
  type PendingTaskUpdate,
  type TaskChange,
} from "../guardian/task-update.js";
import { siteDomain } from "../runtime/same-site.js";
import { validateSignedInMarker } from "../destinations/signed-in-marker.js";
import { finiteCaptureGap, finiteRunnerFailure } from "./runner-failure.js";
import { isSecretHandle } from "./secret-handles.js";
import { fileReadbackRule } from "./file-readback.js";
import type {
  AcceptedTaskUpdate,
  AllowedExecution,
  AgentInputRequest,
  BuildAssumption,
  TaskState,
  TaskUpdateStatus,
  ExecutionEvidence,
  MintActions,
  MintOutcome,
  MintHarnessSnapshot,
  PublicationDecision,
  PublicationRecovery,
  SpentSignIn,
  WeakenedOutput,
} from "./contracts.js";
import { pickedOption, type ValidAnswers } from "../runtime/input-request.js";
import {
  bufferedHistoryArchive,
  makeOutcomeReviewer,
  memoryHistoryArchive,
  minterHistory,
} from "./outcome-review.js";
import { readImportClosure } from "./operation-source.js";
import { contentDigest } from "./step-checks.js";
import {
  caseDigest,
  caseView,
  cursorPairOf,
  decodeCasesFile,
  judgeCase,
  liveTestCasesPath,
  liveTestsEvidence,
  liveTestsEvidencePath,
  liveTestsEvidenceProblem,
  liveTestVersion,
  LiveTestOutputChecks,
  maximumBatchCases,
  outputExcerpt,
  primaryListOf,
  type LiveTestCasesFile,
  type LiveTestRecord,
  type LiveTestVersion,
  type LiveTestVersionResults,
} from "./live-tests.js";
import type {
  LiveMinterHistory,
  OutcomeEvidence,
  WriteExecutionStatus,
} from "./outcome-review-contracts.js";
import type { SiteAccessDiagnostic } from "./site-access-contracts.js";
import type { ModelDiagnosticTiming } from "../models/model-diagnostic-timing.js";
import type { RuntimeRecordInput } from "../models/model-runtime-record.js";
import { inputContractChangedInstruction, registryRefusal } from "./registry-feedback.js";
import { publicationBlockFeedback, workspacePath } from "./publication-block.js";
import { outputChecksRefusal } from "./output-notes.js";
import { lintOutput } from "../runtime/output-lint.js";
import {
  inputFeedbackInstruction,
  maximumInputFeedbackRounds,
  unresolvedInputFeedbackSummary,
} from "./input-feedback.js";
import type { MintCompletion } from "./input-feedback.js";
import {
  makeMintWorkspace,
  questionOnlyWorkspace,
  relativeSourcePath,
  screenMintText,
} from "./workspace.js";

/**
 * Whether a maintenance update only adds or tightens output fields: callers keep everything the
 * registered contract gives them, so nobody needs to confirm it.
 */
const keepsContract = (update: TaskUpdateRequest) =>
  update.changes.every(
    (change) =>
      change.setting === "output" && (change.change === "add" || change.change === "tighten"),
  );

/** Each loosened field and how, for the minter; a host refusal that names none reads as a sentence. */
const weakenedOutputsText = (weakened: readonly WeakenedOutput[]) =>
  weakened.length === 0
    ? ""
    : `: ${weakened
        .map(({ field, change }) =>
          change === "removed"
            ? `${field} was removed`
            : change === "optional"
              ? `${field} became optional`
              : change === "nullable"
                ? `${field} became nullable`
                : `${field} admits more values than before`,
        )
        .join("; ")}`;

const effectQuestionInstruction =
  "Before any website access, ask the person whether this build only looks things up or changes something on the website. Call request_input once with exactly one choice question whose options have the ids read and write: the prompt says in one or two plain sentences what the finished tool would do, and your best guess comes first; filling in or advancing a form that saves data on the site (an application, profile or checkout form) counts as a change, while searching or filtering does not. A write build does the requested task once, for real, with the person's values, while it builds (it may take several steps), and ends by reading the site's confirmation. No other tool is available until the person answers.";

/**
 * The host's own labels for the two answers of the effect question. The agent writes the prompt,
 * which Guardian reviews, but never what an answer says, so a label cannot present `write` as
 * keeping the build read-only.
 */
const effectAnswerLabels: Readonly<Record<string, string>> = {
  read: "Keep it read-only: only look things up",
  write: "Make it a write build: let it change the website",
};
const withEffectAnswerLabels = <
  Q extends { readonly type: string; readonly options?: readonly { readonly id: string }[] },
>(
  questions: readonly Q[],
): Q[] =>
  questions.map((question) =>
    question.type !== "choice" || question.options === undefined
      ? question
      : {
          ...question,
          options: question.options.map((option) => {
            const label = effectAnswerLabels[option.id];
            return label === undefined ? option : { id: option.id, label };
          }),
        },
  );

/**
 * A saved login another of the account's jobs holds, still held after the host waited for it in
 * place: nothing was sent, no sign-in was spent, and the login itself is fine. Never a credentials
 * problem.
 */
const loginInUseAnswer = {
  code: "login_in_use",
  fields: {
    signInOutcome: "signed_out",
    nextStep: "authenticate",
    credentialSent: false,
    countsTowardSignInCap: false,
  },
  notice:
    "The host started no sign-in: the saved login is in use by another of the account's jobs, which holds it until that job ends, and it was still in use after the host waited for it. This is not a credentials problem: nothing was sent, this does not count toward the attempt's sign-in limit, and no other login is needed, so do not ask the caller for one. Work that needs no sign-in may go on; call execute purpose authenticate again later, and the host binds the same login once it is free.",
} as const;

/** A failed or refused sign-in's answer, or a held login's; undefined for any other failure. */
const signInOrLoginInUseAnswer = (
  error: MintFailure,
  feedback: ReturnType<typeof signInFeedbackOf>,
  ending: Parameters<typeof signInAnswer>[2],
) =>
  feedback !== undefined
    ? signInAnswer(error, feedback, ending)
    : error.reason === "login_in_use"
      ? loginInUseAnswer
      : undefined;

/** A task update request's identity: the same request has the same digest. */
const taskUpdateDigest = (request: TaskUpdateRequest) =>
  createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex");

type AgentQuestion = (typeof AgentRequest.Type)["questions"][number];
/** The agent's question as its caller reads it, with each caller-visible text redacted. */
const callerVisibleQuestion = (
  question: AgentQuestion,
  redact: (text: string) => string,
): AgentQuestion => {
  const prompt = redact(question.prompt);
  if (question.type === "choice" || question.type === "multi_choice")
    return {
      ...question,
      prompt,
      options: question.options.map((option) => ({
        ...option,
        label: redact(option.label),
        ...(option.maskedLabel === undefined ? {} : { maskedLabel: redact(option.maskedLabel) }),
      })),
    };
  if (question.type === "confirm" && question.followUp !== undefined) {
    const { defaultText } = question.followUp;
    return {
      ...question,
      prompt,
      followUp: {
        prompt: redact(question.followUp.prompt),
        // The caller's form shows it as the field's default.
        ...(defaultText === undefined ? {} : { defaultText: redact(defaultText) }),
      },
    };
  }
  return { ...question, prompt };
};
/** The agent's request as its caller reads it: its notice and every question. */
const callerVisibleRequest = <R extends typeof AgentRequest.Type>(
  request: R,
  redact: (text: string) => string,
): R => ({
  ...request,
  ...(request.notice === undefined ? {} : { notice: redact(request.notice) }),
  questions: request.questions.map((question) => callerVisibleQuestion(question, redact)),
});

/** How the minter removes an account reference from the named part of a tool's definition. */
const definitionFix = (section: string | undefined) =>
  section === "loginUrl"
    ? "Run authenticate again with the site's plain sign-in page as loginUrl, then call finish_build again with the same executionId."
    : section === "name" || section === "description" || section === "supportedVariants"
      ? `Rewrite the ${section} in finish_build's metadata without it and call finish_build again with the same executionId.`
      : section === "site"
        ? "Rewrite siteName and siteSummary in finish_build's metadata without it and call finish_build again with the same executionId."
        : section === "inputSchema" || section === "outputSchema" || section === "questions"
          ? "Edit the operation's schemas and questions in its source without it, then call finish_build again with the same executionId."
          : "Remove it from the metadata, the operation's schemas and questions, and the login URL, then call finish_build again with the same executionId.";

/**
 * Whether the agent's request sets whether the caller may answer in their own words, which is the
 * host's to set on every choice.
 */
const setsOwnWords = (input: unknown) =>
  Option.isSome(
    Schema.decodeUnknownOption(
      Schema.Struct({
        questions: Schema.Array(Schema.Unknown).pipe(
          Schema.filter((questions) =>
            questions.some(
              (question) =>
                typeof question === "object" &&
                question !== null &&
                ("allowOther" in question || "allowNote" in question),
            ),
          ),
        ),
      }),
    )(input),
  );

/**
 * The option the owner picked on the effect question, undefined when they answered in their own
 * words instead.
 */
const readOrWritePick = (submitted: AgentInputRequest, answers: ValidAnswers) => {
  const given = answers[submitted.questions[0]?.id ?? ""];
  return given?.type === "choice" ? pickedOption(given.value) : undefined;
};

/**
 * An answer as the model receives it: the value alone, keyed by question id. A `secret` answer is
 * the host's handle; anything else in its place could be the secret itself, so nothing is returned.
 */
const answersForModel = (answers: ValidAnswers) =>
  Object.values(answers).some((answer) => answer.type === "secret" && !isSecretHandle(answer.value))
    ? Effect.fail(
        new MintFailure({
          code: "Unavailable",
          failureDetail: failureDetail("mint_host_dependency_failed", {
            operation: "askInput",
            context: { check: "secret_answer_without_handle" },
          }),
        }),
      )
    : Effect.succeed(
        Object.fromEntries(Object.entries(answers).map(([id, answer]) => [id, answer.value])),
      );
/**
 * What an execution whose runner left no readable result means for the agent: an execution-host
 * fault. It says nothing about the website, the browser or its egress, so it is no reason to
 * change browser mode or proxy.
 */
const runnerResultNotice = (runner: RunnerResultDefect) =>
  `The operation runner ended without a readable result (execution.runnerResult.cause: ${runner.cause}${runner.signal === undefined ? `, exit status ${runner.exitCode}` : `, ended by ${runner.signal}`}). This is an execution-host fault, not evidence about the website, the browser or its proxy; stderr, when present, is the runner's own account. The execution may have run, so its effect is possible. `;

/** How many of the latest publication refusals a question or blocked-explanation review reads. */
const reviewedPublicationRefusals = 8;
/** The HTTP version's file, whose live tests the publication record shows beside the Playwright version's. */
const httpVersionPath = "src/tool-http.mjs";
/** Refusals of a write the session did not demonstrate as its build declares it. */
const writeCompletionReasons: ReadonlySet<string> = new Set([
  "write_not_submitted",
  "commit_marks_undeclared",
  "commit_marks_unentered",
  "confirmation_undeclared",
  "confirmation_unrecorded",
  // A read's execution after the build became a write: the write itself is still to do.
  "example_before_effect_change",
]);
/** A contract that rejects what ran: a write not demonstrated as declared, or a read's source fix. */
const contractReasons: ReadonlySet<string> = new Set([
  "contract_input_mismatch",
  "contract_output_mismatch",
]);
/** Refusals that need a new live read, test or sign-in, never a completed write again. */
const newObservationReasons: ReadonlySet<string> = new Set([
  "http_implementation_untested",
  "http_implementation_stale",
  "example_output_unavailable",
  "destination_validation",
  "read_back_required",
  "login_url_one_time",
  "login_url_contains_credential",
  // An execution on the site the build moved away from: a fresh example on the current site.
  "example_before_site_change",
  // Restored inputs change the code, which needs its own example.
  "input_contract_changed",
]);
/** How the minter goes on after a refusal that is neither an outage nor Guardian's. */
const refusalRecovery = (reason: string | undefined, write: boolean): PublicationRecovery =>
  reason !== undefined &&
  (writeCompletionReasons.has(reason) || (write && contractReasons.has(reason)))
    ? "write_completion"
    : reason !== undefined && newObservationReasons.has(reason)
      ? "new_observation"
      : "correct_source";
/** A refusal the harness makes before publication runs, as its decision. */
const hostRefusalDecision = (
  reason: string,
  executionId: string | undefined,
  write: boolean,
  code: MintFailure["code"] = "PublicationUnavailable",
): Omit<PublicationDecision, "decisionId" | "decidedAt"> => ({
  outcome: "refused",
  code,
  reason,
  ...(executionId === undefined ? {} : { executionId }),
  failedChecks: [reason],
  recovery: refusalRecovery(reason, write),
});
/**
 * A failure's code as diagnostics and publication evidence name it. A review whose outcome
 * Guardian kept refusing fails as `ReviewUnavailable`, but it is a verdict that did not form, not
 * an outage, so it is named `InvalidOutcome`.
 */
const failureCode = (error: MintFailure) =>
  error.reviewFailure === "InvalidOutcome" ? "InvalidOutcome" : error.code;
/** The finite checks behind a publication refusal: never a value, path or rationale. */
const refusalChecks = (error: MintFailure) => [
  ...new Set(
    [
      error.reason,
      error.reviewFailure === "InvalidOutcome" ? error.reviewFailure : undefined,
      error.review?.reason,
      error.registryIssue,
      error.publicationBlock?.check,
      error.destinationEvidenceGap,
      ...(error.review?.findings ?? []).map(({ category }) => category),
    ].filter((check) => check !== undefined),
  ),
];

const Count = Schema.Int.pipe(Schema.between(0, Number.MAX_SAFE_INTEGER));
/** Fresh verified examples allowed per attempt after publication finds an unreadable output. */
const maximumUnavailableOutputReruns = 2;
const VisibleReceipt = Schema.Struct({
  authentication: Schema.optional(
    Schema.Struct({
      state: Schema.Literal("authenticated", "failed"),
      effect: Schema.Literal("possible", "verified"),
    }),
  ),
  executionId: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{1,200}$/)),
  status: Schema.Literal("completed", "failed", "unsupported", "needs_input"),
  effect: Schema.Literal("not_sent", "possible", "verified"),
  confirmation: Schema.optional(Schema.Literal("message", "readback")),
  withheldConfirmation: Schema.optional(Schema.Literal("message", "readback")),
  preflight: Schema.optional(Schema.Literal("rejected_before_claim")),
  checks: Schema.optional(
    Schema.Struct({
      passed: Count,
      failed: Count,
      skipped: Count,
      unsupported: Count,
      liveSiteTouched: Schema.Boolean,
    }),
  ),
});

/**
 * Adds the host's pending notices (browser state that changed after an earlier call returned) to
 * a JSON tool result, so the agent hears them on its next host tool call of any kind. A result that
 * is not a JSON object, such as a source read, or a failed call keeps them for the next one.
 */
const decodeJsonObject = Schema.decodeUnknownEither(
  Schema.parseJson(Schema.Record({ key: Schema.String, value: Schema.Unknown })),
);

/** The entrypoint a recovered execute call's arguments name, if any. */
const submittedEntrypoint = (args: string): string | undefined => {
  const parsed = decodeJsonObject(args);
  if (parsed._tag === "Left") return undefined;
  const entrypoint = parsed.right["entrypoint"];
  return typeof entrypoint === "string" ? entrypoint : undefined;
};

const withHostNotices = (
  actions: MintActions,
  drain: (() => readonly object[] | undefined) | undefined,
): MintActions => {
  if (drain === undefined) return actions;
  const attach = (result: string): string => {
    // A result that is not a JSON object, such as a source read, keeps its notices for the next.
    const parsed = decodeJsonObject(result);
    if (parsed._tag === "Left") return result;
    const notices = drain();
    if (notices === undefined) return result;
    return JSON.stringify({ ...parsed.right, hostNotices: notices });
  };
  const wrap =
    <A extends readonly unknown[]>(action: (...args: A) => Effect.Effect<string, MintFailure>) =>
    (...args: A) =>
      action(...args).pipe(Effect.map(attach));
  return {
    ...actions,
    ...(actions.retainCapture === undefined ? {} : { retainCapture: wrap(actions.retainCapture) }),
    execute: wrap(actions.execute),
    finish: wrap(actions.finish),
    requestInput: wrap(actions.requestInput),
    ...(actions.reportBlocked === undefined ? {} : { reportBlocked: wrap(actions.reportBlocked) }),
    ...(actions.updateTask === undefined ? {} : { updateTask: wrap(actions.updateTask) }),
    ...(actions.captchaState === undefined ? {} : { captchaState: wrap(actions.captchaState) }),
    ...(actions.liveTests === undefined ? {} : { liveTests: wrap(actions.liveTests) }),
    ...(actions.requestBrowserRecovery === undefined
      ? {}
      : { requestBrowserRecovery: wrap(actions.requestBrowserRecovery) }),
    ...(actions.checkSignedInMarker === undefined
      ? {}
      : { checkSignedInMarker: wrap(actions.checkSignedInMarker) }),
  };
};

/** The paths an input schema rejected, as a sentence, or nothing when the host has none. */
const inputIssueText = (issues: MintFailure["inputIssues"]) =>
  issues === undefined || issues.length === 0
    ? ""
    : ` It rejected ${issues
        .map(
          ({ path, issue }) =>
            `${path === "" ? "the input itself" : JSON.stringify(path)} (${issue})`,
        )
        .join(", ")}.`;

/** What the agent does about a question its script asked that reached nobody. */
const scriptQuestionInstruction: Readonly<
  Record<NonNullable<ExecutionEvidence["scriptQuestion"]>["outcome"], string>
> = {
  reword:
    "Guardian did not allow the question this script asked, so nobody was asked and the script's ask failed. Revise the script's declared question using the rationale, then execute again; the revised question is reviewed again. Do not ask for a value you were already given or that the site shows: read a value the caller's input or the request gives from the tool's input (when the caller's input is empty, pass it in exampleInput on the example, or on each write act step that needs it), and use the {{secret.<id>}} handle of a protected answer you already hold.",
  authentication:
    "The script's question asks for a website login, which only the host requests, so nobody was asked. Remove it from the script's questions and sign in with execute purpose authenticate instead.",
  invalid:
    "The host could not accept the script's question as asked, so nobody was asked. Check its declaration and options, then execute again.",
  unavailable:
    "The host could not review or deliver the script's question, so nobody was asked; nothing is wrong with the question. You may execute again once; if it fails the same way, end the attempt and say the question could not be asked.",
  unanswered:
    "The caller was asked the script's question and gave no answer before it expired, so the script's ask failed. Decide how to go on without it: run the example again with an input that does not need the answer, narrow the tool, or end the build with report_blocked (reason policy when only the caller's answer would let it go on). No answer is never consent: it authorizes no write. Verify the site's current state before any further write. After two questions have gone unanswered, the next one left unanswered ends the build.",
};

/** What the minter reads when its own question expired unanswered. */
const noAnswerInstruction =
  "No answer was given before the question expired. Decide how to proceed without it: continue with a sensible default and list it in finish_build assumptions, narrow the tool so it does not need the answer, or end the build with report_blocked (reason policy when only the caller's answer would let it go on). No answer is never consent: it authorizes no write, sign-in or change of task, so never cite this question in confirmedBy. Ask again only when the answer is essential: after two questions have gone unanswered, the next one left unanswered ends the build.";

/**
 * How many unanswered questions go back to the minter in one build, the minter's own and its
 * scripts' together. A question's wait pauses the build's active time, so a minter that kept asking
 * an absent caller would hold its browser and login for as long as the job may live; the next
 * unanswered question ends the build as no_response instead.
 */
const noAnswerHandBackLimit = 2;

const siteAccessDiagnostic = (evidence: ExecutionEvidence): SiteAccessDiagnostic | undefined => {
  try {
    if (evidence.status !== "failed") return undefined;
    const candidate: unknown = evidence.siteAccess;
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate))
      return undefined;
    const code: unknown = Reflect.get(candidate, "code");
    const basis: unknown = Reflect.get(candidate, "evidence");
    if (code === "site_bot_challenge" && basis === "screened_page_and_response_headers")
      return { code, evidence: basis };
    if (code === "site_rate_limited" && basis === "response_headers")
      return { code, evidence: basis };
  } catch {
    // Optional model-visible provenance cannot replace the primary execution receipt.
  }
  return undefined;
};

/**
 * What the agent does after a write step whose confirmation the host withheld with its result:
 * the write went out, so it is never repeated; a step that only reads the confirmation back
 * confirms the session, and the withheld step publishes only when no read-back is possible.
 */
const withheldConfirmationInstruction =
  "This step read the write's confirmation, so the write went out, but the host did not accept its result, so it confirms nothing yet. Never repeat the write: entering its commit steps again is refused. Fix the source if the host said why, then run one act step that only reads the confirmation or the saved state back and records it, and publish against that step. Only if no step can read it back, call finish_build naming this step with readBackUnavailable saying why; it then publishes with no output kept.";

/** Copy known receipt fields without invoking an optional hostile accessor. */
const safeExecutionEvidence = (evidence: ExecutionEvidence): ExecutionEvidence => {
  const siteAccess = siteAccessDiagnostic(evidence);
  return {
    executionId: evidence.executionId,
    status: evidence.status,
    effect: evidence.effect,
    observations: evidence.observations,
    ...(evidence.review === undefined ? {} : { review: evidence.review }),
    ...(evidence.authentication === undefined ? {} : { authentication: evidence.authentication }),
    ...(evidence.terminalFailure === undefined
      ? {}
      : { terminalFailure: evidence.terminalFailure }),
    ...(evidence.noResponse === undefined ? {} : { noResponse: evidence.noResponse }),
    ...(evidence.preflight === undefined ? {} : { preflight: evidence.preflight }),
    ...(evidence.resultRef === undefined ? {} : { resultRef: evidence.resultRef }),
    ...(evidence.confirmation === undefined ? {} : { confirmation: evidence.confirmation }),
    // A recorded confirmation wins: a step carries a withheld one only in its place.
    ...(evidence.withheldConfirmation === undefined || evidence.confirmation !== undefined
      ? {}
      : { withheldConfirmation: evidence.withheldConfirmation }),
    ...(evidence.checks === undefined ? {} : { checks: evidence.checks }),
    ...(siteAccess === undefined ? {} : { siteAccess }),
    ...Option.match(Schema.decodeUnknownOption(ExecutionRefusal)(evidence.refusal), {
      onNone: () => ({}),
      onSome: (refusal) => ({ refusal }),
    }),
  };
};

const decode = <A, I>(schema: Schema.Schema<A, I>, input: unknown) =>
  Schema.decodeUnknown(schema)(input, { onExcessProperty: "error" }).pipe(
    Effect.mapError(
      (error) =>
        new MintFailure({
          failureDetail: failureDetail("mint_host_dependency_failed", {
            operation: "Schema.decodeUnknown",
            error,
          }),
          code: "InvalidRequest",
        }),
    ),
  );

const diagnosticUnavailable = (error: unknown) =>
  new MintFailure({
    code: "Unavailable",
    diagnosticRetentionReason: diagnosticRetentionReason(error),
    diagnosticStorageFailure: diagnosticStorageFailure(error),
  });

type JsonTypeTree =
  | { readonly type: "null" | "string" | "number" | "boolean" }
  | { readonly type: "object"; readonly fields: Record<string, JsonTypeTree> }
  | { readonly type: "array"; readonly elementTypes: JsonTypeTree[] };

const jsonTypeTree = (value: unknown): JsonTypeTree => {
  const visit = (current: unknown): JsonTypeTree => {
    if (current === null) return { type: "null" };
    if (typeof current === "string") return { type: "string" };
    if (typeof current === "boolean") return { type: "boolean" };
    if (typeof current === "number" && Number.isFinite(current)) return { type: "number" };
    if (Array.isArray(current)) {
      const elements = new Map<string, JsonTypeTree>();
      for (const value of current) {
        const tree = visit(value);
        elements.set(JSON.stringify(tree), tree);
      }
      return {
        type: "array",
        elementTypes: [...elements]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([, tree]) => tree),
      };
    }
    if (typeof current !== "object") throw new Error("Invalid JSON input");
    const fields: Record<string, JsonTypeTree> = {};
    for (const key of Object.keys(current).sort())
      Object.defineProperty(fields, key, {
        value: visit(Reflect.get(current, key)),
        enumerable: true,
        configurable: true,
      });
    return { type: "object", fields };
  };
  return visit(value);
};

const loginRequestInstruction = (login: "held" | "supplied" | "inspect" | "unavailable") =>
  login === "inspect"
    ? "Inspect the website's current sign-in screen, then call execute purpose authenticate with target liveBrowser and signInStep describing its observed fields. The host asks privately for only the missing fields after verifying them. Never ask for credentials yourself."
    : login === "unavailable"
      ? "This asks for a website login, which only the host requests, and this build cannot be given one. Do not ask for it again; continue without it or end the attempt and say why."
      : "This asks for a website login, which only the host requests. The host now holds a login for this site: call execute purpose authenticate with target liveBrowser. Never ask for passwords, usernames or logins yourself.";

/** One coding flow. Durable dispatch claims, leases, authority and cleanup belong to the host. */
export const runMint = (input: unknown): Effect.Effect<MintOutcome, MintFailure, MintServices> =>
  Effect.scoped(
    Effect.gen(function* () {
      const request = yield* decode(MintRequest, input);
      yield* Effect.try({
        try: () =>
          JSON.stringify(request, (key, value: unknown) => {
            if (key === "website_auth" || key === "websiteAuth") throw new Error("private_input");
            return value;
          }),
        catch: (error) =>
          new MintFailure({
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "JSON.stringify",
              phase: "request_validation",
              error,
            }),
            code: "InvalidRequest",
          }),
      });
      const dependencies = yield* MintServices;
      const redactCallerText = dependencies.redactCallerText ?? ((text: string) => text);
      const reportFailure = (error: unknown, details: MintReportContext) =>
        dependencies.reporting?.failure(error, details) ?? Effect.void;
      const reportBestEffort = (effect: Effect.Effect<void, Error>, details: MintReportContext) =>
        dependencies.reporting?.bestEffort(effect, details) ??
        effect.pipe(
          Effect.catchAll((error) =>
            diagnose({
              operation: details.operation,
              ...(details.phase === undefined ? {} : { phase: details.phase }),
              ...failureDetailMetadata(
                new MintFailure({
                  code: "Unavailable",
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: details.operation,
                    ...(details.phase === undefined ? {} : { phase: details.phase }),
                    error,
                  }),
                }),
              ),
            }),
          ),
        );
      const recovered = dependencies.agentRecovery?.initial?.harness;
      const finished: { build?: MintOutcome["build"] } = {};
      yield* Effect.addFinalizer((exit) =>
        dependencies.attemptFinished === undefined
          ? Effect.void
          : dependencies.attemptFinished(
              Exit.isFailure(exit)
                ? Cause.isInterruptedOnly(exit.cause)
                  ? "interrupted"
                  : "failed"
                : finished.build === "published"
                  ? finished.build
                  : "incomplete",
            ),
      );
      // An unanswered Dashboard build only asks its effect question. It is always the first turn.
      const effectQuestion = request.effect === "ask";
      if (effectQuestion && dependencies.capabilityQuestion)
        return yield* new MintFailure({ code: "ScopeDenied" });
      const toolScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(toolScope, Exit.void));
      const runTool = yield* FiberSet.makeRuntimePromise().pipe(
        Effect.provideService(Scope.Scope, toolScope),
      );
      const initialPrompt = yield* screenMintText(dependencies, {
        ...request,
        siteOrigin: undefined,
      });
      const businessInputTypes = dependencies.capabilityQuestion
        ? undefined
        : yield* Effect.gen(function* () {
            const types = yield* Effect.try({
              try: () => jsonTypeTree(request.businessInput),
              catch: (error) =>
                new MintFailure({
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: "jsonTypeTree",
                    phase: "business_input_types",
                    error,
                  }),
                  code: "InvalidRequest",
                }),
            });
            const screened = yield* screenMintText(dependencies, types);
            return yield* Effect.try({
              try: () => JSON.parse(screened) as unknown,
              catch: (error) =>
                new MintFailure({
                  failureDetail: failureDetail("mint_host_dependency_failed", {
                    operation: "JSON.parse",
                    phase: "business_input_types",
                    error,
                  }),
                  code: "Unavailable",
                }),
            });
          });
      // The job's own site origin is routing data the agent may see (decided 2026-09-26).
      const site =
        request.siteOrigin === undefined
          ? { available: false as const }
          : {
              available: true as const,
              siteOrigin: request.siteOrigin,
              loginRouting: "kernel_domain_discovery" as const,
              instruction:
                "The host already owns this exact site origin; do not ask the user to repeat it. Never use opaque or withheld text as a URL. Pass loginUrl on authenticate with the sign-in page you observed; the host uses it exactly as given, query and one-time values included. Without it, sign-in starts from the page the browser is on, else Kernel discovery.",
            };
      const serial = yield* Effect.makeSemaphore(1);
      const prompt = initialPrompt;
      const executions: ExecutionEvidence[] = [
        ...new Map(
          [
            ...(recovered?.executions ??
              (dependencies.initialExample ? [dependencies.initialExample] : [])),
            ...(dependencies.priorReadExecutions ?? []),
          ].map((entry) => [entry.executionId, entry]),
        ).values(),
      ];
      const diagnostics: string[] = [...(recovered?.diagnostics ?? [])];
      let unavailableOutputRefusals = recovered?.unavailableOutputRefusals ?? 0;
      const purposes = new Map<string, ExecutionRequest["purpose"] | "command">(
        (
          recovered?.purposes ??
          (dependencies.initialExample
            ? [
                {
                  executionId: dependencies.initialExample.executionId,
                  purpose: "example" as const,
                },
              ]
            : [])
        ).map((entry) => [entry.executionId, entry.purpose]),
      );
      for (const receipt of dependencies.priorReadExecutions ?? [])
        purposes.set(receipt.executionId, "example");
      /** The task revision each execution ran under, when an update had applied before it. */
      const revisions = new Map<string, number>(
        (recovered?.purposes ?? []).flatMap((entry) =>
          entry.taskRevision === undefined ? [] : [[entry.executionId, entry.taskRevision]],
        ),
      );
      let example: ExecutionEvidence | undefined =
        recovered?.exampleId === undefined
          ? executions.findLast((entry) => purposes.get(entry.executionId) === "example")
          : executions.find((entry) => entry.executionId === recovered.exampleId);
      let exampleClaimed =
        (recovered?.exampleClaimed ?? false) || (dependencies.exampleClaimed ?? false);
      // The effective task: the original request with each update the host applied. A takeover
      // restores it from the checkpoint.
      let taskState: TaskState = recovered?.taskState ?? {
        revision: 0,
        effect: request.effect === "write" ? "write" : "read",
        ...(request.siteOrigin === undefined ? {} : { siteOrigin: request.siteOrigin }),
        businessInput: request.businessInput,
        updates: [],
      };
      // The build's effect and read authority. A `mint_update` the caller confirmed may turn a
      // read build into a write build mid-build, which switches both in place.
      let buildEffect = taskState.effect === "write" ? ("write" as const) : request.effect;
      let repeatableRead = buildEffect !== "write" && dependencies.repeatableRead === true;
      /** The caller's answers this build may cite as confirmation, by question id. */
      const answeredQuestions = new Map<string, AnsweredQuestion>(
        (recovered?.answeredQuestions ?? []).map(({ id, answer }) => [id, answer]),
      );
      // A write build's one live session: its first act step takes the example claim and the
      // step that records the site's confirmation closes it. A takeover restores this session;
      // an unrelated attempt with an existing claim keeps it closed.
      let writeSession: "none" | "open" | "closed" =
        recovered?.writeSession ?? (exampleClaimed ? "closed" : "none");
      const availabilityMetadata = () => {
        const executionAvailability = dependencies.executionAvailability?.();
        return executionAvailability === undefined ? {} : { executionAvailability };
      };
      const availabilityInstruction = () => {
        if (executionClosed)
          return "Live execution has ended for this attempt, but its eligible retained receipt can still be published: call finish_build with that receipt's executionId while the source it ran is unchanged; do not execute again. Any source correction, the schemas included, needs a fresh example, which needs live execution, so end with report_blocked reason host_unavailable, never policy. request_input is still available when publication needs something only the user knows. ";
        switch (dependencies.executionAvailability?.()) {
          case "host_unavailable":
            return "The execution host is unavailable. End this attempt; preserve existing receipts and unresolved effects. Source edits or user input cannot restore this host. ";
          case "open":
          case undefined:
            return "Fresh reads require both existing authority and an available host; repeatableRead is not a promise of lifecycle capacity. ";
        }
      };
      // The trusted host notice about its entry page. It lives in the request
      // context, never the agent instructions, and is repeated only when it changes.
      // The host supplies it only for a fresh entry, never for a resumed page.
      let shownEntryState: string | undefined;
      const entryNotice = () => {
        const current = dependencies.entryNavigation?.();
        if (current === undefined) return undefined;
        const notice =
          current.state === "replaced"
            ? {
                state: current.state,
                requestedUrl: current.requestedUrl,
                page: current.page,
                reason: current.reason,
                instruction:
                  current.reason === "recovery"
                    ? current.page === undefined
                      ? "The host replaced the browser in this same attempt after a failure (see that execution's proxyNotice or browserRecovery), on a new, empty profile. Read page.url() before acting and navigate from there."
                      : "The host replaced the browser in this same attempt after a failure (see that execution's proxyNotice or browserRecovery) and, because this is a read, reopened the last page the site served the previous browser; page is where it landed. The new browser has a new, empty profile. Read page.url() and the page before acting and continue from there."
                    : current.page === undefined
                      ? "The host signed in on a new browser from the site's saved profile, in this same attempt. Read page.url() before acting and navigate from there."
                      : "The host signed in on a new browser from the site's saved profile, in this same attempt, and opened it on page: the page you were on, or the login page when that did not load. Read page.url() before acting and continue from there.",
                ...(current.instruction === undefined ? {} : { instruction: current.instruction }),
              }
            : current.state === "opened"
              ? {
                  state: current.state,
                  outcome: current.outcome,
                  requestedUrl: current.requestedUrl,
                  resolvedUrl: current.resolvedUrl,
                  ...(current.status === null ? {} : { status: current.status }),
                  instruction:
                    current.outcome === "ready"
                      ? "The trusted host already loaded this exact requested page before you started; the browser is at resolvedUrl. Do not navigate to the entry URL again or guess a homepage; start from the current page."
                      : (current.instruction ??
                        "The trusted host already loaded the requested page before you started, but the site answered with an HTTP error status. Inspect the current page before assuming its content; do not navigate to the entry URL again."),
                }
              : current.reason === "prior_effect"
                ? {
                    state: current.state,
                    outcome: current.outcome,
                    reason: current.reason,
                    requestedUrl: current.requestedUrl,
                    instruction:
                      "The host did not open the requested page, because an earlier attempt of this build already ran on the website. The browser is not on requestedUrl; read page.url() before acting. Navigate to requestedUrl yourself when the task needs it, after reading back whether a write an earlier attempt may have made already happened.",
                  }
                : {
                    state: current.state,
                    outcome: current.outcome,
                    requestedUrl: current.requestedUrl,
                    instruction:
                      "Host entry navigation did not reach the requested page. Do not assume the browser is on requestedUrl; read page.url() before acting.",
                  };
        // The caller's own page URLs are shown exactly; they are never masked.
        return current.state === "opened" && current.egressProxy !== undefined
          ? {
              ...notice,
              egressProxy: current.egressProxy,
            }
          : notice;
      };
      const changedEntryNotice = (): { readonly hostEntryNavigation?: object } => {
        const current = dependencies.entryNavigation?.();
        const state =
          current === undefined
            ? undefined
            : `${current.state}:${"outcome" in current ? current.outcome : ""}:${"reason" in current ? current.reason : ""}:${"page" in current ? (current.page ?? "") : ""}`;
        if (state === undefined || state === shownEntryState) return {};
        const notice = entryNotice();
        shownEntryState = state;
        return notice === undefined ? {} : { hostEntryNavigation: notice };
      };
      const executionContext = () =>
        Effect.gen(function* () {
          const retainedExecutions = yield* Effect.forEach(executions, (entry) =>
            decode(VisibleReceipt, {
              executionId: entry.executionId,
              status: entry.status,
              effect: entry.effect,
            }).pipe(
              Effect.map((receipt) => ({
                ...receipt,

                purpose: purposes.get(entry.executionId),
                repairPublicationAllowed:
                  dependencies.canPublishRepair?.(entry.executionId) === true,
              })),
            ),
          );
          return {
            repeatableRead,
            ...availabilityMetadata(),
            exampleClaimed,
            ...(writeSession === "none" ? {} : { writeSession }),
            retainedExecutions,
            instruction:
              availabilityInstruction() +
              "These are host-owned execution references, distinct from invocation and attempt IDs. Do not ask the user for internal receipt IDs. Failed receipts do not establish a successful current result. With repeatableRead:true and an available live host, use purpose explore for current read-only observations and purpose example for a fresh reviewed execution of the corrected read under the original input/account after confirmed executor cleanup. Purpose inspect is the separate reconciliation protocol for prior uncertain effects, not the generic browser-probe mode. Otherwise preserve the dispatch fence and reconcile current state; repairPublicationAllowed permits future source review, not replay or a claim that the original action failed.",
          };
        });
      let terminal: MintHarnessSnapshot["terminal"] = recovered?.terminal;
      /**
       * The last sign-in's failure while no later authenticate has started, and whether a final
       * answer already got its guidance back.
       */
      let unresolvedSignIn:
        | {
            readonly failure: SignInDiagnostic;
            readonly spent: SpentSignIn | undefined;
            guided: boolean;
          }
        | undefined;
      /**
       * The host's identical refusals in a row while typing into a sign-in screen: the latest
       * and how many. An authenticate that ends any other way clears it.
       */
      let hostRefusals: { readonly refusal: HostRefusal; readonly count: number } | undefined;
      /** `hostRefusals` before the running authenticate, which a refusal of its own extends. */
      let priorHostRefusals: typeof hostRefusals;
      /**
       * Sign-in is unavailable in this build: the answer that said so, which a later authenticate
       * gets again, and the outcome the build ends with. A retained receipt that may still
       * publish holds the outcome back until the model stops.
       */
      let signInUnavailable: MintHarnessSnapshot["signInUnavailable"] =
        recovered?.signInUnavailable;
      /** The model gave a final answer while sign-in was unavailable, which stops it. */
      let modelStoppedForSignIn = false;
      // A question to the build's owner went unanswered; the build ends as no_response.
      let noResponse = recovered?.noResponse;
      let unavailableCauseRecorded = recovered?.unavailableCauseRecorded ?? false;
      // Resubmissions after a review outage, per kind; recorded for diagnosis only. The host
      // already retried each review with backoff, so only an outage that outlasts
      // `reviewOutageBudgetMs` with no review completing ends the attempt.
      const reviewUnavailableRetries = {
        execution: 0,
        publication: 0,
        question: 0,
        update: 0,
        ...recovered?.reviewUnavailableRetries,
      };
      /** When the current run of review outages began; cleared by any completed review. */
      let reviewOutageStartedAt = recovered?.reviewOutageStartedAt;
      /**
       * Reviews that ended `InvalidOutcome` in this attempt. Guardian already corrected each once
       * in the review, so a second ends the attempt even while other reviews complete.
       */
      let invalidOutcomes = recovered?.invalidOutcomes ?? 0;
      /** The pending review outage is a blocked explanation's, which report_blocked resubmits. */
      let blockedReviewUnavailable = recovered?.blockedReviewUnavailable === true;
      const reviewCompleted = Effect.sync(() => {
        reviewOutageStartedAt = undefined;
        blockedReviewUnavailable = false;
      });
      /** A failure that shows Guardian decided: a deny, or an execution it allowed. */
      const reviewDecided = (error: MintFailure) =>
        error.code === "ReviewDenied" ||
        error.review !== undefined ||
        error.execution !== undefined;
      /**
       * Guardian denied or escalated an execution, or denied a publication for a reason no
       * correction gets past, in this attempt.
       */
      let guardianRefused = recovered?.guardianRefused === true;
      /**
       * Guardian denied a publication in this attempt with feedback the minter can correct
       * (`correctablePublicationReason`): never a refusal a `policy` block stands on.
       */
      let guardianCorrection = recovered?.guardianCorrection === true;
      /** Unanswered questions handed back to the minter in this build, up to the limit. */
      let noAnswerHandBacks = recovered?.noAnswerHandBacks ?? 0;
      /**
       * The host obtained a login partway (`requestLogin` answered `supplied` or `held`): an
       * unanswered question asked after it ends the build instead of going back.
       */
      let loginHeld = recovered?.loginHeld === true;
      let destinationEvidenceRefusals = recovered?.destinationEvidenceRefusals ?? 0;
      let inputFeedbackRounds = recovered?.inputFeedbackRounds ?? 0;
      /** The last input-feedback review found a tool already public, which never falls back. */
      let inputFeedbackPublicTool = recovered?.inputFeedbackPublicTool ?? false;
      /** The screened coverage of the last candidate Guardian returned input feedback for. */
      let inputFeedbackCoverage = recovered?.inputFeedbackCoverage ?? "";
      /** The last completed publication review's input feedback, while no later review replaced it. */
      let inputFeedbackReview = recovered?.inputFeedbackReview;
      /** Guardian's finite reason when the latest publication was a completed denial. */
      let publicationDenial = recovered?.publicationDenial;
      const destinationEvidenceInstruction = {
        no_route_evidence:
          "This example recorded no route of its own, so there is no route evidence to publish with.",
        sign_in_route_evidence:
          "No verified sign-in's routes cover this example: no sign-in ran in this build, the example ran with a different selected login URL than the sign-in used, or the sign-in recorded no routes. Call execute with purpose authenticate to sign in, then run the example again.",
        inconsistent_route_evidence:
          "The recorded route evidence is inconsistent, for example more than 64 routes.",
        receipt_mismatch: "The recorded route evidence belongs to other source than this receipt.",
        unknown: "The recorded route evidence cannot support publication.",
      };
      // Executions the provider failed, for diagnosis; like review outages, only an outage that
      // outlasts its budget with no execution completing closes live execution.
      let providerUnavailableRetries = recovered?.providerUnavailableRetries ?? 0;
      let providerOutageStartedAt = recovered?.providerOutageStartedAt;
      const reviewOutageBudgetMs = dependencies.reviewOutageBudgetMs ?? 15 * 60_000;
      const unavailableHostTerminal = () => {
        const cause = dependencies.unavailableHostCause?.();
        if (!unavailableCauseRecorded) {
          unavailableCauseRecorded = true;
          // The terminal diagnostics always name the host's own first cause, so a stop after the
          // last successful tool call is never recorded without one.
          const stopped = dependencies.hostUnavailableCause?.();
          if (cause !== undefined)
            for (const entry of cause.diagnostics) diagnostics.push(JSON.stringify(entry));
          else
            diagnostics.push(
              JSON.stringify({
                phase: "host",
                hostFailure: "host_unavailable",
                cause: stopped,
              }),
            );
        }
        return {
          build: "incomplete" as const,
          // A policy failure of background traffic is the site's doing, not infrastructure's.
          ...(cause === undefined ? { hostFailure: "host_unavailable" as const } : {}),
          summary:
            cause === undefined
              ? "Execution infrastructure is unavailable. Preserve recorded effects and reconcile possible dispatch before further execution."
              : `Execution infrastructure is unavailable because background browser traffic failed a policy check${cause.reason === undefined ? "" : ` (${cause.reason})`}. Diagnostics list any earlier execution failure first; the later check does not explain that earlier failure. Preserve recorded effects and reconcile possible dispatch before further execution.`,
        };
      };
      /**
       * Publishes the last candidate whose review found only input feedback, privately and
       * flagged, and settles the build. Nothing publishes for a tool that is already public or
       * when that publication fails; the build then ends incomplete, naming which. A host with no
       * fallback ends the build incomplete with the last review's categories and rationale.
       */
      const settleUnresolvedInputFeedback = Effect.gen(function* () {
        const fallback = dependencies.inputFeedbackFallback;
        // With no fallback the build ends unpublished, with the last review's findings.
        if (fallback === undefined) {
          if (inputFeedbackReview !== undefined)
            terminal = {
              build: "incomplete",
              summary: unresolvedInputFeedbackSummary(undefined, inputFeedbackReview),
            };
          return false;
        }
        const outcome = yield* Effect.either(fallback.publish);
        if (outcome._tag === "Left") {
          terminal = { build: "incomplete", summary: unresolvedInputFeedbackSummary(outcome.left) };
          yield* recordDecision({
            outcome: "refused",
            code: outcome.left.code,
            reason: "input_feedback_unresolved",
            failedChecks: refusalChecks(outcome.left),
            recovery: "ended",
          });
          yield* diagnose({
            phase: "publication",
            reason: "input_feedback_unresolved",
            code: outcome.left.code,
            failureReason: outcome.left.reason,
          });
          return false;
        }
        const published = outcome.right;
        if (published === undefined) {
          // A later review dropped the candidate; that review's own outcome stands. A public
          // tool keeps its published revision, flagged for its next maintenance.
          if (inputFeedbackPublicTool) {
            yield* fallback.flagPublished;
            terminal = {
              build: "incomplete",
              summary: unresolvedInputFeedbackSummary("public_tool"),
            };
          }
          return false;
        }
        for (const gap of published.diagnostics) {
          const diagnostic = JSON.stringify(gap);
          if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
        }
        terminal = {
          build: "published",
          publicationRef: published.publicationRef,
          summary: `${inputFeedbackCoverage} Published for this account only and flagged: Guardian's input feedback (${published.categories.join(", ")}) was not resolved.`,
        };
        yield* recordDecision({
          outcome: "published",
          code: "Published",
          failedChecks: [],
          recovery: "none",
        });
        return true;
      });
      // Publication reads workspace files and retained results, never the browser or executor.
      // Once live execution ends, a retained publishable receipt keeps the attempt open for
      // source correction and finish_build instead of ending it.
      let executionClosed = recovered?.executionClosed ?? false;
      // A read repair's example that refused the caller's own value, listing the choices the
      // page offers, shows the tool now behaves correctly; maintenance cannot change the input.
      const refusedWithChoices = (entry: ExecutionEvidence) =>
        request.mode === "maintenance" &&
        buildEffect !== "write" &&
        purposes.get(entry.executionId) === "example" &&
        entry.status === "failed" &&
        (entry.refusal?.available.length ?? 0) > 0;
      const publishableReceipt = () =>
        executions.some(
          (entry) =>
            refusedWithChoices(entry) ||
            ((purposes.get(entry.executionId) === "example" ||
              purposes.get(entry.executionId) === "act") &&
              entry.status === "completed" &&
              entry.resultRef !== undefined) ||
            (purposes.get(entry.executionId) === "act" &&
              (entry.confirmation !== undefined || entry.withheldConfirmation !== undefined)) ||
            dependencies.canPublishRepair?.(entry.executionId) === true,
        );
      const hostIsUnavailable = () => dependencies.executionAvailability?.() === "host_unavailable";
      /** Ends live execution; the attempt itself ends only without a publishable receipt. */
      const closeExecution = () => {
        if (terminal === undefined && publishableReceipt()) executionClosed = true;
        else terminal ??= unavailableHostTerminal();
      };
      const stopUnavailableHost = (afterModel = false) => {
        if (!hostIsUnavailable()) return false;
        if (!afterModel && terminal === undefined && publishableReceipt()) {
          executionClosed = true;
          return false;
        }
        const unavailable = unavailableHostTerminal();
        terminal ??= unavailable;
        return true;
      };
      const stopRevokedAttempt = () => {
        if (!dependencies.attemptRevoked?.()) return false;
        if (terminal === undefined) {
          terminal = {
            build: "incomplete",
            summary:
              "This attempt stopped or lost its lease. Earlier execution receipts and unresolved effects remain retained; no further model or tool work is allowed.",
          };
          diagnostics.push(JSON.stringify({ phase: "attempt", reason: "stopped" }));
        }
        return true;
      };
      const active = (use: "execution" | "publication" = "execution") =>
        Effect.suspend(() =>
          terminal
            ? Effect.fail(new MintFailure({ code: "AlreadyExecuted" }))
            : stopUnavailableHost()
              ? Effect.fail(new MintFailure({ code: "Unavailable" }))
              : stopRevokedAttempt()
                ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
                : use === "execution" && executionClosed
                  ? Effect.fail(
                      new MintFailure({ code: "Unavailable", reason: "executor_unavailable" }),
                    )
                  : Effect.void,
        );
      const screenRationale = (rationale: string) =>
        screenMintText(dependencies, rationale).pipe(
          Effect.catchAll((error) =>
            Effect.succeed(
              `Guardian feedback delivery failed during credential screening (${error.code}); consult the protected review trace.`,
            ),
          ),
        );
      /**
       * A review as the minter reads it: the rationale and each finding's explanation screened
       * like any Guardian text, and each finding's file as the minter's workspace names it.
       */
      const minterFindings = (findings: readonly PublicationFinding[]) =>
        Effect.forEach(findings, (finding) =>
          screenRationale(finding.explanation).pipe(
            Effect.map((explanation) => ({
              ...finding,
              file: workspacePath(finding.path),
              explanation,
            })),
          ),
        );
      const minterReview = <
        Review extends {
          readonly rationale: string;
          readonly findings?: readonly PublicationFinding[] | undefined;
        },
      >(
        review: Review,
      ) =>
        Effect.gen(function* () {
          const rationale = yield* screenRationale(review.rationale);
          return review.findings === undefined
            ? { ...review, rationale }
            : { ...review, rationale, findings: yield* minterFindings(review.findings) };
        });
      const screenAssumptions = (proposedAssumptions: PublicationRequest["assumptions"] = []) =>
        Effect.gen(function* () {
          // An assumption that screening would change may carry private data: drop it.
          const assumptions: BuildAssumption[] = [];
          for (const entry of proposedAssumptions ?? []) {
            const subject = yield* screenMintText(dependencies, entry.subject);
            const choice = yield* screenMintText(dependencies, entry.choice);
            if (subject === entry.subject && choice === entry.choice)
              assumptions.push({ kind: "site_default", subject, choice });
          }
          return assumptions;
        });
      const publicationResult = (
        published: MintCompletion,
        coverage: string,
        assumptions: readonly BuildAssumption[] = [],
      ) =>
        Effect.gen(function* () {
          terminal = {
            build: "published",
            ...(published.publicationRef === undefined
              ? {}
              : { publicationRef: published.publicationRef }),
            ...("artifact" in published ? { artifact: published.artifact } : {}),
            summary: coverage,
            ...(assumptions.length === 0 ? {} : { assumptions }),
          };
          return JSON.stringify({
            status: "published",
            ...(published.review === undefined
              ? {}
              : {
                  review: {
                    ...published.review,
                    rationale: yield* screenRationale(published.review.rationale),
                  },
                }),
            ...(published.shareability === undefined
              ? {}
              : {
                  shareability: {
                    ...published.shareability,
                    rationale: yield* screenRationale(published.shareability.rationale),
                  },
                }),
            instruction:
              "Build published for future calls. The current invocation outcome is returned separately; do not execute the example again.",
          });
        });
      /**
       * Records the answer to the host's own question of a question-only turn. Returns the agent's
       * instruction instead when the owner answered the effect question in their own words, which
       * decides nothing.
       */
      const recordInputAnswer = (submitted: AgentInputRequest, answers: ValidAnswers) =>
        Effect.gen(function* () {
          const value = answers[submitted.questions[0]?.id ?? ""]?.value;
          let summary: string;
          if (effectQuestion) {
            const effect = readOrWritePick(submitted, answers);
            if (effect === undefined && value !== undefined)
              return "The owner answered in their own words instead of choosing read or write, so the build's effect is not decided. Ask the read-or-write question again with request_input, its prompt reflecting what they said.";
            if (effect !== "read" && effect !== "write")
              return yield* new MintFailure({ code: "InvalidRequest" });
            if (!dependencies.recordBuildEffect)
              return yield* new MintFailure({ code: "Unavailable" });
            yield* dependencies.recordBuildEffect(effect);
            summary = `The owner chose a ${effect} build.`;
          } else if (dependencies.capabilityQuestion !== undefined) {
            const answer = value;
            if (typeof answer !== "string" || !dependencies.capabilityAnswered)
              return yield* new MintFailure({ code: "Unavailable" });
            yield* dependencies.capabilityAnswered(answer);
            summary = "The owner answered the capability question.";
          } else return undefined;
          terminal ??= { build: "incomplete", summary };
          return undefined;
        });
      /**
       * Keeps each answered question as Guardian reads it, by id, so a later `mint_update` can cite
       * the caller's real answer as confirmation. A protected answer is never kept.
       */
      const keepAnswers = (submitted: AgentInputRequest, answers: ValidAnswers) =>
        Effect.forEach(submitted.questions, (question) =>
          answersForReview({ questions: [question] }, answers, (text) =>
            screenMintText(dependencies, text),
          ).pipe(
            Effect.tap(([entry]) =>
              Effect.sync(() => {
                if (entry === undefined) return;
                answeredQuestions.delete(question.id);
                answeredQuestions.set(question.id, entry);
              }),
            ),
          ),
        );
      const inputResult = (submitted: AgentInputRequest, answers: ValidAnswers) =>
        Effect.gen(function* () {
          const askAgain = yield* recordInputAnswer(submitted, answers);
          yield* keepAnswers(submitted, answers);
          const visibleAnswers = yield* answersForModel(answers);
          acceptedAnswers.push({
            questions: submitted.questions.map((question) => question.prompt),
            answers: visibleAnswers,
          });
          yield* reviewer.taskUpdated("The caller answered a question.");
          const handles = Object.values(answers).some((answer) => answer.type === "secret");
          if (askAgain !== undefined)
            return JSON.stringify({
              status: "answered",
              answers: visibleAnswers,
              instruction: askAgain,
            });
          return JSON.stringify({
            status: "answered",
            answers: visibleAnswers,
            instruction: `The caller answered. Continue in this attempt with these answers; verify the current page before acting on them, and before any further write.${handles ? " A secret answer is a handle such as {{secret.s1}}, never the value, which you never see. Write the handle exactly as given, as the whole string literal passed as the value to fill, type or pressSequentially, or as a field of a request to this site, in the Playwright code of a kernel.browsers.playwright.execute call in explore, test or act source; the host fills in the value when it runs that source live, and masks it in what comes back. It refuses a handle anywhere else, such as in a variable, a concatenation, a transform, a return value or a navigation. Offline targets get the handle text unchanged. An example and published source never hold a handle: a value the finished tool needs at run time is a declared secret question it asks with ask." : ""}`,
          });
        });
      /** `handedBack`: the execution's unanswered script question went back to the minter. */
      const visible = (evidence: ExecutionEvidence, handedBack = false) =>
        Effect.gen(function* () {
          const siteAccess = siteAccessDiagnostic(evidence);
          const withheld = safeExecutionEvidence(evidence).withheldConfirmation;
          const receipt = yield* decode(VisibleReceipt, {
            executionId: evidence.executionId,
            status: evidence.status,
            effect: evidence.effect,
            ...(evidence.authentication ? { authentication: evidence.authentication } : {}),
            ...(evidence.confirmation === undefined ? {} : { confirmation: evidence.confirmation }),
            ...(withheld === undefined ? {} : { withheldConfirmation: withheld }),
            ...(evidence.preflight === undefined ? {} : { preflight: evidence.preflight }),
            ...(evidence.checks === undefined ? {} : { checks: evidence.checks }),
          });
          // Receipt identifiers are host control metadata, never generated observations.
          // Screening the whole envelope can corrupt IDs and make completion impossible.
          const parsed = yield* Effect.try((): unknown =>
            typeof evidence.observations === "string"
              ? JSON.parse(evidence.observations)
              : evidence.observations,
          ).pipe(Effect.option);
          const observations =
            parsed._tag === "Some"
              ? yield* dependencies.projection.json(parsed.value).pipe(
                  Effect.map((value) => JSON.stringify(value)),
                  Effect.mapError(
                    (error) =>
                      new MintFailure({
                        failureDetail: failureDetail("mint_host_dependency_failed", {
                          operation: "screenJsonObservation",
                          error: error,
                          context: {
                            executionId: evidence.executionId,
                            executionStatus: evidence.status,
                          },
                        }),
                        code: "Unavailable",
                      }),
                  ),
                )
              : yield* screenMintText(dependencies, evidence.observations);
          // A script question left unanswered goes back to the agent, which decides how to go on.
          const scriptQuestion =
            evidence.scriptQuestion === undefined && handedBack
              ? { outcome: "unanswered" as const }
              : evidence.scriptQuestion;
          return JSON.stringify({
            ...receipt,
            ...(withheld === undefined ? {} : { instruction: withheldConfirmationInstruction }),
            ...(evidence.review === undefined
              ? {}
              : {
                  review: {
                    ...evidence.review,
                    rationale: yield* screenRationale(evidence.review.rationale),
                  },
                }),
            siteAccess,
            ...(scriptQuestion === undefined
              ? {}
              : {
                  scriptQuestion: {
                    ...scriptQuestion,
                    ...("rationale" in scriptQuestion
                      ? { rationale: yield* screenRationale(scriptQuestion.rationale) }
                      : {}),
                    instruction: scriptQuestionInstruction[scriptQuestion.outcome],
                  },
                }),
            repeatableRead,
            ...availabilityMetadata(),
            ...changedEntryNotice(),
            observations,
          });
        });
      const record = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
      ) => {
        const safe = safeExecutionEvidence(evidence);
        const referenceOnly = {
          ...safe,
          observations:
            "Private observations are available through the screened execution response.",
        };
        executions.push(referenceOnly);
        purposes.set(evidence.executionId, purpose);
        if (taskState.revision > 0) revisions.set(evidence.executionId, taskState.revision);
        if (purpose === "example") example = referenceOnly;
        // The step that recorded the site's confirmation is the build's own write result.
        if (purpose === "act" && safe.confirmation !== undefined) {
          example = referenceOnly;
          writeSession = "closed";
        }
        if (safe.siteAccess !== undefined)
          diagnostics.push(JSON.stringify({ phase: "site_access", ...safe.siteAccess }));
      };
      const executionResult = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
      ) =>
        Effect.gen(function* () {
          record(evidence, purpose);
          const handedBack = evidence.noResponse !== undefined && handsBackNoAnswer();
          if (handedBack) yield* questionHandedBack;
          const receipt = yield* visible(evidence, handedBack);
          if (evidence.terminalFailure === "ChallengeFailure" && !stopUnavailableHost())
            terminal ??= {
              build: "incomplete",
              summary:
                "The live operation reported a challenge failure. No build was published. Recorded effects and receipts are preserved.",
            };
          // The owner never answered the example's question. The minter decides how to go on,
          // with the execution's `scriptQuestion` saying so, unless the question could gate a
          // write repair's write, the build is signed in or holds a login, or it already handed
          // back its limit: then the build ends as no_response.
          if (evidence.noResponse !== undefined && !handedBack && !stopUnavailableHost()) {
            noResponse ??= evidence.noResponse;
            terminal ??= {
              build: "incomplete",
              summary:
                "The build's example asked a question that was not answered in time, so the build stopped. No build was published. Recorded effects and receipts are preserved.",
            };
          }
          return receipt;
        });
      /** Restore the host's durable claim before exposing an adopted execution receipt. */
      const recoveredExecutionResult = (
        evidence: ExecutionEvidence,
        purpose: ExecutionRequest["purpose"] | "command",
        entrypoint: string | undefined,
      ) =>
        Effect.gen(function* () {
          if (
            (purpose === "example" || purpose === "act") &&
            evidence.preflight !== "rejected_before_claim"
          ) {
            exampleClaimed = true;
            if (purpose === "act" && writeSession === "none") writeSession = "open";
          }
          // A write that ran before a takeover, which the restored reviewer does not yet track.
          // The recovered call's arguments name its entrypoint, so its repeat is refused too.
          if (
            evidence.review?.action === "write" &&
            !reviewer.tracked().some((write) => write.executionId === evidence.executionId)
          )
            yield* reviewer.write(
              yield* trackedWrite(
                evidence.executionId,
                evidence.review.reviewId,
                purpose,
                entrypoint,
                evidence.status,
                evidence,
              ),
            );
          return yield* executionResult(evidence, purpose);
        });
      /** A diagnostic copy that could not be written, kept as a gap in the outcome. */
      const recordDiagnosticGap = (event: string) => (error: MintFailure) =>
        Effect.gen(function* () {
          diagnostics.push(
            JSON.stringify({
              phase: "diagnostics",
              reason: "diagnostic_gap",
              event,
              code: error.code,
              diagnosticRetentionReason: error.diagnosticRetentionReason,
              diagnosticStorageFailure: error.diagnosticStorageFailure,
            }),
          );
          yield* reportFailure(error, {
            component: "mint",
            operation: "diagnostics.emit",
            phase: event,
            subCause: "mint_host_dependency_failed",
            correlation: dependencies.reportCorrelation ?? "process",
          });
        });
      // Screening serializes through JSON, which leaves out undefined fields.
      const diagnose = (value: unknown) =>
        screenMintText(dependencies, value).pipe(
          Effect.tap((safe) =>
            Effect.sync(() => {
              diagnostics.push(safe);
            }),
          ),
          Effect.ignore,
        );
      /** A host evidence call whose defect, such as a thrown error, is a failure like any other. */
      const hostEvidence = <A>(evidence: Effect.Effect<A, MintFailure>) =>
        evidence.pipe(
          Effect.catchAllDefect((error) =>
            Effect.fail(
              new MintFailure({
                code: "Unavailable",
                failureDetail: failureDetail("mint_host_dependency_failed", {
                  operation: "publicationDecisions",
                  error,
                }),
              }),
            ),
          ),
        );
      /**
       * The build's latest publication refusals the host holds, as a question or blocked-explanation
       * review's option, so Guardian reads what the host refused. A list the host could not read is
       * a recorded gap, and the review goes on without it.
       */
      const publicationRefusals = hostEvidence(
        Effect.suspend(() => dependencies.publicationDecisions?.list ?? Effect.succeed([])),
      ).pipe(
        Effect.map((decisions) =>
          decisions
            .filter(({ outcome }) => outcome === "refused")
            .slice(-reviewedPublicationRefusals),
        ),
        Effect.catchAll((error) =>
          recordDiagnosticGap("publication_decisions")(error).pipe(
            Effect.as<readonly PublicationDecision[]>([]),
          ),
        ),
        Effect.map((refusals) => (refusals.length === 0 ? {} : { publicationDecisions: refusals })),
      );
      /**
       * Keeps one publication decision through the host's hook. A decision that ended the build
       * leaves nothing to recover. Evidence the host could not keep, a thrown error included, is a
       * recorded gap.
       */
      const recordDecision = (pending: Omit<PublicationDecision, "decisionId" | "decidedAt">) =>
        Effect.gen(function* () {
          const decision: PublicationDecision = {
            ...pending,
            decisionId: randomUUID(),
            decidedAt: yield* Clock.currentTimeMillis,
            ...(pending.outcome === "refused" && terminal !== undefined
              ? { recovery: "ended" as const }
              : {}),
          };
          const log = dependencies.publicationDecisions;
          if (log !== undefined)
            yield* hostEvidence(Effect.suspend(() => log.record(decision))).pipe(
              Effect.catchAll(recordDiagnosticGap("publication_decision")),
            );
          return decision;
        });
      /** The decision the running `finish_build` made, recorded once it answers. */
      let pendingDecision: Omit<PublicationDecision, "decisionId" | "decidedAt"> | undefined;
      const takePendingDecision = () => {
        const pending = pendingDecision;
        pendingDecision = undefined;
        return pending;
      };
      /**
       * Records the publication decision `finish_build` made as host evidence, and names it in the
       * answer so the minter can cite it. Evidence the host could not keep is a recorded gap.
       */
      const recordPublicationDecision = <R>(answer: Effect.Effect<string, MintFailure, R>) =>
        Effect.gen(function* () {
          takePendingDecision();
          const settled = yield* Effect.either(answer);
          const pending = takePendingDecision();
          if (pending === undefined) return yield* settled;
          const decision = yield* recordDecision(pending);
          if (settled._tag === "Left") return yield* settled;
          const parsed = decodeJsonObject(settled.right);
          return parsed._tag === "Left"
            ? settled.right
            : JSON.stringify({ ...parsed.right, decisionId: decision.decisionId });
        });
      const diagnoseExecution = (
        submitted: Parameters<typeof dependencies.reviewAndExecute>[0],
        details: Readonly<Record<string, unknown>>,
        /** Archive-only detail; never copied into the harness's own diagnostics. */
        failure?: unknown,
      ) => {
        const policy = policyFailureMetadata(details);
        const authority = authorityCheckMetadata(details);
        const privateCandidate = destinationPrivateCandidateMetadata(details);
        const code = details.code;
        const retained =
          (policy !== undefined || authority !== undefined || privateCandidate !== undefined) &&
          (code === "ScopeDenied" || code === "Unavailable")
            ? (dependencies.diagnostics
                ?.emit("mint.policy_failed", {
                  code,
                  ...policy,
                  ...authority,
                  ...privateCandidate,
                  ...failureDetailMetadata(failure),
                })
                .pipe(Effect.ignore) ?? Effect.void)
            : failureDetailMetadata(failure) !== undefined
              ? // Every other execution failure with detail is retained for diagnosis.
                (dependencies.diagnostics
                  ?.emit("mint.execution_failed", {
                    code,
                    ...(typeof details.rootCode === "string" ? { rootCode: details.rootCode } : {}),
                    ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
                    ...failureDetailMetadata(failure),
                  })
                  .pipe(Effect.ignore) ?? Effect.void)
              : Effect.void;
        return diagnose({
          phase: "execution",
          purpose: submitted.purpose,
          target: submitted.target,
          ...(submitted.purpose === "command"
            ? {}
            : {
                fixtureCount: submitted.fixtureRefs.length,
                filterCount: submitted.caseFilter.length,
                maxWorkers: submitted.maxWorkers,
              }),
          ...details,
        }).pipe(Effect.zipRight(retained));
      };
      /**
       * Whether the unanswered build may have committed: yes unless it never dispatched or the
       * site rejected it, so any write example or residual not proven `not_sent` counts.
       */
      const possibleCommit = () =>
        buildEffect === "write" &&
        executions.some((entry) => {
          const purpose = purposes.get(entry.executionId);
          return (
            (purpose === "example" || purpose === "residual") &&
            entry.effect !== "not_sent" &&
            // A read example from before the build became a write committed nothing.
            (revisions.get(entry.executionId) ?? 0) >= latestRevisionChanging("effect")
          );
        });
      /** The revision of the latest accepted update that changed `setting`; 0 for none. */
      const latestRevisionChanging = (setting: TaskChange["setting"]) =>
        Math.max(
          0,
          ...taskState.updates
            .filter((update) => update.changes.some((change) => change.setting === setting))
            .map((update) => update.revision),
        );
      /**
       * Why the host refuses a task update before review, as its reason and the agent's next step,
       * or undefined. A recommended new build is never refused here: it changes nothing.
       */
      const taskUpdateRefusal = (
        submitted: TaskUpdateRequest,
      ): { readonly reason: string; readonly instruction: string } | undefined => {
        const settings = new Set(submitted.changes.map((change) => change.setting));
        // A repair keeps the published tool's task. Only a change to its contract may apply: a
        // requirement, the purpose or an output field.
        if (
          request.mode === "maintenance" &&
          (submitted.recommend === "new_mint" ||
            [...settings].some(
              (setting) =>
                setting !== "requirement" && setting !== "purpose" && setting !== "output",
            ))
        )
          return {
            reason: "maintenance_setting",
            instruction:
              "Maintenance repairs the published tool under its own task. Only a change to its contract may apply, as a requirement, purpose or output change; its input, effect, site and login stay, and it never becomes a new build. Repair it as it is, or end the attempt and say in the summary what the caller now wants.",
          };
        if (request.mode !== "maintenance" && settings.has("output"))
          return {
            reason: "output_outside_maintenance",
            instruction:
              "An output change alters a published tool's registered contract, so only maintenance makes one. This build sets its own output schema: change it in the source.",
          };
        // Removing a field callers receive has the higher bar: a stated reason Guardian judges.
        const unexplained = submitted.changes.find(
          (change) =>
            change.setting === "output" && change.change === "remove" && change.reason === undefined,
        );
        if (unexplained !== undefined && unexplained.setting === "output")
          return {
            reason: "output_removal_reason",
            instruction: `Removing ${unexplained.field} takes away a value the tool's callers receive, so it needs a reason, and nothing changed. If the site still shows the value, keep the field and fix the extraction instead. Otherwise add reason to that change: why the field must go, from what the site shows now and where you looked, which Guardian checks against the captures. Then call mint_update again.`,
          };
        if (submitted.recommend === "new_mint") return undefined;
        if (settings.has("effect")) {
          if (buildEffect === "write")
            return {
              reason: "already_write",
              instruction:
                "This build is already a write build. Perform the task through purpose act steps, as .agents/writes/SKILL.md describes.",
            };
          if (taskState.siteOrigin === undefined)
            return {
              reason: "offline_build",
              instruction: "An offline build has no website to change. Finish it as a read.",
            };
        }
        if (settings.has("site")) {
          if (taskState.siteOrigin === undefined)
            return {
              reason: "offline_build",
              instruction: "An offline build has no website to move. Finish it offline.",
            };
          if (writeSession === "open")
            return {
              reason: "write_session_open",
              instruction:
                "This build's write session is open, and its write may have committed on the current site. Finish or read back that write first; the site cannot change under it.",
            };
          // Publication needs an example from the new site, so the build must still be able to
          // run one there.
          if (executionClosed || (exampleClaimed && !repeatableRead))
            return {
              reason: "no_live_example_left",
              instruction:
                "This build can no longer run a live example, so nothing it publishes could be proven on another site. Finish under the current site, or call mint_update with recommend new_mint and a suggestedRequest for a build on the other site.",
            };
        }
        const input = taskState.businessInput;
        if (
          settings.has("input") &&
          (typeof input !== "object" || input === null || Array.isArray(input))
        )
          return {
            reason: "input_not_an_object",
            instruction:
              "This build's input is not an object of named values, so an input change cannot name what it sets. Change a requirement or the purpose instead.",
          };
        return undefined;
      };
      /**
       * Why a request is refused before anyone reviews it, if it is: the effect question is one
       * read-or-write choice, and the capability question is the host's own text question.
       */
      const requestShapeRefusal = (
        submitted: AgentInputRequest,
      ): { readonly reason: string; readonly instruction: string } | undefined => {
        const [only] = submitted.questions;
        const readOrWrite = isReadOrWriteChoice(submitted);
        if (effectQuestion && !readOrWrite)
          return {
            reason: "effect_question_shape",
            instruction:
              "Ask exactly one choice question whose options have the ids read and write, with no other option and no notice.",
          };
        if (
          !effectQuestion &&
          dependencies.capabilityQuestion !== undefined &&
          (submitted.questions.length !== 1 ||
            only?.type !== "text" ||
            only.prompt !== dependencies.capabilityQuestion)
        )
          return {
            reason: "capability_question_shape",
            instruction:
              "Ask exactly the host's capability question as one text question with that prompt.",
          };
        return undefined;
      };
      /**
       * Whether the build is signed in or holds a login now: one bound from the start, one the
       * host obtained in place, or one a sign-in in this build sent.
       */
      const signedInOrHoldsLogin = () =>
        dependencies.websiteCredentialsAvailable === true ||
        loginHeld ||
        executions.some(
          (entry) =>
            entry.authentication !== undefined ||
            (purposes.get(entry.executionId) === "authenticate" && entry.effect !== "not_sent"),
        );
      /**
       * Whether an unanswered question goes back to the minter as no answer, which then decides
       * how the build goes on, decided for each question when it goes unanswered. Not when the
       * question decides what the build may do: the read-or-write and capability questions, any
       * question in a write repair, which could gate its write, and any asked while the build is
       * signed in or holds a login, which acts as the account's owner. Nor once the build handed
       * back `noAnswerHandBackLimit` questions.
       */
      const handsBackNoAnswer = () =>
        request.effect !== "ask" &&
        dependencies.capabilityQuestion === undefined &&
        !(request.mode === "maintenance" && buildEffect === "write") &&
        !signedInOrHoldsLogin() &&
        noAnswerHandBacks < noAnswerHandBackLimit;
      /** Counts a question handed back and records it. */
      const questionHandedBack = Effect.sync(() => {
        noAnswerHandBacks += 1;
      }).pipe(
        Effect.zipRight(
          reportBestEffort(
            dependencies.diagnostics?.emit("mint.question_handed_back", {}) ?? Effect.void,
            {
              component: "mint",
              operation: "diagnostics.emit",
              phase: "mint.question_handed_back",
              correlation: dependencies.reportCorrelation ?? "process",
            },
          ),
        ),
      );
      /**
       * The minter's question went unanswered and the build goes on. It stays unanswered: no
       * `mint_update` can cite it, and no review reads an answer from it.
       */
      const noAnswer = () =>
        questionHandedBack.pipe(
          Effect.as(
            JSON.stringify({
              status: "no_answer",
              userInputRequired: false,
              instruction: noAnswerInstruction,
            }),
          ),
        );
      /** The build's owner left a question that decides what it may do unanswered: it ends. */
      const unanswered = (error: MintFailure, step: string) =>
        Effect.sync(() => {
          noResponse ??= {
            possibleCommit: error.noResponse?.possibleCommit === true || possibleCommit(),
          };
          terminal ??= {
            build: "incomplete",
            summary: `A question to the build's owner while ${step} was not answered in time, so the build stopped. No build was published. Recorded effects and receipts are preserved.`,
          };
          return JSON.stringify({
            status: "no_response",
            instruction: "The build's owner did not answer in time. The host is ending this build.",
          });
        });
      const reviewFeedback = (error: MintFailure) =>
        Effect.gen(function* () {
          guardianRefused = true;
          const rationale = error.review
            ? yield* screenMintText(dependencies, error.review.rationale)
            : "Guardian rejected this submission; rationale unavailable.";
          return JSON.stringify({
            status: "review_rejected",
            code: "ReviewDenied",
            exampleClaimed,
            repeatableRead,
            ...availabilityMetadata(),
            ...(error.review
              ? { outcome: error.review.outcome, reviewId: error.review.reviewId }
              : {}),
            rationale,
            notice:
              availabilityInstruction() +
              (repeatableRead
                ? "This invocation permits fresh reviewed reads only while live execution remains available and after confirmed executor cleanup; preserve earlier receipts. "
                : exampleClaimed
                  ? "The example is already claimed; never repeat it. "
                  : "This example has not been claimed. Correct undispatched source and submit it for fresh review. ") +
              "Correct the submitted source or collect missing evidence through an authorized safe observation, then submit for fresh review. Request user input only for missing authority or information the user must supply. This feedback grants no new authority. Preserve prior effects; do not repeat a claimed example or uncertain write/login.",
          });
        }).pipe(
          Effect.catchAll(() =>
            Effect.succeed(
              JSON.stringify({
                status: "review_rejected",
                code: "ReviewDenied",
                exampleClaimed,
                ...availabilityMetadata(),
                rationale: "Review feedback unavailable.",
                notice:
                  availabilityInstruction() +
                  "Preserve prior effects; do not repeat a claimed example.",
              }),
            ),
          ),
        );
      /** Whether reviews have been unavailable for the whole outage budget, which ends the attempt. */
      const reviewRetryExhausted = () =>
        Effect.map(Clock.currentTimeMillis, (now) => {
          reviewOutageStartedAt ??= now;
          return now - reviewOutageStartedAt >= reviewOutageBudgetMs;
        });
      /**
       * Counts a review that ended `InvalidOutcome`: Guardian, already corrected once in the
       * review, returned no outcome its kind allows. A verdict that did not form, not an outage:
       * it neither starts the outage budget nor counts as an outage retry. True for the second in
       * the attempt, which ends it.
       */
      const invalidOutcomeRepeated = () => {
        invalidOutcomes += 1;
        return invalidOutcomes > 1;
      };
      /** What the agent may change instead of resubmitting a review Guardian could not decide. */
      const invalidOutcomeSubject = {
        execution: "the execution's source",
        publication: "the build before calling finish_build again",
        question: "the request",
        update: "the update",
      };
      /** An `InvalidOutcome` answer that ends the attempt; its terminal outcome is already set. */
      const invalidOutcomeEnded = (instruction: string) =>
        JSON.stringify({
          status: "review_invalid_outcome",
          reviewFailure: "InvalidOutcome",
          retryable: false,
          userInputRequired: false,
          ...availabilityMetadata(),
          instruction,
        });
      /**
       * The agent's answer for a review that ended `InvalidOutcome`. A host that became
       * unavailable during the review ends the attempt with its own cause. Otherwise the first goes
       * back to the agent to revise or withdraw, never to resubmit unchanged, so it is not
       * `retryable`; once live execution has closed, an execution goes on through its retained
       * receipt instead. The second ends the attempt incomplete without a host failure, since no
       * outage caused it and running the attempt again would repeat it.
       */
      const invalidOutcomeAnswer = (kind: keyof typeof invalidOutcomeSubject) =>
        Effect.sync(() => {
          if (stopUnavailableHost())
            return invalidOutcomeEnded(
              "Guardian returned no decision its review allows, so nothing was approved, and the host became unavailable, so the attempt has ended. Preserve recorded effects and receipts.",
            );
          if (invalidOutcomeRepeated()) {
            terminal ??= {
              build: "incomplete",
              summary:
                "Guardian returned no decision its review allows, again, so the host ended the attempt without publishing. Nothing it was reviewing was approved; recorded effects and receipts are preserved.",
            };
            return invalidOutcomeEnded(
              "Guardian again returned no decision its review allows, so the attempt has ended and nothing was approved. Preserve recorded effects and receipts.",
            );
          }
          const next =
            kind === "execution" && executionClosed
              ? "Live execution has ended, so this execution cannot be resubmitted or revised; publish an eligible retained receipt with finish_build, or ask with request_input when publication needs something only the user knows."
              : `Revise ${invalidOutcomeSubject[kind]} so what is under review is plain, or withdraw it and continue another way; do not submit it again unchanged.`;
          return JSON.stringify({
            status: "review_invalid_outcome",
            reviewFailure: "InvalidOutcome",
            userInputRequired: false,
            ...availabilityMetadata(),
            instruction: `Guardian returned no decision this review allows, even after the host named the outcomes it may return, so nothing was approved. This is not a deny and not an outage. ${next} A second such result ends the attempt.`,
          });
        });
      /**
       * A spent model quota is a host failure no retry gets past, whether the minter's call or
       * Guardian's hit it, since both use the same provider account.
       * Operators see it like any other host failure, with the provider's error beneath the
       * finite code.
       */
      const endForSpentModelQuota = (failure: MintFailure, phase: "model" | "review") =>
        Effect.gen(function* () {
          // Another outcome already ended the attempt; it stands, and nothing claims otherwise.
          if (terminal !== undefined) return terminal.hostFailure === "model_quota_exhausted";
          terminal = {
            build: "incomplete",
            hostFailure: "model_quota_exhausted",
            summary:
              "The model provider refused this attempt's calls because the account's model quota is spent, so the host ended the attempt without publishing. Retrying cannot help until the quota is restored. Recorded effects and receipts are preserved.",
          };
          yield* diagnose({
            phase,
            hostFailure: "model_quota_exhausted",
            code: failure.code,
            rootCause: failureRootCause(failure),
          });
          yield* reportFailure(failure, {
            component: "mint",
            operation: phase === "model" ? "model.run" : "guardian.review",
            phase,
            subCause: "model_quota_exhausted",
            correlation: dependencies.reportCorrelation ?? "process",
            ...(dependencies.diagnostics === undefined ? {} : { sink: dependencies.diagnostics }),
          });
          return true;
        });
      /** Guardian's review found the quota spent; the reply names only the outcome that stands. */
      const spentQuotaReview = (error: MintFailure) =>
        endForSpentModelQuota(error, "review").pipe(
          Effect.map((ended) =>
            JSON.stringify({
              status: "review_unavailable",
              code: error.code,
              reviewFailure: error.reviewFailure,
              ...(ended ? { hostFailure: "model_quota_exhausted" } : {}),
              retryable: false,
              userInputRequired: false,
              instruction: ended
                ? "Guardian could not review because the model provider's quota is spent; nothing was approved and waiting does not restore it. End this attempt; preserve recorded effects and receipts."
                : "Guardian could not review, and nothing was approved; this attempt has already ended with its recorded outcome. Preserve recorded effects and receipts.",
            }),
          ),
        );
      /**
       * A review Guardian could not complete, as the agent reads it. `next` is how the attempt goes
       * on, with the live execution it still has; without it the attempt ends. `retention` adds why
       * the review's evidence could not be kept.
       */
      const reviewUnavailableAnswer = (
        error: MintFailure,
        notice: string,
        {
          retention = true,
          next,
        }: {
          readonly retention?: boolean;
          readonly next?: { readonly retryable: boolean; readonly retriesRemaining?: number };
        } = {},
      ) =>
        // JSON.stringify leaves out each field that is undefined.
        JSON.stringify({
          status: "review_unavailable",
          code: "ReviewUnavailable",
          reviewFailure: error.reviewFailure,
          reviewPhase: error.reviewPhase,
          reviewDispatch: error.reviewDispatch,
          ...(retention
            ? {
                ...(error.diagnosticRetentionReason === undefined
                  ? {}
                  : { diagnosticRetentionReason: diagnosticRetentionReason(error) }),
                diagnosticScreeningReason: diagnosticScreeningReason(error),
                diagnosticStorageFailure: diagnosticStorageFailure(error),
              }
            : {}),
          ...next,
          userInputRequired: false,
          ...(next === undefined ? {} : availabilityMetadata()),
          notice: next === undefined ? notice : availabilityInstruction() + notice,
        });
      /**
       * A review that Guardian could not complete is not a deny. The host already retried it with
       * backoff; the agent may resubmit while reviews have been unavailable for less than the
       * outage budget, and any completed review starts the budget again. A review whose evidence
       * could not be retained is such an outage too. Past the budget, `exhausted` ends the attempt.
       */
      const reviewUnavailableRetry =
        (
          kind: keyof typeof reviewUnavailableRetries,
          exhausted: (error: MintFailure) => Effect.Effect<string>,
        ) =>
        (error: MintFailure) =>
          Effect.gen(function* () {
            if (error.reviewFailure === "InvalidOutcome") return yield* invalidOutcomeAnswer(kind);
            // This outage is another review's, which is resubmitted before report_blocked.
            blockedReviewUnavailable = false;
            if (error.modelOutage === "quota_exhausted") return yield* spentQuotaReview(error);
            const retentionFailure = error.reviewPhase === "diagnostic_retention";
            if (stopUnavailableHost() || (yield* reviewRetryExhausted()))
              return yield* exhausted(error);
            // Live execution ended during this review: the execution cannot be resubmitted, but the
            // retained receipt can still be published and a question still asked.
            if (kind === "execution" && executionClosed)
              return reviewUnavailableAnswer(
                error,
                "Guardian review did not complete and nothing was approved; this execution cannot be resubmitted.",
                { retention: false, next: { retryable: false } },
              );
            reviewUnavailableRetries[kind] += 1;
            return reviewUnavailableAnswer(
              error,
              "Guardian review did not complete. This is not a deny or escalation, and nothing was approved. " +
                reviewRetryInstruction[kind] +
                (retentionFailure
                  ? " The host could not keep this review's evidence and recorded the gap."
                  : " The host already retried this review with backoff before answering.") +
                " Resubmitting is safe; if Guardian stays unavailable long enough, the host ends the attempt. Do not change site code to work around review infrastructure.",
              { next: { retryable: true } },
            );
          });
      const reviewRetryInstruction = {
        execution:
          "You may resubmit the same execution for a fresh review. reviewDispatch not_sent means this submission did not run; without it, treat the submission as possibly executed and reconcile before any further effect. Never repeat a claimed example.",
        publication:
          "Nothing was published. Call finish_build again with the same executionId for a fresh publication review; the retained example is not executed again.",
        question:
          "No question was created. Submit the same request_input again for a fresh question review; do not ask it in prose or invent a clarification.",
        update:
          "Nothing changed. Submit the same mint_update again for a fresh review; the task stays as it was until an update applies.",
      };
      const reviewUnavailableFeedback = (error: MintFailure) =>
        Effect.sync(() => {
          terminal = {
            build: "incomplete",
            hostFailure: "review_unavailable",
            summary:
              "Guardian review could not complete. No review approval was obtained; recorded effects and claimed examples remain preserved.",
          };
          return reviewUnavailableAnswer(
            error,
            "Review did not complete; this is not a Guardian deny or escalation decision. End this attempt without publication. Do not change site code to repair review infrastructure or automatically retry execution. Preserve prior effects and claimed examples; reconcile possibly executed operations before any further effect. Missing user authority or credentials has not been established.",
          );
        });
      /**
       * A publication dependency the host retried and that stayed unavailable: the registry, its
       * source store, or a screening or source read that named no file to fix. `path_screening`
       * stays a refusal: it can mean a source path holds a credential, which the minter fixes.
       */
      const publicationOutage = (error: MintFailure) =>
        error.reason === "registry_unavailable" ||
        error.reason === "source_storage" ||
        error.reason === "source_read" ||
        (error.publicationBlock === undefined &&
          (error.reason === "evidence_screening" ||
            error.reason === "source_screening" ||
            error.reason === "schema_screening")) ||
        (error.code === "Unavailable" && error.reason === undefined);
      /**
       * A publication refusal the minter can act on: `details` names what was refused, and
       * `instruction` follows what live execution is still available.
       */
      const notPublished = (
        code: MintFailure["code"],
        reason: string | undefined,
        details: object,
        instruction: string,
      ) =>
        // JSON.stringify leaves out each field that is undefined.
        JSON.stringify({
          status: "not_published",
          code,
          reason,
          ...details,
          ...availabilityMetadata(),
          userInputRequired: false,
          instruction: availabilityInstruction() + instruction,
        });
      /**
       * A registry refusal of a reviewed publication. A check the minter's metadata or source
       * decides goes back to it to fix, with no cap; any other refusal ends the attempt with its
       * reason. A registry outage the host's retries did not clear may be tried again until the
       * publication outage budget runs out.
       */
      const registryFeedback = (error: MintFailure) =>
        Effect.gen(function* () {
          const outage = publicationOutage(error);
          const refusal = outage
            ? {
                fixable: !(stopUnavailableHost() || (yield* reviewRetryExhausted())),
                instruction:
                  "Publication infrastructure (the tool registry, its source store or the host's screening) stayed unavailable through the host's retries, so nothing was published. Call finish_build again with the same executionId; the retained example is not executed again.",
              }
            : registryRefusal(error.registryIssue, error.registryProblem);
          if (!refusal.fixable)
            terminal = {
              build: "incomplete",
              ...(outage || error.registryIssue === undefined
                ? { hostFailure: "publication_unavailable" as const }
                : {}),
              summary: `Not published: ${refusal.instruction} The existing execution outcomes and protected results remain retained.`,
            };
          return notPublished(
            error.code,
            error.reason,
            {
              registryIssue: error.registryIssue,
              registryProblem: error.registryProblem,
              ...failureDetailMetadata(error),
              fixRequired: refusal.fixable && !outage,
              ...(outage ? { retryable: refusal.fixable } : {}),
            },
            refusal.instruction +
              (refusal.fixable ? "" : " This attempt ends here; preserve the recorded receipt."),
          );
        });
      const unavailableExecutionHost = (error: MintFailure) =>
        error.code === "Unavailable" &&
        error.reason === "executor_unavailable" &&
        error.execution === undefined &&
        error.authentication === undefined;
      const screenedRunnerFailure = (error: MintFailure) => {
        try {
          return finiteRunnerFailure(error.runnerFailure);
          // error-reporting-allow: parse-predicate an unreadable runnerFailure getter supplies no trusted finite metadata
        } catch {
          return undefined;
        }
      };
      const screenedCaptureGap = (error: MintFailure) => {
        try {
          return finiteCaptureGap(error.captureGap);
          // error-reporting-allow: parse-predicate an unreadable captureGap getter supplies no trusted finite metadata
        } catch {
          return undefined;
        }
      };
      const screenedRunnerChannels = ({ runnerChannels }: MintFailure) =>
        runnerChannels === undefined
          ? {}
          : {
              stdout: runnerChannels.stdout,
              stderr: runnerChannels.stderr,
              events: runnerChannels.events,
            };
      /** Whether a provider outage may still be resubmitted, starting its window if new. */
      const providerOutageOpen = (now: number) => {
        providerUnavailableRetries += 1;
        providerOutageStartedAt ??= now;
        return now - providerOutageStartedAt < reviewOutageBudgetMs;
      };
      const executionFeedback = (error: MintFailure) =>
        Effect.flatMap(Clock.currentTimeMillis, (now) => providerFeedback(error, now));
      /**
       * Counts a host refusal while typing into a sign-in screen. The `maximumHostRefusals`th
       * identical one in a row spends the attempt's sign-ins: sign-in is unavailable in the build.
       */
      const countHostRefusal = (error: MintFailure) => {
        const refusal = error.authentication?.hostRefusal;
        if (refusal === undefined) return error;
        const prior = priorHostRefusals;
        const count =
          prior !== undefined && sameHostRefusal(prior.refusal, refusal) ? prior.count + 1 : 1;
        hostRefusals = { refusal, count };
        return count < maximumHostRefusals || error.spentSignIn !== undefined
          ? error
          : new MintFailure({ ...error, spentSignIn: "host_refusals_repeated" });
      };
      const providerFeedback = (failed: MintFailure, now: number) => {
        const error = countHostRefusal(failed);
        const runnerFailure = screenedRunnerFailure(error);
        // A capture the host could not produce or screen is a gap: the result is withheld, the
        // effect possible, and the build goes on.
        const captureGap =
          screenedCaptureGap(error) ??
          runnerFailure?.captureGap ??
          (error.code === "CaptureUnavailable" ? ("capture_publication" as const) : undefined);
        const hostStopped = stopUnavailableHost() || unavailableExecutionHost(error);
        // The executor stop settles before this failure arrives, and a stop that failed makes
        // the host unavailable. So an available host here means the stop was confirmed. The host
        // already retried what it could, so the agent may resubmit until the outage outlasts its
        // budget.
        const providerRetry =
          !hostStopped &&
          error.execution?.reason === "provider_unavailable" &&
          providerOutageOpen(now);
        if (!providerRetry && (hostStopped || error.execution?.reason === "provider_unavailable"))
          closeExecution();
        const openCaptureGapNotice =
          captureGap !== undefined &&
          dependencies.executionAvailability?.() === "open" &&
          !hostStopped &&
          !executionClosed &&
          terminal === undefined
            ? "This command may have completed, but its capture observation is unavailable. The execution host remains open. You may make a new bounded observation of the current page and continue the request under ordinary review. Do not replay the previous command automatically or treat the missing capture as proof of success. Read back an uncertain write before any further write, never repeat a claimed example, and publish only from an eligible retained receipt."
            : undefined;
        const providerNotice = providerRetry
          ? {
              retryable: true,
              effect: error.execution?.dispatch === "not_sent" ? "not_sent" : "possible",
              providerNotice:
                error.execution?.dispatch === "not_sent"
                  ? "The execution provider was unavailable before this execution was dispatched, so it did not run. The host already retried; you may submit it again. If the provider stays unavailable long enough, live execution closes."
                  : "The execution provider failed after dispatch, and the host confirmed the executor stopped. The execution may have run: its effect is possible. Reconcile current state before claiming success or repeating any write; never repeat a claimed example. If the provider stays unavailable long enough, live execution closes.",
            }
          : {};
        // A failed sign-in names its own root cause and next step, never the wrapper's code.
        const feedback = signInFeedbackOf(error);
        // Until the agent signs in again, a final answer gets the way past it back once.
        if (error.authentication !== undefined && !hostStopped)
          unresolvedSignIn = {
            failure: error.authentication,
            spent: error.spentSignIn,
            guided: false,
          };
        // No further sign-in can run: the build ends with that outcome, not the loop guard.
        // A stop or cleanup the host could not confirm ends live work on its own terms.
        const ending =
          hostStopped ||
          terminal !== undefined ||
          error.authentication?.cleanupCode !== undefined ||
          feedback?.nextStep !== "report_sign_in_unavailable"
            ? ("none" as const)
            : publishableReceipt()
              ? ("after_publication" as const)
              : ("now" as const);
        const signIn = signInOrLoginInUseAnswer(error, feedback, ending);
        const rootCause = failureRootCause(error);
        return dependencies.projection
          .json({
            status: signIn === undefined ? "execution_unavailable" : "authentication_unavailable",
            code: signIn?.code ?? error.code,
            ...signIn?.fields,
            reason: error.reason,
            // A sign-in's diagnostic is its root cause; anything else names the one beneath.
            ...(signIn !== undefined || rootCause === undefined ? {} : { rootCause }),
            ...availabilityMetadata(),
            ...(error.destinationReason === "observation_unavailable"
              ? { destinationReason: error.destinationReason }
              : {}),
            execution: error.execution,
            workspace: error.workspace,
            runnerFailure,
            captureGap,
            // The runner's own output, when there is no capture view to carry it.
            ...screenedRunnerChannels(error),
            authentication: error.authentication,
            ...providerNotice,
            userInputRequired: false,
            notice:
              openCaptureGapNotice ??
              (error.execution?.workspace === undefined
                ? availabilityInstruction() +
                  (error.execution?.runnerResult === undefined
                    ? ""
                    : runnerResultNotice(error.execution.runnerResult)) +
                  (signIn?.notice ??
                    "Host execution failed; this does not establish missing credentials or a missing user answer. Preserve prior effects and the claimed example; reconcile uncertain website state before any further effect.")
                : error.execution.workspace.reason === "digest_mismatch"
                  ? `Nothing ran: the job sandbox's copy of ${(error.execution.workspace.mismatched ?? []).join(", ")} did not match the source Guardian reviewed. The host writes those files again before the next execution; submit the same execution again.`
                  : `Nothing ran: the host could not copy ${error.execution.workspace.fileCount} workspace file(s) inside the job sandbox for this execution. Submit it again; if it fails the same way, report that the execution sandbox is unavailable.`),
          })
          .pipe(
            Effect.map((value) => JSON.stringify(value)),
            Effect.catchAll(() =>
              Effect.succeed(
                JSON.stringify({
                  status: "execution_unavailable",
                  code: "Unavailable",
                  ...availabilityMetadata(),
                  userInputRequired: false,
                  notice:
                    availabilityInstruction() +
                    "Execution diagnostics unavailable; missing credentials were not established. Preserve prior effects; do not repeat a claimed example.",
                }),
              ),
            ),
            Effect.tap((answer) =>
              ending === "none" ? Effect.void : endForUnavailableSignIn(error, answer),
            ),
          );
      };
      /**
       * Records that sign-in is unavailable in this build, with the failed sign-in's root cause:
       * the build ends with that outcome at once, or once the model stops when a retained receipt
       * may still publish. A later authenticate gets the same answer.
       */
      const endForUnavailableSignIn = (error: MintFailure, answer: string) =>
        Effect.gen(function* () {
          const failure = error.authentication;
          const outcome = {
            build: "incomplete" as const,
            // A Personal conflict keeps its own actionable status; the worker words a saved
            // login's with its masked username.
            recoveryReason:
              failure?.code === "LoginIdentityConflict"
                ? ("login_identity_conflict" as const)
                : ("sign_in_unavailable" as const),
            summary: signInUnavailableSummary(failure, error.spentSignIn, error.sessionLoss),
          };
          signInUnavailable = { answer, outcome };
          if (!publishableReceipt()) terminal ??= outcome;
          yield* diagnose({
            phase: "sign_in",
            reason: "sign_in_unavailable",
            ...(failure === undefined
              ? {}
              : {
                  code: signInRootCode(failure),
                  authenticationCode: failure.code,
                  authenticationPhase: failure.phase,
                  credentialSent: failure.nothingSubmitted !== true,
                }),
            spentSignIn: error.spentSignIn,
            sessionLoss: error.sessionLoss,
          });
        });
      /**
       * An execution whose diagnostics the host could not keep: a recorded gap, however many, and
       * the build goes on. Its observations stay withheld and its effect is possible.
       */
      const diagnosticUnavailableFeedback = (error: MintFailure) =>
        Effect.sync(() =>
          JSON.stringify({
            status: "diagnostic_unavailable",
            code: "Unavailable",
            diagnosticRetentionReason: diagnosticRetentionReason(error),
            diagnosticStorageFailure: diagnosticStorageFailure(error),
            retryable: true,
            effect: "possible",
            userInputRequired: false,
            notice:
              "The host could not safely retain this execution's diagnostics and recorded the gap, so no unscreened observations are available for it. The website action may have completed: treat its effect as possible and reconcile before claiming success; never repeat a claimed example. Continue the build. Site code changes, credentials and user clarification cannot repair this infrastructure failure.",
          }),
        );
      /** The entrypoint each execution ran, so a repeat of a write's step can be recognized. */
      const entrypoints = new Map<string, string>();
      /** Every finish_build result as the minter received it, for the outcome reviewer. */
      const publications: string[] = [];
      /** The caller's accepted answers and approved changes, in order, for the outcome reviewer. */
      const acceptedAnswers: unknown[] = [];
      /**
       * The digest of what `entrypoint`'s import closure holds in the workspace now, without
       * paths; undefined when it cannot be read, and a failed read is reported to the host.
       */
      const stepDigest = (entrypoint: string) =>
        Effect.tryPromise({
          try: async () => {
            const files = await readImportClosure(async (path) => {
              if ((await session.pathExists?.(path)) === false) return undefined;
              const text: unknown = await session.readFile?.({ path });
              return typeof text === "string" ? text : undefined;
            }, entrypoint);
            return files.size === 0 ? undefined : contentDigest(files);
          },
          catch: (error) => error,
        }).pipe(
          Effect.catchAll((error) =>
            reportFailure(error, {
              component: "mint",
              operation: "stepDigest",
              phase: "source_digest",
              subCause: "mint_host_dependency_failed",
              correlation: dependencies.reportCorrelation ?? "process",
            }).pipe(Effect.as(undefined)),
          ),
        );
      /** A write Guardian labelled, as the outcome reviewer tracks it. */
      const trackedWrite = (
        executionId: string,
        reviewId: string | undefined,
        purpose: string,
        entrypoint: string | undefined,
        status: WriteExecutionStatus,
        evidence: ExecutionEvidence,
      ) =>
        Effect.gen(function* () {
          const sourceDigest = entrypoint === undefined ? undefined : yield* stepDigest(entrypoint);
          return {
            executionId,
            ...(reviewId === undefined ? {} : { reviewId }),
            purpose,
            ...(entrypoint === undefined ? {} : { entrypoint }),
            ...(sourceDigest === undefined ? {} : { sourceDigest }),
            status,
            effect: evidence.effect,
            ...(evidence.confirmation === undefined ? {} : { confirmation: evidence.confirmation }),
          };
        });
      /**
       * Tells the outcome reviewer about an execution that ran: a write Guardian labelled is
       * tracked and wakes it, and a later live execution wakes it while a write is unresolved,
       * since it may hold a readback.
       */
      const observeExecution = (
        submitted: Parameters<typeof dependencies.reviewAndExecute>[0],
        evidence: ExecutionEvidence,
        allowed: AllowedExecution | undefined,
        status: WriteExecutionStatus,
      ) =>
        Effect.gen(function* () {
          if (evidence.status === "unsupported") return;
          if (submitted.purpose !== "command")
            entrypoints.set(evidence.executionId, submitted.entrypoint);
          const action = evidence.review?.action ?? allowed?.action;
          const reviewId =
            evidence.review?.reviewId ??
            (allowed !== undefined && "reviewId" in allowed ? allowed.reviewId : undefined);
          if (action === "write" && submitted.purpose !== "command")
            return yield* reviewer.write(
              yield* trackedWrite(
                evidence.executionId,
                reviewId,
                submitted.purpose,
                submitted.entrypoint,
                status,
                evidence,
              ),
            );
          if (submitted.target === "liveBrowser")
            yield* reviewer.execution({
              executionId: evidence.executionId,
              purpose: submitted.purpose,
              ...(action === undefined ? {} : { action }),
              status,
            });
        });
      /**
       * Why a step is refused as a repeat of a write: it runs an earlier write's entrypoint, or
       * the same source under another name, after that write may have reached the site, and the
       * outcome reviewer, caught up with no readback outstanding, has not assessed every such
       * write `not_done`. This is the one place the minter waits for the reviewer, and an outage
       * leaves the write unresolved, so it is not repeated.
       */
      const repeatedWriteRefusal = (
        submitted: Parameters<typeof dependencies.reviewAndExecute>[0],
      ) =>
        Effect.gen(function* () {
          if (submitted.purpose === "command" || submitted.target !== "liveBrowser")
            return undefined;
          const sent = reviewer.tracked().filter((write) => write.effect !== "not_sent");
          if (sent.length === 0) return undefined;
          const digest = yield* stepDigest(submitted.entrypoint);
          const earlier = sent.filter(
            (write) =>
              write.entrypoint === submitted.entrypoint ||
              (digest !== undefined && write.sourceDigest === digest),
          );
          if (earlier.length === 0) return undefined;
          const settled = yield* reviewer.settle(earlier.map((write) => write.executionId));
          if (
            settled.current &&
            settled.assessments.every((assessment) => assessment?.outcome === "not_done")
          )
            return undefined;
          const applied = settled.assessments.some((assessment) => assessment?.outcome === "done");
          // A read-back that reuses the write's file is refused as this same repeat.
          const newFile = earlier.some((write) => write.entrypoint === submitted.entrypoint)
            ? ` Write a read-back as a new file: any step that runs ${submitted.entrypoint} again is refused as this repeat.`
            : "";
          return (
            (applied
              ? `This step repeats a write that already changed the site (${earlier.map((write) => write.executionId).join(", ")}), as the outcome review found. Never run it again: continue with the next step, read back the result, or publish. Nothing was executed.`
              : `This step repeats a write that may already have changed the site (${earlier.map((write) => write.executionId).join(", ")}), and no review has shown it did not. A write is never repeated unless its outcome review finds it did not happen. Read back the account or page in a step that changes nothing, so the review can settle it, or publish: a write whose outcome stays unknown is reported as possibly applied. Nothing was executed.`) +
            newFile
          );
        });
      const reviewedExecution: typeof dependencies.reviewAndExecute = (
        submitted,
        onDispatch = () => Effect.void,
      ) =>
        dependencies
          .reviewAndExecute(
            submitted,
            submitted.purpose === "example" ||
              (submitted.purpose === "act" && writeSession === "none")
              ? (allowed) =>
                  Effect.uninterruptible(
                    dependencies.claimExample.pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          exampleClaimed = true;
                          if (submitted.purpose === "act") writeSession = "open";
                        }),
                      ),
                      Effect.zipRight(onDispatch(allowed)),
                    ),
                  )
              : submitted.purpose === "act"
                ? // Later steps continue the session's started claim; the journal never claims again.
                  (allowed) => Effect.uninterruptible(onDispatch(allowed))
                : onDispatch,
          )
          .pipe(
            // A refusal the host returned before any review or dispatch shows neither Guardian
            // nor the provider working, so it leaves both outage windows running.
            Effect.tap((evidence) =>
              evidence.status === "unsupported"
                ? Effect.void
                : reviewCompleted.pipe(
                    Effect.zipRight(
                      Effect.sync(() => {
                        providerOutageStartedAt = undefined;
                      }),
                    ),
                  ),
            ),
            Effect.tapError((error) => (reviewDecided(error) ? reviewCompleted : Effect.void)),
            Effect.map((evidence) => {
              // The script question's correction is for this result only, never the ledger.
              const receipt = {
                ...safeExecutionEvidence(evidence),
                ...(evidence.scriptQuestion === undefined
                  ? {}
                  : { scriptQuestion: evidence.scriptQuestion }),
              };
              // Only this harness's preflight can authorize correcting request mechanics.
              delete receipt.preflight;
              return receipt;
            }),
            Effect.tapError((error) =>
              diagnoseExecution(
                submitted,
                {
                  code: failureCode(error),
                  // The root cause's own code, beneath the host's wrapper.
                  rootCode:
                    error.authentication === undefined
                      ? undefined
                      : signInRootCode(error.authentication),
                  reason: error.reason,
                  destinationReason: error.destinationReason,
                  ...policyFailureMetadata(error),
                  ...authorityCheckMetadata(error),
                  ...destinationPrivateCandidateMetadata(error),
                  reconciliationStage: error.reconciliationStage,
                  review: error.review,
                  reviewFailure: error.reviewFailure,
                  reviewPhase: error.reviewPhase,
                  reviewDispatch: error.reviewDispatch,
                  diagnosticRetentionReason: error.diagnosticRetentionReason,
                  diagnosticScreeningReason: diagnosticScreeningReason(error),
                  diagnosticStorageFailure: error.diagnosticStorageFailure,
                  execution: error.execution,
                  authentication: error.authentication,
                },
                error,
              ),
            ),
            Effect.tap((evidence) =>
              evidence.status === "unsupported"
                ? diagnoseExecution(submitted, {
                    status: evidence.status,
                    reason: evidence.observations,
                  })
                : Effect.void,
            ),
          );
      /**
       * Answers a reviewed execution's failure the agent can act on: a review deny or outage, a
       * retention failure, a capture the host could not produce, the host's own unavailability,
       * or what `executionFailed` picks out.
       */
      const executionFailureFeedback =
        (executionFailed: (error: MintFailure) => boolean) =>
        <A, R>(execution: Effect.Effect<A, MintFailure, R>) =>
          execution.pipe(
            Effect.catchIf((error) => error.code === "ReviewDenied", reviewFeedback),
            Effect.catchIf(
              (error) => error.code === "ReviewUnavailable",
              reviewUnavailableRetry("execution", reviewUnavailableFeedback),
            ),
            Effect.catchIf(
              (error) => error.diagnosticRetentionReason !== undefined,
              diagnosticUnavailableFeedback,
            ),
            Effect.catchIf(
              (error) =>
                dependencies.executionAvailability?.() === "host_unavailable" ||
                unavailableExecutionHost(error) ||
                error.code === "CaptureUnavailable" ||
                executionFailed(error),
              executionFeedback,
            ),
          );
      const command = (command: string) =>
        serial.withPermits(1)(
          Effect.gen(function* () {
            if (effectQuestion) return yield* new MintFailure({ code: "ScopeDenied" });
            yield* active();
            const evidence = yield* reviewedExecution({
              purpose: "command",
              target: "pureFiles",
              command,
            });
            record(evidence, "command");
            return yield* visible(evidence);
          }).pipe(
            executionFailureFeedback(
              (error) => error.execution !== undefined || error.authentication !== undefined,
            ),
          ),
        );
      const workspace = yield* Effect.try({
        try: () =>
          makeMintWorkspace(dependencies, command, runTool, (run) =>
            runTool(
              serial.withPermits(1)(
                active("publication").pipe(
                  Effect.zipRight(Effect.promise(run).pipe(Effect.uninterruptible)),
                ),
              ),
            ),
          ),
        catch: (error) =>
          new MintFailure({
            failureDetail: failureDetail("mint_host_dependency_failed", {
              operation: "makeMintWorkspace",
              error,
            }),
            code: "Unavailable",
          }),
      });
      const session = effectQuestion ? questionOnlyWorkspace(workspace) : workspace;
      // A host-enforced question turn authorizes no execution, source read or publication.
      const questionOnly = effectQuestion || Boolean(dependencies.capabilityQuestion);
      let captchaChecks = recovered?.captchaChecks ?? 0;
      /**
       * Why the agent may not end blocked now, as its tool result, or undefined. Something it can
       * still get past is not impossible as asked, and the screened explanation keeps its bound,
       * which screening's longer markers can break, so a takeover's checkpoint still reads it.
       */
      const blockedRefusal = (
        reason: (typeof BuildBlocked.Type)["reason"],
        screenedExplanation: string,
        now: number,
      ) => {
        const refused = (reason: string, instruction: string) =>
          JSON.stringify({
            status: "blocked_refused",
            reason,
            userInputRequired: false,
            instruction,
          });
        if (unresolvedSignIn !== undefined)
          return refused(
            "sign_in_unresolved",
            "The last sign-in failed and is unresolved. Resolve it as its result says, with authenticate once its cause is fixed, before deciding the task is impossible as asked.",
          );
        // Another review's outage is resubmitted first, until it outlasts its budget.
        if (
          reviewOutageStartedAt !== undefined &&
          !blockedReviewUnavailable &&
          now - reviewOutageStartedAt < reviewOutageBudgetMs
        )
          return refused(
            "review_unavailable_pending",
            "A Guardian review was unavailable and may be resubmitted. Submit that same call again first; an unavailable review is not a reason the task is impossible.",
          );
        if (screenedExplanation.length > blockedExplanationLimit)
          return refused(
            "explanation_too_long",
            "Private values in the explanation made it longer than 500 characters once screened. Shorten it, leave private values out, and call report_blocked again.",
          );
        // A policy block stands on a refusal on record: Guardian's deny or escalation, or the
        // owner's no to a confirm question, unless the host's own guidance names the ending. The
        // minter's reading of its own instructions is none, and neither is Guardian's feedback
        // that names a correction the minter can make. A question handed back unanswered also
        // lets the minter stop: no answer is no consent, so it may end the build safely instead
        // of going on past what it asked. A refused block costs a turn, so the attempt's turn
        // budget bounds how often the minter can try one.
        const ownerRefused = [...answeredQuestions.values()].some(
          ({ answer }) => typeof answer === "object" && "confirmed" in answer && !answer.confirmed,
        );
        if (
          reason === "policy" &&
          !guardianRefused &&
          !ownerRefused &&
          noAnswerHandBacks === 0 &&
          dependencies.policyBlockAllowed?.(screenedExplanation) !== true
        )
          return guardianCorrection
            ? refused(
                "guardian_correction_pending",
                "Guardian's feedback in this attempt names corrections you can make, such as missing metadata or a schema narrower than the site accepts, so it is not a refusal and the build has not ended. Apply each correction its rationale and findings name, collect any evidence it asks for, and call finish_build again; when a correction needs a fresh example and executionAvailability is host_unavailable, use report_blocked with host_unavailable instead. A policy block needs a refusal no correction gets past: Guardian denying or escalating an execution, a publication denial for privacy or authority, or the owner's no to a confirm question.",
              )
            : refused(
                "policy_not_refused",
                "Nothing in this attempt refused this: Guardian denied or escalated nothing, and the owner answered no to nothing. Your instructions are not a refusal, so the build has not ended. Continue through the page's own controls. Ask the owner with request_input when only they can decide; their no to a confirm question is a refusal. Use site_lacks_capability only when the site does not offer what the task needs.",
              );
        return undefined;
      };
      /**
       * Guardian's question review of a blocked explanation before any caller reads it, with the
       * host's publication refusals. `allow_business` shows it; an unavailable review is offered
       * back for resubmission under the review outage budget (`retry`), and past it, or for any
       * other failure, leaves the reason's fixed sentence alone, never the agent's words; any
       * other outcome goes back to the agent with its rationale.
       */
      const reviewBlockedExplanation = (explanation: string) => {
        const review = dependencies.reviewQuestion;
        return review === undefined
          ? Effect.succeed({ outcome: "unavailable" as const })
          : publicationRefusals.pipe(
              Effect.flatMap((publicationDecisions) =>
                review(
                  { questions: [{ id: "blocked", type: "text", prompt: explanation }] },
                  { blockedOutcome: true, ...publicationDecisions },
                ),
              ),
              Effect.tap(() => reviewCompleted),
              Effect.catchAll((error) =>
                Effect.gen(function* () {
                  yield* diagnose({
                    phase: "blocked_review",
                    code: failureCode(error),
                    reviewFailure: error.reviewFailure,
                    reviewPhase: error.reviewPhase,
                  });
                  // No outcome a question review allows: the agent revises or withdraws the
                  // explanation once, and a second ends blocked with the reason alone.
                  if (error.reviewFailure === "InvalidOutcome")
                    return invalidOutcomeRepeated()
                      ? { outcome: "unavailable" as const }
                      : {
                          outcome: "invalid_outcome" as const,
                          rationale:
                            "Guardian returned no decision a question review allows, so it neither allowed nor reworded the explanation. Make it plain and consistent with the evidence.",
                        };
                  // A spent quota or an outage past its budget still ends blocked: the caller
                  // reads the reason alone.
                  if (
                    error.code !== "ReviewUnavailable" ||
                    error.modelOutage === "quota_exhausted" ||
                    (yield* reviewRetryExhausted())
                  )
                    return { outcome: "unavailable" as const };
                  blockedReviewUnavailable = true;
                  reviewUnavailableRetries.question += 1;
                  return { outcome: "retry" as const, error };
                }),
              ),
            );
      };
      /** A `mint_update` result for the agent: its status and what the host says. */
      const taskUpdateAnswer = (
        status: TaskUpdateStatus,
        fields: Readonly<Record<string, unknown>>,
      ): string => JSON.stringify({ status, userInputRequired: false, ...fields });
      /** The task an update makes: the current one with its changes applied in order. */
      const nextTaskState = (
        changes: readonly TaskChange[],
        accepted: AcceptedTaskUpdate,
      ): TaskState => {
        let { effect, siteOrigin, businessInput } = taskState;
        for (const change of changes) {
          if (change.setting === "effect") effect = change.effect;
          else if (change.setting === "site") siteOrigin = change.origin;
          else if (change.setting === "input") {
            const values: Record<string, unknown> = { ...(businessInput as object) };
            for (const [key, value] of Object.entries(change.values))
              if (value === null) Reflect.deleteProperty(values, key);
              else
                Object.defineProperty(values, key, {
                  value,
                  enumerable: true,
                  configurable: true,
                  writable: true,
                });
            businessInput = values;
          }
        }
        return {
          revision: accepted.revision,
          effect,
          ...(siteOrigin === undefined ? {} : { siteOrigin }),
          businessInput,
          updates: [...taskState.updates, accepted],
        };
      };
      /**
       * Ends the build blocked with a recommended new build: the reviewed summary and suggested
       * request, which its caller reads. Text that screening lengthened past the limit stays out.
       */
      const recommendNewMint = (update: PendingTaskUpdate, by: "minter" | "guardian") =>
        Effect.gen(function* () {
          const shown = (text: string | undefined) =>
            text !== undefined && text.length <= blockedExplanationLimit ? text : undefined;
          const explanation = shown(update.summary);
          const suggestedRequest = shown(update.suggestedRequest);
          terminal = {
            build: "incomplete",
            blocked: {
              reason: "new_mint_recommended",
              ...(explanation === undefined ? {} : { explanation }),
              ...(suggestedRequest === undefined ? {} : { suggestedRequest }),
            },
            summary: `The build is blocked (new_mint_recommended): ${update.summary}`,
          };
          yield* diagnose({ phase: "blocked", reason: "new_mint_recommended", recommendedBy: by });
          return taskUpdateAnswer("new_mint_recommended", {
            notice:
              by === "guardian"
                ? "Guardian found that this change belongs in a new build, so this build ended blocked. Its caller reads your summary and suggested request; nothing more runs in this attempt."
                : "The build ended blocked with your recommendation of a new build. Its caller reads your summary and suggested request; nothing more runs in this attempt.",
          });
        });
      /** What the agent does after an update the host applied, by what it changed. */
      const updatedInstruction = (changes: readonly TaskChange[]) => {
        const settings = new Set(changes.map((change) => change.setting));
        return [
          "The host applied the update. Continue in this attempt under the effective task: the original request with this and every earlier accepted update, which every later review reads. Executions already recorded keep the task they ran under, and a write that may have committed is never repeated.",
          ...(settings.has("site")
            ? [
                "The build now targets task.siteOrigin: the host rebound its site, sign-in and publication there. Navigate there yourself; pages, captures and sign-ins from the earlier site are evidence about that site only. Sign in with execute purpose authenticate if the task needs it there.",
              ]
            : []),
          ...(settings.has("input")
            ? [
                "The changed input values are the host-bound input from now on: an example or act step runs them, and the tool's input schema takes them.",
              ]
            : []),
          ...(settings.has("effect")
            ? [
                "This build is now a write build, and every later execution is reviewed under write authority. Read .agents/writes/SKILL.md, and .agents/forms/SKILL.md for a form, before the next step. The write is the whole task the request asks for, done once through purpose act steps; it may take several steps, and drafts, autosaves and step saves along the way are part of it. Before the first act step, ask with request_input for any value the task needs that the input does not settle. The first act step starts with navigation to the site origin (keeping the session saved after sign-in), so it must navigate to any deeper task page it needs; what you observed so far stays valid evidence. From now on a live example or live test is refused, and so is a live explore once the session starts.",
              ]
            : []),
        ].join(" ");
      };
      /** The `updated` result: the effective task as it now stands, and what to do next. */
      const updatedAnswer = (changes: readonly TaskChange[], notice: string | undefined) =>
        Effect.gen(function* () {
          const domain =
            taskState.siteOrigin === undefined ? undefined : siteDomain(taskState.siteOrigin);
          return taskUpdateAnswer("updated", {
            task: {
              revision: taskState.revision,
              effect: buildEffect === "write" ? "write" : "read",
              ...(taskState.siteOrigin === undefined ? {} : { siteOrigin: taskState.siteOrigin }),
              ...(domain === undefined ? {} : { siteDomain: domain }),
            },
            repeatableRead,
            ...(notice === undefined
              ? {}
              : { notice: yield* screenMintText(dependencies, notice) }),
            instruction: updatedInstruction(changes),
          });
        });
      /** Who may confirm a maintenance contract change; a failure or no hook means nobody. */
      const maintenanceConfirmer = (
        dependencies.taskUpdateConfirmer?.() ?? Effect.succeed("none" as const)
      ).pipe(
        Effect.catchAll((error) =>
          reportFailure(error, {
            component: "mint",
            operation: "taskUpdateConfirmer",
            phase: "task_update",
            subCause: "mint_host_dependency_failed",
            correlation: dependencies.reportCorrelation ?? "process",
          }).pipe(Effect.as("none" as const)),
        ),
      );
      /** Guardian's review of a confirmed update, then the host's application of an allowed one. */
      const reviewAndApplyTaskUpdate = (submitted: TaskUpdateRequest) =>
        Effect.gen(function* () {
          const review = dependencies.reviewTaskUpdate;
          const apply = dependencies.applyTaskUpdate;
          if (review === undefined || apply === undefined)
            return yield* new MintFailure({ code: "Unavailable" });
          const confirmation = submitted.confirmedBy.flatMap((id) => {
            const answer = answeredQuestions.get(id);
            return answer === undefined ? [] : [answer];
          });
          // The caller may read the summary and suggested request, so host-private values go first.
          const update = yield* taskUpdateForReview(
            {
              summary: redactCallerText(submitted.summary),
              changes: submitted.changes,
              recommend: submitted.recommend,
              ...(submitted.suggestedRequest === undefined
                ? {}
                : { suggestedRequest: redactCallerText(submitted.suggestedRequest) }),
            },
            {
              confirmation,
              effect: buildEffect === "write" ? "write" : "read",
              ...(yield* publicationRefusals),
              // The harness reviews a maintenance update only once the owner may confirm it,
              // unless it only adds or tightens output fields, which nobody needs to confirm.
              ...(request.mode === "maintenance"
                ? {
                    maintenance: {
                      confirmer: keepsContract(submitted) ? ("none" as const) : ("owner" as const),
                    },
                  }
                : {}),
            },
            {
              text: (text) => screenMintText(dependencies, text),
              json: (value) => dependencies.projection.json(value),
            },
          );
          const decision = yield* review({ update, current: taskState });
          yield* reviewCompleted;
          yield* active("publication");
          const rationale = yield* screenRationale(decision.rationale);
          yield* reportBestEffort(
            dependencies.diagnostics?.emit("mint.task_update_reviewed", {
              ...(decision.reviewId === undefined ? {} : { reviewId: decision.reviewId }),
              outcome: decision.outcome,
              recommend: submitted.recommend,
              settings: submitted.changes.map((change) => change.setting),
              confirmations: confirmation.length,
            }) ?? Effect.void,
            {
              component: "mint",
              operation: "diagnostics.emit",
              phase: "mint.task_update_reviewed",
              correlation: dependencies.reportCorrelation ?? "process",
            },
          );
          if (decision.outcome === "reword")
            return taskUpdateAnswer("reword", {
              rationale,
              instruction:
                "Nothing changed, and the build continues under the current task. Revise the update using the rationale and call mint_update again, or continue without it.",
            });
          if (decision.outcome === "clarify")
            return taskUpdateAnswer("clarification_required", {
              source: "guardian",
              rationale,
              instruction:
                "Nothing changed. Ask the caller with request_input about what the rationale says is unconfirmed, naming the change plainly, then call mint_update again naming the questions they answered in confirmedBy.",
            });
          if (decision.outcome === "new_mint" || submitted.recommend === "new_mint")
            return yield* recommendNewMint(
              update,
              decision.outcome === "new_mint" ? "guardian" : "minter",
            );
          const accepted: AcceptedTaskUpdate = {
            revision: taskState.revision + 1,
            summary: update.summary,
            changes: update.changes,
            confirmation,
            requestDigest: taskUpdateDigest(submitted),
            ...(decision.reviewId === undefined ? {} : { reviewId: decision.reviewId }),
          };
          // The host binds the values the agent gave; reviews read the screened copy in `accepted`.
          const next = nextTaskState(submitted.changes, accepted);
          // The host stores this checkpoint with its own bindings in one step, so a takeover
          // restores either the whole update or none of it.
          const applied = yield* Effect.either(
            apply({
              current: taskState,
              next,
              update: accepted,
              harness: captureHarness(next),
            }),
          );
          if (applied._tag === "Left") {
            yield* reportFailure(applied.left, {
              component: "mint",
              operation: "applyTaskUpdate",
              phase: "task_update",
              subCause: "mint_host_dependency_failed",
              correlation: dependencies.reportCorrelation ?? "process",
            });
            return taskUpdateAnswer("update_refused", {
              reason: "host_failed",
              code: applied.left.code,
              ...failureDetailMetadata(applied.left),
              instruction:
                "Guardian allowed the update, but the host could not apply it, so nothing changed. failureDetail says which step failed. You may call mint_update again once; otherwise continue under the current task, or end the attempt and say in the summary that the caller confirmed a change the host could not apply.",
            });
          }
          const result = applied.right;
          if (result.outcome === "clarification_required")
            return taskUpdateAnswer("clarification_required", {
              source: "host",
              reason: result.reason,
              notice: yield* screenMintText(dependencies, result.notice),
              instruction:
                "Guardian allowed the update, but the host needs something only the caller can give before it applies, so nothing changed yet. Follow the notice, then call mint_update again.",
            });
          if (result.outcome === "refused")
            return taskUpdateAnswer("update_refused", {
              reason: result.reason,
              notice: yield* screenMintText(dependencies, result.notice),
              instruction:
                "The host cannot apply this update to this build, so nothing changed. Continue under the current task, or call mint_update with recommend new_mint if the caller's change needs a new build.",
            });
          const effectChanged = next.effect === "write" && buildEffect !== "write";
          const siteChanged = next.siteOrigin !== taskState.siteOrigin;
          taskState = next;
          // An applied update changes the remaining work, which may settle an unresolved write.
          yield* reviewer.taskUpdated(
            `The caller confirmed a task update (revision ${next.revision}): ${accepted.summary}`,
          );
          if (effectChanged) {
            buildEffect = "write";
            repeatableRead = false;
            // A read example's claim was the read's, and a read ran no write session: the write
            // session takes its own claim.
            exampleClaimed = false;
            writeSession = "none";
          }
          yield* reportBestEffort(
            dependencies.diagnostics?.emit("mint.task_updated", {
              revision: taskState.revision,
              settings: submitted.changes.map((change) => change.setting),
              effectChanged,
              siteChanged,
              priorExecutions: purposes.size,
              priorLiveExecutions: executions.filter((entry) => entry.effect !== "not_sent").length,
            }) ?? Effect.void,
            {
              component: "mint",
              operation: "diagnostics.emit",
              phase: "mint.task_updated",
              correlation: dependencies.reportCorrelation ?? "process",
            },
          );
          return yield* updatedAnswer(submitted.changes, result.notice);
        });
      /**
       * Each live test case's latest result on each version, by case id; a takeover restores
       * them. A batch on the HTTP version never replaces or stales the Playwright version's
       * results, nor the reverse. A record from an older release names no entrypoint: it is the
       * Playwright version's.
       */
      const liveTestRecords: Record<LiveTestVersion, Map<string, LiveTestRecord>> = {
        playwright: new Map(),
        http: new Map(),
      };
      // The HTTP version's results have a field of their own: a record in liveTests that names
      // no entrypoint, as an older release writes it, is the Playwright version's.
      const recoveredLiveTests = [
        ...(recovered?.liveTests ?? []),
        ...(recovered?.liveTestsHttp ?? []),
      ];
      for (const record of recoveredLiveTests)
        if (record.retired !== true)
          liveTestRecords[liveTestVersion(record.entrypoint)].set(record.id, record);
      const recordsFor = (entrypoint: string) => liveTestRecords[liveTestVersion(entrypoint)];
      /**
       * Failing results the minter replaced by changing their case, so the publication review
       * still sees them. Bounded for each version: the oldest go first.
       */
      const liveTestReplaced: LiveTestRecord[] = recoveredLiveTests.filter(
        (record) => record.retired === true,
      );
      /**
       * Whether the attempt ran out of time for live tests: a batch refused for time, or a case
       * stopped by a batch deadline the attempt's own end set. A batch's ten-minute cap never
       * counts, so the size of a batch cannot set it.
       */
      let liveTestsOutOfTime = recovered?.liveTestsOutOfTime === true;
      /** Each case's latest screened output, by version and case id: this attempt's runs only. */
      const liveTestOutputs = new Map<string, unknown>();
      const outputKey = (entrypoint: string, id: string) => `${liveTestVersion(entrypoint)}\n${id}`;
      /** Whether a passing example's receipt already carried the test plan. */
      let testPlanSent = recoveredLiveTests.length > 0;
      /**
       * Whether this read signed in. Only a read signed out designs and runs live tests; a
       * signed-in read proves its tool with its example alone. Read at each use, with the build's
       * current effect, so a read that signs in or becomes a write mid-build, a repair included,
       * stops testing from then on. Only a sign-in on the current site counts, as on the host.
       */
      const signedIn = () =>
        executions.some(
          (entry) =>
            entry.authentication?.state === "authenticated" &&
            // A sign-in on the site an update moved the build away from is that site's.
            (revisions.get(entry.executionId) ?? 0) >= latestRevisionChanging("site"),
        );
      const liveTestsOffered = () =>
        dependencies.liveTests !== undefined && buildEffect === "read" && !signedIn();
      /** The agent's cases file as it stands, or why it cannot be used. */
      const readCasesFile = Effect.promise(async () => {
        try {
          if ((await session.pathExists?.(liveTestCasesPath)) !== true)
            return decodeCasesFile(undefined);
          const text: unknown = await session.readFile?.({ path: liveTestCasesPath });
          return decodeCasesFile(typeof text === "string" ? text : undefined);
        } catch {
          return Either.left(`${liveTestCasesPath} could not be read.`);
        }
      });
      /** Schemas the host read, by entrypoint and source digest, so one source is read once. */
      const liveTestSchemas = new Map<string, { readonly input: unknown; readonly output: unknown }>();
      /**
       * What judging and paging a batch read from `entrypoint`'s current schemas: the cursor pair
       * and where a list read's results sit, or why the host could not read them.
       */
      const liveTestShape = (entrypoint: string) =>
        Effect.gen(function* () {
          const host = dependencies.liveTests;
          if (host === undefined) return { problem: "This host runs no live test batches." };
          const key = `${entrypoint}\n${(yield* stepDigest(entrypoint)) ?? ""}`;
          const known = liveTestSchemas.get(key);
          const schemas =
            known === undefined ? yield* Effect.either(host.schemas(entrypoint)) : Either.right(known);
          if (Either.isLeft(schemas))
            return {
              problem: `The host could not read ${entrypoint}'s input and output schemas offline, so it judged each result as a single record and can run no next page. Make the source import cleanly and declare both schemas, then run the cases again.`,
            };
          liveTestSchemas.set(key, schemas.right);
          const { input, output } = schemas.right;
          return {
            cursor: cursorPairOf(input, output),
            list: primaryListOf(input, output),
            outputSchema: output,
          };
        });
      const emptyCases: LiveTestCasesFile = { cases: [] };
      /** What the agent reads about its tests: its cases and their results. */
      const liveTestPlanView = (
        entrypoint: string,
        options: { readonly show?: readonly string[]; readonly ran?: readonly string[] } = {},
      ) =>
        Effect.gen(function* () {
          const read = yield* readCasesFile;
          const file = Either.isRight(read) ? read.right : emptyCases;
          const digest = yield* stepDigest(entrypoint);
          const cases = file.cases.map((testCase) => ({
            ...caseView(testCase, recordsFor(entrypoint).get(testCase.id), digest),
            ...(options.show?.includes(testCase.id) &&
            liveTestOutputs.has(outputKey(entrypoint, testCase.id))
              ? { output: liveTestOutputs.get(outputKey(entrypoint, testCase.id)) }
              : {}),
          }));
          const shown =
            options.ran === undefined
              ? cases
              : cases.filter((testCase) => options.ran?.includes(testCase.id));
          return {
            kind: "host_live_tests",
            entrypoint,
            ...(Either.isLeft(read) ? { casesFileProblem: read.left } : {}),
            cases: shown,
            ...(options.ran === undefined ? {} : { otherCases: file.cases.length - options.ran.length }),
            ...(shown.some((testCase) => "outputChecks" in testCase)
              ? {
                  outputChecksInstruction:
                    "The host checked every value each case returned, as it checks the example's. Check each finding against the page. Fix a wrong value at the read in source: read rendered text with visibleText, visibleTexts or readRows, expand collapsed text before reading it and read it back, and scope rows to the main list; never clean a string afterwards. A value that is correct as it is needs no change. A case's findings never refuse publication by themselves, but a blocking one (script, css, markup, template_residue) in the example's output refuses finish_build until fixed or overridden.",
                }
              : {}),
            ...(file.notTested === undefined ? {} : { notTested: file.notTested }),
            instruction:
              cases.length === 0
                ? `Design the cases in ${liveTestCasesPath} from what you saw on the site, as the testing skill says: different real values unlike the example's, smart combinations, edge cases and one rerun of the example's input. Then call live_tests with action run.`
                : cases.every((testCase) => testCase.status === "pass")
                  ? "Every case passes on the current source. Check what the outputs mean (filters applied to every item, the order, the applied location), add a case for anything the tool claims that no case tests yet, then make your last edit, run the cases again, run the example last and call finish_build."
                  : `Fix the code for each failing case at its frame, run the stale and not-run cases with action run, and add a case for anything the tool claims that no case tests yet. Publication review reads ${liveTestsEvidencePath}, the host's record of these results on the source you publish, against what the tool claims.`,
          };
        });
      /**
       * The batch's end: ten minutes at most, and two minutes before the attempt's deadline;
       * `attemptBound` when the attempt's end, not the cap, set it.
       */
      const liveTestDeadline = Effect.map(Clock.currentTimeMillis, (now) => {
        const remaining = dependencies.deadline?.remainingMs() ?? Number.POSITIVE_INFINITY;
        const attemptLeft = remaining - 2 * 60_000;
        return {
          deadlineAt: now + Math.min(10 * 60_000, attemptLeft),
          attemptBound: attemptLeft <= 10 * 60_000,
        };
      });
      const runLiveTests = (request: LiveTestsRequest) =>
        Effect.gen(function* () {
          const host = dependencies.liveTests;
          if (host === undefined) return yield* new MintFailure({ code: "Unavailable" });
          const read = yield* readCasesFile;
          if (Either.isLeft(read))
            return JSON.stringify({
              kind: "host_live_tests",
              status: "invalid_cases",
              problem: read.left,
              instruction: `Fix ${liveTestCasesPath}, then run again. Nothing was executed.`,
            });
          const file = read.right;
          const unknown = (request.cases ?? []).filter(
            (id) => !file.cases.some((testCase) => testCase.id === id),
          );
          if (unknown.length > 0)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "unknown_cases",
              cases: unknown,
              instruction: `Name only case ids ${liveTestCasesPath} lists, or pass cases null to run them all. Nothing was executed.`,
            });
          const selected =
            request.cases === null
              ? file.cases
              : file.cases.filter((testCase) => request.cases?.includes(testCase.id));
          if (selected.length === 0 || selected.length > maximumBatchCases)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "batch_size",
              instruction:
                selected.length === 0
                  ? `${liveTestCasesPath} has no cases to run. Design them there first, as the testing skill says. Nothing was executed.`
                  : `A batch runs at most ${maximumBatchCases} cases; name the ones to run in cases. Nothing was executed.`,
            });
          const shape = yield* liveTestShape(request.entrypoint);
          const cursor = "cursor" in shape ? shape.cursor : undefined;
          if (selected.some((testCase) => testCase.next_page === true) && cursor === undefined)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "no_cursor",
              instruction:
                "A next_page case needs an input field named cursor (or page_token) and an output field such as next_cursor, both strings or numbers, in the tool's schemas. Add them, or drop next_page. Nothing was executed.",
            });
          const digest = yield* stepDigest(request.entrypoint);
          if (digest === undefined)
            return JSON.stringify({
              kind: "host_live_tests",
              status: "source_unreadable",
              instruction: `The host could not read ${request.entrypoint} and its imports. Nothing was executed.`,
            });
          const { deadlineAt, attemptBound } = yield* liveTestDeadline;
          if (deadlineAt - (yield* Clock.currentTimeMillis) < 60_000) {
            liveTestsOutOfTime = true;
            return JSON.stringify({
              kind: "host_live_tests",
              status: "no_time",
              instruction:
                "Too little of this attempt is left to run a batch. Run the example last and publish, and say in coverage which cases did not run; the host's record says time ran out. Nothing was executed.",
            });
          }
          const workers = Math.max(1, Math.min(request.maxWorkers ?? host.maxWorkers, host.maxWorkers));
          const result = yield* host.run({
            entrypoint: request.entrypoint,
            sourceDigest: digest,
            cases: selected.map((testCase) => ({
              id: testCase.id,
              input: testCase.input,
              ...(testCase.next_page === true && cursor !== undefined ? { nextPage: cursor } : {}),
            })),
            workers,
            deadlineAt,
          });
          if (result.status === "review_denied")
            return JSON.stringify({
              kind: "host_live_tests",
              status: "review_denied",
              ...(result.reviewId === undefined ? {} : { reviewId: result.reviewId }),
              rationale: yield* screenRationale(result.rationale),
              instruction:
                "Guardian denied this batch, so nothing ran. Fix what the rationale names (often an input that names or guesses a private value, or a case that would change the site), then run again.",
            });
          // The source the batch ran: a change while it ran leaves its results stale.
          const after = yield* stepDigest(request.entrypoint);
          const sourceDigest = after === digest ? digest : "changed_while_running";
          const verdicts: Record<string, number> = {};
          for (const run of result.cases) {
            const testCase = selected.find((entry) => entry.id === run.id);
            if (testCase === undefined) continue;
            const judged = judgeCase(testCase, run, "list" in shape ? shape.list : undefined);
            const screened =
              judged.output === undefined
                ? undefined
                : yield* dependencies.projection
                    .json(judged.output)
                    .pipe(Effect.orElseSucceed(() => "[output withheld: screening failed]"));
            const outputAt = outputKey(request.entrypoint, run.id);
            if (screened === undefined) liveTestOutputs.delete(outputAt);
            else liveTestOutputs.set(outputAt, screened);
            const message =
              judged.message === undefined
                ? undefined
                : yield* screenMintText(dependencies, judged.message).pipe(
                    Effect.orElseSucceed(() => "[message withheld]"),
                  );
            const excerpt = outputExcerpt(screened);
            // The same output check an example gets, on the output the verdict judged; a sample
            // is a value from it, so it is screened like the output.
            const findings =
              judged.output === undefined
                ? []
                : lintOutput(judged.output, {
                    ...("outputSchema" in shape ? { outputSchema: shape.outputSchema } : {}),
                    samples: true,
                  });
            const outputChecks =
              findings.length === 0
                ? undefined
                : yield* dependencies.projection.json(findings).pipe(
                    Effect.flatMap((value) =>
                      Schema.decodeUnknown(LiveTestOutputChecks)(value),
                    ),
                    Effect.orElseSucceed(() =>
                      findings.map(({ sample: _sample, ...finding }) => finding),
                    ),
                  );
            const digestOfCase = caseDigest(testCase);
            const records = recordsFor(request.entrypoint);
            const version = liveTestVersion(request.entrypoint);
            const previous = records.get(run.id);
            // A failure the run replaces stays in the record: the case changed after it, or it
            // did not fail again on the same source and case, which shows it is flaky.
            const flaky =
              previous?.caseDigest === digestOfCase &&
              previous.sourceDigest === sourceDigest &&
              judged.verdict !== "fail";
            if (
              previous !== undefined &&
              previous.verdict === "fail" &&
              (previous.caseDigest !== digestOfCase || flaky) &&
              !liveTestReplaced.some(
                (entry) =>
                  liveTestVersion(entry.entrypoint) === version &&
                  entry.id === previous.id &&
                  entry.caseDigest === previous.caseDigest &&
                  entry.sourceDigest === previous.sourceDigest,
              )
            ) {
              liveTestReplaced.push({ ...previous, retired: true, ...(flaky ? { flaky: true } : {}) });
              const ofVersion = liveTestReplaced.filter(
                (entry) => liveTestVersion(entry.entrypoint) === version,
              );
              for (const dropped of ofVersion.slice(0, Math.max(0, ofVersion.length - maximumBatchCases)))
                liveTestReplaced.splice(liveTestReplaced.indexOf(dropped), 1);
            }
            records.set(run.id, {
              id: run.id,
              entrypoint: request.entrypoint,
              caseDigest: digestOfCase,
              sourceDigest,
              verdict: judged.verdict,
              got: judged.got,
              ...(judged.detail === undefined ? {} : { detail: judged.detail }),
              ...(judged.errorClass === undefined ? {} : { errorClass: judged.errorClass }),
              ...(message === undefined ? {} : { message }),
              ...(judged.frame === undefined ? {} : { frame: judged.frame }),
              ...(judged.refusal === undefined ? {} : { refusal: judged.refusal }),
              ...(excerpt === undefined ? {} : { excerpt }),
              ...(outputChecks === undefined ? {} : { outputChecks }),
              durationMs: Math.max(0, Math.round(run.durationMs)),
              ...(run.lane === undefined ? {} : { lane: run.lane }),
              input: testCase.input,
              purpose: testCase.purpose,
              expect: testCase.expect,
              ...(testCase.next_page === true ? { nextPage: true } : {}),
            });
            verdicts[judged.verdict] = (verdicts[judged.verdict] ?? 0) + 1;
            if (attemptBound && judged.verdict === "inconclusive" && judged.got === "deadline")
              liveTestsOutOfTime = true;
          }
          yield* reportBestEffort(
            dependencies.diagnostics?.emit("mint.live_tests", {
              cases: selected.length,
              lanes: result.lanes,
              challengeStops: result.challengeStops ?? 0,
              ...verdicts,
            }) ?? Effect.void,
            {
              component: "mint",
              operation: "diagnostics.emit",
              phase: "mint.live_tests",
              correlation: dependencies.reportCorrelation ?? "process",
            },
          );
          return JSON.stringify({
            status: "ran",
            ...(result.reviewId === undefined ? {} : { reviewId: result.reviewId }),
            lanes: result.lanes,
            ...(sourceDigest === digest
              ? {}
              : {
                  notice:
                    "The source changed while the batch ran, so these results describe other code. Run the cases again.",
                }),
            ...("problem" in shape ? { schemaProblem: shape.problem } : {}),
            ...(yield* liveTestPlanView(request.entrypoint, {
              ran: selected.map((testCase) => testCase.id),
            })),
          });
        });
      /**
       * The publication review's record of a read's live tests, and its coverage line. It lists
       * only the versions that ship: the published entrypoint's, and the HTTP version beside a
       * published Playwright version unless finish_build ruled it out (`httpRuledOut`). A version
       * that does not ship is neither recorded nor judged.
       */
      const liveTestsForPublication = (entrypoint: string, httpRuledOut: boolean) =>
        Effect.gen(function* () {
          if (dependencies.liveTests === undefined || buildEffect !== "read" || signedIn())
            return undefined;
          const read = yield* readCasesFile;
          const published = liveTestVersion(entrypoint);
          const replacedOf = (version: LiveTestVersion) =>
            liveTestReplaced.filter((record) => liveTestVersion(record.entrypoint) === version);
          const versions: LiveTestVersionResults[] = [
            {
              version: published,
              entrypoint,
              sourceDigest: yield* stepDigest(entrypoint),
              records: liveTestRecords[published],
              replaced: replacedOf(published),
            },
          ];
          if (published === "playwright" && !httpRuledOut) {
            // The file the HTTP version's latest results ran, else its conventional file when
            // the workspace has one.
            const ran = [...replacedOf("http"), ...liveTestRecords.http.values()]
              .map((record) => record.entrypoint)
              .filter((path) => path !== undefined)
              .at(-1);
            const httpEntrypoint =
              ran ??
              ((yield* Effect.promise(async () => {
                try {
                  return (await session.pathExists?.(httpVersionPath)) === true;
                } catch {
                  return false;
                }
              }))
                ? httpVersionPath
                : undefined);
            if (httpEntrypoint !== undefined)
              versions.push({
                version: "http",
                entrypoint: httpEntrypoint,
                sourceDigest: yield* stepDigest(httpEntrypoint),
                records: liveTestRecords.http,
                replaced: replacedOf("http"),
              });
          }
          return liveTestsEvidence({
            file: Either.isRight(read) ? read.right : emptyCases,
            ...(Either.isLeft(read) ? { fileProblem: read.left } : {}),
            versions,
            outOfTime: liveTestsOutOfTime,
          });
        }).pipe(
          // A record the host could not build says so, rather than vanishing from the review.
          Effect.catchAllCause((cause) =>
            Cause.isInterruptedOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed(
                  liveTestsEvidenceProblem(
                    "an error stopped it; judge coverage from the example and the minter's account",
                  ),
                ),
          ),
        );
      const actions: MintActions = {
        retainCapture: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              yield* active();
              const submitted = yield* decode(CaptureRequest, input);
              if ((submitted.kind === "full") !== (submitted.requestId === null))
                return yield* new MintFailure({ code: "InvalidRequest" });
              if (!dependencies.retainCapture)
                return yield* new MintFailure({ code: "CaptureUnavailable" });
              return yield* dependencies.retainCapture(submitted);
            }),
          ),
        readSource: (path, range) =>
          questionOnly
            ? Effect.fail(new MintFailure({ code: "ScopeDenied" }))
            : Effect.tryPromise({
                try: async () => {
                  const relative = relativeSourcePath(path);
                  const offset = range?.offset ?? 0;
                  const limit =
                    range?.limit ?? (relative.startsWith("captures/") ? 24_000 : undefined);
                  if (
                    !Number.isSafeInteger(offset) ||
                    offset < 0 ||
                    (limit !== undefined &&
                      (!Number.isSafeInteger(limit) || limit < 1 || limit > 64_000))
                  )
                    throw new MintFailure({ code: "InvalidRequest" });
                  // This attempt's own capture the workspace does not hold is not saved yet, not
                  // refused. Another attempt's retained capture keeps its read's own result.
                  const own = dependencies.reportCorrelation;
                  if (
                    own !== undefined &&
                    relative.startsWith(`captures/${own.jobId}/attempts/${own.attemptId}/`) &&
                    !(await session.pathExists?.(relative))
                  )
                    throw new MintFailure({
                      code: "CaptureUnavailable",
                      reason: "capture_not_saved",
                    });
                  // Screen the complete source before slicing so partial secrets cannot evade screening.
                  let result: unknown;
                  try {
                    result = await session.readFile?.({ path: relative });
                  } catch (error) {
                    // The index and route summary arrive with the first published capture. Only a
                    // failed read counts, so a maintenance mint's retained index still reads.
                    if (
                      (relative === "captures/index.json" || relative === "captures/routes.json") &&
                      !(await session.pathExists?.("captures/index.json"))
                    )
                      throw new MintFailure({
                        code: "CaptureUnavailable",
                        reason: "capture_not_saved",
                      });
                    throw error;
                  }
                  if (typeof result !== "string") throw new MintFailure({ code: "Unavailable" });
                  if (offset > result.length) throw new MintFailure({ code: "InvalidRequest" });
                  const end =
                    limit === undefined ? result.length : Math.min(result.length, offset + limit);
                  return JSON.stringify({
                    kind: "untrusted_source",
                    path: relative,
                    source: result.slice(offset, end),
                    offset,
                    total: result.length,
                    offsetUnit: "UTF-16 code units",
                    nextOffset: end < result.length ? end : null,
                  });
                },
                catch: (error) =>
                  error instanceof MintFailure && error.reason === "capture_not_saved"
                    ? error
                    : new MintFailure({
                        failureDetail: failureDetail("mint_host_dependency_failed", {
                          operation: "session.readFile",
                          error,
                          context: { path, offset: range?.offset, limit: range?.limit },
                        }),
                        code: "ScopeDenied",
                      }),
              }),
        execute: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              // Once sign-in is unavailable, another authenticate gets the same answer.
              if (
                signInUnavailable !== undefined &&
                Schema.is(Schema.Struct({ purpose: Schema.Literal("authenticate") }))(input)
              )
                return signInUnavailable.answer;
              yield* active();
              const submitted = yield* decode(ExecutionRequest, input);
              yield* Effect.try({
                try: () => relativeSourcePath(submitted.entrypoint),
                catch: (error) =>
                  new MintFailure({
                    failureDetail: failureDetail("mint_host_dependency_failed", {
                      operation: "relativeSourcePath",
                      error,
                      context: {
                        entrypoint: submitted.entrypoint,
                        purpose: submitted.purpose,
                        target: submitted.target,
                      },
                    }),
                    code: "ScopeDenied",
                  }),
              });
              if (submitted.target === "liveBrowser" && submitted.maxWorkers !== 1)
                return yield* new MintFailure({ code: "InvalidRequest" });
              if (submitted.purpose === "example" && exampleClaimed && !repeatableRead)
                return yield* new MintFailure({ code: "AlreadyExecuted" });
              if (
                submitted.purpose === "act" &&
                (writeSession === "closed" || (writeSession === "none" && exampleClaimed))
              )
                return yield* new MintFailure({ code: "AlreadyExecuted" });
              const repeated = yield* repeatedWriteRefusal(submitted);
              const availability =
                repeated === undefined
                  ? yield* dependencies
                      .preflight(submitted)
                      .pipe(
                        Effect.tapError((error) =>
                          diagnoseExecution(submitted, { code: error.code }),
                        ),
                      )
                  : { supported: false as const, reason: repeated };
              if (!availability.supported) {
                const evidence: ExecutionEvidence = {
                  executionId: randomUUID(),
                  status: "unsupported",
                  effect: "not_sent",
                  ...(submitted.purpose === "example"
                    ? { preflight: "rejected_before_claim" as const }
                    : {}),
                  observations: availability.reason,
                };
                yield* diagnoseExecution(submitted, {
                  status: evidence.status,
                  reason: availability.reason,
                });
                record(evidence, submitted.purpose);
                return yield* visible(evidence);
              }
              if (submitted.purpose === "residual") yield* dependencies.authorizeResidual;
              if (submitted.purpose === "authenticate") {
                unresolvedSignIn = undefined;
                priorHostRefusals = hostRefusals;
                hostRefusals = undefined;
              }
              const effectful =
                submitted.purpose === "example" ||
                submitted.purpose === "act" ||
                submitted.purpose === "residual";
              let crossedDispatchBoundary = false;
              /** The allow the host's dispatch fence followed, with Guardian's action label. */
              let allowed: AllowedExecution | undefined;
              const evidence = yield* reviewedExecution(submitted, (fenced) =>
                Effect.sync(() => {
                  crossedDispatchBoundary = true;
                  allowed = fenced;
                }),
              ).pipe(
                Effect.onExit((result) =>
                  Effect.suspend(() => {
                    if (
                      (!effectful && submitted.purpose !== "authenticate") ||
                      Exit.isSuccess(result)
                    )
                      return Effect.void;
                    // A defect or interruption can occur after dispatch just like a typed failure.
                    const reviewPreventedExecution =
                      Cause.isFailType(result.cause) &&
                      (result.cause.error.code === "ReviewDenied" ||
                        (result.cause.error.code === "ReviewUnavailable" &&
                          result.cause.error.reviewDispatch === "not_sent"));
                    const lost: ExecutionEvidence = {
                      executionId: `unresolved_${randomUUID()}`,
                      status: "failed",
                      effect:
                        submitted.purpose === "example" || submitted.purpose === "act"
                          ? crossedDispatchBoundary
                            ? "possible"
                            : "not_sent"
                          : reviewPreventedExecution || submitted.purpose === "authenticate"
                            ? "not_sent"
                            : "possible",
                      ...(submitted.purpose === "authenticate" && !reviewPreventedExecution
                        ? {
                            authentication: {
                              state: "failed" as const,
                              // Possible only while the sign-in's outcome is unknown.
                              effect:
                                Cause.isFailType(result.cause) &&
                                (result.cause.error.code === "CredentialsRejected" ||
                                  (result.cause.error.authentication !== undefined &&
                                    signInFailureFeedback(result.cause.error.authentication)
                                      .signInOutcome === "signed_out"))
                                  ? ("verified" as const)
                                  : ("possible" as const),
                            },
                          }
                        : {}),
                      observations:
                        "Execution did not produce a result. Reconcile using the host's durable execution journal.",
                    };
                    record(lost, submitted.purpose);
                    // Only an execution that crossed its dispatch fence ran; a write whose result
                    // was lost is exactly what the outcome reviewer settles.
                    return crossedDispatchBoundary
                      ? observeExecution(submitted, lost, allowed, "result_lost")
                      : Effect.void;
                  }),
                ),
              );
              yield* observeExecution(submitted, evidence, allowed, evidence.status);
              const result = yield* executionResult(evidence, submitted.purpose);
              // The first passing example settles the schemas: its receipt reminds the agent to
              // design and run its cases.
              if (
                submitted.purpose !== "example" ||
                evidence.status !== "completed" ||
                testPlanSent ||
                !liveTestsOffered()
              )
                return result;
              testPlanSent = true;
              const read = yield* readCasesFile;
              const planned = Either.isRight(read) ? read.right.cases.length : 0;
              const parsed = yield* Effect.option(
                Effect.try(() => JSON.parse(result) as Readonly<Record<string, unknown>>),
              );
              return Option.isNone(parsed)
                ? result
                : JSON.stringify({
                    ...parsed.value,
                    testPlan: {
                      plannedCases: planned,
                      instruction: `Your example passed, so the tool's schemas are settled. Design the cases in ${liveTestCasesPath} as the testing skill says, from what you saw on the site: different real values unlike the example's (another record, retailer or store the site lists), smart combinations, edge cases and one rerun of the example's input. Run them with live_tests action run and fix every failing case. Then make your last edit, run the cases again and run the example last.`,
                    },
                  });
            }).pipe(
              // The owner never answered a sign-in request: the build ends as no_response.
              Effect.catchIf(
                (error) => error.noResponse !== undefined && !stopUnavailableHost(),
                (error) => unanswered(error, "signing in to the website"),
              ),
              // The host already asked for a correction in place, and the site refused it too.
              Effect.catchIf(
                (error) => error.code === "CredentialsRejected",
                (error) => {
                  terminal ??= {
                    build: "incomplete",
                    rejectedCredential: error.rejectedCredential ?? "password",
                    summary:
                      "The website rejected a sign-in value and the bounded correction flow ended. No build was published. Recorded effects and receipts are preserved.",
                  };
                  return Effect.succeed(
                    JSON.stringify({
                      status: "credentials_rejected",
                      field: error.rejectedCredential ?? "password",
                      userInputRequired: false,
                      instruction:
                        "The website rejected the login again after the host asked for a correction. The host is ending this build; never ask for credentials yourself.",
                    }),
                  );
                },
              ),
              executionFailureFeedback(
                (error) =>
                  screenedRunnerFailure(error) !== undefined ||
                  screenedCaptureGap(error) !== undefined ||
                  error.execution !== undefined ||
                  error.authentication !== undefined ||
                  error.spentSignIn !== undefined ||
                  error.sessionLoss !== undefined ||
                  error.reason === "login_in_use",
              ),
            ),
          ),
        finish: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              if (questionOnly) return yield* new MintFailure({ code: "ScopeDenied" });
              yield* active("publication");
              const write = buildEffect === "write";
              const proposed = yield* decode(PublicationRequest, input).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    pendingDecision = hostRefusalDecision(
                      "request_invalid",
                      undefined,
                      write,
                      "InvalidRequest",
                    );
                  }),
                ),
              );
              if (proposed.httpVersion !== undefined && buildEffect === "write") {
                const reason = "http_version_on_write";
                pendingDecision = hostRefusalDecision(reason, undefined, true);
                yield* diagnose({ phase: "publication", code: "PublicationUnavailable", reason });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  instruction:
                    "httpVersion is only for a read published without an HTTP version. A write's HTTP version is tested offline against its session's recorded exchanges. Call finish_build again without httpVersion.",
                  executionContext: yield* executionContext(),
                });
              }
              yield* Effect.try({
                try: () => relativeSourcePath(proposed.entrypoint),
                catch: (error) =>
                  new MintFailure({
                    failureDetail: failureDetail("mint_host_dependency_failed", {
                      operation: "relativeSourcePath",
                      error,
                      context: {
                        entrypoint: proposed.entrypoint,
                        executionId: proposed.executionId,
                      },
                    }),
                    code: "ScopeDenied",
                  }),
              }).pipe(
                Effect.tapError(() =>
                  Effect.sync(() => {
                    pendingDecision = hostRefusalDecision(
                      "entrypoint_out_of_scope",
                      undefined,
                      write,
                      "ScopeDenied",
                    );
                  }),
                ),
              );
              const evidence = executions.find(
                (entry) => entry.executionId === proposed.executionId,
              );
              // A build that moved to another site publishes only what ran on that site, and a
              // build that became a write only what its write session did.
              const ranAt = evidence === undefined ? 0 : (revisions.get(evidence.executionId) ?? 0);
              const stale =
                evidence === undefined
                  ? undefined
                  : ranAt < latestRevisionChanging("site")
                    ? ({
                        reason: "example_before_site_change",
                        instruction:
                          "This execution ran before the build moved to its current site, so it proves nothing there. Run a fresh reviewed example on the current site, then call finish_build with that new executionId.",
                      } as const)
                    : ranAt < latestRevisionChanging("effect")
                      ? ({
                          reason: "example_before_effect_change",
                          instruction:
                            "This execution ran while the build was a read, so it is not the write the task now asks for. Perform the write through purpose act steps, then call finish_build with the step that confirmed it.",
                        } as const)
                      : undefined;
              if (stale !== undefined) {
                pendingDecision = hostRefusalDecision(stale.reason, evidence?.executionId, write);
                yield* diagnose({
                  phase: "publication",
                  code: "PublicationUnavailable",
                  reason: stale.reason,
                });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason: stale.reason,
                  userInputRequired: false,
                  instruction: stale.instruction,
                  executionContext: yield* executionContext(),
                });
              }
              const repair = dependencies.canPublishRepair?.(proposed.executionId) === true;
              const actStep =
                evidence !== undefined && purposes.get(evidence.executionId) === "act";
              // A step whose confirmation the host withheld with its result confirms nothing: a
              // later step that only reads the confirmation back publishes the session, and this
              // one does only when no read-back is possible.
              const withheld = actStep && evidence.withheldConfirmation !== undefined;
              if (withheld && (writeSession === "closed" || !proposed.readBackUnavailable)) {
                const reason = "read_back_required";
                pendingDecision = hostRefusalDecision(
                  reason,
                  evidence.executionId,
                  buildEffect === "write",
                );
                yield* diagnose({ phase: "publication", code: "PublicationUnavailable", reason });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  instruction:
                    writeSession === "closed"
                      ? "A later act step confirmed this write session. Publish against that step."
                      : withheldConfirmationInstruction,
                  executionContext: yield* executionContext(),
                });
              }
              // The step that read the site's confirmation publishes its session even when its
              // own output failed: the write happened once, and publication never runs it again.
              const confirmedWrite = actStep && (evidence.confirmation !== undefined || withheld);
              if (
                !evidence ||
                (!repair &&
                  !confirmedWrite &&
                  !refusedWithChoices(evidence) &&
                  (evidence.status !== "completed" || !evidence.resultRef)) ||
                purposes.get(evidence.executionId) === "authenticate" ||
                purposes.get(evidence.executionId) === "test" ||
                purposes.get(evidence.executionId) === "command" ||
                // A write maintenance's inspection or residual step is its repair receipt.
                (!repair &&
                  (purposes.get(evidence.executionId) === "inspect" ||
                    purposes.get(evidence.executionId) === "residual"))
              ) {
                const reason = !evidence
                  ? "missing_receipt"
                  : evidence.status !== "completed"
                    ? "receipt_incomplete"
                    : !evidence.resultRef
                      ? "missing_protected_result"
                      : "wrong_execution_purpose";
                pendingDecision = hostRefusalDecision(
                  reason,
                  evidence?.executionId,
                  buildEffect === "write",
                );
                yield* diagnose({
                  phase: "publication",
                  code: "PublicationUnavailable",
                  reason,
                });
                return JSON.stringify({
                  status: "not_published",
                  code: "PublicationUnavailable",
                  reason,
                  userInputRequired: false,
                  executionContext: yield* executionContext(),
                });
              }
              const minterCoverage = yield* screenMintText(dependencies, proposed.coverage);
              const assumptions = yield* screenAssumptions(proposed.assumptions);
              const readBackUnavailable = withheld
                ? yield* screenMintText(dependencies, proposed.readBackUnavailable ?? "")
                : undefined;
              const httpVersion =
                proposed.httpVersion === undefined
                  ? undefined
                  : {
                      ...proposed.httpVersion,
                      note: yield* screenMintText(dependencies, proposed.httpVersion.note),
                    };
              const outputOverrides =
                proposed.outputOverrides === undefined
                  ? undefined
                  : yield* Effect.forEach(proposed.outputOverrides, (override) =>
                      screenMintText(dependencies, override.reason).pipe(
                        Effect.map((reason) => ({ ...override, reason })),
                      ),
                    );
              // The host's own record of a read's live tests on this source goes to the review
              // as evidence, and its line to coverage. It never refuses publication by itself.
              const liveTests = yield* liveTestsForPublication(
                proposed.entrypoint,
                proposed.httpVersion?.outcome === "ruled_out",
              );
              const coverage =
                liveTests === undefined
                  ? minterCoverage
                  : `${minterCoverage}\n${liveTests.coverage}`;
              const publication = yield* dependencies
                .publish(
                  {
                    entrypoint: proposed.entrypoint,
                    executionId: proposed.executionId,
                    metadata: proposed.metadata,
                    coverage,
                    ...(readBackUnavailable === undefined ? {} : { readBackUnavailable }),
                    ...(httpVersion === undefined ? {} : { httpVersion }),
                    ...(outputOverrides === undefined ? {} : { outputOverrides }),
                  },
                  evidence,
                  ...(liveTests === undefined ? [] : [{ liveTests: liveTests.record }]),
                )
                .pipe(Effect.either);
              const reviewId =
                publication._tag === "Right"
                  ? publication.right.review?.reviewId
                  : publication.left.review?.reviewId;
              const reason =
                publication._tag === "Right"
                  ? undefined
                  : (publication.left.reason ?? publication.left.review?.reason);
              pendingDecision = {
                outcome: publication._tag === "Right" ? "published" : "refused",
                code: publication._tag === "Right" ? "Published" : publication.left.code,
                ...(reason === undefined ? {} : { reason }),
                executionId: evidence.executionId,
                ...(reviewId === undefined ? {} : { reviewId }),
                failedChecks: publication._tag === "Right" ? [] : refusalChecks(publication.left),
                recovery:
                  publication._tag === "Right"
                    ? "none"
                    : publication.left.reviewFailure === "InvalidOutcome"
                      ? "correct_source"
                      : publication.left.code === "ReviewUnavailable" ||
                          publication.left.code === "CaptureUnavailable" ||
                          publicationOutage(publication.left)
                        ? "retry"
                        : publication.left.code === "ReviewDenied"
                          ? "guardian_feedback"
                          : refusalRecovery(reason, buildEffect === "write"),
              };
              if (publication._tag === "Right" || reviewDecided(publication.left)) {
                yield* reviewCompleted;
                // A completed review replaces the input feedback an earlier one returned.
                inputFeedbackReview = undefined;
              }
              const denial = publication._tag === "Left" ? publication.left.review : undefined;
              const deniedCategory = denial?.findings?.[0]?.category;
              if (publication._tag === "Left" && publication.left.code === "ReviewDenied") {
                if (correctablePublicationReason(publication.left.review?.reason))
                  guardianCorrection = true;
                else guardianRefused = true;
              }
              publicationDenial =
                publication._tag === "Left" && publication.left.code === "ReviewDenied"
                  ? {
                      ...(denial?.reason === undefined ? {} : { reason: denial.reason }),
                      ...(deniedCategory === undefined ? {} : { category: deniedCategory }),
                    }
                  : undefined;
              const publicationDiagnostics =
                publication._tag === "Right"
                  ? publication.right.diagnostics
                  : (publication.left.publicationDiagnostics ?? []);
              for (const gap of publicationDiagnostics) {
                const diagnostic = JSON.stringify(gap);
                if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
              }
              if (publication._tag === "Left") {
                const error = publication.left;
                const outputUnavailable =
                  error.code === "PublicationUnavailable" &&
                  error.reason === "example_output_unavailable";
                if (outputUnavailable) unavailableOutputRefusals++;
                // Each refusal permits one fresh verified example; a third unavailable output, or
                // an example that cannot be repeated, is an infrastructure failure.
                const outputUnrecoverable =
                  outputUnavailable &&
                  (!repeatableRead ||
                    executionClosed ||
                    unavailableOutputRefusals > maximumUnavailableOutputReruns);
                const hostUnavailable =
                  stopUnavailableHost() ||
                  outputUnrecoverable ||
                  (error.code === "PublicationUnavailable" &&
                    (error.reason === "executor_unavailable" ||
                      error.reason === "registry_publication"));
                if (hostUnavailable)
                  terminal = {
                    build: "incomplete",
                    hostFailure: "publication_unavailable",
                    summary: outputUnrecoverable
                      ? "The host could not read the retained output of a verified example, so publication review had nothing to judge. The existing execution outcomes remain recorded."
                      : "Publication infrastructure is unavailable. The existing execution outcomes and protected results remain retained independently of future code publication.",
                  };
                // The review as the minter reads it, screened once for every reply below.
                const review =
                  error.review === undefined ? undefined : yield* minterReview(error.review);
                // Screening serializes through JSON, which leaves out undefined fields.
                const diagnostic = yield* screenMintText(dependencies, {
                  phase: "publication",
                  code: failureCode(error),
                  reason: error.reason,
                  screening: error.screening,
                  publicationBlock: error.publicationBlock,
                  destinationEvidenceGap: error.destinationEvidenceGap,
                  ...(review === undefined ? {} : { review }),
                  reviewPhase: error.reviewPhase,
                  reviewFailure: error.reviewFailure,
                  diagnosticRetentionReason: error.diagnosticRetentionReason,
                  diagnosticScreeningReason: diagnosticScreeningReason(error),
                  diagnosticStorageFailure: error.diagnosticStorageFailure,
                }).pipe(Effect.either);
                if (diagnostic._tag === "Right") diagnostics.push(diagnostic.right);
                if (error.code === "ReviewUnavailable")
                  return yield* reviewUnavailableRetry(
                    "publication",
                    reviewUnavailableFeedback,
                  )(error);
                if (
                  error.reason === "registry_invalid_definition" ||
                  error.reason === "registry_conflict" ||
                  publicationOutage(error)
                )
                  return yield* registryFeedback(error);
                if (hostUnavailable)
                  return JSON.stringify({
                    status: "publication_unavailable",
                    code: error.code,
                    ...availabilityMetadata(),
                    reason: outputUnrecoverable ? "example_output_unrecoverable" : error.reason,
                    diagnostic:
                      diagnostic._tag === "Right"
                        ? diagnostic.right
                        : "Publication diagnostic unavailable.",
                    userInputRequired: false,
                    instruction:
                      "Publication infrastructure is unavailable. End this attempt without retrying finish_build or execution. Preserve all existing receipts and protected results; source edits or a fabricated user question cannot restore this dependency.",
                  });
                // Capture evidence publication needs is a gap, never a reason to run a write again.
                // Like any publication dependency, it may be tried again until the outage budget
                // runs out.
                if (error.code === "CaptureUnavailable") {
                  const retryable = !(stopUnavailableHost() || (yield* reviewRetryExhausted()));
                  if (!retryable)
                    terminal = {
                      build: "incomplete",
                      hostFailure: "publication_unavailable",
                      summary:
                        "Not published: the capture evidence publication needs stayed unavailable. The existing execution outcomes and protected results remain retained.",
                    };
                  return notPublished(
                    error.code,
                    error.reason,
                    { captureGap: screenedCaptureGap(error), retryable },
                    retryable
                      ? "Not published yet: the capture evidence publication needs is unavailable, and the host recorded the gap. The existing example and result remain recorded. Call finish_build again with the same executionId. If it stays unavailable, gather what publication needs through a new read-only observation; never run a write that may have committed again to regenerate capture."
                      : "Not published: the capture evidence publication needs stayed unavailable through the publication outage budget. This attempt ends here; preserve the recorded receipt.",
                  );
                }
                if (error.code !== "PublicationUnavailable" && error.code !== "ReviewDenied")
                  return yield* error;
                // Input feedback never fails the mint at once: the minter gets bounded rounds to
                // fix it. Then a host's fallback publishes the last reviewed candidate, privately
                // and flagged, or with no fallback the build ends unpublished with the findings.
                if (error.review?.reason === "input_feedback") {
                  inputFeedbackRounds++;
                  inputFeedbackCoverage = coverage;
                  const fallback = dependencies.inputFeedbackFallback;
                  const privateFallback = fallback?.kept() === true;
                  inputFeedbackPublicTool = fallback !== undefined && !privateFallback;
                  const findings = error.review.findings ?? [];
                  const inRounds = inputFeedbackRounds <= maximumInputFeedbackRounds;
                  // The minter reads the screened rationale in each round, and a build with no
                  // fallback ends on it; a fallback's last round never reads it.
                  const rationale =
                    inRounds || fallback === undefined
                      ? yield* screenRationale(error.review.rationale)
                      : undefined;
                  if (fallback === undefined && rationale !== undefined)
                    inputFeedbackReview = {
                      categories: [...new Set(findings.map(({ category }) => category))],
                      rationale,
                    };
                  if (inRounds && rationale !== undefined)
                    return notPublished(
                      error.code,
                      "input_feedback",
                      {
                        findings: yield* minterFindings(findings),
                        rationale,
                        reviewId: error.review.reviewId,
                        feedbackRoundsRemaining: maximumInputFeedbackRounds - inputFeedbackRounds,
                      },
                      inputFeedbackInstruction(maximumInputFeedbackRounds - inputFeedbackRounds, {
                        write: buildEffect === "write",
                        ...(fallback === undefined ? {} : { privateFallback }),
                      }),
                    );
                  if (yield* settleUnresolvedInputFeedback)
                    return "Build published for this account only and flagged with Guardian's unresolved input feedback. The current invocation outcome is returned separately; do not execute again.";
                  terminal ??= { build: "incomplete", summary: unresolvedInputFeedbackSummary() };
                  return JSON.stringify({
                    status: "not_published",
                    code: error.code,
                    reason: "input_feedback_unresolved",
                    userInputRequired: false,
                    instruction: "Nothing was published. End this attempt; do not execute again.",
                  });
                }
                // Every finding is in a file the host wrote, which no edit of the minter's changes
                //: it stops and reports rather than resubmitting unchanged.
                if (error.review?.reason === "host_owned")
                  return notPublished(
                    error.code,
                    "host_owned",
                    {
                      findings: yield* minterFindings(error.review.findings ?? []),
                      rationale: yield* screenRationale(error.review.rationale),
                      reviewId: error.review.reviewId,
                    },
                    "Not published: every finding is in a host-owned file, which cannot be fixed from source. Do not edit source for it, run anything again or call finish_build unchanged. Stop and report the findings and Guardian's rationale in your final answer.",
                  );
                // A gate refusal names its file and what matched there. It is the minter's to fix,
                // never a review outage to retry.
                if (error.publicationBlock !== undefined) {
                  const feedback = publicationBlockFeedback(error.publicationBlock);
                  // The file goes out as the minter knows it, under `file` below.
                  const block = Object.fromEntries(
                    Object.entries(error.publicationBlock).filter(([key]) => key !== "file"),
                  );
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      file: feedback.file,
                      ...block,
                      retryable: false,
                      fixRequired: feedback.fixable,
                    },
                    feedback.instruction,
                  );
                }
                // Nothing to publish ends the repair here, so no continuation prompt asks for an edit.
                if (error.reason === "repair_unchanged") {
                  terminal ??= {
                    build: "incomplete",
                    summary:
                      "The repair changed none of the registered revision's source, so nothing was published and the registered revision stays current. Recorded effects and receipts are preserved.",
                  };
                  return JSON.stringify({
                    status: "not_published",
                    code: error.code,
                    reason: error.reason,
                    userInputRequired: false,
                    instruction:
                      "Not published: the source this repair would publish is byte for byte the registered revision's, so there is nothing to publish. A new name or description alone is not a repair. The registered revision stays current and this repair ends here; do not call finish_build again.",
                  });
                }
                // Deterministic, before any review: the minter fixes the extraction, or the owner
                // confirms a contract change. It is neither a review nor an outage.
                if (error.reason === "output_obligation_weakened")
                  return notPublished(
                    error.code,
                    error.reason,
                    { weakenedOutputs: error.weakenedOutputs ?? [] },
                    `Not published and not reviewed: this repair loosens the registered tool's output contract${weakenedOutputsText(error.weakenedOutputs ?? [])}. A repair keeps every output the registered tool returns, at least as required and as strictly typed; it may add or tighten fields. ${
                      buildEffect === "write"
                        ? "Keep the schema as registered and fix the extraction from what the session already read, then call finish_build again with the same executionId; never run the write again for this."
                        : "Keep the schema as registered and fix the extraction so it returns each value, then run the example again and call finish_build with that new executionId."
                    } If the site no longer shows a value, propose mint_update with an output change for that field, which the tool's owner must confirm, and a reason when it removes the field; once it is updated, call finish_build again with the same executionId. Otherwise end with report_blocked, reason site_lacks_capability, naming the field.`,
                  );
                // A host's own comparison with the published tool's inputs: exactly its fixed
                // instruction, with each broken input as data.
                if (error.reason === "input_contract_changed")
                  return notPublished(
                    error.code,
                    error.reason,
                    { brokenInputs: error.brokenInputs ?? [] },
                    inputContractChangedInstruction,
                  );
                if (error.reason === "tool_name_taken")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    `Not published and not reviewed: ${registryRefusal("tool_name_taken").instruction}`,
                  );
                if (error.reason === "site_metadata_required")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published and not reviewed: this is the first tool of this site's integration, which takes its name from this publication. Add siteName, the site's everyday name as people say it (such as Example Flights, 1 to 60 characters), and siteSummary, one sentence on what the site is, not what this tool does (1 to 160 characters), to finish_build's metadata, and call finish_build again with the same executionId. Both are public: write them from what the site shows anyone, never from this account or session.",
                  );
                if (error.reason === "output_checks_blocked")
                  return notPublished(
                    error.code,
                    error.reason,
                    { outputFindings: error.outputFindings ?? [] },
                    outputChecksRefusal(error.outputFindings ?? []),
                  );
                if (error.reason === "variants_unsupported")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published: this Kernel script declares supportedVariants, and only Effect runs dispatch variants, so every call would fail with InvalidOutput. Either remove supportedVariants from the tool's metadata (keep one script that handles the variation itself) and call finish_build again with the same executionId; the recorded example and result stay valid and nothing needs to run again. Or, if variants are essential, make it an offline tool: execute a new example with target pureFiles, then call finish_build with that new executionId. The same executionId is refused again while its receipt is a Kernel script.",
                  );
                if (
                  error.reason === "http_implementation_untested" ||
                  error.reason === "http_implementation_stale"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    (error.reason === "http_implementation_stale"
                      ? "Not published yet: src/tool-http.mjs changed since its last passing live test, and a test counts only for the source it ran. Run execute purpose test, target liveBrowser, entrypoint src/tool-http.mjs on the current file, or restore the version that passed, then call finish_build again with the same executionId."
                      : "Not published yet: this read has no HTTP version that passed a live test. Read .agents/http-mcp/SKILL.md from the top, find where the example's data comes from (step 1), write src/tool-http.mjs and test it live with execute purpose test, target liveBrowser, entrypoint src/tool-http.mjs. Fix and test again until its output matches the example's; a request refused before sending never counts. A read signed out then runs its cases as a batch on it with live_tests, as on src/tool.mjs (testing skill); a signed-in read checks it once, against the example. Then call finish_build again with the same executionId.") +
                      " If it can't port, call finish_build again with httpVersion naming the signal from the skill's \"When it can't port\", the requestId it rests on and a short note; don't write or run a stub. The host asks only once.",
                  );
                if (error.reason === "login_url_one_time")
                  return notPublished(
                    error.code,
                    error.reason,
                    { ...error.publicationFeedback },
                    "Not published yet: the login URL this tool would publish (the loginUrl you passed to authenticate, or the page the browser was on when you passed none) is one authorization request: an identity provider's authorize URL, or a URL carrying one-time authorization values (oneTimeParameters names the authorize path and those values). They are spent once this sign-in ends, so later runs that reopen it would start from stale values. The host changed nothing. Navigate the browser to the site's stable sign-in entry, the page a person would bookmark or the site's own login link before it redirected, run authenticate again with that page's address as loginUrl, then call finish_build again with the same executionId. If no stable entry exists, call finish_build again and the host publishes the URL as it is, flagged. The host asks only once.",
                  );
                if (
                  error.reason === "login_url_contains_credential" ||
                  error.reason === "metadata_contains_credential"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    { ...error.publicationFeedback },
                    "Not published: each part named in parts holds a registered credential (credentialKinds names the kind, never the value). A published tool never carries one, and the host changes nothing itself. For loginUrl, run authenticate again with a login URL that has no credential in it, the site's plain sign-in page. For name, description, siteName or siteSummary, rewrite the text without it. Then call finish_build again with the same executionId. The host refuses every time until the credential is gone; the build is not over.",
                  );
                if (error.reason === "definition_login_reference") {
                  const section = error.screening?.section;
                  return notPublished(
                    error.code,
                    error.reason,
                    { section },
                    `Not published: the tool's ${section ?? "definition"} quotes this build's account reference, an opaque value the host gave this build to identify its login (such as an inspection's accountScope). It means nothing to a caller and is never published. ${definitionFix(section)} The existing example and result remain recorded.`,
                  );
                }
                if (error.reason === "secret_handle") {
                  const path = error.screening?.path ?? "the source";
                  return notPublished(
                    error.code,
                    error.reason,
                    { path: error.screening?.path },
                    `Not published: ${path} holds a {{secret.…}} handle. A handle works only in this build's own executions, where the host fills in the caller's answer; published code never holds a handle or a value. Declare the value as a secret question in the operation's questions and read it with ask at run time, as .agents/caller-input/SKILL.md shows, then call finish_build again.`,
                  );
                }
                if (error.reason === "file_handle")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published: the source holds a {{file.…}} handle, which names a caller's file only in this build. A tool takes each file from its input: type the field as FileInput and pass the input's value to files.place. Remove the handle from the source, then call finish_build again.",
                  );
                if (error.reason === "file_readback")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    `Not published: the source moves or reads a file outside the host's file service. Rule: ${fileReadbackRule}. Remove that code, then call finish_build again.`,
                  );
                if (
                  error.reason === "session_token_literal" ||
                  error.reason === "session_token_placeholder"
                ) {
                  const path = error.screening?.path ?? "the source";
                  const placeholder = error.reason === "session_token_placeholder";
                  return notPublished(
                    error.code,
                    error.reason,
                    { path: error.screening?.path, section: error.screening?.section },
                    placeholder
                      ? `Not published: ${path} still reads [session token withheld] where an earlier release withheld a live token, so it no longer matches what ran. Do not paste a token back in: edit the source to read the token at run time from the response, cookie or page that issues it, then call finish_build again; the existing example and result remain recorded.`
                      : error.screening?.section === "loginUrl"
                        ? "Not published: the login URL holds a literal session token observed during sign-in. Run authenticate again with the site's stable sign-in page URL, without the token, then call finish_build again with the same executionId. The host keeps the URL unchanged for your HTTP work and does not end this build."
                        : `Not published: ${path} holds a literal session token from captures/session-tokens.json. Published code never contains a token. Edit the source to read the token at run time from the response, cookie or page that issues it, then call finish_build again; the existing example and result remain recorded. Your workspace keeps the token for your own HTTP work. If the file is src/tool-http.mjs, run its live test again first, because the edit invalidates the last one.`,
                  );
                }
                if (error.reason === "confirm_action_unmatched")
                  return notPublished(
                    error.code,
                    error.reason,
                    { confirmActionIds: error.confirmActionIds ?? [] },
                    "Not published: the session accepted confirm popups reported to decideDialog under these step names, and the composed script does not report them under the same names. Reuse each step literal exactly, for example by importing the step's helper, so runs accept the same popups without asking; then call finish_build again with the same executionId. Never run the write again.",
                  );
                if (error.reason === "write_not_submitted")
                  return notPublished(
                    error.code,
                    error.reason,
                    {},
                    "Not published: this build has not demonstrated the requested write. Continue the remaining authorized work, and never run a write that completed again. If a step may already have committed, read back first, in a new act step that only reads the page or the account: if the write happened, record it with verified() in that step and call finish_build naming it. The host runs a step that may have committed only once, unless the outcome review finds it did not happen; a repeat is refused until then. If the site offers no read-back that can tell, never submit again: publish the write as unverifiable against the step that could have committed. If the caller's inputs cannot work on the site as given, ask the owner with request_input whether to revise them. A path that skipped the write does not show a working write tool.",
                  );
                if (
                  error.reason === "confirmation_undeclared" ||
                  error.reason === "commit_marks_undeclared" ||
                  error.reason === "commit_marks_unentered" ||
                  error.reason === "confirmation_unrecorded" ||
                  error.reason === "contract_input_mismatch" ||
                  error.reason === "contract_output_mismatch"
                )
                  return notPublished(
                    error.code,
                    error.reason,
                    error.reason === "contract_input_mismatch" && error.inputIssues !== undefined
                      ? { inputIssues: error.inputIssues }
                      : {},
                    (error.reason === "confirmation_undeclared"
                      ? "Not published: the composed script declares no write confirmation. Add write: {confirmation: 'message' | 'readback' | 'unverifiable'} to its defineOperation, matching what the session read, and call finish_build again with the same executionId."
                      : error.reason === "commit_marks_undeclared"
                        ? "Not published: the composed script names none of its commit steps. List every step that can change the site (an autosave, a saved form step, the final submit) in order as write.commits, such as commits: ['save-address', 'place-order'], using short lowercase hyphenated names, and mark each with the context's enteringCommit(name) right before the execute call that can send it (an HTTP implementation calls journal.enteringCommit(name) before that request). Opening or filling an unsaved form is not a commit step. Then call finish_build again with the same executionId."
                        : error.reason === "commit_marks_unentered"
                          ? "Not published: the composed script declares a commit step that no act step of the session entered, so nothing shows its marks follow the real commit. Declare exactly the marks the session's act steps entered, marked by the same helper the composed script uses, and call finish_build again with the same executionId. If the session's steps entered none, it cannot publish: never run the write again for this; end the build and say its commit steps were not marked."
                          : error.reason === "confirmation_unrecorded"
                            ? "Not published: the declared write confirmation does not match the session. Name the act step that recorded the declared confirmation, or declare what the session actually read; a session that recorded a confirmation is never unverifiable. Then call finish_build again."
                            : error.reason === "contract_input_mismatch"
                              ? `Not published: the script's input schema rejects the input the example or session ran: the caller's own, or the exampleInput you passed when the caller's was empty (in maintenance, the original invocation's).${inputIssueText(error.inputIssues)} Correct the schema, or the code that reads that input, so this input decodes, then call finish_build again with the same executionId. Keep each input the tool needs required; make one optional only when the tool can work without it.`
                              : request.mode === "maintenance" && buildEffect !== "write"
                                ? "Not published: the script's output schema rejects the output this repair's example returned. A field the registered tool returns stays in the schema as registered. Fix the extraction so it returns that field, then run the example again and call finish_build with that new executionId. If the site no longer shows the field, propose mint_update with an output change for it, which the tool's owner must confirm, and a reason when it removes the field, or end with report_blocked, reason site_lacks_capability, naming the field."
                                : request.mode === "maintenance"
                                  ? "Not published: the script's output schema rejects the output this repair's write session returned. A field the registered tool returns stays in the schema as registered. Fix the extraction from what the session already read, then call finish_build again with the same executionId. If the site no longer shows the field, propose mint_update with an output change for it, which the tool's owner must confirm, and a reason when it removes the field, or end with report_blocked, reason site_lacks_capability, naming the field."
                                  : "Not published: the script's output schema rejects the output this read's example returned. Correct the schema so that output decodes: a field the example did not return must be optional or removed. Then call finish_build again with the same executionId.") +
                      (error.reason === "contract_output_mismatch" &&
                      request.mode === "maintenance" &&
                      buildEffect !== "write"
                        ? ""
                        : " The host extracts the contract offline; never run the write or the example again for this."),
                  );
                if (error.reason === "destination_validation") {
                  // Publication uses the route evidence the host recorded while the example ran.
                  // Source edits and another finish_build on the same receipt cannot change it,
                  // so only one fresh reviewed read gets a chance before the attempt ends.
                  destinationEvidenceRefusals++;
                  const freshRead =
                    repeatableRead && !executionClosed && destinationEvidenceRefusals === 1;
                  if (!freshRead)
                    terminal = {
                      build: "incomplete",
                      summary:
                        "Publication could not use the route evidence the host recorded for the example, and no fresh example can replace it in this attempt. The existing execution outcomes and protected results remain retained.",
                    };
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      destinationEvidenceGap: error.destinationEvidenceGap,
                      repeatableRead: freshRead,
                    },
                    "Not published: publication uses the route evidence the host recorded while this example ran. " +
                      destinationEvidenceInstruction[error.destinationEvidenceGap ?? "unknown"] +
                      " Source edits and another finish_build against this executionId cannot change it. " +
                      (freshRead
                        ? "Run one fresh reviewed execute with purpose example of the same source under the original input/account/budget, restoring the sign-in's login URL first if it changed, then call finish_build with the new executionId. Another refusal ends this attempt."
                        : "No fresh example can replace it in this attempt, which ends here. Preserve the recorded receipt."),
                  );
                }
                if (outputUnavailable)
                  return notPublished(
                    error.code,
                    error.reason,
                    {
                      rerunsRemaining: maximumUnavailableOutputReruns - unavailableOutputRefusals,
                      repeatableRead: true,
                    },
                    "Not published and not reviewed: the host could not read the retained output of this example, so there was nothing to judge. Run a fresh reviewed execute with purpose example of the same source under the original input/account so its result is retained, then call finish_build with that new executionId. Do not edit source for this reason. This is bounded; another unavailable output after the remaining re-runs ends publication.",
                  );
                return notPublished(
                  error.code,
                  error.reason,
                  {
                    expectedEntrypoint: error.expectedEntrypoint,
                    untrustedSignInOrigins: error.untrustedSignInOrigins,
                    ...(review === undefined ? {} : { review }),
                    diagnostic:
                      diagnostic._tag === "Right"
                        ? diagnostic.right
                        : "Publication diagnostic unavailable.",
                    repeatableRead,
                  },
                  (error.code === "ReviewDenied" && error.review !== undefined
                    ? "Not published: Guardian blocked this publication. Each finding's explanation says what is wrong, the evidence and the fix, at its file and byte range. Fix every finding and each missing item the rationale names, then call finish_build again with the same executionId. The existing example and result remain recorded."
                    : "Not published. The existing example and result remain recorded. Source edits and another finish_build publication review may continue; this does not guarantee the failure is repairable.") +
                    " A fresh reviewed example read requires an available live host and host repeatableRead:true within the same input/account after confirmed executor cleanup. Otherwise never repeat the example or a write step that may have committed.",
                );
              }
              return yield* publicationResult(publication.right, coverage, assumptions);
            }).pipe(recordPublicationDecision),
          ),
        // One open request at a time: the execution permit is held while the caller decides.
        requestInput: (input) =>
          serial.withPermits(1)(
            Effect.gen(function* () {
              // Asking needs no live execution: it stays open after execution closed and while a
              // write's outcome is uncertain. The agent still verifies before writing again.
              yield* active("publication");
              if (setsOwnWords(input))
                return JSON.stringify({
                  status: "question_invalid",
                  reason: "own_words_are_the_hosts",
                  userInputRequired: false,
                  instruction:
                    "Remove allowOther and allowNote from every question and ask again: the host lets the caller answer every choice and multi_choice in their own words.",
                });
              const proposed = callerVisibleRequest(
                yield* decode(AgentRequest, input),
                redactCallerText,
              );
              const submitted = {
                ...proposed,
                questions: (effectQuestion
                  ? withEffectAnswerLabels(proposed.questions)
                  : proposed.questions
                ).map(withOwnWords),
              };
              const refusal = requestShapeRefusal(submitted);
              if (refusal !== undefined)
                return JSON.stringify({
                  status: "question_refused",
                  reason: refusal.reason,
                  userInputRequired: false,
                  instruction: refusal.instruction,
                });
              if (!dependencies.askInput)
                return yield* new MintFailure({
                  code: "Unavailable",
                  reason: "executor_unavailable",
                });
              // The capability question is the host's own, so it cannot collect private data. Every
              // request the agent writes, the effect question included, is reviewed before the
              // caller sees it: the caller may answer any of its choices in their own words.
              let reviewId: string | undefined;
              // One id from proposal on: its review, the request the caller sees and its end.
              const requestId = randomUUID();
              if (dependencies.capabilityQuestion === undefined) {
                if (!dependencies.reviewQuestion)
                  return yield* new MintFailure({
                    code: "ReviewUnavailable",
                    reviewFailure: "Unavailable",
                  });
                const review = yield* dependencies.reviewQuestion(submitted, {
                  requestId,
                  ...(yield* publicationRefusals),
                });
                yield* reviewCompleted;
                reviewId = review.reviewId;
                // When the question came relative to the work before it, without reading the
                // model's reasoning: how much ran first and whether sign-in was tried.
                const priorPurposes = [...purposes.values()];
                yield* reportBestEffort(
                  dependencies.diagnostics?.emit("mint.input_requested", {
                    requestId,
                    ...(reviewId === undefined ? {} : { reviewId }),
                    questionCount: submitted.questions.length,
                    reviewOutcome: review.outcome,
                    priorExecutions: priorPurposes.length,
                    priorLiveExecutions: executions.filter((entry) => entry.effect !== "not_sent")
                      .length,
                    ...(priorPurposes.at(-1) === undefined
                      ? {}
                      : { lastExecutionPurpose: priorPurposes.at(-1) }),
                    authenticateAttempted: priorPurposes.includes("authenticate"),
                  }) ?? Effect.void,
                  {
                    component: "mint",
                    operation: "diagnostics.emit",
                    phase: "mint.input_requested",
                    correlation: dependencies.reportCorrelation ?? "process",
                  },
                );
                const rationale = yield* screenMintText(dependencies, review.rationale);
                // A read-or-write choice never asks for a login, so a login verdict means reword it.
                if (review.outcome === "authentication" && !effectQuestion) {
                  const login = dependencies.requestLogin
                    ? yield* dependencies.requestLogin()
                    : ("unavailable" as const);
                  if (login === "supplied" || login === "held") loginHeld = true;
                  if (login === "in_use")
                    return JSON.stringify({
                      status: "login_request",
                      login,
                      code: loginInUseAnswer.code,
                      ...loginInUseAnswer.fields,
                      rationale,
                      userInputRequired: false,
                      instruction: loginInUseAnswer.notice,
                    });
                  return JSON.stringify({
                    status: "login_request",
                    login,
                    rationale,
                    userInputRequired: false,
                    instruction: loginRequestInstruction(login),
                  });
                }
                if (review.outcome !== "allow_business")
                  return JSON.stringify({
                    status: "question_rejected",
                    rationale,
                    userInputRequired: false,
                    instruction:
                      "Reword the question using the rationale, or withdraw it and continue. Do not ask again for a value you were already given or that the site shows. A reworded question is reviewed again.",
                  });
              }
              const answers = yield* dependencies.askInput(submitted, {
                requestId,
                ...(reviewId === undefined ? {} : { reviewId }),
              });
              return yield* inputResult(submitted, answers);
            }).pipe(
              Effect.catchIf(
                (error) => error.noResponse !== undefined,
                // An owner's cancel is a choice to stop, never a question to decide without.
                (error) =>
                  error.ownerCancelled !== true && handsBackNoAnswer()
                    ? noAnswer()
                    : unanswered(error, "asking a question"),
              ),
              // error-reporting-allow: typed-recovery an invalid request is the model's to correct, told as its result
              Effect.catchIf(
                (error) => error.code === "InvalidRequest",
                () =>
                  Effect.succeed(
                    JSON.stringify({
                      status: "question_invalid",
                      userInputRequired: false,
                      instruction:
                        "The request was not valid: use unique lowercase question ids, unique option ids, at most eight questions and selection bounds that fit the options. Correct it and ask again.",
                    }),
                  ),
              ),
              Effect.catchIf(
                (error) => error.code === "ReviewUnavailable",
                (error) =>
                  diagnose({
                    phase: "question_review",
                    code: failureCode(error),
                    reviewFailure: error.reviewFailure,
                    reviewPhase: error.reviewPhase,
                  }).pipe(
                    Effect.zipRight(
                      reviewUnavailableRetry("question", () =>
                        Effect.sync(() => {
                          terminal ??= {
                            build: "incomplete",
                            hostFailure: "review_unavailable",
                            summary:
                              "The proposed question could not be reviewed. No user input request was created; prior execution outcomes remain retained.",
                          };
                          return JSON.stringify({
                            status: "question_review_unavailable",
                            code: "ReviewUnavailable",
                            userInputRequired: false,
                            instruction:
                              "Question review is unavailable. End this attempt; do not ask the question in prose or resubmit execution.",
                          });
                        }),
                      )(error),
                    ),
                  ),
              ),
            ),
          ),
        // The minter's own ending for a task impossible as asked: a
        // terminal outcome distinct from failure, with a typed reason and a screened explanation
        // its caller reads. It runs nothing and holds the permit only to order it with the rest.
        ...(questionOnly
          ? {}
          : {
              reportBlocked: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active("publication");
                    const report = yield* decode(BlockedReport, input);
                    // The host's own end, not the task's: no explanation reaches the caller, so
                    // none is reviewed, and the outcome names the host's cause.
                    if (report.reason === "host_unavailable") {
                      if (!hostIsUnavailable())
                        return JSON.stringify({
                          status: "blocked_refused",
                          reason: "host_available",
                          userInputRequired: false,
                          instruction:
                            "The host still offers live execution, so host_unavailable does not apply. Run what the build needs, such as the example again, then call finish_build.",
                        });
                      terminal ??= unavailableHostTerminal();
                      yield* diagnose({ phase: "blocked", reason: "host_unavailable" });
                      return JSON.stringify({
                        status: "host_unavailable",
                        notice:
                          "The build ended because the host has no live execution for what it still needs. It ends as the host's failure, not as blocked; nothing more runs in this attempt.",
                      });
                    }
                    const submitted = { ...report, reason: report.reason };
                    const explanation = redactCallerText(
                      yield* screenMintText(dependencies, submitted.explanation),
                    );
                    const refusal = blockedRefusal(
                      submitted.reason,
                      explanation,
                      yield* Clock.currentTimeMillis,
                    );
                    if (refusal !== undefined) return refusal;
                    const review = yield* reviewBlockedExplanation(explanation);
                    yield* active("publication");
                    if (review.outcome === "retry")
                      return reviewUnavailableAnswer(
                        review.error,
                        "Guardian could not review the explanation, so the build has not ended and nothing reached the caller. Call report_blocked again for a fresh review. If Guardian stays unavailable long enough, the build ends blocked and the caller reads only the reason's fixed sentence.",
                        { next: { retryable: true } },
                      );
                    // Guardian asked for other words: the agent revises or withdraws its
                    // explanation, and the build goes on. A reword never ends a build.
                    if (review.outcome !== "allow_business" && review.outcome !== "unavailable") {
                      yield* diagnose({
                        phase: "blocked",
                        reason: submitted.reason,
                        explanationReview: review.outcome,
                      });
                      return JSON.stringify({
                        status: "blocked_explanation_rejected",
                        reason: submitted.reason,
                        rationale: yield* screenRationale(review.rationale),
                        userInputRequired: false,
                        instruction:
                          "Guardian did not allow this explanation to reach the caller, so the build has not ended. Revise the explanation using the rationale and call report_blocked again, which is reviewed again, or withdraw it and continue the build.",
                      });
                    }
                    const shown = review.outcome === "allow_business";
                    const blocked = {
                      reason: submitted.reason,
                      ...(shown ? { explanation } : {}),
                    };
                    terminal = {
                      build: "incomplete",
                      blocked,
                      summary: `The build is blocked (${blocked.reason}): ${explanation}`,
                    };
                    yield* diagnose({
                      phase: "blocked",
                      reason: blocked.reason,
                      explanationReview: review.outcome,
                    });
                    return JSON.stringify({
                      status: "blocked",
                      reason: blocked.reason,
                      explanationShown: shown,
                      notice: shown
                        ? "The build ended blocked. Its caller reads the reason and your explanation; nothing more runs in this attempt."
                        : "The build ended blocked. Guardian could not review your explanation, so the caller reads only the reason's fixed sentence; nothing more runs in this attempt.",
                    });
                  }),
                ),
            }),
        // The minter's change to the task's settings, once the caller confirmed it. It runs
        // nothing on the site and holds the permit only to order it with the rest.
        ...(questionOnly ||
        dependencies.reviewTaskUpdate === undefined ||
        dependencies.applyTaskUpdate === undefined
          ? {}
          : {
              updateTask: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active("publication");
                    const decoded = yield* Effect.either(decode(TaskUpdateRequest, input));
                    if (decoded._tag === "Left")
                      return taskUpdateAnswer("update_invalid", {
                        instruction:
                          "The update was not valid: give a summary, one to eight changes, the ids of the answered questions that confirm it in confirmedBy (empty when the request already settles the change), and recommend update or new_mint. Correct it and call mint_update again.",
                      });
                    const submitted = decoded.right;
                    if (
                      submitted.recommend === "new_mint" &&
                      submitted.suggestedRequest === undefined
                    )
                      return taskUpdateAnswer("update_invalid", {
                        instruction:
                          "A recommended new build needs suggestedRequest: the request the caller could submit for it, in one or two plain sentences. Add it and call mint_update again.",
                      });
                    // The same update again, as after a takeover, is already applied.
                    if (taskState.updates.at(-1)?.requestDigest === taskUpdateDigest(submitted))
                      return yield* updatedAnswer(
                        submitted.changes,
                        "This update was already applied; nothing changed again.",
                      );
                    const refusal = taskUpdateRefusal(submitted);
                    if (refusal !== undefined) return taskUpdateAnswer("update_refused", refusal);
                    if (request.mode === "maintenance" && !keepsContract(submitted)) {
                      // Only the tool's owner confirms a change that takes from the registered
                      // contract; adding or tightening an output field takes nothing away.
                      const confirmer = yield* maintenanceConfirmer;
                      if (confirmer !== "owner")
                        return taskUpdateAnswer("update_refused", {
                          reason: "owner_unavailable",
                          instruction:
                            "No one who owns this tool can confirm a change that loosens or removes an output, or changes a requirement or the purpose, now, so nothing changed. Keep the registered contract: publish a repair that still returns every required output field (adding or tightening a field needs no confirmation), or end with report_blocked, reason site_lacks_capability, naming the field the site no longer shows.",
                        });
                      if (submitted.confirmedBy.length === 0)
                        return taskUpdateAnswer("clarification_required", {
                          source: "host",
                          reason: "confirmation_required",
                          instruction:
                            "A change to the published tool's contract needs its owner's confirmation, and nothing changed. Ask with request_input, naming the change and what the site no longer shows, then call mint_update again naming the questions answered in confirmedBy.",
                        });
                    }
                    if (
                      submitted.recommend === "update" &&
                      submitted.confirmedBy.length === 0 &&
                      submitted.changes.some(
                        (change) =>
                          change.setting === "site" ||
                          change.setting === "login" ||
                          change.setting === "effect",
                      )
                    )
                      return taskUpdateAnswer("clarification_required", {
                        source: "host",
                        reason: "confirmation_required",
                        instruction:
                          "A change of the site, the login or the effect widens what this build may do, so it needs the caller's confirmation and nothing changed. Ask the caller with request_input, then call mint_update again naming the questions they answered in confirmedBy.",
                      });
                    const unanswered = submitted.confirmedBy.filter(
                      (id) => !answeredQuestions.has(id),
                    );
                    if (unanswered.length > 0)
                      return taskUpdateAnswer("clarification_required", {
                        source: "host",
                        unanswered,
                        instruction:
                          "confirmedBy names questions the caller has not answered in this build, so nothing confirms the update and nothing changed. Ask the caller with request_input, then call mint_update again naming the questions they answered.",
                      });
                    return yield* reviewAndApplyTaskUpdate(submitted);
                  }).pipe(
                    Effect.catchIf(
                      (error) => error.code === "ReviewUnavailable",
                      (error) =>
                        diagnose({
                          phase: "task_update_review",
                          code: failureCode(error),
                          reviewFailure: error.reviewFailure,
                          reviewPhase: error.reviewPhase,
                        }).pipe(
                          Effect.zipRight(
                            reviewUnavailableRetry("update", () =>
                              Effect.sync(() => {
                                terminal ??= {
                                  build: "incomplete",
                                  hostFailure: "review_unavailable",
                                  summary:
                                    "The proposed task update could not be reviewed, so the task did not change. Prior execution outcomes remain retained.",
                                };
                                return taskUpdateAnswer("review_unavailable", {
                                  code: "ReviewUnavailable",
                                  instruction:
                                    "Task update review is unavailable. End this attempt; the task did not change.",
                                });
                              }),
                            )(error),
                          ),
                        ),
                    ),
                  ),
                ),
            }),
        // Read-only provider state. It takes no execution permit, dispatches no browser
        // action and grants no authority; unsupported hosts do not offer the tool.
        ...(dependencies.captchaState === undefined || questionOnly
          ? {}
          : {
              captchaState: (input: unknown) => {
                const read = dependencies.captchaState;
                return Effect.gen(function* () {
                  if (read === undefined) return yield* new MintFailure({ code: "Unavailable" });
                  yield* active();
                  yield* decode(Schema.Struct({}), input);
                  if (captchaChecks >= read.limit)
                    return JSON.stringify({ kind: "host_captcha_state", ...read.exhausted });
                  captchaChecks += 1;
                  const state = yield* read.read();
                  return JSON.stringify({ kind: "host_captcha_state", ...state });
                });
              },
            }),
        // A troubleshooting request for a new browser. It holds the execution permit, so
        // no execution runs while the browser changes, and it is never part of the published tool.
        ...(dependencies.requestBrowserRecovery === undefined || questionOnly
          ? {}
          : {
              requestBrowserRecovery: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    const request = dependencies.requestBrowserRecovery;
                    if (request === undefined)
                      return yield* new MintFailure({ code: "Unavailable" });
                    yield* active();
                    const { rationale } = yield* decode(
                      Schema.Struct({
                        rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
                      }),
                      input,
                    );
                    return JSON.stringify({
                      kind: "host_browser_recovery",
                      ...(yield* request(rationale)),
                    });
                  }),
                ),
            }),
        // The agent tests a signed-in marker before it sends it. The host may reload the page,
        // so the check holds the execution permit; it signs nothing in and sends no value. A host
        // without the check says so, and the agent compares the pages itself.
        ...(questionOnly
          ? {}
          : {
              checkSignedInMarker: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active();
                    const marker = yield* decode(SignedInMarkerCheckRequest, input);
                    const check = dependencies.checkSignedInMarker;
                    if (check === undefined)
                      return JSON.stringify({
                        kind: "host_signed_in_marker",
                        status: "unavailable",
                        notice:
                          "This host cannot test a marker. Confirm yourself that it is absent on the signed-out pages you explored before signing in, and present on the signed-in page and on another page you visited signed in.",
                      });
                    const result = yield* check(marker);
                    const verdict = validateSignedInMarker({ marker, check: result });
                    return JSON.stringify({
                      kind: "host_signed_in_marker",
                      // A pass the signed-out page could not confirm is not a plain pass.
                      status: !verdict.accepted
                        ? "refused"
                        : result.signedOutSnapshot === "unchecked"
                          ? "passed_unchecked"
                          : "passed",
                      ...result,
                      ...(verdict.accepted ? {} : { refusals: verdict.refusals }),
                      ...(verdict.warnings.length === 0 ? {} : { warnings: verdict.warnings }),
                    });
                  }),
                ),
            }),
        // A read's live tests: the cases the agent designed and their results, and batches
        // run in parallel browsers after one Guardian review. It holds the execution permit, since
        // a batch uses the build's own browser too.
        ...(dependencies.liveTests === undefined || questionOnly
          ? {}
          : {
              liveTests: (input: unknown) =>
                serial.withPermits(1)(
                  Effect.gen(function* () {
                    yield* active();
                    const request = yield* decode(LiveTestsRequest, input);
                    yield* Effect.try({
                      try: () => relativeSourcePath(request.entrypoint),
                      catch: () => new MintFailure({ code: "ScopeDenied" }),
                    });
                    if (!liveTestsOffered())
                      return JSON.stringify({
                        kind: "host_live_tests",
                        status: "unavailable",
                        instruction:
                          buildEffect === "write"
                            ? "A write build runs no live tests: its act session is the one run that proves it. Compose the script from the session and publish."
                            : "This read signed in, so it runs no live tests: its example alone proves the tool. Check src/tool-http.mjs once against the example's input, if you wrote one (execute purpose test, target liveBrowser, no testInput), run the example last, after your last edit, and publish.",
                      });
                    if (request.action === "plan")
                      return JSON.stringify(
                        yield* liveTestPlanView(request.entrypoint, {
                          show: request.cases ?? [],
                        }),
                      );
                    return yield* runLiveTests(request);
                  }),
                ),
            }),
      };
      /** The minter's history from before a compaction, which its run state no longer holds. */
      const historyArchive =
        dependencies.outcomeReview?.historyArchive === undefined
          ? memoryHistoryArchive()
          : bufferedHistoryArchive(dependencies.outcomeReview.historyArchive, (error) =>
              Effect.sync(() => {
                diagnostics.push(
                  JSON.stringify({
                    phase: "diagnostics",
                    reason: "history_archive_gap",
                    code: error.code,
                  }),
                );
              }),
            );
      /** What the minter's run state holds, which the model registers before its first request. */
      let liveHistory: (() => LiveMinterHistory) | undefined;
      /** Done once the model registered its run state, or ended without doing so. */
      const historyRegistered = yield* Deferred.make<void>();
      /** Each piece of the harness's evidence as the outcome reviewer reads it. */
      const recordChunk = (ref: string, text: string, range: { offset: number; limit: number }) => {
        const end = Math.min(text.length, range.offset + range.limit);
        return {
          ref,
          text: text.slice(range.offset, end),
          offset: range.offset,
          total: text.length,
          nextOffset: end < text.length ? end : null,
        };
      };
      /** A workspace file through the minter's own screened source read. */
      const workspaceChunk = (
        ref: string,
        path: string,
        range: { offset: number; limit: number },
      ) =>
        actions
          .readSource(path, { offset: range.offset, limit: Math.min(range.limit, 64_000) })
          .pipe(
            Effect.map((read) => {
              const chunk = decodeJsonObject(read);
              if (chunk._tag === "Left") return undefined;
              const source = chunk.right["source"];
              const total = chunk.right["total"];
              const next = chunk.right["nextOffset"];
              return typeof source !== "string" || typeof total !== "number"
                ? undefined
                : {
                    ref,
                    text: source,
                    offset: range.offset,
                    total,
                    nextOffset: typeof next === "number" ? next : null,
                  };
            }),
            // A file the workspace does not hold is a record the reviewer cannot read, not a failure.
            Effect.catchAll(() => Effect.succeed(undefined)),
          );
      const executionRecord = (entry: ExecutionEvidence) => ({
        ...entry,
        purpose: purposes.get(entry.executionId),
        ...(entrypoints.has(entry.executionId)
          ? { entrypoint: entrypoints.get(entry.executionId) }
          : {}),
        note: "The screened result the minter received is in its history: search_history for this executionId.",
      });
      const baseEvidence: OutcomeEvidence = {
        list: (kind) =>
          Effect.gen(function* () {
            if (kind === "execution")
              return executions.map((entry) => ({
                ref: `execution:${entry.executionId}`,
                kind,
                summary: JSON.stringify({
                  purpose: purposes.get(entry.executionId),
                  action: entry.review?.action,
                  status: entry.status,
                  effect: entry.effect,
                  confirmation: entry.confirmation,
                }),
              }));
            if (kind === "source")
              return [...new Set(entrypoints.values())].map((path) => ({
                ref: `source:${path}`,
                kind,
                summary:
                  "An entrypoint an execution ran; read any other workspace path the same way.",
              }));
            if (kind === "capture") {
              const index = yield* workspaceChunk(
                "capture:captures/index.json",
                "captures/index.json",
                {
                  offset: 0,
                  limit: 1,
                },
              );
              return index === undefined
                ? []
                : [
                    {
                      ref: "capture:captures/index.json",
                      kind,
                      summary: "The capture index; read it for the screened captures it lists.",
                    },
                  ];
            }
            return publications.map((_publication, index) => ({
              ref: `publication:${index + 1}`,
              kind,
              summary: "A finish_build result as the minter received it.",
            }));
          }),
        read: (ref, range) =>
          Effect.suspend(() => {
            const separator = ref.indexOf(":");
            const kind = ref.slice(0, separator);
            const id = ref.slice(separator + 1);
            if (separator < 1 || id === "") return Effect.succeed(undefined);
            if (kind === "execution") {
              const entry = executions.find((candidate) => candidate.executionId === id);
              return Effect.succeed(
                entry === undefined
                  ? undefined
                  : recordChunk(ref, JSON.stringify(executionRecord(entry)), range),
              );
            }
            if (kind === "publication") {
              const publication = publications[Number(id) - 1];
              return Effect.succeed(
                publication === undefined ? undefined : recordChunk(ref, publication, range),
              );
            }
            if (kind === "source" || (kind === "capture" && id.startsWith("captures/")))
              return workspaceChunk(ref, id, range);
            return Effect.succeed(undefined);
          }),
        task: () =>
          Effect.succeed({
            request: initialPrompt,
            answers: [...acceptedAnswers],
            state: {
              // The effective task after confirmed updates, in its screened form.
              task: {
                revision: taskState.revision,
                effect: taskState.effect,
                ...(taskState.siteOrigin === undefined ? {} : { siteOrigin: taskState.siteOrigin }),
                updates: taskState.updates,
              },
              buildEffect,
              writeSession,
              exampleClaimed,
              executionClosed,
              published: terminal?.build === "published",
            },
          }),
      };
      const reviewer = yield* makeOutcomeReviewer({
        host: dependencies.outcomeReview,
        evidence: dependencies.outcomeReview?.evidence?.(baseEvidence) ?? baseEvidence,
        history: minterHistory(
          historyArchive,
          () => liveHistory?.(),
          Deferred.await(historyRegistered),
        ),
        ...(recovered?.outcomeWrites === undefined
          ? {}
          : { recoveredWrites: recovered.outcomeWrites }),
      });
      dependencies.outcomeReview?.bindWrites?.(reviewer.outcomes);
      /** The outcome reviewer's readback requests, beside the host's own notices. */
      const drainNotices = () => {
        const notices = [
          ...(dependencies.drainHostNotices?.() ?? []),
          ...reviewer.observationRequests().map((observation) => ({
            kind: "outcome_review_observation",
            ...observation,
            instruction:
              "The outcome reviewer asks for this readback to settle whether that write changed the site. When it can be read without changing anything, run it as a read step; never repeat the write to answer it.",
          })),
        ];
        return notices.length === 0 ? undefined : notices;
      };
      const published = () => terminal?.build === "published";
      const reviewedActions: MintActions = {
        ...actions,
        // A published build with a write unresolved gives the reviewer its last turn;
        // publication itself never waits for it.
        finish: (input) =>
          actions.finish(input).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                publications.push(result);
              }),
            ),
            // Only a published build gives the reviewer its final turn; a refused publication
            // leaves the minter working and the reviewer on its ordinary turns.
            Effect.tap(() => (published() ? reviewer.finishing : Effect.void)),
          ),
      };
      const hostIncidentsBeforeStart = yield* dependencies.drainStartIncidents?.() ??
        Effect.succeed(undefined);
      const retainRuntimeRecord = dependencies.diagnostics?.retainRuntimeRecord;
      const observeModelTrace = dependencies.diagnostics?.observeModelTrace;
      /** The harness checkpoint, with `task` as its effective task. */
      /** One version's results for the checkpoint, under `field`, or nothing when it has none. */
      const liveTestsCheckpoint = (
        version: LiveTestVersion,
        field: "liveTests" | "liveTestsHttp",
      ): Partial<MintHarnessSnapshot> => {
        const records = [
          ...liveTestReplaced.filter((record) => liveTestVersion(record.entrypoint) === version),
          ...liveTestRecords[version].values(),
        ];
        return records.length === 0 ? {} : { [field]: records };
      };
      const captureHarness = (task: TaskState = taskState): MintHarnessSnapshot => ({
        executions: [...executions],
        // Replaced failures come first, so an older worker that keys records by id keeps the
        // latest. The HTTP version's results go in their own field, which an older worker drops.
        ...liveTestsCheckpoint("playwright", "liveTests"),
        ...liveTestsCheckpoint("http", "liveTestsHttp"),
        ...(liveTestsOutOfTime ? { liveTestsOutOfTime: true } : {}),
        ...(reviewer.tracked().length === 0 ? {} : { outcomeWrites: reviewer.tracked() }),
        purposes: [...purposes].map(([executionId, purpose]) => {
          const taskRevision = revisions.get(executionId);
          return { executionId, purpose, ...(taskRevision === undefined ? {} : { taskRevision }) };
        }),
        diagnostics: [...diagnostics],
        ...(example === undefined ? {} : { exampleId: example.executionId }),
        // A build becoming a write leaves its read example's claim behind.
        ...(task.effect === "write" && buildEffect !== "write"
          ? { exampleClaimed: false, writeSession: "none" as const }
          : { exampleClaimed, writeSession }),
        unavailableOutputRefusals,
        ...(terminal === undefined ? {} : { terminal }),
        ...(noResponse === undefined ? {} : { noResponse }),
        unavailableCauseRecorded,
        reviewUnavailableRetries: { ...reviewUnavailableRetries },
        ...(reviewOutageStartedAt === undefined ? {} : { reviewOutageStartedAt }),
        ...(invalidOutcomes === 0 ? {} : { invalidOutcomes }),
        ...(blockedReviewUnavailable ? { blockedReviewUnavailable: true as const } : {}),
        ...(guardianRefused ? { guardianRefused: true as const } : {}),
        ...(guardianCorrection ? { guardianCorrection: true as const } : {}),
        ...(noAnswerHandBacks === 0 ? {} : { noAnswerHandBacks }),
        ...(loginHeld ? { loginHeld: true as const } : {}),
        destinationEvidenceRefusals,
        inputFeedbackRounds,
        inputFeedbackPublicTool,
        inputFeedbackCoverage,
        providerUnavailableRetries,
        ...(providerOutageStartedAt === undefined ? {} : { providerOutageStartedAt }),
        // Deprecated and unread; written only so an older worker can restore this checkpoint.
        diagnosticRetentionRetries: 0,
        executionClosed,
        captchaChecks,
        ...(task.revision === 0 ? {} : { taskState: task }),
        ...(answeredQuestions.size === 0
          ? {}
          : {
              answeredQuestions: [...answeredQuestions].map(([id, answer]) => ({ id, answer })),
            }),
        ...(signInUnavailable === undefined ? {} : { signInUnavailable }),
        ...(publicationDenial === undefined ? {} : { publicationDenial }),
        ...(inputFeedbackReview === undefined ? {} : { inputFeedbackReview }),
      });
      const agentRecovery = dependencies.agentRecovery;
      yield* agentRecovery?.bindHarness?.(captureHarness) ?? Effect.void;
      const modelResult = yield* dependencies.model
        .run({
          runTool,
          ...(agentRecovery === undefined
            ? {}
            : {
                recovery: {
                  ...(agentRecovery.recoverTool === undefined
                    ? {}
                    : {
                        recoverTool: (call) =>
                          Effect.gen(function* () {
                            const recoveredTool = yield* agentRecovery.recoverTool?.(call) ??
                              Effect.succeed(undefined);
                            if (recoveredTool === undefined) return undefined;
                            if (recoveredTool.input !== undefined) {
                              const { request: asked, answers } = recoveredTool.input;
                              const result = yield* inputResult(asked, answers);
                              return { result: recoveredTool.result ?? result };
                            }
                            if (recoveredTool.publication !== undefined) {
                              const result = yield* publicationResult(
                                recoveredTool.publication.published,
                                yield* screenMintText(
                                  dependencies,
                                  recoveredTool.publication.coverage,
                                ),
                                yield* screenAssumptions(recoveredTool.publication.assumptions),
                              );
                              return { result: recoveredTool.result ?? result };
                            }
                            const execution = recoveredTool.execution;
                            if (execution === undefined) return { result: recoveredTool.result };
                            const result = yield* recoveredExecutionResult(
                              execution.evidence,
                              execution.purpose,
                              submittedEntrypoint(call.arguments),
                            );
                            return { result: recoveredTool.result ?? result };
                          }),
                      }),
                  ...(agentRecovery.initial === undefined
                    ? {}
                    : { initial: agentRecovery.initial.agent }),
                  save: (agent) => agentRecovery.save(agent, captureHarness()),
                },
              }),
          ...(effectQuestion ? { effectQuestion: true as const } : {}),
          ...(dependencies.autofillSignIn ? { autofillSignIn: true as const } : {}),
          input: JSON.stringify({
            ...(effectQuestion
              ? { effectQuestion: { instruction: effectQuestionInstruction } }
              : {}),
            screenedRequest: dependencies.capabilityQuestion
              ? {
                  instruction:
                    "Ask exactly this question through request_input as one text question with this prompt. No other action is authorized until the answer is reassessed.",
                  question: dependencies.capabilityQuestion,
                }
              : prompt,
            businessInputTypes,
            site,
            ...changedEntryNotice(),
            hostIncidentsBeforeStart,
            executionContext: yield* executionContext(),
            websiteAuthentication: {
              credentialsAvailable: dependencies.websiteCredentialsAvailable === true,
              instruction:
                dependencies.websiteCredentialsAvailable === true
                  ? `Credential values are private host input. When the task needs the account (AGENTS.md, 'Sign in only when the task needs it'), discover the login entry, then call execute purpose authenticate with its loginUrl${dependencies.autofillSignIn ? " and a signInStep for each sign-in screen" : ""} before the business example. You cannot request credentials; if the site cannot be reached, report that instead of starting sign-in. Codes and other sign-in steps during authenticate go to the caller through the host: a text, email or authenticator code that is part of signing in is a code field of the signInStep, never a request_input question.`
                  : "No website credentials are bound to this invocation. If the requested operation works signed out, proceed with its business flow and example without discovering a login or calling authenticate. If the task needs an account or the site presents a login wall, discover the actual login entry and pass it as loginUrl to execute purpose authenticate before dependent business work; the host asks the caller for a login and continues within the same call. You cannot request credentials; if the site cannot be reached, report that instead of starting sign-in. Codes and other sign-in steps during authenticate go to the caller through the host: a text, email or authenticator code that is part of signing in is a code field of the signInStep, never a request_input question.",
            },
          }),
          ...(dependencies.deadline ? { deadline: dependencies.deadline } : {}),
          session,
          instructions: dependencies.instructions,
          skills: dependencies.skills,
          ...(dependencies.hostToolDescriptions === undefined
            ? {}
            : { hostToolDescriptions: dependencies.hostToolDescriptions }),
          actions: withHostNotices(
            dependencies.retainCapture === undefined
              ? (({ retainCapture: _capture, ...available }) => available)(reviewedActions)
              : reviewedActions,
            drainNotices,
          ),
          history: {
            archive: historyArchive,
            live: (read) => {
              liveHistory = read;
              Deferred.unsafeDone(historyRegistered, Exit.void);
            },
          },
          screen: (value) => screenMintText(dependencies, value),
          isComplete: () =>
            stopUnavailableHost() ||
            stopRevokedAttempt() ||
            terminal !== undefined ||
            modelStoppedForSignIn,
          reportTrace: (value, timing) => {
            const retained = (
              dependencies.diagnostics?.[timing !== undefined ? "retainModelTranscript" : "emit"](
                "mint.model",
                value,
                timing === undefined
                  ? undefined
                  : {
                      modelTiming: timing,
                      ...(observeModelTrace === undefined ? {} : { lifecycleObserved: true }),
                      // With traced records the readable copy is a projection: it is never
                      // dropped for ordinary diagnostics, and a failed write is a recorded gap.
                      ...(retainRuntimeRecord === undefined ? {} : { required: true }),
                    },
              ) ?? Effect.void
            ).pipe(Effect.mapError(diagnosticUnavailable));
            // Readable copies and trace events are diagnosis: a failed write is a recorded gap and
            // the build goes on. The raw record of each model call (`retainRuntimeRecord`) is the
            // required trace, and stays fail closed.
            return retained.pipe(Effect.catchAll(recordDiagnosticGap("mint.model")));
          },
          ...(retainRuntimeRecord === undefined
            ? {}
            : {
                retainRuntimeRecord: (record: RuntimeRecordInput) =>
                  retainRuntimeRecord(record).pipe(Effect.mapError(diagnosticUnavailable)),
              }),
          ...(observeModelTrace === undefined
            ? {}
            : {
                observeTrace: (timing: ModelDiagnosticTiming) => {
                  Effect.runFork(observeModelTrace("mint.model", timing));
                },
              }),
          reportDiagnostic: (value) =>
            screenMintText(dependencies, value).pipe(
              Effect.tap((safe) =>
                Effect.sync(() => {
                  diagnostics.push(safe);
                }),
              ),
              Effect.asVoid,
            ),
          unresolvedGuidance: () =>
            Effect.suspend(() => {
              // Sign-in is unavailable and the model answered without publishing its retained
              // receipt: the model stops here, never after more prompts. Its outcome is settled
              // after the model stops, in the usual order: a flagged input-feedback publication,
              // then the host's own stop, then the sign-in outcome.
              if (signInUnavailable !== undefined) {
                modelStoppedForSignIn = true;
                return Effect.succeed(undefined);
              }
              const pending = unresolvedSignIn;
              if (
                pending === undefined ||
                pending.guided ||
                terminal !== undefined ||
                stopUnavailableHost()
              )
                return Effect.succeed(undefined);
              pending.guided = true;
              return screenMintText(
                dependencies,
                unresolvedSignInGuidance(pending.failure, pending.spent),
              );
            }),
        })
        .pipe(
          Effect.exit,
          Effect.ensuring(Scope.close(toolScope, Exit.void)),
          // A model that ended before registering its run state leaves the archive to read.
          Effect.ensuring(Deferred.done(historyRegistered, Exit.void)),
        );
      const modelFailure = Exit.isFailure(modelResult)
        ? Option.getOrUndefined(Cause.failureOption(modelResult.cause))
        : undefined;
      if (
        terminal === undefined &&
        (modelFailure?.diagnosticRetentionReason === "storage" ||
          modelFailure?.diagnosticRetentionReason === "serialization")
      ) {
        // A model call's raw record, the required trace, could not be retained, so the model
        // adapter blocked the next call: raw traces stay fail closed, while readable copies and
        // diagnostic retention are recorded gaps. Report the storage outcome, not a site or model
        // failure.
        terminal = {
          build: "incomplete",
          hostFailure: "diagnostic_retention",
          summary:
            "Required model trace retention failed, so the host stopped new model and tool work. Preserve recorded effects and receipts; this does not establish a website, browser or model failure.",
        };
        yield* diagnose({
          phase: "model_trace",
          code: modelFailure.code,
          diagnosticRetentionReason: modelFailure.diagnosticRetentionReason,
          diagnosticStorageFailure: modelFailure.diagnosticStorageFailure,
        });
      }
      // A minter that stopped without fixing Guardian's input feedback still publishes its last
      // reviewed candidate, privately and flagged, where the host has a fallback; without one the
      // build ends with the review's findings. Publication needs no browser or executor, but an
      // attempt that lost its lease publishes nothing.
      if (terminal === undefined && inputFeedbackRounds > 0 && !stopRevokedAttempt())
        yield* settleUnresolvedInputFeedback;
      // Background traffic can poison the host after the last tool call and completion check.
      // Name that cause instead of the generic stop, but never replace a terminal outcome.
      if (terminal === undefined) stopUnavailableHost(true);
      if (terminal === undefined) stopRevokedAttempt();
      // Sign-in stayed unavailable and the retained receipt never published.
      if (terminal === undefined && signInUnavailable !== undefined)
        terminal = signInUnavailable.outcome;
      // Live execution ended and the model stopped without publishing its retained receipt.
      if (terminal === undefined && executionClosed) terminal = unavailableHostTerminal();
      if (
        terminal === undefined &&
        Exit.isSuccess(modelResult) &&
        modelResult.value.stopReason === "repeated_final_without_tool"
      ) {
        terminal = {
          build: "incomplete",
          summary:
            "The minter kept answering without a tool call after the host asked it to continue, so the host ended this attempt. No build was published. Recorded effects and receipts are preserved.",
        };
        yield* diagnose({ phase: "continuation", reason: "repeated_final_without_tool" });
      }
      if (terminal === undefined && modelFailure?.modelOutage === "quota_exhausted")
        yield* endForSpentModelQuota(modelFailure, "model");
      // The outcome is already decided; its diagnostic copy never blocks returning it.
      yield* dependencies.diagnostics
        ?.emit("mint.model_finished", {
          state: Exit.isSuccess(modelResult) ? "completed" : "failed",
          diagnostics,
          executions,
          ...(dependencies.hostAnomalies === undefined
            ? {}
            : { anomalies: dependencies.hostAnomalies() }),
        })
        .pipe(
          Effect.mapError(diagnosticUnavailable),
          Effect.catchAll(recordDiagnosticGap("mint.model_finished")),
        ) ?? Effect.void;
      // The reviewer's final turn, when finish_build left a write unresolved, ends here; whatever
      // it decided stands, and an unresolved write is reported as possibly applied.
      const writes = yield* reviewer.close;
      const currentInvocation = dependencies.currentInvocation?.();
      finished.build = terminal?.build ?? "incomplete";
      // An unpublished build whose last publication Guardian denied says so, with its reason.
      const denied = finished.build === "incomplete" ? publicationDenial : undefined;
      return {
        ...(terminal ?? {
          build: "incomplete" as const,
          // The provider or the run's record failed, as opposed to the agent running out of
          // calls, turns or time, or choosing to stop.
          ...(modelFailure?.modelOutage === "unavailable"
            ? { hostFailure: "model_unavailable" as const }
            : {}),
          summary:
            denied === undefined
              ? "Minting stopped before publication; inspect recorded execution outcomes before continuing."
              : `Guardian's publication review denied the last publication (${[denied.reason, denied.category].filter((part) => part !== undefined).join(", ")}), and minting stopped before a corrected one was published; inspect recorded execution outcomes before continuing.`,
        }),
        ...(denied === undefined ? {} : { publicationDenial: denied }),
        ...(noResponse === undefined ? {} : { noResponse }),
        ...(example ? { example } : {}),
        ...(currentInvocation === undefined ? {} : { currentInvocation }),
        executions,
        ...(writes.length === 0 ? {} : { writes }),
        diagnostics,
      };
    }),
  );
