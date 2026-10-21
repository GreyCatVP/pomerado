---
name: core
description: Kernel script operation SDK, mint intake, execution targets and ownership.
---

# Start here

Identify the requested operation, website/login realm, required account, business
inputs, desired result and permitted effects. A read build explores, then iterates its
script from a reset start by running its example until it works (re-running a read's
example is normal); resolve its missing choices with reads when possible. A write build
does the caller's requested task once, live (in as many write steps as it takes), then
composes its script from what happened (the `writes` skill). A read tests what its example
did not exercise with a few combined live cases (the `testing` skill). A write proves its tool
with its act session; it never reads
the `testing` skill or designs further tests<!-- pomerado:section core.write-http-check -->.
That forbids running the write again or testing it live, not writing checks: a write's script
checks its own result, and its read-back and comparison are checked offline over what the session
read (the `writes` skill). The scope follows what the tool is now, as the `testing` skill says. Credentials and
sign-in codes
belong to the host; never request a password, cookie or TOTP seed in model-visible text.

Asking the caller follows `AGENTS.md` ("Try hard, then ask").

Write ordinary TypeScript or JavaScript files. Export a default Kernel script, as
described below. Import the actual canonical SDK entrypoint given in the workspace
README; do not assume an unconfigured package alias. Repository examples compile
against `typescript/src/runtime/index.ts` and show the real method signatures.

## Secret answers

A `secret` answer comes back as a handle such as `{{secret.s1}}`, never the value,
which you never see. In explore, test or `act` source, write the handle exactly as given as
the whole string passed as the value to `fill`, `type` or `pressSequentially` on a `page`
chain, or as a field of a `fetch` call to a literal URL on this site, inside
the code of a `kernel.browsers.playwright.execute` call, such as
`await page.getByLabel("Code").fill("{{secret.s1}}")`. The host fills in the value when it runs
that source live and masks it in what comes back; offline targets get the handle unchanged.
A handle anywhere else is refused before anything runs, naming its file and line: in a
variable or a locator held in one, joined or transformed, returned, logged, in a URL or a JSON
file, or beside code that reads the field back (`inputValue`, `evaluate`), reads its own source,
or redefines JSON, a global, a prototype or a page or Kernel method; check the result in a later
execute call. So is a handle the attempt never issued. An example and published
source never hold a handle: a value the finished tool needs at run time is a declared
`secret` question it asks with `ask` (caller-input skill).

## Kernel scripts

An operation is `defineOperation({ name, input, output }, async ({ kernel, sessionId,
siteOrigin, siteDomain, input, decideDialog, ask, waitPastChallenge, verified, remainingMs, errors }) => ...)`. Its browser
work is its own `kernel.browsers.playwright.execute(sessionId, { code, timeout_sec })`
calls. <!-- pomerado:section core.operation-shape:start
The host runs
pomerado:section core.operation-shape:end --> each `code` string as plain Playwright code on its own `page` and
answers `{ success, result, error, stderr }`. Throw
`new errors.OperationFailure(String(answer.error), { stderr: answer.stderr })` when
`success` is false or the page is not what the operation needs.

- After a write, call `verified()` with no argument just before returning, once a call has
  read the result back, either the site's confirmation for this submission or the saved state.
  Return the confirmation number or record in the output. Without it the write stays a
  possible effect. A write declares which in its contract's `write`, and a write build runs
  as `act` steps; see `writes/SKILL.md` and `forms/SKILL.md`.

The tools and the files you may edit are in `AGENTS.md`. The host binds the caller's actual input/account; no tool
argument selects another account or private reference. A live test's `testInput`, on a
read only, is an input you choose as .agents/testing/SKILL.md says. Every new command/probe/execution gets Guardian review<!-- pomerado:section core.tools-and-files -->.
Nested Playwright actions do not each trigger review. A probe operation still receives the host-bound business
input. Its declared schema must accept that input even when the bounded observation
does not use every field; do not replace it with an empty or probe-only schema.

<!-- pomerado:section core.captured-checks -->

<!-- pomerado:section core.references:start
Choose relevant references: search for a search or listing tool, writes, cart for a cart or
checkout, pagination, forms, caller input for a choice only the page can offer, or a code,
during the run, and publication before the first `finish_build`.
pomerado:section core.references:end --> Read their bodies only when useful.
Finish with actual execution evidence and
truthful coverage through `finish_build`. A write finishes after its session's
confirmation read; never run the composed script live. Ask only as "Try hard, then
ask" allows. If infrastructure prevents further
work, report the recorded failure and unresolved effects, then end without
publication; the host preserves an incomplete build. Do not ask the user to
answer a provider outage. Publishing future code does not replace the build's own
result or resolve uncertain effects.

Examples: `references/parser.ts`, `references/native-page.ts`,
and `references/selection.ts`. For custom choices, the forms skill includes
`references/custom-selection.ts` and points to the relevant helper implementations.
Read those on demand when deciding whether a helper fits the observed control.
SDK reference gaps must be reported, not recreated as unreviewed infrastructure
in every site script.

For a demonstrated account/layout variant, handle every supported layout in one
script. The call that reads the page first observes which layout it shows, and the
script fails on a loading, ambiguous, unknown or mismatched layout. Inspect stable
containers, roles,
field organization and legitimate account/input capabilities; never classify a
layout from private customer literals, changing dates or whole-page hashes.
Loading is not proof of a new version. An identity mismatch blocks every candidate.

See the compiling `references/variants.ts` example.

<!-- pomerado:section core.layout-captures -->

## Skills

Each skill in the skills list says when to read it. Read it then, before you write or change the
code or schema it covers, even when you think you know the rule. The browser code, its waits, the
input schema and the output schema each have their own skill (`browser-code`, `waits`, `inputs`
and `outputs`); a skill your first message already holds needs no read. `AGENTS.md`
("Publication blocks on these") keeps one line for each rule that blocks publication.

## Safety defaults

Turn safety defaults off, on every tool, a read or a write. A preselected option whose only effect is to
share the caller's data with another company, such as a partner comparison that opens the search
on another site, to opt into tracking beyond what the site needs, or to sign the caller up for
marketing email, is never an input and never a question. The tool turns it off on every run
before the submit it affects, and reads back that it is off. When the site won't submit with it
off, leave it on and say so in the description. Name the ones the tool turns off in the
description in general words, such as "turns off partner comparisons". A repair keeps each one
the registered source turns off. Never turn one on yourself, in a form or a request body. For a
consent flag the site sets for the user in a request body, send the value read at run time or
leave the field out.

Find these boxes where you fill the form, unlabeled ones included. List every checkbox, switch
and toggle in and near the form by role and by `input[type=checkbox]`, never only by label, with
its checked state, its nearest text, its group's heading and the alt text or title of any logo
beside it. A preselected box whose group names another company or shows its logo is a partner
box. After a probe's first submit, check whether a new tab opened or the page left the site. If
one did, a box you missed sent it there.

## State-changing requests

A live execute result may carry `stateChangingRequests`: every request other than
GET, HEAD or OPTIONS the page sent since the last execution result, by `method`,
`origin`, `path` and `resourceType`, with a `count` (`omitted` counts routes past
the list). Each entry also lists its requests' final response `statuses` in order, and
`unanswered` counts any with no answer when the step ended. Nothing refused them; the
list exists so you can catch writes you did not intend. Telemetry, analytics and bot-sensor POSTs are normal and need no change.
So is an anonymous recent-search, prefill or search-state save the site fires when
you submit a search.

For a read tool, look for a write your own action caused, such as adding an item to
a cart, submitting a form, saving a preference or starting a checkout. If you find
one, change the code so it reads without causing it, for example by reading the
value from the page instead of clicking the control that changes it, and run it
again. Setting a read's location, filter, sort or option through the site's control is part of
the read, not a saved preference (tailoring skill). For a write session, the list shows the commit your step caused and any
autosave, with the status the site answered: a 2xx or 3xx on the commit's route, with no
error after it, is what the writes skill confirms from. A 200 whose body reports an error, as
GraphQL can, did not go through. The list is the evidence for the `http` version, and any
other write is unintended and must not be in the composed script. `initiator` is evidence, not proof: `evaluated_script` is usually your own
page evaluation, `page_script` is the site's script (which your click can also
start), and `parser` is markup such as a form submission.

## Host incidents

The host records every request your code causes and blocks none. An execute or inspect result
may carry `hostIncidents`. The first model request may carry `hostIncidentsBeforeStart` for the
host's own entry-page load. The mint continued past each listed gap.

`hostIncidents` kinds:

<!-- pomerado:section core.incident-kinds -->

Unclear means possible. `websiteEffect: may_have_dispatched` makes that execution's
effect possible: reconcile current state before claiming success, and never repeat
a claimed example or an uncertain write blindly: in a write session or a maintenance
repair, read back whether the write happened first, and do the write only if it did not.
`hostBug: true` marks a suspected Pomerado defect, which the host has reported. On a
`dialog`, report it in your diagnostics and do not work around it. On an `observation_gap`
or `capture_unavailable`, note it in `finish_build` coverage and keep building. A gap never
stops a read. A write the gap covers has an unknown outcome, so never repeat it without the
read-back above.
<!-- pomerado:section core.standalone-completion:start

## Standalone execution and completion

Use the ordinary `defineOperation` API and existing Kernel-shaped browser calls above. `liveBrowser` is native Playwright and `pureFiles` is local computation. The host retains Guardian review, caller authority, source reads, questions, deadline/cleanup and no-replay rules. It offers no browser replacement or captured replay facility. An invalidated native executor ends this attempt; never use a new browser to repeat an uncertain effect.

Declare explicit input and output schemas, concrete types and bounds for each supported field. A detail read verifies the requested record identity and final page state.

`finish_build` returns the current integration files and schemas after shared checks. A read needs a successful example using supplied values. A write needs its original confirming act receipt and current source; compose it without running it again. Return the task result and honest evidence, not unsupported success claims.

Only the host asks for website credentials and only during `authenticate`. Give it the observed field selectors, slots, allowed identifier kinds, format and submit. No generated source receives the raw password; follow the same destination, stale field/focus, no-readback and code-handle rules as hosted execution. Correct a refused binding by reading the current screen. A rejected credential needs caller correction; do not resubmit it.

pomerado:section core.standalone-completion:end -->
