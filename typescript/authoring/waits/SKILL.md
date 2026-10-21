---
name: waits
description: Read before writing or changing any step that waits for the page, a network answer or an outcome, or that uses `waitForOutcome`, `waitForOutcomeResult`, `waitForRows`, `waitForValues`, `waitForChange`, `waitForReady` or `waitPastChallenge`: budgets, readiness, naming every answer a step can give, value waits and what each wait failure means
---

# Waits and readiness

- Prefer waiting for the page a click opens, which may be a new tab, over waiting on the old
  page's URL.
- After a step whose answer can vary or that redraws part of the page, such as a click that may
  navigate, a search, a filter, a pick from a list, a date pick, adding a table row or a submit,
  prefer `waitForOutcome`, the step passed as its `action`, naming every result it can lead to: the
  next page's own control, a dialog on the same URL, an empty or sold-out message, a greyed-out
  choice (`getByRole(role, { name, disabled: true })` or the site's own disabled marker), the site's
  error or validation message, a pick-one list, or the element the next step uses. Prefer it over
  `waitForURL` or `waitForLoadState`: a dialog keeps the URL, and a page that changes route without
  loading a document passes `waitForLoadState` at once. Opening a record by its identifier or URL
  can also answer with a removed or not-found page, or an exact lookup of its key with an empty
  result: name it, and throw `InvalidInput` with `field` and what the page shows, before any
  commit mark, never a readiness timeout; the rejections skill says when it starts "Caller input error:". The waits paragraph below shows how to
  paste `waitCode` and call it.
- Wait for a change (`waitForChange`, or a settle of your own) only after a step that changed the
  page or should have, such as a click, fill or navigation that loads new results. Skip it when no
  step changed the page since the last wait, such as after closing a panel without picking
  anything or skipping a control already in the requested state. The values you return still get
  their one `waitForRows` or `waitForValues` after the last change, which passes at once on a
  settled page.
- `waitForOutcome` already waited for its answer, so prefer no extra wait for that same answer after it.
- Start a response wait in the same call as the click that causes it: name the response as a
  `{ response }` answer of `waitForOutcomeResult`, beside the page's other answers, with the click
  as its `action`. Listeners do not outlive a call.
- When a challenge appears, call `await waitPastChallenge({ ready })`. `ready` is code that
  returns true once the page is usable. It throws `ChallengeFailure` if the page stays blocked.
  Naming a challenge the build saw as one answer of the same `waitForOutcome` that waits for the
  expected content, as `references/navigation.ts` does, is right and costs nothing extra. Avoid a
  separate challenge probe or call on every pass of a polling loop of your own, and never wait out
  a timeout and swallow it to probe for a challenge.

Budgets: navigation 30 s for the document to commit; a click, fill or other action 5 s, taken
only on an element a wait has shown ready. After a navigation commits or an action returns, the
page gets 8 s without progress to show one of the answers you named, and up to 30 s while it
keeps progressing: a loading sign showing, the part of the page you named changing, the site's own
request in flight, the URL changing, or the values you read filling in. Values the site fills in
after its answer get up to 15 s. The runtime's waits (`waitCode`, below) apply these budgets. Give
every other Playwright call in the code an explicit `timeout`, and keep `timeout_sec` within
`remainingMs()`.
Child waits cannot extend the outer deadline. Explicitly name observation conditions.
`domcontentloaded` is document readiness, not readiness of the requested page or
control. Initial navigation can land on a temporary verification page before the
site redirects or renders its controls. JavaScript challenges, redirects and
delayed rendering can be intermittent: a fast exploration load does not establish
that later executions will be immediately ready. Include a bounded wait for the
expected page or control even when exploration never observed a delay. Derive
that readiness condition from the intended page, not from having seen a particular
challenge. Wait for a unique operation control or page state before testing absence
or choosing a fallback. Use `locator.waitFor` for one expected state, `waitForOutcome`
(below) when the page can answer more than one way, `waitForRows`, `waitForValues` or
`waitForChange` (below) for the values you return, or, only where none fits, a bounded loop of
your own that reads every condition in one `evaluate` per pass;
`count()` and `isVisible()` only observe the current instant. Share one bounded navigation
deadline across navigation
and first-page readiness, as in `references/navigation.ts`. Readiness polling and every re-check
below only observe: do not repeat `goto`, reload, login, submission, the action that caused the
change or another action inside them. Preserve site/path and account guards while waiting.
Wait for the values you will return, not for their containers or the rest of the page. A record
is ready when each value you return is filled in and reads the same on two looks
(`waitForValues`): two consecutive identical reads, the first included. Call it after a step
that changed the page, and never again on a page nothing changed since. A list is ready when
the rows you return, the first `limit` from the page's
position (pagination skill), have their identifier and the values the request needs, filled in
and reading the same twice (`waitForRows`); keeping every result row means every row up to that
page size. A slot that is present but empty, a skeleton, `aria-busy` or reading "Loading…" is
still loading, never absent; a slot with no identifier is not a result. A value still loading
when the page stops progressing fails the run, optional or not: null is only for a field this
record's markup lacks altogether, as the build saw on records without it, never for a slow one.
Use observed conditions: never add a fixed sleep, since a ready page passes immediately, and
never wait for rows you won't return, for the whole list to stop changing, for whole-page
network idle or for the page's `load` event. Read image links from attributes (`src`, `srcset`) without scrolling. A page with
an outcome is ready only when it shows that outcome: results, or the site's own empty message.
Before acting on a control, wait until loading overlays covering it are gone and its section is
expanded. `waitForReady(control, { overlays, expand, dismiss })` waits for all of it: the control
enabled, uncovered and still, the overlays you name gone, the section toggle you name opened once,
and the close controls you name for a tour, a what's-new dialog or a banner that opens on its own
clicked, now or before a later action. A panel or dialog you opened does not go away by waiting: close it with its own
control or Escape and check it closed. A click Playwright keeps reporting as intercepted by the
same element is a page state, not slowness. After an action that navigates or re-renders, wait
for the committed state
(URL, selected value or header) before checking identity or reading. Use bounded retrying
waits: re-check the condition until it holds or the budget ends, then throw `OperationFailure`
naming what was last observed and what was expected. Never swallow a failed wait and continue
(`try { await wait } catch {}`): either the condition is required, so throw, or it is not, so do
not wait for it. After extracting, confirm the page did not re-render under you: the same IDs
for the rows you returned, the same values for the fields you returned, and the same URL as
before extraction. If any changed, read again within the deadline.
Build any check that values stopped changing from stable keys, such as record IDs, names and
prices, never from text that changes on its own, such as a countdown, a timer, a rotating badge
or a live viewer count.
After an action that can navigate, prefer waiting with `waitForOutcome` for a control only the destination page has, beside every other answer the action can give, over waiting for the destination URL alone, then extract. Keep the action,
readiness wait and extraction in the same Kernel execute call when possible. If a read
reports “Execution context was destroyed,” the action may already have succeeded.
Reacquire page/frame locators, wait for readiness and retry only the read within the
original deadline. Never repeat the click or submission as part of that recovery.
Race every answer a step can give with `waitForOutcome` rather than waiting for one request you
saw, which the site may batch, cache or rename; name a write's commit request as a `{ response }`
answer beside them (writes skill).
For an unknown destination, inspect after the document transition; do not invent a
selector or repeat the action in a follow-up read.
Import `waitCode` from the runtime (`outcomeWaitCode` declares `waitForOutcome` alone, for code
written before; paste one, never both), paste it once at the top of the call's code, and wait with `waitForOutcome({ refused, failed, unavailable, empty,
results }, { action, loading, region })`, one scoped locator per answer, each an element only
that answer has, such as a results list that holds a
row. The first listed wins when several show, so list a refusal, error or greyed-out choice
first, then the empty state, then results. Pass the step itself as `action`, such as
`() => apply.click()`: the wait runs it once, and an answer the page already showed before it counts
only after staying unchanged for `unchangedMs`, 2 s by default, so a list the step has not yet
re-rendered is not read while a step that leaves the same answer still resolves; a new or
changed element counts at once. `waitForOutcome` returns the name of the answer that showed.
An answer may also be `{ invalid: form }` (a field the site marked invalid), `{ gone: locator }`
(a form or dialog that closed), `{ url }` (a navigation or route change), `{ response }`,
`{ dialog }` (a native dialog, left open as `result.dialog`: keep it on `globalThis.dialog` and
return its type and message for `decideDialog`, as `references/native-dialog.ts` does), `{ popup }`, `{ announced: text }` (a toast or
alert a live region announced, even one gone before a look) or `{ check: fn }`.
`waitForOutcomeResult` returns the winner with its `evidence`, such as the invalid fields' labels
and messages, the toast's text or the `response`.
Prefer branching on that name over waiting again for the same answers or rechecking them with
`isVisible`. Pass the site's own loading sign as `loading`, the part of the
page the answer appears in as `region`, and the context's `siteDomain`, so the sign counts for as
long as it shows, changes in that part count as progress, and so do the site's own requests on
every host of its domain. A generic sign, such as `aria-busy` or a spinner class, counts only
while it is new, so a decoration holds a wait for at most the no-progress window; `waitForRows`
also waits while one shows beside its rows, never inside one, and for the requests its `action`
started. Without an `action`, a list beside a loader that never leaves costs about one
no-progress window. A request already in flight when a wait starts is not seen: on a page still
loading its list, name its loading sign as `loading`. Read results;
return an empty list for a listing's empty state;
throw `InvalidInput` with `field` and the site's own words for a refusal; handle a greyed-out
choice the input asked for as "Configure, then read" in the inputs skill says; ask the caller about a pick-one list
(.agents/caller-input/SKILL.md). It throws an
`Error` named `OutcomeWaitFailure` whose message says what each outcome matched, which progress
signs it saw and when progress stopped: `outcome_ambiguous` when the winning locator matches more
than one element; `outcome_unknown` when the page stops progressing for `noProgressMs` (8 s)
while showing none of the answers; and `outcome_timeout` when it is still progressing at
`timeout` (30 s). An unknown page is a challenge, the site's error or a layout you have not
handled: do not turn it into your own timeout; the host reports it as one. `references/navigation.ts` waits for a search's answer and
a record's page this way.
The same code declares the waits for the values you return. `waitForRows(rows, fields, { count,
key })` returns `{ rows, more }`: the first `count` rows that have a `key`, each field filled in
and reading the same twice. It reads each field from its first visible match, skips a row without
a key, and returns fewer rows once their count holds; no rows is never its answer, so decide an empty list with `waitForOutcome` first.
`waitForValues(fields)` returns `{ values }` for a record, a quote or a form's state.
Prefer the wait helpers' own settling over loops of your own that poll until values hold still:
`waitForRows` and `waitForValues` already return only once what they read is filled in and reads
the same on two looks.
`waitForChange(fields, { before, action, loading })` returns `{ values, changed }` after a choice:
changed, or the same with no progress sign for `unchangedMs`. They throw a `ValueWaitFailure`:
`values_loading` when a value is still loading as progress stops, `change_unknown` when the
fields are missing, `values_timeout` at the cap. A host may retry a read once after
`outcome_timeout`, `outcome_unknown`, `values_loading`, `values_timeout` or `change_unknown`,
so let them throw. `waitReport()` returns a one-line summary of how each wait in the call ended.
A field is a Playwright locator, or `{ locator, attribute, optional, all }`, where `all` reads
every visible match as a list. After a search or a filter, use `waitForChange` on the rows you
return, such as `{ ids: { locator: rowIds, all: true } }`, with the site's own loading sign as
`loading` when it has one.
After a step that reloads the page, such as choosing a city, prefer typing into the search box
again when its suggestions don't appear.
Typing or choosing can reload part of the page once per key or choice, such as suggestions or a
dependent list. The answers can land out of order, and the page may replace the element it
updates. Prefer waiting until every answer has landed, then look that element up again rather
than reading a node or handle found earlier, and check it shows the answer to the whole value.
When it doesn't, prefer entering the value once more over waiting longer.
