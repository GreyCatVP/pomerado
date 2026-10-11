---
name: writes
description: Do a write build's requested task once as a live act session, confirm it, then compose and publish its script without running it again.
---

# Do the task once, then compose its script

A write build changes something real on the caller's account: an order, a booking,
a submitted form, a saved profile. There is no practice run. The write is the whole
task the request asks for, done once, live, with the caller's values, as a series
of `act` steps. When the caller's input is empty (`{}`), pass the request's values and
the owner's answers as `exampleInput` (JSON text) on each act step that needs them. The
first act step that passes it fixes it: later steps repeat it unchanged or omit it, and
every step from then on runs that one input. Decide from the
request and the site which inputs are required, and keep them required. An optional
input plus a declared question the tool asks before any effect is only for a value the
request genuinely leaves open; never make a value the request states optional with
nothing that asks. It may take several write steps: filling in and advancing a
multi-step form, choosing options, saving, then submitting. Drafts, autosaves and the
saves a site makes at each step along the way are part of that one task. You never
redo the whole task, and never redo a step that finished; run a step again only when
a fresh read of the page shows it did not finish, or the task cannot complete without it. Then you compose the
published script from what those steps did and publish it. Nothing runs again.

A read build may search, filter and query, but may not fill in or advance a form that
saves data on the site, save or submit anything; a task that needs that is a write build.
Signed out, setting the session's store, location or delivery or pickup mode is part of a
read, even through a Save button (core skill). Adding to a cart, a hold on inventory, a seat or a time slot, an upload and a draft stay writes,
signed out too.

## When a read build finds it needs to write

When a read build's task turns out to need that (a form that saves each step, a search
that is really a booking), ask the caller with `request_input` whether the build may make
that change, saying in one or two plain sentences what it would change on the site and why
the task needs it. Ask as soon as exploration shows it; a live read example that already ran
is fine, though it never stands in for the write. Once they confirm, by picking your option
or in their own words, call `mint_update` with the change `{"setting": "effect", "effect":
"write"}` and the answered question in `confirmedBy`. Guardian reviews it. An `updated` result
makes this a write build in place: every later step is reviewed under write authority and the
rules below, what you explored stays valid evidence, and the first `act` step starts on the
site origin page. If they keep it read-only, finish what a read can do, or recommend a new
write build with `mint_update` and `recommend: "new_mint"`.

## Before the session

Sign in first when the site needs it, and always for a cart or checkout
(.agents/cart/SKILL.md), with the auth skill: read-only `explore` to find the login, then
`authenticate`. Before the first `act` step you may still explore
read-only, for example to read the first page's options, but never fill, select,
add, save or submit anything there.

Read the path's options with read-only exploration where you can, then ask with
`request_input` about the ones the caller's input does not settle, as `AGENTS.md` ("Try
hard, then ask") says: each add-on, pre-selected paid option and saved payment you saw,
and any other option only when the request's purpose clearly depends on it. An unasked
optional field keeps the page's default and is still an optional input of the script. Ask
only about options the site actually shows. Never keep, clear, accept or decline an add-on,
pre-selected paid option or saved payment unasked. A safety default (core skill) is
neither: never ask about it, and the script turns it off. Credentials never go through a
question; the host's protected form owns them.

During the session:

- Before a committing step, read the selected options and total from the current
  page or an available read-only summary. Use a review page when the site has one;
  a separate review page is not required, and submitting a form is never a way to
  discover whether one exists.
- Make the commit step check that no option the input does not settle is selected,
  and fail before clicking commit if one is.
- Before committing, read back from the page what you are about to submit and check each
  value against the caller's input, normalized as the core skill's Confirm step says, in
  the session and on every branch of the
  composed script. Fail before the commit if one does not match. Never read back a
  field filled with a secret handle.
- When the write changes state that already exists, such as a saved record or a cart
  (.agents/cart/SKILL.md), read that state before the committing step and again after it,
  in the session and in the composed script, and check that only the requested change
  happened. Fail when it did not.
- If a step meets an option the input does not settle, stop that step before choosing
  it and ask. A `request_input` question during the session waits in place; a choice
  that exists only on the page mid-flow, such as a seat on the flight just chosen, is
  a declared `ask` in the next `act` step's script (the caller-input skill). An
  answered question settles the option. Check the page again before continuing.

## The session

Author each step as a Kernel script under `src/` with the caller's input schema (the
core skill), and keep the flow's calls in a module the composed script will import
too. Run each step with `execute` purpose `act`, target `liveBrowser`.

- The first `act` step claims the build's write. The host resets the browser to
  the site origin page first, with fresh page state (a signed-in build
  keeps the session saved right after sign-in), so that step starts the flow there.
- Later steps continue on the page exactly as the previous step left it. Keep steps
  small and read the actual state after each submission. On multi-step forms, a
  button named Continue, Next or Save may save a draft, persist that page, or finish
  the task immediately; its label does not establish that another review or final
  submit follows. A step that saves or advances a form page is part of the task,
  not a second write.
- Report a confirm popup to `decideDialog` with a literal `step` name, and keep that
  literal in the helper the composed script imports. Runs accept a popup without
  asking only at the step the session accepted it at, so the host refuses to publish
  a composed script that drops one.
- Mark only the step whose click saves or submits. Opening or filling an unsaved
  form is not a commit step. Mark every such step other than a hold that expires on
  its own, including an autosave, a saved form step and a payment submission whose
  next screen is unknown. Call `enteringCommit("place-order")` right before the
  execute call that can send that change, and declare the names in order as
  `write.commits`. Use the same marked helper in the session and the composed
  script. If the call returns an unexpected page or fails while waiting for an
  assumed review, read back before another submission: the task may already be
  complete. The host cannot see a commit sent as a GET link or over a websocket, so
  the mark is its evidence of whether the commit step ran.
- Prefer marking the commit at the step that submits the booking or order. A hold that
  expires on its own, such as a reserved table or a cart timer, is not the commit.
- The host refuses an `act` step whose source is unchanged since it ran and sent
  state-changing requests: submitting it again could commit twice.
- Read `stateChangingRequests` on every step. It lists the commit your step caused,
  with each request's response status, and any autosave or draft save. That is the
  evidence for the `http` version; any other write is unintended and must not be in
  the script.
- Prefer confirming the write from its commit request. Keep the click on the final commit
  control, such as Save, Send, Submit, Book or Pay, in its own step. In the same call as
  that click, wait for the site's response to the request it sends, matched by the method
  and path the session saw carry the commit on the site, and by its body where the body
  shows the caller's values, as `references/write-readback.ts` does. Wait too for every way
  the page can answer with `waitForOutcome`, listing the site's error or validation message
  first. The write went through when that response is 2xx or 3xx, a body the call can read
  shows no error, and the page shows no error or validation message after it. A 201 whose
  Location names the new record went through as soon as it arrives, with no wait for the
  page. A 200 whose
  body reports an error, as GraphQL can, did not go through. A 202, or a 2xx whose body says
  the work is queued, went through too; return the site's own status word for it in the
  output. Then read what the output promises from that response or from the page the commit
  left, match it to the caller's values, and call `verified()` with no argument just before
  returning. Declare `write: { confirmation: "readback" }`. Prefer not opening another page,
  such as a list, a history or an account screen, only to prove the write. When a commit
  step returned without calling `verified()` and its `stateChangingRequests` list the commit
  request with a 2xx or 3xx status, prefer confirming it in the next step from the page as
  it stands. Make no execute
  call after `verified()`: a later call reopens the effect. After the confirming step,
  further `act` steps are refused.
- Read the site's own proof instead only when the commit request can't confirm the write:
  no such request went out; it failed, got no answer or returned an error status; its body
  shows an error, or can't be read on an endpoint that reports errors with a 200, such as
  GraphQL or a batch call; the page shows an error; the commit went over a websocket or a GET
  link; or a later stage the site can still refuse, such as sending what an earlier click
  saved, sent no request of its own. Then prefer the confirmation the page shows after the
  click: an order, booking or reference number, or a success message or toast that appears
  after the click with no error on the page. Open the saved state, such as the orders page,
  the booking list or the updated profile, only when the page shows no confirmation. Match
  it to the caller's values, return the number or record in the output, and call
  `verified()` as above. A 200 from any other request is not a confirmation.
- Only if the site offers none of these, a commit response the call can check, a
  confirmation or the saved state, the write is `unverifiable`: do not call
  `verified`. It publishes flagged, and its runs report the write as possibly
  completed. A session in which any step recorded a confirmation is never
  `unverifiable`; publish against the confirming step.
- When a read-back is needed, the first one that matches confirms the write; stop there. It
  matches when it shows
  the written record after the write, found by something the write produced or entered (its
  number, its own reference or the exact values entered), and every field the caller asked
  for that the view shows agrees (the read before the commit already checked what you
  entered). When the write changed state that already existed, the same read also checks
  that only the requested change happened. Write each read-back step to check that match in
  its own code and call `verified()` when it holds, so the first one that matches is the
  confirming step. Read one confirmation, list or detail view: find the record there by that
  identity, never by its position, such as the first or newest row. Read only that record,
  and the view's other rows only where the before-and-after check or another skill, such as
  the cart skill, compares them. Read another page, in that same step before `verified()`,
  only for a field the view did not show and the tool's output promises.
- State from before the write never matches. Require something only the finished write can
  show: the number or reference it produced, or a value it changed from what you read before
  it, such as a status that now reads Sent or a row that was not there. A list still showing
  the row from before the write, or a table that has not reloaded yet, neither confirms the
  write nor shows that it did not happen. Values you entered find the record but never prove
  it new. When they are all a create's read-back can match, read that list before the write
  too, in the session and the composed script, note the rows that already match (their count
  or ids), and count only a new one: a row whose id you had not seen, or the one match where
  there was none. When two rows match after the write and no noted id shows which one is new,
  values alone do not confirm it.
- Never repeat a step blindly. If an `act` step fails after the page sent a
  state-changing request or opened a socket, after it entered a commit mark, or
  without returning a result at all (its page was lost), the write may already be
  committed; its receipt says so under `writeSession` (`verifyFirst`). Before any
  further write, run an `act` step that only reads the page or the account. When
  `stateChangingRequests` shows the failed step's commit request went through, that
  step may read only the page as it stands: check it for an error or validation
  message, read what the output needs, and call `verified()` there. If the
  write happened, call `verified()` there and publish against that step, never
  submitting it again. If nothing happened, do the write with the
  caller's values and read its confirmation. The host refuses only an unchanged
  commit step run again straight after it sent state-changing requests, and never
  resubmits for you. Make the composed script match what actually worked end to end.
- A failed step that sent no state-changing request changes nothing: the next `act`
  step reads the page as it is and continues, finishing what is still missing.
  A step that never calls `verified` does not end a session.

Once the session has started, a live `explore` or `test` is refused, and a write
build never runs a live `example`. The session is the one run that proves the write: design
no tests and build no offline test suite for it. Its HTTP version gets one offline replay of
the session (http-mcp skill), and the testing skill is not for a write.

## Compose and publish

Write `src/tool.mjs`, the `playwright` version: a Kernel script running the whole
flow from the site origin page and the caller's input, with the same calls, the commit
exactly once, and the same confirmation or read-back the session recorded. The call
that reads it, the commit call or a read-only call after it as in the session, reads
only what the session's confirming step read and returns it; the script matches those
values to the input and calls `verified()`, as the references do. Nothing runs live
before publishing, so a read the session never made, added to that call, can fail
after the write has landed, and a run that hits it reports a successful write as
possibly completed. When the session confirmed the write on another page but its commit
step's `stateChangingRequests` listed the commit request with a 2xx or 3xx status,
prefer confirming the script from that request in the commit call, as above, over
opening that page. Declare the script's contract, `defineOperation({ name,
input, output, write: { confirmation: "readback", commits: ["place-order"] } }, run)`
(or `"unverifiable"` when the site shows neither a confirmation nor the saved state),
marking the same commit steps as the session. A script declared `unverifiable` cannot call
`verified`. One that declares no commit marks is refused as `commit_marks_undeclared`,
and one that declares a mark no `act` step of the session entered is refused as
`commit_marks_unentered`. If the declaration names the wrong marks, correct it to
match the marks the session actually entered. If the completed session entered no
marks, it cannot publish: changing its source or entering a mark in a later read
cannot show that the earlier commit was marked. End the build and explain that
the task completed but its commit steps were not marked; never repeat the write
to add them.

Every option the session met on its path is an input of the script, add-ons and
pre-selected defaults included: required when the site requires a choice, optional
otherwise. The script sets each option from its input. An unset optional input leaves the
page's default, as in a read. The exception is an add-on, a pre-selected paid option or
a saved payment: each must be explicit, so the script never keeps, clears, accepts or
declines one the input leaves open, and fails before the commit instead. A safety default
(core skill) is neither: never ask about it, and the script turns it off. An
account-specific value, such as a passenger, loyalty number, saved card, address or
account ID, is a free-form input, never an enum member, example or default in the
public schema (core's input schema rules).

The composed script publishes without ever running end to end, so it ends with a check that
tells whether its action succeeded: its commit response checked as above, the site's
confirmation for this submission, or a read-back of the saved state matched to the input,
unless the site offers none of them; then declare it
`unverifiable`. Compose it from the steps that worked, also when a commit step returned an
uncertain result and a later read-back showed the write landed.

<!-- pomerado:section writes.alternate-version -->

Call `finish_build` with entrypoint `src/tool.mjs` and the confirming step's
`executionId` (for an `unverifiable` write, the step that committed). The host reads
the script's contract offline, checks that the input the session ran (the caller's own,
or the `exampleInput` the first act step to pass one fixed) decodes against it and that
the named step recorded the declared confirmation, then publishes. A
`not_published` reason of `confirmation_undeclared`, `confirmation_unrecorded` or
`contract_input_mismatch` means correct the source and call `finish_build` again;
never run the write again. So does `input_feedback`, Guardian's findings on the input
schema; the host re-reads the corrected schema offline. `write_not_submitted` means the
session has not demonstrated the requested write: no step recorded a confirmation, and no
`act` step Guardian labelled a write reached the site unless the outcome review found it
did not happen. Continue the remaining authorized work. If a step may already have
committed, read back first, in a new file. If the write happened, publish with
`readback`. The host runs a step that may have committed only once, unless the outcome
review finds it did not happen. If no read-back can tell, never submit again: publish it
as `unverifiable`. Filling a form or an offline example
is not the write. An unreadable step output never justifies a run either: the write
publishes with its output recorded as unavailable.

After a `not_published`, live `act` steps are open again while the write session is still
open (a commit that recorded its confirmation stays done), on the same browser, still signed
in: read `page.url()` first, and prefer not to sign in again. Only after a publication whose
capture failed do they run on a fresh browser on a new, empty profile: read `page.url()`
first and sign in again when the build signs in. Before
running a commit again, run an `act` step that only reads the site or the account to see
whether the earlier commit landed, and never resubmit one that did. If no read-back can
tell, never submit again. Guardian reviews every
`act` step and denies one that would repeat a finished commit.

Guardian labels each step it allows `read`, `write` or `authentication`, and every step
that changes what the site keeps is a write, a draft, a saved field or a cart included.
A separate outcome reviewer then judges each write from your history and the host's
records. The host refuses a step that runs an earlier write's entrypoint again until
that review finds the write did not happen, so write a read-back as a new file. When a
tool result's `hostNotices` holds an `outcome_review_observation`, the reviewer needs
that readback: run it in a step that changes nothing when you can.

## What runs do with it

A run of the published write ends one of three ways. A recorded confirmation makes
it a result. A failure the host can prove sent nothing (its marks show no commit
step entered and the page sent only reads) may retry on a new browser, and a retry
that fails too goes to maintenance. On a host that repairs, a failure whose marks show no
commit step entered reports that it changed nothing, and its repair fixes the code and runs
the write once, without reading the site back. Anything
else, including a run that finished without its confirmation or lost its page
before reporting its marks, returns <!-- pomerado:section writes.uncertain-status:start
`may_have_applied`
pomerado:section writes.uncertain-status:end --> with any unconfirmed
result, and maintenance reads the site back and finishes the write at most once.
An `unverifiable` write reports <!-- pomerado:section writes.unverifiable-status:start
`may_have_applied`
pomerado:section writes.unverifiable-status:end --> too, and nothing repairs it.
A script that throws `errors.InvalidInput` (core skill) fails as the caller's input; with
`available`, the host ends the run at once with those choices. Before any commit
mark is entered, the run reports that it changed nothing.

See `references/write-session.ts` for two steps and the composed script, and
`references/write-readback.ts` for a write confirmed from its own commit request.
<!-- pomerado:section writes.completion:start

## Standalone write completion

Perform the authorized task once through live `act` steps, preserving the shared effect journal and caller choices. Wait for actual confirmation, from the commit request's response or the page, and read back committed state only when neither confirms it. Declare `verified`, `unverifiable`, and their confirmation behavior accurately using the existing SDK; a missing result alone never proves the write absent.

Keep steps small and read the actual state after each submission. A button named Continue, Next or Save may save a draft, persist that page, or finish the task immediately; its label does not establish that another review or final submit follows. Mark only the step whose click saves or submits. Opening or filling an unsaved form is not a commit step. Mark every such step, including autosaves, saved form steps and payment submissions whose next screen is unknown: call `enteringCommit("place-order")` right before the execute call that can send the change and declare the names in order as `write.commits`. Use the same marked helper in the session and the composed script. If a call returns an unexpected page or fails while waiting for an assumed review, read back before another submission: the task may already be complete.

Compose `src/tool.mjs` from the original reviewed steps and confirming observation. Design no tests for it, and never run the composed write live again. Call `finish_build` with its confirming `executionId`, declared entrypoint and honest coverage. It returns integration files/schemas. When a write's outcome remains uncertain, report that uncertainty and preserve the no-replay rule.

If the composed contract names the wrong commit marks, correct it to match the marks the session actually entered. If the completed session entered no marks, it cannot finish: changing its source or entering a mark in a later read cannot show that the earlier commit was marked. End the build and explain that the task completed but its commit steps were not marked; never repeat the write to add them.

pomerado:section writes.completion:end -->
