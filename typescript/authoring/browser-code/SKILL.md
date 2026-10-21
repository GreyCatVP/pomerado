---
name: browser-code
description: Read before writing or changing any browser code: a `kernel.browsers.playwright.execute` call, an explore or a probe: execute calls, clicks and locators, the site origin, reading values from the page, page identity, uncertain transitions, probes and native dialogs
---

# Writing the browser code

- Make one execute call per operation. Add a call only at a `decideDialog` decision, an
  `ask` for the caller's choice, after `waitPastChallenge`, where the flow could run past
  300 s, or in a composed write, which keeps one call per `act` step.
  `timeout_sec` is at most 300.
- The code cannot see your variables. Write outside values into it with `JSON.stringify`,
  and return plain JSON, never a Locator or Response.
- Click with a plain `locator.click()`, with at most a `timeout`. A hosted browser may make
  it a real pointer click, after the same checks Playwright makes. `force`, `position`,
  `modifiers`, `button`, `clickCount` and `delay` keep a synthetic click, so pass them only
  when the step needs them.
- Prefer clicking a control's visible label when its input is hidden.
- Prefer taking a role locator's name from an ARIA snapshot (the host's `*.aria.yml` capture or a
  scoped `ariaSnapshot()`) over `textContent` or `innerText`, which include hidden labels. When the
  snapshot shows a link with no name, prefer its `href`.
- Check the null case if possible. Make sure the tool handles a lookup or filter that matches
  nothing.
- Do site HTTP inside the page with `page.evaluate(() => fetch(...))`. Never use
  `page.request` or a Node-side fetch<!-- pomerado:section browser-code.execute-calls:start
.
pomerado:section browser-code.execute-calls:end -->
- Console logs do not work. Return what you need to see.
- Never repeat a call that may have run.

<!-- pomerado:section browser-code.host-ownership:start

The host owns input/output validation, deadlines, caller authority and the browser. Do not close the page.

pomerado:section browser-code.host-ownership:end -->A newly allocated Page may start at `about:blank`; the supplied site origin does
not mean the host has navigated there. Navigate to the authorized site and wait
for a named page condition before inspecting its title or controls. Empty content
on a blank Page is not evidence about the website or its availability.

Take the site origin from the context's `siteOrigin`. If it is undefined, fail before
live navigation; offline fixtures intentionally have no live origin. Build URLs with
`new URL("/", siteOrigin).href` or a fixed path the site links to (`AGENTS.md` says when a
caller's value may go in a URL), and write them into the code. Never embed the site's hostname
or account-specific origin as a literal in authored source, schema examples, or logs, and never replace it with `page.url()`
after a redirect. The host supplies the primary origin even when the model cannot see
it. This value does not authorize other destinations or credential submission.
For a tool whose sign-in moves each account to its own workspace host, `siteOrigin` is that
account's workspace origin at run time, so a URL built from it, or from `siteDomain` for a
fixed API host, reaches the right workspace, and one built from `page.url()` or a literal does not.
The context's `siteDomain` is the site's registrable domain: check that a page is on the site
with it as `AGENTS.md` shows ("Check the page is on the site before exploring it"), writing it
into the code as you do `siteOrigin`, never derived from the hostname.
`references/native-page.ts` shows the check. Use `page.evaluate`,
`locator.evaluate` or `locator.evaluateAll` when code needs browser globals such as
`document`.
Read each output value from the element or structured-data entry that holds the whole value,
never a shorter or secondary one, found by a stable id, a `data-` attribute, a role and name or
the record's own key, with `visibleText`, `visibleTexts` or `readRows` (paste `visibleTextCode`
from `pomerado/runtime` at the top of the call's code). They return only the text a person sees
on the rendered page, with whitespace normalized and invisible characters removed, and fail
instead of returning hidden text; `as: "accessible"` reads what a screen reader reads instead.
`textContent` always includes hidden text, scripts and styles, and so does `innerText` of an
element that is not rendered, such as a hidden duplicate of the block you meant. `readRows`
reads a window of rows in one call, each field relative to its row. Read a list's rows in one
call: `readRows` and `waitForRows` read every returned row at once. A list of texts read from a
page, such as bullets, highlights or option names, can hold blank entries the site renders
invisibly: trim each entry and drop the empty ones, so one blank entry does not fail the result.
A single text field that can be blank on some records is nullable, and its description says when
(a needed value also takes a field that says why, as the outputs skill's "Never loosen a value" says). Never select
by a generated CSS class, a hashed or build-numbered name such as `.e-1a2b3c` or `.css-1x2y3z`:
it changes on the site's next deploy.
Never read it from a broad container, whole-page text, tag-stripped HTML, a regex over page-wide
text or a page-wide setting such as a currency or language picker: a heading, label or
placeholder is not the value beside it. Read embedded data separately when it is relevant to
the requested operation.
On a hosted browser each Playwright call is a remote round trip, and each awaited call waits for
its own, so a read costs its number of calls, not its navigations. Read every field a page needs in
one `evaluate`, `readRows` or snapshot per page, never one locator call per field or a probe per
element. Prefer values the list page already holds, in its rows or its embedded data, or the
site's own data request<!-- pomerado:section browser-code.data-request-reference -->, to opening each record's page. When the tool must open
each record's detail page, keep each to a few calls (open, wait, one read), and consider whether
the request is better served as two tools, a search and a details read by identifier; say so in
`coverage`.
Prefer the page's own structured data, its embedded JSON or the data response it renders from,
to its rendered cards when it holds the same fields for the same records, and check on the
example that it matches what the page shows. Embedded JSON holds the page as first rendered:
after an in-page change, such as a filter that reloads the list without a navigation, read that
change's data response or the rendered rows, never the initial JSON. Read the rendered page for
a value that exists only after client-side rendering, or that the page computes where you see
it, such as a total.
<!-- pomerado:section browser-code.site-origin -->After a probe reveals a challenge, inspect the retained Page in follow-up probes
and wait for the intended page/control within the existing deadline and job budget;
do not click the challenge, reload, or navigate to another route merely because
the earlier probe timed out. A new probe execution does not require new navigation.
A live example, a live read `test`, and a write session's first `act` step are
different: they start from a reset page, as `AGENTS.md` says ("Reads, writes and examples"),
so the source sets every value its input controls and its own start state itself. A sign-in that started and was never verified is the exception: that
reset clears cookies and site storage. When the page is signed out after that reset, or after a
full page load your source asks about with `ensureSignedIn`, the host signs in again by itself;
do not call `authenticate` for it. When the host cannot keep the site signed in, the step fails with
`session_not_kept`: report that cause instead of signing in again. That source must perform
the flow from its input,
never rely on a page an exploration left open. So a read iterates from a reset start,
and re-running its example or live test is normal.
If the deadline expires, report the named readiness failure and use current
screened evidence to distinguish a remaining challenge, loading and changed
layout.<!-- pomerado:section browser-code.challenge-reference --> Do not invent a CAPTCHA bypass or replace the target with an arbitrary
first element. Resolve role and computed accessible name from observed evidence;
`searchbox` and `textbox`, and their exact names, are not interchangeable.
When a locator is missing or a Playwright timeout names one, first check that the page's URL and
heading are the page you meant: a wrong or error page needs the site's own route to the right
page, never a new selector. Otherwise repair that wait and keep the checks that already
passed. A `DeadlineExceeded` phase of `execution` is the shared operation deadline. Before increasing a timeout, make one bounded observation of the candidate
target count or state; increase it only when evidence shows that the correct unique
target is slow. Do not catch-and-repeat timed-out work: a timed-out click or navigation is
an uncertain transition (`AGENTS.md`).

Never call `.first()` (or `.nth(0)`) on a broad text or regex match, whether to
click it or to wait for readiness: collapsed menus often hold an earlier hidden
match. Scope a role locator to its evidenced container and to visible elements,
for example `nav.getByRole("link", { name: /log in/i }).filter({ visible: true })`,
then check that exactly one element matches; `waitForOutcome` checks it for the outcome it
returns. When several candidates remain, inspect them and choose by evidence such as
section, accessible name and destination before clicking or waiting. A readiness wait targets one specific
evidenced element or page state.

Never search the open web, such as Google, to find the page a task needs. Make its URL an
input and ask the caller for it.

For a detail read whose input is the record's page URL, check that it is https on the tool's
site and open it unchanged. Otherwise reach the record through the site's own search, list or
link for the schema-validated caller identifier, or through a stable identifier route the site
itself uses when that is clearly better (AGENTS.md, "Work through the page's own controls").
A successful response or plausible content is insufficient: the final page's
site (any https host on the site's registrable domain), final path and stable page
identity must all agree with the requested identifier. A path agrees when it carries the
identifier; a site can serve one record under several of its own routes. Explicitly classify
a detail page, loading state, known interstitial and unsupported or mismatched page. Continue through an interstitial only when its
own stable identity matches the request and one unique continuation control belongs
to that interstitial. This exception does not include a CAPTCHA, login or unknown
challenge. Wait for the detail or proven interstitial, guard the continuation, then
wait again and recheck the final site, path and page identity before extraction. Use
typed failures for every other state; never return interstitial fields as a detail
result. `references/navigation.ts` shows this sequence in one call, reached through the site's
search (`detailNavigation`) and from a caller's page URL opened unchanged (`detailFromUrl`).

Target identity guards, effect authority and semantic completion are separate.
A dispatched click is not completed work. Missing completion after a possible
write, login or other consequential effect requires reconciliation before repeating
it. Bounded repeatable reads and transient search interactions may continue under
existing authority when source and current observations establish their semantics;
inspect state before choosing a retry or safe read reconstruction. A search/query
submission can be a read; autosave, drafts, uploads, holds and business commitments
are writes regardless of method or control names. <!-- pomerado:section browser-code.raw-page-calls:start
Raw Page calls require host review and caller authority.

pomerado:section browser-code.raw-page-calls:end -->Preserve the host's reported failure stage and dispatch state. Missing output or
a provider 404 does not prove that navigation, login or a previous action never
happened. A guard failure before one click says nothing about earlier actions in
that script. For a reviewed current-state inspection, check that the page is on the
site before reading the existing page, as `AGENTS.md` ("Check the page is on the site before exploring it")
shows. Prefer that retained state when usable;
reconstruct only established repeatable reads within the request's constraints.
For a repeatable read, use the exact returned failure phase to narrow the repair.
Do not replace a passed readiness condition or repeat successful setup merely
because a later extraction call timed out.
Never recreate a write or login to recover an observation. See
`references/native-page.ts` for a site-guarded read.

<!-- pomerado:section browser-code.capture-evidence -->

Keep exploratory output focused on the current question: the relevant control or
container, its state, and the nearby choices. Prefer the existing accessibility
checkpoint to repeatedly returning whole-page text and all controls. If a probe
reports a missing choice, compare its post-action checkpoint before concluding
the site does not support it. Listing a filter panel's or option group's controls is a
focused observation. Return explicit partial coverage when an observation is bounded; never
describe a truncated list as complete. In a probe, count a locator before acting on it and give
each action `timeout: 5000`, the default the host also gives probe actions; take names from a
scoped `ariaSnapshot()`, not visible text. A probe that waits out a long timeout for a missing
element learns nothing a count would not. Return `waitReport()` from a probe that waits.

For a native dialog, the call that raises it keeps it on `globalThis.dialog` from a
`page.once("dialog")` listener and returns its type, message and URL without awaiting the
click. Pass that to `decideDialog` with a stable step name, and apply the host's choice in
the next call with `globalThis.dialog.accept(promptText)` or `globalThis.dialog.dismiss()`,
as in `references/native-dialog.ts`. Never pre-dismiss the dialog or retry the action.
