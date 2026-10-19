import { Effect, Either, Option, Schema } from "effect";
import type { ReusedAnswer } from "../guardian/question.js";
import {
  ChoiceAnswer,
  foldedAnswer,
  MultiChoiceAnswer,
  QuestionId,
  validateAnswer,
  type InputRequest,
  type Question,
  type ValidAnswer,
  type ValidAnswers,
} from "../runtime/input-request.js";
import type { ScriptQuestionDeclarations } from "../runtime/script-input.js";

/** The question types whose answers a later step may reuse: never a code, a secret or a login. */
const ReusableType = Schema.Literal("choice", "multi_choice", "text", "confirm");
const reusable = Schema.is(ReusableType);

/**
 * What a later ask must match to reuse an answer: the same id, type, screened prompt, and screened
 * options or a confirm's screened follow-up.
 */
const KeptQuestion = Schema.Struct({
  id: Schema.String,
  type: ReusableType,
  prompt: Schema.String,
  options: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  ),
  followUp: Schema.optional(
    Schema.Struct({ prompt: Schema.String, defaultText: Schema.optional(Schema.String) }),
  ),
});
type KeptQuestion = typeof KeptQuestion.Type;

/**
 * One answer the owner gave in this build, to the agent's own question or a script's, which a
 * later script ask may reuse: the screened question, the answer as the asker returned it, and the
 * decision it settles, if any: the agent's question's id, or the `decision` a script question's
 * declaration names. Only a later question that names a decision reuses an answer by it.
 */
export const KeptScriptAnswer = Schema.Struct({
  question: KeptQuestion,
  answer: Schema.Struct({ type: Schema.String, value: Schema.Unknown }),
  decision: Schema.optional(QuestionId),
});
export type KeptScriptAnswer = typeof KeptScriptAnswer.Type;

/**
 * Each question's match key, its texts screened as the owner saw them, or undefined for a question
 * no later step may reuse: a code, a secret or a login.
 */
export const scriptQuestionKeys = <E>(
  asked: InputRequest,
  screen: (text: string) => Effect.Effect<string, E>,
) =>
  Effect.forEach(asked.questions, (question) =>
    Effect.gen(function* () {
      const { type } = question;
      if (!reusable(type)) return undefined;
      const key = { id: question.id, type, prompt: yield* screen(question.prompt) };
      if (question.type === "choice" || question.type === "multi_choice") {
        const options = yield* Effect.forEach(question.options, (option) =>
          screen(option.label).pipe(Effect.map((label) => ({ id: option.id, label }))),
        );
        return { ...key, options } satisfies KeptQuestion;
      }
      if (question.type !== "confirm" || question.followUp === undefined)
        return key satisfies KeptQuestion;
      const { prompt, defaultText } = question.followUp;
      const followUp = {
        prompt: yield* screen(prompt),
        ...(defaultText === undefined ? {} : { defaultText: yield* screen(defaultText) }),
      };
      return { ...key, followUp } satisfies KeptQuestion;
    }),
  );

const sameQuestion = (left: KeptQuestion, right: KeptQuestion) =>
  JSON.stringify(left) === JSON.stringify(right);

/** Each asked question's decision key, by its declaration: the `decision` it names, if any. */
export const declaredDecisions = (
  asked: InputRequest,
  declared: ScriptQuestionDeclarations | undefined,
): readonly (string | undefined)[] =>
  asked.questions.map((question) => {
    const declaration =
      declared !== undefined && Object.hasOwn(declared, question.id)
        ? declared[question.id]
        : undefined;
    const decision =
      declaration !== undefined && "decision" in declaration ? declaration.decision : undefined;
    return typeof decision === "string" ? decision : undefined;
  });

/** The answer as one asked question takes it, or undefined when it no longer fits. */
const validFor = (asked: InputRequest, question: Question, value: unknown) => {
  const valid = validateAnswer({ ...asked, questions: [question] }, { [question.id]: value });
  return Either.isLeft(valid) ? undefined : valid.right[question.id];
};

/** The options whose label is this text, folded for case, accents and spacing. */
const labelled = (
  options: readonly { readonly id: string; readonly label: string }[],
  label: string,
) => options.filter((option) => foldedAnswer(option.label) === foldedAnswer(label));

/** The one offered option a label names; else undefined. */
const optionNamed = (key: KeptQuestion, label: string | undefined) => {
  if (label === undefined || key.options === undefined) return undefined;
  const [named, ...more] = labelled(key.options, label);
  return more.length === 0 ? named?.id : undefined;
};

/**
 * An earlier answer to the same decision as the question asked now takes it: the same type, each
 * option the owner picked found among the page's options by its label (ids differ: a script's
 * options get the host's ids at ask time), and the owner's own text kept only where the question
 * takes it or it names exactly one option. Undefined when any part does not carry over: a pick
 * whose label two earlier options shared, a pick with a note, which may qualify it, or a confirm,
 * whose yes stands only for the prompt the owner saw.
 */
const decidedValue = (entry: KeptScriptAnswer, key: KeptQuestion): unknown => {
  const earlier = entry.question;
  if (earlier.type !== key.type) return undefined;
  const label = (id: string) => {
    const options = earlier.options ?? [];
    const picked = options.find((option) => option.id === id);
    return picked !== undefined && labelled(options, picked.label).length === 1
      ? picked.label
      : undefined;
  };
  const value: unknown = entry.answer.value;
  switch (key.type) {
    case "text":
      return value;
    case "confirm":
      return undefined;
    case "choice": {
      const answer = Schema.decodeUnknownOption(ChoiceAnswer)(value);
      if (Option.isNone(answer)) return undefined;
      const choice = answer.value;
      if (typeof choice === "string") return optionNamed(key, label(choice));
      if ("option" in choice)
        return choice.note === undefined ? optionNamed(key, label(choice.option)) : undefined;
      return optionNamed(key, choice.other) ?? { other: choice.other };
    }
    case "multi_choice": {
      const answer = Schema.decodeUnknownOption(MultiChoiceAnswer)(value);
      if (Option.isNone(answer)) return undefined;
      const { options, other, note } =
        "options" in answer.value
          ? answer.value
          : { options: answer.value, other: undefined, note: undefined };
      if (note !== undefined) return undefined;
      const picks = [...options.map(label), ...(other === undefined ? [] : [other])];
      const ids = picks.map((picked) => optionNamed(key, picked));
      return ids.every((id) => id !== undefined) && new Set(ids).size === ids.length
        ? ids
        : undefined;
    }
  }
};

/**
 * An answer the host may give for the owner once Guardian agrees: the question asked now, the
 * value it would take, and the owner's earlier answer to the same decision, to a question worded
 * differently.
 */
export interface DecidedAnswer {
  readonly question: Question;
  readonly answer: ValidAnswer;
  readonly earlier: KeptScriptAnswer;
}

/** The request's questions without an answer here, or undefined when none is left. */
export const unansweredRequest = (
  asked: InputRequest,
  answers: ValidAnswers,
): InputRequest | undefined => {
  const left = asked.questions.filter((question) => !Object.hasOwn(answers, question.id));
  return left.length === 0 ? undefined : { ...asked, questions: left };
};

/**
 * What the owner already answered of a script's ask, and what is left to ask. A question takes a
 * kept answer to the same question (same id, type, screened prompt, and screened options or
 * follow-up); else the latest kept answer to the decision its declaration names, from the agent's
 * own question or a script's that names the same decision, which is `decided` when the owner saw
 * another prompt, so the host asks Guardian first; either only while still valid for the question
 * as asked now. Any step may reuse it, the one that got it included, as often as the question
 * comes back and however long ago the owner gave it. A code, secret or login question is always
 * left to ask.
 */
export const settledScriptAnswers = (
  asked: InputRequest,
  keys: readonly (KeptQuestion | undefined)[],
  kept: readonly KeptScriptAnswer[],
  decisions: readonly (string | undefined)[] = [],
): {
  readonly reused: ValidAnswers;
  readonly decided: readonly DecidedAnswer[];
  readonly remaining: InputRequest | undefined;
} => {
  const reused: Record<string, ValidAnswer> = {};
  const decided: DecidedAnswer[] = [];
  asked.questions.forEach((question, index) => {
    const key = keys[index];
    const decision = decisions[index];
    if (key === undefined) return;
    const same = kept.find((entry) => sameQuestion(entry.question, key));
    const exact = same && validFor(asked, question, same.answer.value);
    if (exact !== undefined) {
      reused[question.id] = exact;
      return;
    }
    const earlier =
      decision === undefined ? undefined : kept.findLast((entry) => entry.decision === decision);
    const answer = earlier && validFor(asked, question, decidedValue(earlier, key));
    if (earlier === undefined || answer === undefined) return;
    if (earlier.question.prompt === key.prompt) reused[question.id] = answer;
    else decided.push({ question, answer, earlier });
  });
  const pending = Object.fromEntries(decided.map((entry) => [entry.question.id, entry.answer]));
  return { reused, decided, remaining: unansweredRequest(asked, { ...reused, ...pending }) };
};

/**
 * The owner's earlier answer a decided answer reuses, as Guardian's trusted answers show it: the
 * earlier question's screened prompt and the screened answer, a picked option by its label. Only
 * a text, a choice without a note or a multiple choice without one is ever decided.
 */
export const earlierAnswerForReview = <E>(
  decided: DecidedAnswer,
  screen: (text: string) => Effect.Effect<string, E>,
): Effect.Effect<ReusedAnswer, E> =>
  Effect.gen(function* () {
    const { question, answer } = decided.earlier;
    const label = (id: string) => question.options?.find((option) => option.id === id)?.label ?? id;
    const choice = Schema.decodeUnknownOption(ChoiceAnswer)(answer.value).pipe(Option.getOrUndefined);
    const picks = Schema.decodeUnknownOption(MultiChoiceAnswer)(answer.value).pipe(
      Option.getOrUndefined,
    );
    const shown =
      question.type === "multi_choice" && picks !== undefined
        ? "options" in picks
          ? {
              answer: picks.options.map(label),
              ...(picks.other === undefined ? {} : { other: yield* screen(picks.other) }),
            }
          : { answer: picks.map(label) }
        : question.type === "choice" && choice !== undefined
          ? typeof choice === "string"
            ? { answer: label(choice) }
            : "option" in choice
              ? { answer: label(choice.option) }
              : { answer: yield* screen(choice.other) }
          : { answer: yield* screen(String(answer.value)) };
    return { id: decided.question.id, answered: { question: question.prompt, ...shown } };
  });

/**
 * The kept answers without any to these screened prompts. Only the owner's latest answer to a
 * prompt stands, as in Guardian's trusted answers, so an answer the owner gave since to a question
 * with the same prompt, whoever asked it, means the next script ask asks again.
 */
export const forgetScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  prompts: readonly string[],
): readonly KeptScriptAnswer[] => kept.filter((entry) => !prompts.includes(entry.question.prompt));

/**
 * The kept answers once the owner answered afresh, the agent's own question or a script's: each
 * reusable answer settles the decision `decisions` gives it, by question (the agent's question's
 * id, or the `decision` a script's declaration names; none for a script question that names
 * none, so its id never stands for the agent's decision), and replaces any kept answer to the
 * same prompt or the same decision.
 */
export const keptScriptAnswers = (
  kept: readonly KeptScriptAnswer[],
  keys: readonly (KeptQuestion | undefined)[],
  answers: ValidAnswers,
  decisions: readonly (string | undefined)[] = [],
): readonly KeptScriptAnswer[] => {
  const latest = keys.flatMap((key, index): KeptScriptAnswer[] => {
    const answer = key === undefined ? undefined : answers[key.id];
    return key === undefined || answer === undefined
      ? []
      : [
          {
            question: key,
            answer,
            ...(decisions[index] === undefined ? {} : { decision: decisions[index] }),
          },
        ];
  });
  const decided = new Set(latest.flatMap((entry) => entry.decision ?? []));
  return [
    ...forgetScriptAnswers(
      kept,
      latest.map((entry) => entry.question.prompt),
    ).filter((entry) => entry.decision === undefined || !decided.has(entry.decision)),
    ...latest,
  ];
};
