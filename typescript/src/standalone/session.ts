import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { makePlaywrightExecutor } from "../execution/playwright-execute.js";
import { makeRunSecrets, registerSecretAnswer } from "../inputs/secrets.js";
import { localRuntimeAssets } from "../execution/local-runtime-assets.js";
import type { InputAsker } from "../runtime/input-request.js";
import type { SessionTyping } from "./authentication.js";
import type { PomeradoOptions } from "./contracts.js";
import { tracedEffect, type JobTrace } from "./job-trace.js";
import { error, mintError } from "./errors.js";
export const makeSession = (options: PomeradoOptions, trace?: JobTrace) =>
  Effect.gen(function* () {
    if (options.browser !== undefined && "cdp" in options.browser)
      return yield* Effect.fail(
        new Error(
          "The local host doesn't attach over CDP: its runs close other tabs and reset site data in the browser. Use endpoint or a launched browser.",
        ),
      );
    trace?.event("session.start", {});
    if (trace !== undefined) yield* Effect.addFinalizer(() => Effect.sync(() => trace.event("session.cleanup", {})));
    const originalBrowser = yield* makePlaywrightExecutor(options.browser).pipe(
      Effect.tap((browser) => Effect.sync(() => trace?.event("browser.start", { sessionId: browser.sessionId, targetId: browser.targetId }))),
      Effect.tapErrorCause((cause) => Effect.sync(() => trace?.event("browser.error", cause))),
    );
    const browser = trace === undefined ? originalBrowser : { ...originalBrowser,
      execute: (...args: Parameters<typeof originalBrowser.execute>) => tracedEffect(trace, "browser.execute", originalBrowser.execute(...args)),
      executeResponse: (...args: Parameters<typeof originalBrowser.executeResponse>) => tracedEffect(trace, "browser.execute", originalBrowser.executeResponse(...args)),
      watchTyping: (...args: Parameters<typeof originalBrowser.watchTyping>) => {
        const watch = originalBrowser.watchTyping(...args);
        return { ...watch, executeResponse: (...call: Parameters<typeof watch.executeResponse>) => tracedEffect(trace, "browser.execute", watch.executeResponse(...call)) };
      },
    };
    const policy =
      options.policy ??
      (yield* Effect.tryPromise({
        try: () => readFile(new URL("../guardian/upstream-policy.md", import.meta.url), "utf8"),
        catch: error,
      }));
    const secrets = trace?.secrets ?? makeRunSecrets();
    if (trace === undefined) yield* Effect.addFinalizer(() => Effect.sync(secrets.clear));
    const mutex = yield* Effect.makeSemaphore(1);
    const trustedSources = new Map(yield* localRuntimeAssets);
    const projection = {
      text: (value: string) => Effect.sync(() => secrets.redact(value)),
      json: (value: unknown) => secrets.json(value).pipe(Effect.mapError(mintError)),
      source: (_path: string, value: string) =>
        secrets.assertAbsent(value).pipe(Effect.as(value), Effect.mapError(mintError)),
    };
    const ask: InputAsker = (request, bounds) =>
      Effect.suspend(() => {
        trace?.event("input.asked", request);
        return options.ask(request, bounds);
      }).pipe(
        Effect.tap((answers) =>
          Effect.sync(() => {
            for (const [id, answer] of Object.entries(answers)) {
              if (answer.type === "secret") {
                const question = request.questions.find((candidate) => candidate.id === id);
                registerSecretAnswer(
                  secrets,
                  question?.type === "secret" ? question.secretKind : undefined,
                  answer.value,
                );
              }
              if (answer.type === "credential") {
                if (answer.value.username !== undefined) secrets.register(answer.value.username);
                if (answer.value.password !== undefined) secrets.register(answer.value.password);
              }
            }
            trace?.event("input.answered", { requestId: request.id, answers: Object.entries(answers).map(([id, answer]) => ({ id, type: answer.type })) });
          }),
        ),
      );
    // One typing memory for the session's browser, across every build on it.
    const signInTyping: SessionTyping = { typed: false };
    return {
      trace,
      options,
      browser,
      policy,
      secrets,
      mutex,
      trustedSources,
      projection,
      ask,
      signInTyping,
    };
  });
export type StandaloneSession = Effect.Effect.Success<ReturnType<typeof makeSession>>;
