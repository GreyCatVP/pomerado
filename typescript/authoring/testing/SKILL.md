---
name: testing
description: Design and run live test cases for a read signed out. A signed-in read or a write skips this skill and proves its tool with one run.
---

# Test a read signed out

This skill is for a read signed out only. A signed-in read or a write does the original task: it
proves its tool with one run, the read's example (run again after each fix, as the core skill
says) or the write's act session (writes skill). It designs no tests beyond that run: no
`test/cases.json`, no live test on an input it chose and no offline test suite. Its HTTP version
is checked once, against that run (http-mcp skill). Report what that run did not exercise as
untested in `coverage`. The scope follows what the tool is now: a read that signs in or becomes
a write mid-build, a repair included, stops designing and running tests from then on, and a
repair that rebuilds a signed-in tool or a write as a read signed out tests it fully. Stop reading
here unless the build is a read that has not signed in.

Use execute with purpose=test, target, relative entrypoint/test file, fixtureRefs,
caseFilter, maxWorkers and timeoutSeconds. Fixtures are host-authorized immutable
inputs. Offline cases may use isolated workers; a live test is one read-only flow. It starts
like the example: the site origin page, with exploration cookies and site storage cleared. A
read proves its operation with purpose=example and iterates from that clean start; running the
example or a live test again is normal.

## Test a read signed out as much as it needs

Where the host offers `live_tests`, a read signed out has no limit on live tests, and the host runs
them for you in parallel. Testing is your job, not the caller's: never wait to be told to try another record, retailer or value.

Design the tests yourself. You saw the site: its controls, the values it offers and the ways its
pages differ. Choose the cases that would show the tool works for callers other than this one,
not mechanical variations of the example's input. Start as soon as you know the page and its
inputs, and refine the cases once the example passes. Consider each of these where the site has
it; none is required, and one case may serve several:
- every input, alone and together with the others;
- smart combinations: controls that share a panel, a drawer or a page reload, a location or store
  set with a filter, controls that could undo or hide each other, and the combination a real
  caller would most likely send;
- different real values unlike the example's: another retailer, store or seller, another
  category, a record whose page is laid out differently (a single option, grouped options, a
  multi-item page, sold out); for other reads, another route, date range or region, another
  category of listing, or a document or order page of another kind. Find them on the site, in a
  listing or picker you opened; never invent them;
- edge cases: a value the site does not list at all (`invalid_input`, with the page's choices
  listed), a query or filter with no results (`empty`, never a throw), and an option the page lists
  but greys out, such as a sold-out size, which a read returns as unavailable data;
- page two, with `next_page` or a cursor copied from a result, holding other results than page
  one;
- a location applied and read back, and one the site cannot apply (`error`, a loud failure, never
  results for another place);
- the example's own input once more, which runs on a fresh browser where the host has them;
- whatever you saw this site could break on while exploring: a panel that loads late, a pop-up,
  a layout that changes with the number of results, a value written differently on another page.

About 10 to 20 cases is typical. Write them in `test/cases.json`:

```json
{
  "cases": [
    { "id": "example-again", "purpose": "The example's input on a fresh browser.", "input": { "query": "desk lamp" }, "expect": "result" },
    { "id": "second-store", "purpose": "Another store from the store picker; its results page has no pickup column.", "input": { "query": "desk lamp", "store": "Mill Street" }, "expect": "result" },
    { "id": "sort-in-stock", "purpose": "Sort and the in-stock switch share the filter drawer, which reloads the list.", "input": { "query": "desk lamp", "sort": "price_low", "in_stock": true }, "expect": "result" },
    { "id": "nothing", "purpose": "A price ceiling no lamp is under returns an empty list.", "input": { "query": "desk lamp", "max_price": 1 }, "expect": "empty" },
    { "id": "page-2", "purpose": "Page two through the cursor page one returned.", "input": { "query": "desk lamp" }, "expect": "result", "next_page": true }
  ],
  "notTested": [
    { "what": "A location the site cannot apply", "reason": "The site ships one catalog everywhere and has no location control." }
  ]
}
```

`purpose` says in a sentence what the case establishes. `expect` is `result`, `empty`,
`invalid_input` or `error`: a loud refusal the tool throws on purpose, `InputNotApplied`; any
other throw is a bug and fails the case. Expect `empty`, `invalid_input` or `error` only for an
input the site really has no results for, does not offer or cannot apply. Use real values the site offers, which you saw while
exploring: listed options, places, dates, counts, records and retailers the site lists. Never use
a person's, account's or record's name, number or code, and never the caller's own values beyond
the example's input. List under `notTested` anything the tool claims that you chose not to test,
with why. A choice the request, the caller or the owner declined is not part of the tool (core
skill), so it is never tested.

Run them with `live_tests` action `run` (`cases` null runs them all; `maxWorkers` up to 3). One
Guardian review covers the batch; each case starts like the example, on its own fresh browser
where the host has them, and you get every result: its status, what it returned, and a failure's
error with the source line that threw. Name cases in action `plan` to read their full outputs,
and check what they mean, not just pass or fail: every item matches the filters, the order follows
the sort, the applied location is the one asked for, page 2 differs from page 1. A failing case is
a bug in the tool: fix the code at that line. Never drop the input, narrow the schema or change a
case's expectation to match what it returned to make it pass; fix the code. A
run that returns partly filled results, or passes only when run again, is missing a wait for
content: fix the wait, not the retry, then run that input again a few times.

A filter or sort case that fails because the results lost the choice is often order or waiting,
not the control. When setting one control reloads the list, such as a location or store, set it
before the filters and sorts its reload would drop, and after each reload wait for it to finish,
the row identifiers or the results header changed and then settled, never for every card's value
to hold (search skill).

A case that keeps failing at the same control after two fixes is usually a custom widget, not a
missing wait: a styled checkbox or option whose click does not change its state, a drawer that
hydrates late, or a list that reloads and drops the choice. Stop reworking the click. Look at
what the site did when that control did apply, in a probe or the captures where the host keeps
them. When the results URL then carries the choice, apply it through that URL (`AGENTS.md`,
"Work through the page's own controls"). When the page's own data request takes it as a field
and its answer echoes what applied, apply it there in `src/tool-http.mjs`; when that version
passes the cases, run the example on it, and the tool publishes `http` alone (http-mcp skill).
That is a finished tool: stop fixing the Playwright version. Either way, read the input back
from the site's committed state or the answer.

After the example passes, read its returned fields once at the answer and again about 10 s later
on the same page; a field that changed is filled late, so wait for it in source or describe it as
live, such as a countdown. A run that sits idle after its answer showed, or opens controls its
input did not use, works for more than it returns: trim it. Read every string in each result.
After each run with output the host reports output checks: values that hold code, styles, markup
or template leftovers, text read collapsed or cut short, a whole card's text, repeated entries or
records, and fields that never vary or are always empty. Check each against the page: fix a wrong
value at the read in source, never by cleaning the string afterwards; a correct value needs no
change (publication skill). Set each `include` value the tool offers in at least one live run, and
add any case that catches a real risk. A tool that returns a list runs page two live with the
cursor page one returned, and reaches a last page (pagination skill).

Results count only for the version, the source and the case as they ran: an edit makes them stale.
Finish in this order: make your last edit, run the cases again on each version you ship, run the
example last, then call `finish_build`. Publication review reads the host's record of your cases
(`publication/tests.json`), not your account of them, and judges them against what the tool
claims: a failing case, or a claim no passing case tests while time remained, holds publication
back. Deleting or changing a case after it failed does not hide the failure: the record keeps its
last result as retired, and so does a failure that passes when run again on the same code, as
flaky. When `live_tests` answers `no_time`, run the example last and publish; the record says time
ran out.

When the host offers no `live_tests`, a read signed out runs its cases one input at a time
instead: execute purpose `test`, target `liveBrowser`, with `testInput`, the tool's input as JSON
text; the host may limit how many.

Test the HTTP version, `src/tool-http.mjs`, the same way as `src/tool.mjs`: run the same cases as
a batch on it with `live_tests` entrypoint `src/tool-http.mjs`, in parallel, and fix it until
every case passes on it (http-mcp skill). It need not wait for the Playwright version: when every
case passes on the HTTP version, run the example on it and publish `http` alone, even while a case
still fails on the Playwright version. Each version keeps its own result for each case: a batch on
one never replaces or stales the other's, and `plan` shows the results of the entrypoint you name.
The publication record shows each case's result on each version that ships, and the review judges
each version from its own results; a version that does not ship is neither recorded nor judged. A
test of `src/tool-http.mjs` counts for the HTTP version only for the source it ran. Where the host
offers no `live_tests`, run its inputs one at a time with execute, entrypoint `src/tool-http.mjs`
and `testInput`, and check `testInput` against the schema yourself first: a failed test marks the
HTTP version's latest live test failed until a later one passes.

The example uses the caller's input, or your `exampleInput` when that input is empty, and offline
tests always use the caller's input. If a test shows the schema must widen, widen it in source;
publication reads the schemas from current source, and only a changed flow needs a fresh example
(publication skill).<!-- pomerado:section testing.offline-fixtures -->

- pureFiles: parsers/calculation with ordinary files and meaningful assertions.<!-- pomerado:section testing.saved-targets -->
- liveBrowser: authorized fresh observation for real-site behavior. Optional read
  smoke checks do not grant purchases, cart additions, uploads, holds or autosave.

Choose cases that catch actual risk: applied filters, IDs, units, authoritative empty
versus absent/loading data, partial coverage, schema failures, variants and changed
terms. Avoid assertions that merely
copy implementation expressions.
Report actual passed/failed/skipped/unsupported counts and missing evidence; an
all-skipped suite proves nothing. Never fabricate absent response bodies or assets.

The platform supplies compilation and runners. If a requested runner/fixture mode
is unavailable, report unsupported and preserve the exact gap. Do not install an
alternate network-enabled runner or silently call production from an offline test.

<!-- pomerado:section testing.capture-evidence --><!-- pomerado:section testing.later-cases -->
