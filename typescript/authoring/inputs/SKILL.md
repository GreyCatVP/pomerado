---
name: inputs
description: Read before writing or changing the input schema or any input, and before code that sets an input on the page: what the schema holds, required, optional and defaulted inputs, enums and typeahead lookups, JSON Schema constraints, descriptions and examples, contract gaps, and choices set on the page and read back (Configure, then read)
---

# Inputs

**The input schema.** Every caller sees the tool's input schema, so build it from the
request and the flow, never from one caller's account or example.

A value the request's text supplies, such as a code, a quantity or a choice, is the build's to
use even when the caller's structured input is empty: pass the request's values as
`exampleInput`, as `AGENTS.md` says (`execute`), never as a build-time question. Decide from the request and the site which inputs are
required. An optional input plus a declared question the tool asks before any effect is only for
a value the request genuinely leaves open; never make a required field optional with nothing
that asks. A choice the request or the owner's answer settled as how the tool behaves, such as
sorting by price or which kind of record it creates, is the tool's default, never a required
input or a question at run time. When a caller could reasonably want another value, declare it
with `defaultedInput(schema, answeredValue)` from the runtime, an optional input whose published
schema shows that default and whose run gets it when the caller leaves it out, and say in its
description that it defaults to what the owner chose; keep it fixed with no input only where
varying it would be unsafe or meaningless. A costly choice never takes one owner's answer as
its default (writes skill, "Compose and publish"). A write asks
its questions before its first save wherever the page lets it, so an unanswered question never
leaves a partial save on the site (caller-input skill). An input that tailors the answer on a read is the
exception: it is optional unless the task can't run without it (tailoring skill).

- The code works for every value the schema accepts. Never let the schema promise what
  the code rejects or ignores, such as a string the code throws on unless it is the example's
  value, or an input the code accepts and then never applies, skips or always reports
  unsupported or unapplied: wire it to the site's control. Leave an input out only when the
  site offers no control for it, and say so in the description.
- Every value the code types, selects or fills on the site comes from the input and
  accepts what the site's field accepts. An enum lists the site's full set of options,
  never just the example's value. The example's values are one case, never limits.
- Prefer keying only on what the caller asked for. A detail that changes from one listing to
  the next, such as a seating label or a room name, shouldn't decide whether the tool books or
  refuses unless the caller chose it.
- Read results for every option the schema lists. When an option leads to a page with a
  different structure (other fields or sections), handle that layout too, and on a read signed
  out run it live as a test case (testing skill); an option that only reorders or filters the
  same rows needs no case of its own. Never return results for another option in its place.
- A repair that finds a declared input broken, never applied or always reported unsupported
  fixes it in the same repair, whether or not a caller is waiting. Keeping a tool's contract
  means every input and output it declares works, not leaving a broken one as it was. An input
  whose description starts "By design:" is applied in the use it records, a caller's decision:
  keep that use and its description word for word, and change them only after asking the same
  design question again (tailoring skill).
- Prefer fixing the whole class of a failure over its one instance: when the page requires a control the input has no value for, prefer making every such control a declared caller question with the page's live options over throwing for it.
- Never derive a format from one sample: not an input format, an element key, a selector, a
  URL path or a label. A key the page showed for the example's value says nothing about the
  next value, as when a calendar keyed December 3 as `12-3-2026` where the tool expected `12-03-2026`. Read
  the format off the page for the value you need, such as the day cell whose visible label or
  accessible name is the caller's date, or a key the page itself lists, never a key rebuilt
  from the one you saw.
- Inputs are values a caller knows, such as codes, names, dates and counts, never a
  suggestion's full display text or an internal id the caller cannot know (an id the site
  shows on its own pages, such as a product number, is not internal). A closed list
  of options stays an enum of the site's options, as above. When the options come from a
  query, as in a search box, autocomplete, typeahead or searchable combobox, look the value
  up the way a person would, with `pickValue` from `pickerCode` (forms skill). It types the
  caller's value into the site's own search, reads every suggestion, matches names loosely
  (case, accents, spacing, punctuation, and whole words, so a name with a neighborhood or an
  airport code in brackets still matches) with a whole-name or code match outranking a partial
  one, and counts the matches at the best rank. With none, throw its `pickRefusal`, an
  `InvalidInput` with `field` and `available`, the entries the site showed. With one, use it.
  With several, a read takes the first in the site's own order and returns the one it used, as
  the site labels it. A write asks the caller which one with a declared choice question whose
  options are those matches as the site labels them (.agents/caller-input/SKILL.md).
- Match the caller's proper nouns, such as places, venues and company names, with a fuzzy
  match that accepts the usual forms of the same name, such as a name with or without its
  accents (Abaca for Abacá), a city alone or with its state and country, or a company with
  or without Ltd. or Inc. Never require an exact match. `sameText` from `pomerado/runtime`
  matches a name that differs only in case, accents, spacing, apostrophes, periods, commas or
  hyphens, or in a word the site writes short, such as St-Jean for Saint-Jean, but not one
  with a word added or dropped. Prefer it for confirming the pick, so the read-back agrees with
  the choice, but not for choosing from a list, where a short label can match a longer name it
  isn't, such as UK for Ukraine.
  When more than one option matches equally, a read takes the first in the site's order and
  returns the one it used, and a write lists them for the caller instead of picking one.
- On a write, every choice the session met is an input, costly choices included, and any
  other option, such as a seat, is an optional input, as the writes skill says ("Compose and
  publish").
- Never make an account-specific value (a passenger, loyalty number, saved card or
  address, account or member ID) an enum member, example or default in a public
  schema. Take it as a free-form input when the caller can name it, such as a loyalty
  number; a choice among the account's saved items that the caller cannot name is a
  declared `ask` with `accountSpecific` options (caller-input skill).
- The host's `businessInputTypes` is a value-free tree of the JSON types in the caller's
  input. Use it to pick compatible types when a credential in the input is masked; a mask
  does not mean the value was a string. It says nothing about
  required fields, array lengths, numeric bounds or future values: derive those from
  the request and reviewed evidence.
- Never hard-code a value the caller could vary: it comes from the input, never a literal
  in source, a schema default or the definition. Record every control the flow offers that
  narrows, orders or configures what the tool returns as an optional input wired to its
  control, even when the request never mentions it, except a choice that was declined
  (below). Open collapsed groups, drawers and "more" links before you decide what the page
  offers: a collapsed group is not an absent one. Leave out controls unrelated to the purpose,
  such as a language switch or a newsletter opt-in on a search. The search skill's "Find the
  filters" says how a search records them.
- Turn safety defaults off. They are never an input or a question (core skill, "Safety defaults").
- A choice the request, the caller or the owner declined, or a step they said not to take (no
  location, no store, skip a filter, don't sign in), is not part of the tool for any caller:
  never offer it as an input, never set it in the example or a test, and never put it in
  `exampleInput`. Note it in coverage. That covers a step the tool then never takes. A costly
  choice a write still meets on its path is never settled this way (writes skill).
- Callers and Guardian see the JSON Schema form, so write every constraint in one it
  shows: a `Schema.filter` shows nothing, its description included, so use
  `Schema.NonEmptyTrimmedString`, `pattern`, `minLength`, `Int`, `between` or `Literal`. Type
  every output field, never `Schema.Unknown`. A read publishes the schemas in its current source,
  and its example's own input and output must decode under them, so settle both before that
  example.
- Make each input as strict as the site's field: required text is non-empty and not whitespace
  alone (`Schema.NonEmptyString.pipe(Schema.pattern(/\S/u))`, which still takes a caller's stray
  space); free text takes a `maxLength` no longer than the site's own field takes, so a blank or
  over-long value is refused before the site is touched; a date, time or code keeps its
  `pattern`; a fixed set is a `Literal` enum. Make an input
  optional only when the site accepts the field blank and the tool works without it.
- Start each field's description with how many values it takes and what each one is, such as "One city name" or "A list of airport codes", so the input's cardinality is clear. A description that starts "By design:" keeps that marker first and puts the number of values after it, such as "By design: one postal code, …", never before it.
- When a field takes one value and a caller might send several, say "one per call" and prefer a
  `pattern` that refuses a list, such as several codes separated by commas, while still accepting
  one value that contains a comma, such as "Portland, OR". Prefer `between` to a range written
  only in the description.
- Give every input and output field, nested object and array item fields included, a short
  `description` annotation saying what it is, with the unit or format where one applies:
  "Departure airport as a three-letter IATA code", "Departure date, YYYY-MM-DD", "Average
  guest rating out of 5, not a count of reviews". Effect's stock text, such as "a non empty
  string", is no description. Annotate the field's own schema, inside `Schema.optional(...)`
  for an optional one. Callers see each beside its name.
- Shape inputs and outputs like Pomerado's own API, so every tool reads alike (outputs skill).
- Give every input field one `examples` annotation value, which callers<!-- pomerado:section inputs.example-readers --> use to assemble a sample request: public, generic data such as a well-known airport code
  (`examples: ["SFO"]`), a date a few weeks ahead or a common product category. Never use a value
  from this session: not the caller's input, the owner's answers or anything the site showed
  this account.
- Descriptions, titles, examples and defaults are published and reviewed for private data,
  and an annotation never declares its contents public. Explain constraints without copying private input
  or unneeded numeric identifiers; for a nonnegative safe integer,
  `Schema.between(0, Number.MAX_SAFE_INTEGER, { title: "Safe integer", description:
"Nonnegative safe integer amount" })` keeps the bound with public prose. Only
  host-approved standard enums and origins are recognized as public.
- Guardian's publication review checks the schema and the code that fills it. A
  `not_published` result with reason `input_feedback` lists `account_specific_enum` and
  `input_option` findings. They are feedback, on a read or a write: correct the source
  (make the value free-form or add the option as an input) and call `finish_build` again
  with the same `executionId`. An input narrowed to the example's value (`example_value`)
  blocks publication instead: widen the input and the code that sets it. The host reads the schemas offline from current source and checks that the
  example's or session's own input, and a read example's output, still decode. Never run a
  write again for it. After two such rounds, or if you stop
  without fixing them, the host publishes the last reviewed version privately to the
  caller's account and flags it.

**Find contract gaps before your first example.** Compare the schema you plan with what the
page offers: a control no input covers, an input you cannot wire, a value the request needs
that the page does not show, or a needed field you would have to make nullable. Settle each
then: wire it, ask the owner with `request_input` when the request reads two ways, when you are
unsure how to solve it, or before leaving out a part the site offers (`AGENTS.md`, "Try hard,
then ask", item 8), or state in the description why the tool lacks it, only for a part the site
does not offer, one the owner chose to leave out or, when no answer came, one that is hard and
optional to the request (`AGENTS.md`, "Solve before you narrow"). When the site never shows a
value the request needs, a field to return or a filter or option to apply, ask the owner with
`request_input` as soon as you find it missing, before you build, whether to build without it or
stop. When they need it, end with `report_blocked` reason `site_lacks_capability` (`AGENTS.md`,
"Impossible as asked"). Publication review blocks on the same gaps, and finding them at
`finish_build` costs a full fix-and-resubmit round.

**Configure, then read.** Many pages show values that depend on choices made on the page: a
record's options or variants, a plan or tier, dates, a party size or quantity, units, a
location or store. A search's filters and sort are such choices too. Before reading any value
that depends on them:

1. Discover. While building, read every choice group the page offers and each group's options
   exactly as shown, including which are unavailable, opening collapsed groups and menus as
   above. On a run, open and read only the groups the caller's inputs use. A group
   with one option, or a disabled control showing one value, is a
   fixed value: read it, never click it.
2. Set. Apply each input's value through the page's own control, in the order the page
   presents the groups, since one choice can change the options of the next. When the value is
   not among the options the page lists at all, throw
   `new errors.InvalidInput(message, { field, available })` before any commit mark, with
   `field` the input's name and `available` every option the page currently offers as
   selectable, exactly as shown. Leave disabled, sold-out and other unselectable options out of
   `available`, and say in the message that they were left out. Never pick a near match, the
   page's default or the first option; the same proper noun in another usual form is not a near
   match (input schema above). A broader choice that covers the value, such as "Show all", is
   allowed on a search (search skill).
   - An option the page lists but greys out, disables or marks unavailable, such as a booked
     date, a sold-out size or a full time slot: a read returns it as data, the requested value
     with `available: false`, the page's own reason when it shows one, and the alternatives the
     page offers beside it, such as the in-stock sizes, the open times or the valid stays, and
     the run succeeds. A write throws `InvalidInput` with `field` and `available`, the
     selectable options. Neither picks another value for the caller.
   - For an input whose options depend on another, such as a check-out after a check-in or a
     time after a date, apply the input it depends on first and read `available` from that
     state, then drop the options the input alone rules out. Never list options read before
     the input they depend on applied.
   - A number on a scale the site steps, such as a price range slider or price boxes, is a
     number, not a choice: never refuse it because no label matches. Set the nearest step inside
     the caller's bound, down for a maximum and up for a minimum, so a maximum of 47 on steps of
     10 applies 40, never 50; use the control's end when the value is outside its range. Read the
     applied value back and return it, such as `applied_max_price`, beside the results. The rule above for a value
     the page does not offer covers choice lists only.
3. Confirm. After a step that changed a choice, read it back from the page's selected state and
   wait for the values that depend on it with `waitForChange`, passing that step as `action`:
   changed, or confirmed unchanged once the page's loading sign came and went; a value read
   before the page updates belongs to the previous choice. A choice already in the requested
   state needs no step and no wait. Compare text read back with `sameText(shown, wanted)` from
   `pomerado/runtime`, `wanted` being the option the tool picked from the site's list when it
   picked one, and the caller's value otherwise. It ignores case, accents, spacing,
   apostrophes, and periods, commas and hyphens between letters, and accepts a word the page
   shortened, such as St for Saint. Prefer it over
   exact equality, since a page may echo a query or name in its own case or short form, and
   prefer comparing numbers, dates and amounts as values. When the page kept another value
   after the tool's bounded retries, throw
   `InputNotApplied` (rejections skill); never read on with the page's value, except in the cases the
   rejections skill lists as not unapplied, such as a number snapped as in step 2.
4. Read. Only then read the values the choices affect. Return the applied choices beside
   them. Return a group's offered options as a list when the page shows them without extra
   clicks, as a record page shows its variants, or when the caller asks (search skill).

An optional choice the caller leaves unset keeps the page's default: never set its control.
Read the default from the page's state or data where it shows, with no wait; otherwise, outside
a search (search skill), one open, read and close of its control is allowed; otherwise return
null and say why in the description.
Return it as applied. A control you could not find, open or read throws `OperationFailure`, never
`InvalidInput`.
