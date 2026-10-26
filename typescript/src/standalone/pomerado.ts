import { Effect, type Scope } from "effect";
import type { Pomerado, PomeradoOptions } from "./contracts.js";
import { tracedEffect, type JobTrace } from "./job-trace.js";
import { tracedProvider } from "./trace-model.js";
import { makeSession } from "./session.js";
import { requestContext } from "./request-context.js";
import { mintRequest } from "./mint-host.js";
import { runOperation } from "./run-operation.js";
import { issueFileHandles } from "../mint/file-handles.js";
import { isLocalFileReference, openLocalFile } from "../execution/local-files.js";
export { Artifact } from "./contracts.js";
export type {
  Pomerado,
  PomeradoOptions,
  PomeradoRequest,
  MintArtifact,
  MintOutcome,
  LocalMintOutcome,
} from "./contracts.js";
/** A scoped session owns its browser, so a minted operation can run in the same signed-in session. */
export const createPomerado = (
  options: PomeradoOptions,
  trace?: JobTrace,
): Effect.Effect<Pomerado, Error, Scope.Scope> =>
  Effect.gen(function* () {
    const configured = trace === undefined ? options : { ...options,
      minterProvider: tracedProvider(trace, "minter", options.minterProvider),
      guardianProvider: tracedProvider(trace, "guardian", options.guardianProvider),
      outcomeReviewerProvider: tracedProvider(trace, "outcome", options.outcomeReviewerProvider),
    };
    const session = yield* makeSession(configured, trace).pipe(Effect.tapErrorCause((cause) => Effect.sync(() => trace?.event("session.error", cause))));
    const mint: Pomerado["mint"] = (request) =>
      session.mutex.withPermits(1)(
        Effect.scoped(
          Effect.gen(function* () {
            // The build sees each of the caller's files as a handle, never its reference.
            const issued = yield* issueFileHandles(
              request.input ?? {},
              isLocalFileReference,
              openLocalFile,
            );
            const handled = { ...request, input: issued.input };
            const context = yield* requestContext(session, handled);
            return yield* tracedEffect(trace, "mint", mintRequest(session, context, handled, issued.handles));
          }),
        ),
      );
    const run: Pomerado["run"] = (artifact, request) =>
      session.mutex.withPermits(1)(Effect.scoped(runOperation(session, artifact, request)));
    return { mint, run };
  });
