---
name: search
description: Read before settling a search or listing tool's inputs: the site's own filters, sort and location, applied and read back, and honest empty results.
---

# Build a search from the site's own controls

A search or listing tool returns what the site shows for the caller's query and filters. Every
input changes what the site does on that run, and every value it returns comes from that run's
results. "The tool throws" below means the published tool's code throws at run time, so that run
fails or reports a bad input; it never means ending the build.

## Find the filters

Before you settle the input schema, open the results for a typical query and read every control
that narrows, orders or configures them: the filter panel, chips, the sort menu, range sliders
and boxes, toggles, and every group that is collapsed, scrolled out of view or behind an "All
filters", "More" or "Show all" button (core skill, the input schema). Make every
control that narrows or orders the results an optional input wired to its control, even one the
request never names; leave out only controls that change neither which results come back nor
their order, such as a layout or language switch. A safety default (core skill) is not an input
either, and the tool turns it off. Nor is a filter, sort or location the request, the caller or
the owner declined: it is never an input for any caller (core skill). This survey is build
work. The published tool does not repeat it: on each run it opens only the groups the caller's
inputs use (see "Apply and read back").

- Take each input's choices from the site. When it offers the same choices for every query, the
  enum lists all of them as the page shows them. When they depend on the query, such as sizes or
  brands, take a string and match it against the choices this search's page shows.
- Filters and sort are choices: set them as "Configure, then read" in the core skill says, and
  read the results last. When the page's list of choices does not hold a caller's value but a
  broader choice such as "Show all" covers it, choose the broader choice and return the rows the
  site gives, saying so in the description. Otherwise the tool throws `InvalidInput` with
  `field` and `available`, the choices the group it opened for that value offers on this
  search's page, only after reading them. A control the site has but the tool could not find,
  open or apply makes it throw `OperationFailure`.
- A price or other numeric range is a number, never a label to match: a slider's labels and
  steps often change with the result set. Set the nearest step inside the caller's bound (down
  for a maximum, up for a minimum), the range's end for a value outside it, read the applied
  bound back and return it beside the results (core skill, "Configure, then read").
- A filter group the page disables for this result set, such as a price filter when only one
  result shows, is part of the answer: check that a group is enabled before opening it, never
  wait on a disabled one, and return the results with that filter reported as not offered.
- Never set a filter or sort in code, even one the request names: each is an input, and a
  declined one (above) is neither set nor an input. When the site offers a sort, it is an
  optional input listing every order the site offers. A page size visitors cannot change is the
  site's; state it in the description.

## Apply and read back

On every run, set each input the site has a control for through that control, or through the URL
or data request the site itself uses for it when the control is unreliable (testing skill), never
by filtering the returned rows, then read it back from the site's committed state: the
applied-filter chips, the selected sort, an option the site shows selected, or the results header.
A URL naming the input does not show it applied. When a filter did not apply, the tool throws
`OperationFailure` naming it, so the run fails and the tool gets repaired; it never returns
unfiltered results as filtered.
An HTTP version reads each input back from the answer instead: the echoed query, sort, filters
and store or location in its own state.

When setting one control reloads the result list, order matters: set that control, commonly a
location or store, before the filters and sorts its reload would drop. Open only the groups the
caller's inputs use. For a control inside a drawer or collapsed group, open the group first and
wait for its panel to show and any loading overlay to clear; click the visible label or option,
never a hidden input; when choosing reloads or navigates the results, wait for that reload to
finish: the row identifiers or the results header changed and then settled (`waitForChange` on
them), never every card's value holding still, since values that load lazily may never settle.
Then read the choice back where the page shows it: an applied chip, the selected sort, the results
header, or the reopened panel when nothing else shows it. A follow-up choice that will reload the
results anyway can wait for that reload instead. Close a drawer or panel you opened with its own
close control or Escape, and check it closed. After the last change, wait for the rows you return
with `waitForChange`, as the core skill says.

## Location

When results, prices or availability depend on a location or store that the site lets a visitor
set, make it an input and apply it as the core skill's input schema says. If the site says it has
no such location or store, the tool throws `InvalidInput` with `field` and `available`, the ones
it offers. When the page does not apply the caller's location, or resets a filter or sort the
caller chose, the tool throws `InputNotApplied` with the requested and applied value (core
skill); it never returns results for the page's own location or default in their place.

## Results

Wait for the search's answer with `waitForOutcome` (core skill). Prefer naming its error, its
no-results message and its results over waiting for the results alone, and name results by the
page's most stable sign, such as the result count or heading for the query, over one layout's
classes. Read every field of every result you return from that result's own card on every run.
Lean toward more information (core skill, output fields): return the facts on each card a caller
could reasonably use to choose among results, with full displayed values, and a maker or provider
line in its own field, each fact once. Return only the site's results for these inputs, with
related or recommended items, the filters the site offers and each card's whole text only as
`include` sections (core skill, optional sections). When only some cards show a fact, its field
is nullable and null exactly on the cards that don't. Read the results once the rows you return
have their key fields, filled in and holding still (`waitForRows`). When the site marks results
as suggestions rather than matches, such as "no exact matches, showing similar items", return
that. Keep the matches apart from related items, recommendations and sponsored carousels, which
go in their own list or are left out, never mixed into the results, and return each item once. A
card that stands for a group of variants, such as "6 flavors" or "3 colors", says so in its own
fields, such as a variant count, and that its link opens one member of the group. Check that the
page's echo of the query, such as a results heading, matches it normalized, or for a proper noun
fuzzily, never with exact case-sensitive equality. A search
that applied every input and got the site's no-results message returns an empty list, never an
error.

## Answer quickly

A search should answer in seconds. Every click and wait runs on every call, so a run does only
what its inputs need:
- Open, set and read back only the groups the caller's inputs use. Always return
  `applied_filters`: the groups the tool set, as the page reads them back.
- Return the site's offered filter groups only when the caller asks, through an optional
  `include` list input holding `"filters"`. Their output field, such as `available_filters`, is
  optional and absent unless asked, and its description starts
  "Only with `include: ["filters"]`". When the page already shows the groups without a click,
  the tool may return those, and says they are the visible ones.
- Skip a step whose result the page already shows, such as a location, store or sort that is
  already the caller's.
- Never wait for the page's `load` event, for network idle, or for rows and content you will not
  return.
- Reach the results by the route the build proved (`AGENTS.md`, "Work through the page's own
  controls"), falling back to the search box once. `references/navigation.ts` shows both.
- How many results one call returns, and the way to the next page, follow the pagination skill.

## Pages

A search returns one page of results per call and a cursor to the next: read the pagination
skill before you settle the schema. The window is the first `limit` results in the site's
order, sponsored ones in place.

## Describe and test it

The description briefly states the design decisions, limits and interpretations a caller needs,
such as the site's default location, how many results one call returns and how the site pages. A
search signed out sets every input you expose in at least one live run before publishing, as the
testing skill says; a signed-in one proves the tool with its example. Give each input an
`examples` value the site offers for a typical query.
