---
name: outputs
description: Read before writing or changing the output schema or any output field, and before code that reads a value the tool returns: values the request needs, typed and nullable fields, optional `include` sections, result lists and groups, field names, money, dates and other formats
---

# Outputs

**Never loosen a value the request needs.** The values the request needs are each value it
names, the record's identifier as the site shows it, and the context those depend on as the page
shows it, such as dates, a party size or a location. Make each one required and non-null, typed
so a value the code could not read fails the output check (`Schema.NonEmptyTrimmedString` for
text, `Schema.Int` for a count), never optional, nullable or plain `Schema.Number`, whatever a
description says. A run whose output fails its schema goes to repair.
- The owner may settle a different form for every run: in the request's own explicit words, in
  an answer to your design question or in a task update, such as blank fields returned as empty
  strings. Publication review honours that decision as stated. Build it that way, and say in
  the field's description what the owner chose. It never covers a value the page shows that
  the code failed to read, or anything personal or account-specific.
- Type each output field as strictly as its value: required text is non-empty and trimmed
  (`Schema.NonEmptyTrimmedString`), a date or time keeps its `pattern`, and a field that reports
  an input's value reuses that input's enum or pattern. Make one optional or nullable only where
  the page may genuinely not show the value.
- The one exception is a record whose own page genuinely does not show the value, such as an
  item that is sold out and shows no amount, or a listing that shows no date yet. Then the value may be null only together with a
  field that says why, such as its availability, and both descriptions say so.
- Null never covers a value the page shows that the code failed to read: that throws
  `OperationFailure` naming it. Never turn a read that found nothing into null
  (`?.innerText ?? null`); a missing element is a failure, not an absence.
- Before your first example, list the needed values. If the page may not show one, settle it
  then: find where the site shows it, on every layout its records use, or ask the owner.

**Output fields.** Design the output for what a caller could use, and lean toward more fields
and more information rather than the minimum: include the facts about each record or result
that a caller could reasonably use to identify, choose, compare or act on it, not only the values
the request names. Leave out what is unrelated to the tool's purpose or of no use to a caller.
- Keep each value's full displayed text. Read the element that holds the whole value, never a
  shorter or secondary one. When the page splits one value across elements, such as a maker
  line above a linked name or an author line above a title, return each part in its own field. Never drop either part.
- Prefer a separate typed field for each fact over folding it into another field's text. Never
  derive a value the page does not show.
- A field that is not a needed value is nullable when records on this site can lack it, and it
  is null exactly when this record does not show it.
- Never declare a field the code does not read. A field that is always null, empty or fixed is
  not a disclosed limit: read it from the page, or leave the field out.
- Expand collapsed text (a "more", "show all" or similar control) before reading it, and read it
  back: a value that ends in an ellipsis or holds the control's own label was read collapsed or
  cut short.
- Descriptions, specs, ingredients and variants often sit in collapsed accordion or tab sections
  that read empty while hidden. Prefer the page's embedded record data; otherwise open the section
  and read it back. Never guess a data key and fall back to null when it is missing.
- Before your first example, see each nullable field filled on at least one record that should
  have it. A field never seen filled is a wrong read: fix it or remove it. A field that says why a
  value is absent rests on evidence that this record lacks it, never on a read that found nothing.
  In `finish_build` coverage, name for each nullable field a tested record where it was filled.
- Return each fact once. Never add a field holding a whole row's or card's text beside the typed
  fields: give a fact they miss its own typed field, or offer the whole text only as the
  `card_text` section below.
- A list that can run past one page returns one page per call and a cursor to the next, as the
  pagination skill says.
- A tool that extracts records or table rows from an app whose fields are user-defined or found
  at run time, such as a CRM's records or a table's rows, follows the records skill, which takes
  precedence over the lean toward more fields above and one typed field per fact below: a small
  default keyed by field name, with every other field through its `fields` and `include` inputs.
  A record type whose fields are fixed and known keeps one typed field per fact.

**Optional sections (`include`).** Some parts of a page cost every run extra clicks or waits, or
are large and repeated on every record: the filters, facets and sorts the site offers, each
record's full displayed text, related or recommended records, options that show only on a hover
or a click, a panel each record opens. Leave each such section out of the default output and
offer it through one optional input, `include`: an array of the section names this tool can add,
empty by default (`{ "type": "array", "uniqueItems": true, "items": { "enum": [...] } }`), whose
description says what each name adds and what it costs.
- Decide by cost, not by bytes: a short list that takes a click to open on every run is a
  section; a fact each record already shows is a field.
- Use the standard names where they fit: `filters` (the filter groups, facets and sorts the site
  offers for these inputs), `card_text` (each record's full displayed text), `related` (the
  site's related or recommended records) and `variants` (each record's options). Name any other
  section for what it holds, in lowercase with underscores.
- Examples across kinds of sites: a shop's search offers `filters` and `card_text`; a fare search
  its `filters` and each fare's `fare_rules`, which open in a panel; a rentals or real-estate
  listing its `nearby` listings; a documentation search each hit's `full_section`, beyond its
  title and snippet; an orders list each order's `items`, when they show only after opening it.
- A section's output field is optional in the schema and absent unless asked for, never
  null-filled, and its description starts "Only with `include: ["name"]`".
- Without its name, the tool does none of a section's work: it opens no filter group, hovers on
  nothing and opens no panel. What the caller set is always read back whatever `include` says,
  such as the filters it applied, returned as `applied_filters`.

**Results, related records and groups.** A list holds only the records the site returned for the
inputs. Scope the row locator to the main list, and leave out related, recommended, recently
viewed and "others also" sections; with `include: ["related"]` return them in their own `related`
list of the same row shape, never mixed into the results and never counted toward a limit. A
sponsored or promoted row inside the main list stays where it is, marked as such, unless the list
already holds the same item (pagination skill); a promoted carousel, or any carousel or banner
with its own heading or scroller, is not part of the main list, even when its items are marked
sponsored. Return each item once.
A card that
stands for a group, such as one product in several flavours or sizes, a hotel with several room
types or a building with several units for rent, is one result marked as a group (for example
`kind: "group"`), with the options or count the card shows and a note that its link opens one
member, never presented as one of its members.

Then, for every field:
- Prefer parsing what the page shows into typed fields over returning a result row, card or
  itinerary as one text blob or summary, and keep every result row of the main list the page
  shows, up to the call's `limit` (pagination skill).
- Read every output from the page or response on every run, so every returned field has
  observable support: never a literal, a default you invented, or a constant `null`, `[]`,
  `false`, `0` or fixed label where the page can show the value.
- Return `null` for a field that is not a needed value only when this record's page lacks it,
  and an empty list only when the page shows none; never throw for either. When the code cannot
  read a value the request needs, throw `OperationFailure` naming it; never return a
  placeholder, a label or another record's value in its place.
- One field per fact, as the page states it, and variants as the dimensions and values the page
  lists.
- Prefer numbers for amounts and counts, ISO 8601 for dates and times and minutes for durations;
  type a date-only value as the runtime's `CalendarDate` (forms skill). A value that does not
  parse cleanly may be the site's own text.

- Shape inputs and outputs like Pomerado's own API, so every tool reads alike. A notation the
  request states, such as amounts as decimal strings or signed amounts, always wins; follow it
  and say so in the field's description. Otherwise: field names in snake_case; dates as
  `YYYY-MM-DD` and timestamps as ISO 8601 with an offset; money as an integer in minor units
  with the ISO 4217 `currency` the page shows beside it, such as `total_minor` 12999 and
  `currency` `"EUR"` read from "€129.99", and an amount that can go either way, such as a
  ledger entry, unsigned with a field that says its direction, such as `direction` `"debit"`
  or `"credit"`; enum values, statuses included, in lowercase
  snake_case (`"premium_economy"`, `"partially_paid"`), with the site's own wording, where a
  caller may want it, in a separate `*_label` field (`status_label` `"Partially Paid"`);
  booleans named as statements (`refundable`, not `is_refundable_flag`); lists named in the
  plural; and the unit in the field name or its description (`duration_minutes`). Convert
  between these and the site's own formats in code. The output check flags a date or timestamp
  not in the form its field declares (`format_mismatch`) and one value in two letter cases
  across a list (`case_variant`).
