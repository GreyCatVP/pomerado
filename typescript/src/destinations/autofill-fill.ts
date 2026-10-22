import { randomUUID } from "node:crypto";
import { Effect, Either, Schema } from "effect";
import { failureDetail } from "../runtime/failure-detail.js";
import { type AutofillFillCall, autofillStepCode } from "./autofill-page-code.js";
import { unsupportedSelector } from "./autofill-locate-code.js";
import { firedRefusal, guardedSubmit, GuardRefusal } from "./autofill-submission-guard.js";
import {
  configuredOrigins,
  FoundAt,
  foundEvidence,
  foundFor,
  FoundIn,
  judgedOrigins,
  locatedRefusal,
  lostTypingPhase,
  namedAfterTyping,
  refused,
  targetEvidence,
  withCheck,
  withEvidence,
} from "./autofill-refusal.js";
import {
  type AutofillFieldStatus,
  type AutofillInspection,
  type AutofillPage,
  type AutofillRefusal,
  type AutofillStep,
  type FillSlot,
  type AutofillStepReport,
  hostSubmits,
  LocatedError,
  notingHostTrust,
  Targets,
  untrustedTarget,
} from "./autofill-step.js";
import {
  type CredentialKeyboard,
  type CredentialTypingMode,
  type InsertionRefusal,
} from "./credential-keyboard.js";
import { PageControls } from "./page-controls.js";

/** One fill call's answer: a control that moved, an empty field the host typed, or its own. */
const FillAnswer = Schema.Union(
  LocatedError,
  /**
   * A typed field holds nothing, or, before a submit, a code box (`field`) does not hold exactly
   * one character.
   */
  Schema.Struct({
    checked: Schema.Literal(false),
    field: Schema.optional(Schema.Number),
    url: Schema.String,
  }),
  Schema.Struct({
    focused: Schema.Boolean,
    /** Why the field did not take the focus: the error focusing threw, or the tag that holds it. */
    unfocused: Schema.optional(
      Schema.Union(
        Schema.Struct({ focusError: Schema.String }),
        Schema.Struct({ activeTag: Schema.String }),
      ),
    ),
    located: Schema.optional(FoundIn),
    url: Schema.String,
    /** When the primary page's document began loading, read once the field took the focus. */
    document: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    dated: Schema.Boolean,
    url: Schema.String,
    document: Schema.optional(Schema.Number),
  }),
  /** The submit call found that the page sent what was typed itself (`pageSentCode`). */
  Schema.Struct({ pageSent: Schema.Literal(true), url: Schema.String }),
  Schema.Struct({
    /** `disabled`: the submit was disabled, so the call clicked nothing. */
    submit: Schema.Literal("clicked", "failed", "disabled", "none"),
    url: Schema.String,
    controls: Schema.optional(PageControls),
    /** What a failed click's spot showed instead of the submit, by tag, id, classes and role. */
    covered: Schema.optional(Schema.String),
  }),
  GuardRefusal,
);
type FillAnswer = typeof FillAnswer.Type;
/** A call that found a control changed since the host last judged it did nothing: each as found. */
const Changed = Schema.Struct({
  changed: Targets,
  located: Schema.optional(FoundAt),
  url: Schema.String,
});
/**
 * A call the host refused, with the primary page then. `left`: a submit call of a step with a
 * submit found a field gone from the document the host typed in, which a new document may yet
 * replace (`screenGone`).
 */
type Stop = {
  readonly refusal: AutofillRefusal;
  readonly url?: string | undefined;
  readonly left?: true;
};
/** A fill call's answer once the host judged it: a refusal, or the call's own answer. */
type CallAnswer = Exclude<FillAnswer, typeof LocatedError.Type> | Stop;

const properties = [
  "ownerUrl",
  "ancestors",
  "documentOrigin",
  "editable",
  "control",
  "actions",
  "methods",
  "explicitGet",
  "submitMethod",
] as const;
/** Each control of two judgments: the field's index or `submit`, as judged before and now. */
const controls = (before: typeof Targets.Type, after: typeof Targets.Type) => [
  ...after.fields.map((now, index) => ({ at: index, was: before.fields[index], now })),
  { at: "submit" as const, was: before.submit, now: after.submit },
];
/**
 * Which properties of which controls differ between two judgments, by name only. The submit's
 * `editable` only follows whether it is disabled, which no call judges as a change.
 */
const changedProperties = (before: typeof Targets.Type, after: typeof Targets.Type) =>
  controls(before, after)
    .flatMap(({ at, was, now }) =>
      properties
        .filter((key) => !(at === "submit" && key === "editable"))
        .filter((key) => JSON.stringify(was?.[key]) !== JSON.stringify(now?.[key]))
        .map((key) => `${at}.${key}`),
    )
    .join(" ");
/**
 * The first control whose form changed how or where it submits, which is never judged again: a
 * switch to GET would put the values in a URL Guardian never judged, and the request watch counts
 * only the endpoints judged at inspection. Page code reports where a form submits by origin and
 * path alone, so an action's query or hash never counts as a change.
 */
const resubmitted = (
  before: typeof Targets.Type,
  after: typeof Targets.Type,
  named: ReadonlySet<string> | undefined,
) => {
  const moved = controls(before, after).find(
    ({ was, now }) =>
      JSON.stringify(was?.methods) !== JSON.stringify(now?.methods) ||
      (was?.explicitGet ?? false) !== (now?.explicitGet ?? false) ||
      was?.submitMethod !== now?.submitMethod ||
      JSON.stringify(was?.actions) !== JSON.stringify(now?.actions),
  );
  return (
    moved &&
    withCheck(
      refused("credential_target_refused", moved.at),
      "change",
      targetEvidence(moved.now, named),
    )
  );
};

/**
 * The step's code boxes, by field index: its code fields whose values are one character each, when
 * there are two or more, as the host splits one code across one-character boxes. Otherwise none.
 */
const codeBoxes = (step: AutofillStep<FillSlot>, values: readonly string[]) => {
  const boxes = step.fields.flatMap((field, index) =>
    field.slot === "code" && Array.from(values[index] ?? "").length === 1 ? [index] : [],
  );
  return boxes.length > 1 ? boxes : [];
};

/** What the fill has done so far. */
interface FillProgress {
  readonly statuses: AutofillFieldStatus[];
  /** Whether any value may have reached the page. */
  typed: boolean;
  /** The field the host typed last, which the next call checks holds something. */
  check: number | null;
  /** The controls as the host last judged them; a call acts only when it finds them so. */
  judged: typeof Targets.Type;
  /** The id the page keeps `judged` under, as the call that found it kept it. */
  judgment: string | undefined;
  /** The id the page keeps where it was as each field was typed under (`pageSentCode`). */
  readonly typedAt: string;
  /**
   * The document the host typed the last field in, by when it began loading, which a submit call
   * that finds the screen gone compares against (`screenGone`).
   */
  typedIn: number | undefined;
  /** The origins `trustSignInUrl` trusted as the host judged again a control the page moved. */
  readonly trusted: Set<string>;
}

/** The report's `trustedSignInOrigins`, when the fill's own judgments trusted any. */
const trustedByHost = (progress: FillProgress) =>
  progress.trusted.size === 0 ? {} : { trustedSignInOrigins: [...progress.trusted].sort() };

const filledReport = (
  step: AutofillStep<FillSlot>,
  progress: FillProgress,
  submit: "clicked" | "failed" | "not_attempted" | "refused" | "stayed_disabled" | "none" | "page",
  url: string,
  refusal?: AutofillRefusal,
  clicked?: true,
): AutofillStepReport => ({
  outcome: "filled",
  fields: step.fields.map((field, index) => ({
    slot: field.slot,
    status: progress.statuses[index] ?? "not_attempted",
  })),
  submit,
  ...(clicked === undefined ? {} : { clicked }),
  url,
  ...(refusal?.failureDetail === undefined ? {} : { failureDetail: refusal.failureDetail }),
  ...(progress.typed ? { typed: true as const } : {}),
  ...trustedByHost(progress),
});

/** Whether a text holds any of the step's values, whatever its case. */
const holdsValue = (text: string, values: readonly string[]) =>
  values.some((value) => value !== "" && text.toLowerCase().includes(value.toLowerCase()));

/** The labels a failed call that held a value keeps of its error, by their names in its context. */
const errorLabels = { code: "errorCode", reason: "errorReason", method: "errorMethod" } as const;

/**
 * An error's string labels, such as a DevTools command's finite reason and its method, each kept
 * only when no value of the step appears in it. Never the error's message or parameters.
 */
const valueFreeLabels = (error: Error, values: readonly string[]) => {
  const labels: Record<string, string> = {};
  for (const [key, name] of Object.entries(errorLabels)) {
    const label: unknown = Reflect.get(error, key);
    if (typeof label === "string" && !holdsValue(label, values)) labels[name] = label;
  }
  return labels;
};

/**
 * A failed focus can refuse before typing. A date or submit can already have changed the site
 * even when it was the first call, so a lost reply stays uncertain. A date's call held the date,
 * and a typing call its value (`held`, the step's values), so their failures keep finite facts
 * only. A typing call's failure has the phase `lostTypingPhase`: the host clicks the submit only
 * after every field.
 */
const failedCall = (
  progress: FillProgress,
  error: Error,
  call: {
    readonly held?: readonly string[];
    readonly mayMutate: boolean;
    readonly typing?: true;
  },
): AutofillStepReport => {
  const detail =
    call.held === undefined
      ? failureDetail("autofill_step_failed", { operation: "autofill.fill", error })
      : failureDetail("autofill_step_failed", {
          operation: "autofill.fill",
          ...(call.typing === true ? { phase: lostTypingPhase } : {}),
          context: { errorName: error.name, ...valueFreeLabels(error, call.held) },
        });
  return progress.typed || call.mayMutate
    ? {
        outcome: "uncertain",
        reason: "fill_call_failed",
        failureDetail: detail,
        ...(progress.typed || call.held !== undefined ? { typed: true as const } : {}),
        ...trustedByHost(progress),
      }
    : { ...refused("page_unavailable"), failureDetail: detail };
};

/**
 * A control the host refused, or a field the host typed that holds nothing: a refusal before
 * anything was typed. After, the field about to be typed fails untyped, as a fill into it would, a
 * typed field left empty fails, as does a code box that holds other than one character when the
 * host is about to submit, and only the submit's recheck refuses the submit.
 */
const stopped = (
  step: AutofillStep<FillSlot>,
  progress: FillProgress,
  answer:
    | Stop
    | { readonly checked: false; readonly field?: number | undefined; readonly url: string },
  during: "field" | "submit",
): AutofillStepReport => {
  if ("checked" in answer) {
    const failed = answer.field ?? progress.check;
    if (failed !== null) progress.statuses[failed] = "failed";
    return filledReport(step, progress, "not_attempted", answer.url);
  }
  if (!progress.typed) return answer.refusal;
  if (during === "submit")
    return filledReport(step, progress, "refused", answer.url ?? "", answer.refusal);
  progress.statuses.push("failed");
  return filledReport(step, progress, "not_attempted", answer.url ?? "", answer.refusal);
};

/**
 * The origins the guard's record may name: those judged at inspection, or, when the host typed into
 * the page before it, only those `namedAfterTyping` allows, since the inspection may itself have
 * found a typed value in any other, such as an action's host.
 */
const guardOrigins = (input: FillInput) =>
  namedAfterTyping(input.inspection) ?? judgedOrigins(input.inspection);

/**
 * The origins a refusal's evidence may name: any until something was typed into the page, then
 * only the guard's (`guardOrigins`), since page code may have put a typed value in another.
 */
const evidenceOrigins = (input: FillInput, progress: FillProgress) =>
  progress.typed || input.inspection.judgedBeforeTyping !== undefined
    ? guardOrigins(input)
    : undefined;

interface FillInput {
  readonly step: AutofillStep<FillSlot>;
  readonly values: readonly string[];
  readonly inspection: AutofillInspection;
  readonly page: AutofillPage;
  readonly keyboard: CredentialKeyboard;
  /** How each value is typed; `paste` by default. */
  readonly typing?: CredentialTypingMode;
  /**
   * How long the page may take to navigate after the submit, then to load; 5 s by default. A step
   * with no submit gives the page as long, at most `pageSendMs`, to send what was typed itself.
   */
  readonly settleMs?: number;
  /**
   * Whether the submit call reads the page's alerts just before its click, so its report counts
   * the ones after it that are new (`newAlerts`). The read waits for every frame, so only a host
   * that reads the count asks; a read that takes longer than `alertsBeforeMs` counts nothing.
   */
  readonly countNewAlerts?: boolean;
}

/**
 * The host's judgment of the controls a call found changed, by inspection's rule, where only a
 * field still to be typed must take typing: a refusal, or undefined to call again. A form that
 * changed how or where it submits, beyond an action's query or hash, and a page that changed them
 * a third time (`changes`, counted across every call the host makes again for it) are refused.
 * Controls judged so are ones the host may act on, so the origins `trustSignInUrl` trusted for
 * them join the fill's (`progress.trusted`).
 */
const rejudge = (
  input: FillInput,
  progress: FillProgress,
  changed: typeof Targets.Type,
  call: AutofillFillCall,
  changes: number,
) => {
  const target = call.kind === "submit" ? "submit" : call.index;
  const from = call.kind === "submit" ? input.step.fields.length : call.index;
  const judged = progress.judged;
  const named = evidenceOrigins(input, progress);
  const trusted = new Set<string>();
  const trust = {
    ...input.inspection,
    trustSignInUrl: notingHostTrust(input.inspection.trustSignInUrl, trusted),
  };
  const refusal =
    untrustedTarget(changed, input.step, trust, from, named) ??
    resubmitted(judged, changed, named) ??
    (changes >= 3
      ? withCheck(
          refused("credential_target_refused", target),
          "change",
          targetEvidence(target === "submit" ? changed.submit : changed.fields[target], named),
        )
      : undefined);
  if (refusal === undefined) for (const origin of trusted) progress.trusted.add(origin);
  return refusal;
};

/**
 * A submit call that found the screen gone once every field was typed: `sent` when the page took
 * it away itself. On a step with no submit, a field gone or its popup closed, as a code widget does
 * when it sends what its last box completed. On a step with a submit or a submit key, only a field
 * gone because a new document replaced the one the host typed the last field in (`typedIn`), as a
 * form that submits itself on its last input does: the host's click or key press never ran, so
 * nothing went out twice, and
 * the sign-in's next check decides what the page sent. A field gone from that same document is
 * `left`: a form that takes its fields away or puts a new path in the address with pushState
 * loaded no new document, so it stays a refusal unless one loads within the host's wait.
 */
const screenGone = (
  step: AutofillStep<FillSlot>,
  answer: typeof LocatedError.Type,
  typedIn: number | undefined,
): "sent" | "left" | undefined => {
  if (step.fields.length === 0) return undefined;
  const fieldGone = answer.error === "not_found" && typeof answer.target === "number";
  if (!hostSubmits(step))
    return fieldGone || answer.error === "popup_missing" ? "sent" : undefined;
  if (!fieldGone) return undefined;
  return typedIn !== undefined && answer.document !== undefined && answer.document !== typedIn
    ? "sent"
    : "left";
};

/**
 * One Kernel call of the fill, which first checks the field the host typed last. A call that finds
 * a control changed since the host last judged it does nothing, and the host judges the controls
 * it found again (`rejudge`), then calls again against that judgment, which the page kept as that
 * call found it: no call's code holds an address the page supplied. `changes` counts the changes
 * found, shared by every call the host makes again for the same action.
 */
const fillCall =
  (input: FillInput, progress: FillProgress, changes = { count: 0 }) =>
  (call: AutofillFillCall): Effect.Effect<Either.Either<CallAnswer, Error>> =>
    Effect.gen(function* () {
      for (;;) {
        const observed = randomUUID();
        const answered = yield* input.page
          .execute(
            autofillStepCode(input.page.targetId, input.step, observed, {
              call,
              popupTargetId: input.inspection.popupTargetId,
              judged: progress.judgment,
              check: progress.check,
              typedAt: progress.typedAt,
            }),
            call.kind === "focus" ? 15 : 30,
          )
          .pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Union(FillAnswer, Changed))),
            Effect.either,
          );
        if (answered._tag === "Left") return Either.left(answered.left);
        const answer = answered.right;
        if ("error" in answer) {
          const gone =
            call.kind === "submit" ? screenGone(input.step, answer, progress.typedIn) : undefined;
          return Either.right<CallAnswer>(
            gone === "sent"
              ? { pageSent: true, url: answer.url ?? "" }
              : {
                  refusal: locatedRefusal(answer, evidenceOrigins(input, progress)),
                  url: answer.url,
                  ...(gone === "left" ? { left: true as const } : {}),
                },
          );
        }
        if (!("changed" in answer)) return Either.right(answer);
        const changed = changedProperties(progress.judged, answer.changed);
        changes.count++;
        const untrusted = rejudge(input, progress, answer.changed, call, changes.count);
        if (untrusted !== undefined)
          return Either.right<Stop>({
            refusal: withEvidence(untrusted, {
              changed,
              ...foundEvidence(
                answer.url,
                foundFor(answer.located, untrusted.target),
                evidenceOrigins(input, progress),
              ),
            }),
            url: answer.url,
          });
        progress.judged = answer.changed;
        progress.judgment = observed;
      }
    });

/**
 * How long the host waits for the page to enable a disabled submit once the fields are filled: the
 * 5 s each of its control actions (focus, fill, click) may take. Many sign-in forms enable their
 * submit only on input, some after a short check of what was typed.
 */
const submitEnableMs = 5_000;
/**
 * How long the host gives a step with no submit to send what was typed itself once every field is
 * filled, as a code widget may a moment after its last box: the step's settle wait, at most 2 s,
 * since a step that only shows more of the same screen has no submit either.
 */
const pageSendMs = 2_000;
/** How often the host calls the submit again while it waits on the page. */
const submitPollMs = 250;

/** A submit call that clicked nothing because the submit was disabled, or the step names none. */
const unclicked = (answered: Either.Either<CallAnswer, Error>, submit: "disabled" | "none") =>
  Either.isRight(answered) && "submit" in answered.right && answered.right.submit === submit;

/** A submit call that found a field gone from the document the host typed in (`screenGone`). */
const leftOnly = (answered: Either.Either<CallAnswer, Error>) =>
  Either.isRight(answered) && "left" in answered.right && answered.right.left === true;

/** A submit call that found the page sent what was typed itself. */
const pageSent = (answered: Either.Either<CallAnswer, Error>) =>
  Either.isRight(answered) && "pageSent" in answered.right;

/**
 * After a submit call of a step with a submit found its fields gone from the document the host
 * typed in (`left`, a refusal): looks again for up to `sendMs`, the step's settle wait at most
 * `pageSendMs`, in case a new document replaces it, as a form that hides itself while it sends what
 * was typed, then loads the site's answer, does. Each look only reads the page, never clicks, so a
 * look that fails, as one does while the page navigates, is a look lost. A look that finds the page
 * sent what was typed reports that (`page`); one that finds the fields back, or the wait's end,
 * leaves the first refusal standing.
 */
const awaitNewDocument = (
  input: FillInput,
  progress: FillProgress,
  call: AutofillFillCall,
  left: Either.Either<CallAnswer, Error>,
  sendMs: number,
  changes: { count: number },
) =>
  Effect.gen(function* () {
    if (call.kind !== "submit") return left;
    const since = Date.now();
    const look: AutofillFillCall = { ...call, look: true };
    while (Date.now() - since < sendMs) {
      yield* Effect.sleep(submitPollMs);
      const answered = yield* fillCall(input, progress, changes)(look);
      if (pageSent(answered)) return answered;
      if (Either.isRight(answered) && !leftOnly(answered)) return left;
    }
    return left;
  });

/**
 * The step's submit call, made again while the page keeps the submit disabled, for up to
 * `submitEnableMs`, and while a step with fields and no submit has not seen the page send them
 * itself, for up to `pageSendMs` from the first call that found no submit. Each call judges every
 * control again before it clicks, and none clicks a disabled submit. The changes they find count
 * across the whole wait, so a page that keeps changing a control is refused however the changes
 * fall between the calls. On a step with no submit the call only reads the page, so one that fails
 * there, as when the page navigates or draws itself again while the call reads it, is a look lost:
 * the host looks again, at least once after it, even past the wait. When a later look finds the
 * page sent what was typed, the fill reports that; otherwise the first failure stands. On a step
 * with a submit whose fields are gone from the document the host typed in, the host looks again
 * without clicking (`awaitNewDocument`).
 */
const submitWhenEnabled = (input: FillInput, progress: FillProgress, call: AutofillFillCall) =>
  Effect.gen(function* () {
    const started = Date.now();
    const sendMs = input.step.fields.length > 0 ? Math.min(input.settleMs ?? 5_000, pageSendMs) : 0;
    const readsOnly = !hostSubmits(input.step) && sendMs > 0;
    let unsentSince: number | undefined;
    let lost: Either.Either<CallAnswer, Error> | undefined;
    let lastLost = false;
    const changes = { count: 0 };
    for (;;) {
      const answered = yield* fillCall(input, progress, changes)(call);
      if (leftOnly(answered) && sendMs > 0)
        return yield* awaitNewDocument(input, progress, call, answered, sendMs, changes);
      const failed = readsOnly && Either.isLeft(answered);
      const unsent = unclicked(answered, "none") || failed;
      if (unsent) unsentSince ??= Date.now();
      const waiting = unclicked(answered, "disabled")
        ? Date.now() - started < submitEnableMs
        : unsent &&
          (Date.now() - (unsentSince ?? started) < sendMs || (failed && !lastLost));
      if (failed) lost ??= answered;
      lastLost = failed;
      if (!waiting) return lost === undefined || pageSent(answered) ? answered : lost;
      yield* Effect.sleep(submitPollMs);
    }
  });

/**
 * One field: a date's call fills it; any other field's call focuses it and binds its original node/document/frame; the host inserts its
 * value atomically. Undefined when the fill goes on to the next field, else the step's report.
 */
const fillField = (
  input: FillInput,
  progress: FillProgress,
  index: number,
): Effect.Effect<AutofillStepReport | undefined> =>
  Effect.gen(function* () {
    const field = input.step.fields[index];
    const value = input.values[index] ?? "";
    const bindingKey = `__pomerado_autofill_${randomUUID()}`;
    const format = field?.slot === "date_of_birth" ? (field.format ?? "YYYY-MM-DD") : undefined;
    const answered = yield* fillCall(
      input,
      progress,
    )(
      format === undefined
        ? { kind: "focus", index, bindingKey }
        : { kind: "date", index, iso: value, format },
    );
    if (answered._tag === "Left")
      return failedCall(progress, answered.left, {
        ...(format === undefined ? {} : { held: input.values }),
        mayMutate: format !== undefined,
      });
    const answer = answered.right;
    if ("refusal" in answer || "checked" in answer)
      return stopped(input.step, progress, answer, "field");
    progress.check = null;
    return yield* afterFieldCall(input, progress, index, answer, bindingKey);
  });

/**
 * A field that did not take the focus, or whose native insertion refused (`insertion`, its finite
 * cause), and why. A private answer's question that changed is a change on the screen, as when the
 * call found it changed before focusing.
 */
const untypedRefusal = (
  input: FillInput,
  progress: FillProgress,
  index: number,
  answer: Extract<CallAnswer, { readonly focused: boolean }>,
  insertion: InsertionRefusal | undefined,
) =>
  withCheck(
    refused("credential_target_refused", index),
    insertion === undefined
      ? "not_focused"
      : insertion === "question_changed"
        ? "change"
        : "typing_refused",
    {
      ...answer.unfocused,
      ...(insertion === undefined ? {} : { insertion }),
      ...(insertion === "question_changed" ? { cause: "question_changed" } : {}),
      ...targetEvidence(progress.judged.fields[index], evidenceOrigins(input, progress)),
      ...foundEvidence(answer.url, answer.located, evidenceOrigins(input, progress)),
    },
  );

/** What a field's own call found: a date filled, or a focused field the host now types. */
const afterFieldCall = (
  input: FillInput,
  progress: FillProgress,
  index: number,
  answer: Exclude<CallAnswer, Stop | { readonly checked: false }>,
  bindingKey: string,
): Effect.Effect<AutofillStepReport | undefined> =>
  Effect.gen(function* () {
    if ("dated" in answer) {
      // A date's call may have changed the field even when it failed.
      progress.typed = true;
      progress.typedIn = answer.document;
      progress.statuses.push(answer.dated ? "filled" : "failed");
      return answer.dated
        ? undefined
        : filledReport(input.step, progress, "not_attempted", answer.url);
    }
    if (!("focused" in answer)) return refused("page_unavailable");
    let insertion: InsertionRefusal | undefined;
    if (answer.focused) {
      const value = input.values[index] ?? "";
      const typing = yield* Effect.either(
        input.keyboard.insertText(
          {
            targetId: input.inspection.popupTargetId,
            bindingKey,
            documentOrigin: progress.judged.fields[index]?.documentOrigin ?? "",
          },
          value,
        ),
      );
      if (typing._tag === "Left")
        return failedCall(progress, typing.left, {
          held: input.values,
          mayMutate: true,
          typing: true,
        });
      if (typing.right === "inserted") {
        progress.typed = true;
        progress.typedIn = answer.document;
        progress.statuses.push("filled");
        progress.check = index;
        return undefined;
      }
      insertion = typing.right;
    }
    const refusal = untypedRefusal(input, progress, index, answer, insertion);
    if (!progress.typed) return refusal;
    progress.statuses.push("failed");
    return filledReport(input.step, progress, "not_attempted", answer.url, refusal);
  });

/**
 * Fills the values into the step's fields, in order, and clicks its submit, on the stable primary tab or its inspected authentication popup,
 * judging every control again before each call acts. Kernel calls
 * focus and bind each field and click; the host inserts each value atomically into that original
 * node over its own encrypted DevTools socket (`keyboard`), so no value but a date of birth ever enters a Kernel call's script text or
 * its request to Kernel's REST API. It reports per-field outcomes and never a
 * value. Once anything was typed, a call that fails or finds a control refused can no longer say
 * nothing reached the site: a lost answer is `uncertain`, a control refused before a field's typing
 * fails that field, and one refused before the click, or a submission refused as it fires, refuses
 * the submit. That click ran, though, so the report says so (`clicked`): the page's own handlers
 * ran on it, and what the step filled may have gone out. A submit the page keeps disabled is never
 * clicked: the host waits for the page to enable it once the fields are filled, and when it stays
 * disabled the report says so (`stayed_disabled`). A step whose code the host typed one character
 * per box into several code fields is submitted only once every box holds exactly one character;
 * otherwise that box fails and the submit is not attempted. On a step with fields and no submit, a
 * page that moves on once every field is typed sent what was typed itself (`page`), never a refusal:
 * the step's fields went away or were all disabled, its popup closed, its address moved to another
 * path, or a step of several fields came back emptied. The host gives the page up to `pageSendMs`
 * to do so, and a submit call that fails meanwhile is followed by another look (`submitWhenEnabled`).
 * A step with a submit is the host's to click, whatever its page does meanwhile, unless a new
 * document took the place of the one the host typed the last field in, and the step's fields went
 * with it, before the click or within `pageSendMs` of a look that found them gone: the page sent
 * the form itself (`page`, `screenGone`, `awaitNewDocument`), and the host clicks nothing. A form
 * that locks, redraws itself or changes its address with pushState has sent nothing, and the host
 * waits on it or refuses as before.
 * Guardian's refusals still come first: a control that moved off the site or changed how it
 * submits refuses the submit as before.
 */
export const fillAutofillStep = (input: FillInput): Effect.Effect<AutofillStepReport> =>
  Effect.gen(function* () {
    const { step } = input;
    if (input.typing === "keyboard")
      return withCheck(refused("typing_unavailable"), "typing_unavailable");
    const crossing = unsupportedSelector(step);
    if (crossing !== undefined)
      return withCheck(refused("selector_unsupported", crossing), "selector_unsupported");
    const progress: FillProgress = {
      statuses: [],
      typed: false,
      check: null,
      judged: input.inspection.targets,
      judgment: input.inspection.judgment,
      typedAt: randomUUID(),
      typedIn: undefined,
      trusted: new Set(),
    };
    for (let index = 0; index < step.fields.length; index++) {
      const ended = yield* fillField(input, progress, index);
      if (ended !== undefined) return ended;
    }
    // A re-judge never changes a method, so the submission's method is the one judged now.
    const clicked = yield* submitWhenEnabled(
      input,
      progress,
      guardedSubmit(step, progress.judged, {
        settleMs: input.settleMs ?? 5_000,
        inspection: input.inspection.judgment,
        // Once something was typed before inspection, only a secret inside an origin no page chose
        // Is no leak: the page may have put one in any path or query.
        exempt:
          input.inspection.judgedBeforeTyping === undefined
            ? null
            : configuredOrigins(input.inspection),
        codeBoxes: codeBoxes(step, input.values),
        alertsBefore: input.countNewAlerts === true,
      }),
    );
    if (clicked._tag === "Left")
      return failedCall(progress, clicked.left, { mayMutate: hostSubmits(step) });
    const answer = clicked.right;
    if ("pageSent" in answer) return filledReport(step, progress, "page", answer.url);
    if ("refusal" in answer || "checked" in answer)
      return stopped(step, progress, answer, "submit");
    if ("submission" in answer)
      return filledReport(
        step,
        progress,
        "refused",
        answer.url,
        firedRefusal(answer, guardOrigins(input)),
        true,
      );
    if (!("submit" in answer)) return refused("page_unavailable");
    if (answer.submit === "disabled")
      return filledReport(
        step,
        progress,
        "stayed_disabled",
        answer.url,
        withCheck(refused("not_editable", "submit"), "submit_disabled", {
          waitedMs: submitEnableMs,
          ...foundEvidence(answer.url, undefined, evidenceOrigins(input, progress)),
        }),
      );
    const report = filledReport(step, progress, answer.submit, answer.url);
    // Page code may copy a typed value into an element's id or class, so such a cover is dropped.
    const covered =
      answer.covered === undefined || holdsValue(answer.covered, input.values)
        ? {}
        : { covered: answer.covered };
    return {
      ...report,
      ...covered,
      ...(answer.controls === undefined ? {} : { controls: answer.controls }),
    };
  });
