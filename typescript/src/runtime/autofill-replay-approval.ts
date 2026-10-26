import { Effect } from "effect";
import type { YieldableError } from "effect/Cause";
import type { SignInRecipeStep } from "../destinations/sign-in-recipe.js";
import { leftSignInScreens } from "./autofill-replay-pages.js";
import { returnedCredential, type Replay } from "./autofill-replay-session.js";
import type { AutofillReplayInput } from "./autofill-replay-steps.js";
import type { AutofillLogin } from "./autofill-values.js";

/** A page's origin, scheme, host and port; none for an opaque one, which matches nothing. */
const originOf = (page: string) => {
  const origin = URL.parse(page)?.origin;
  return origin === undefined || origin === "null" ? undefined : origin;
};

/**
 * Whether the page shown after the previous screen's submit is a recorded approval's screen, where
 * the owner approves the sign-in off the page. The recorded page is admitted as before. A site's
 * approval page often holds a code of its own in its path, and a recording may have saved the page
 * the site showed once the owner approved, so a new browser shows neither: any other page on the
 * recorded page's origin (`recordedPage`, a workspace screen's as this replay knows it) is
 * admitted too, unless it is one of the recorded screens or the entry page, shows a password field
 * or the credential screen the replay submitted again, or shows the signed-in marker already, which
 * signed the browser in with no approval (`signed_in`, which the sign-in's own check then verifies).
 * A page on any other origin is never admitted. Anything not admitted ends as before
 * (`screen_changed`).
 */
export const approvalScreen = <E extends YieldableError, V extends string, L extends AutofillLogin>(
  input: AutofillReplayInput<E, V, L>,
  replay: Replay<E, V, L>,
  recorded: SignInRecipeStep,
  recordedPage: string,
  page: string,
) =>
  Effect.gen(function* () {
    if (replay.matchesRecorded(page, recorded)) return "admitted" as const;
    const origin = originOf(recordedPage);
    if (
      origin === undefined ||
      originOf(page) !== origin ||
      !leftSignInScreens(replay.onScreens, input.entryUrl, page)
    )
      return "screen_changed" as const;
    const here = yield* replay.checkHere;
    if (here.signedIn) {
      yield* input.emit({ stage: "skipped", reason: "signed_in_indicator" });
      return "signed_in" as const;
    }
    if ("passwordFieldVisible" in here && here.passwordFieldVisible === true)
      return "screen_changed" as const;
    const returned = yield* returnedCredential({
      progress: replay.progress,
      sent: replay.sent,
      hooks: input.hooks,
    });
    return returned === undefined ? ("admitted" as const) : ("screen_changed" as const);
  });
