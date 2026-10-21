---
name: rejections
description: Read before writing any check of the caller's input, any `InvalidInput`, `InputNotApplied` or `OperationFailure`, or any refusal a tool returns: the rules checked before touching the site, which error fits what happened, `available` and `kind`, and when a message starts "Caller input error:"
---

# Refusals and failures

## Validate it, and fail with the right error

A published tool is an API: every caller reads its input schema and acts on its errors. Refuse a
bad value before the tool touches the site, and fail loudly whenever the run cannot return what
the caller asked for. Never return results computed without a value the caller supplied, except
an input that tailors the answer, which a read returns labeled with the value the site applied.

1. Express in the input schema everything it can hold, so the host refuses a bad value before
   the script runs: each field's type, an enum of the site's full set of options when the
   options are fixed, a minimum and maximum for numbers, counts and lengths, a format such as a
   date-only `CalendarDate` or a pattern for a code, and which fields are required.
2. Check every rule the schema cannot hold before any site action, and throw
   `new errors.InvalidInput(message, { field })` at once, starting "Caller input error:" and
   naming the field and the rule. Such rules include:
   - an end date on or after its start date, and a check-out after its check-in;
   - a date the task rules out, such as a departure before today in its airport's time zone.
     A date is past when it is before today in the site's time zone; UTC's date can be a day
     ahead or behind. On a site with places in several time zones, use the place's zone, such
     as a restaurant's or a departure airport's, when the tool knows it before any site action,
     and otherwise refuse only a date that is past in every time zone, such as one before
     yesterday in UTC;
   - a count below one, or above the site's own limits, such as a party size or quantity the
     site caps, found while building and stated in the message;
   - inputs that exclude each other, such as a store and a ZIP code where the site takes one;
   - at least one of a set the tool needs one of, such as a record's number or its name.

   When the refusal is obvious, start the message with "Caller input error:" so the caller gets
   it at once. It is obvious when the input alone breaks a rule of the task, as above, checked
   before any site action. It is also obvious when the page itself refuses the value in its own
   words, which the message quotes, or when the site's own lookup of a record's own key, such as
   an order, ticket or item number, or the site's own link to that record, shows the site's
   not-found or empty result. Never use that start for a breakage, which goes to repair: a URL
   the tool built itself, a page whose layout or controls the tool no longer finds, or a lookup,
   slider or list that hadn't loaded. Nor when a suggestion list or picker offered nothing, or a
   write finds a day disabled without the page saying why. Prefer not starting a refusal of an
   ambiguous value with it (caller-input skill).
3. Throw the error that matches what happened:
   - `InvalidInput`: the caller's value is wrong or the site does not offer it. It breaks a rule
     above, or is not among the options the page lists, such as a store missing from its
     picker. Pass `field`, and `available`, every option the page offers
     as selectable, exactly as shown, whenever the page lists them. The caller corrects the
     input and runs again.
   - `InputNotApplied`: the value is valid and the site offers it, but the page did not apply
     it after the tool's bounded retries. It ignored, reset or replaced the value, such as a
     filter, sort or date (on a write, a location or store too), and the read-back shows its own
     default or another value (inputs skill, "Configure, then read"). Throw
     `new errors.InputNotApplied(message, { field, requested, applied, step, siteMessage })`:
     `field` the input's name, `requested` the caller's value, `applied` the value the page kept
     as read back (left out when it shows none), `step` the tool's step that failed, such as
     `set_location` or `apply_sort`, and `siteMessage` the page's own error when it showed one.
     The run then fails and returns nothing computed without the caller's value. A read, or a
     run that left the site untouched, may run again with the same request. On a write, check
     it before the first commit step: a write that may already have changed the site still ends
     as a possible change, never retried. Never let an answer to a question make a filter, sort,
     date or other value that narrows the results optional or lookup-only.
     `errors.LocationNotApplied` is an older name for the same error; write `InputNotApplied`.
     Not this error: a number on a stepped scale set to the nearest step inside the caller's
     bound and returned as applied, a filter group the page disables reported as not offered, a
     broader choice that covers the value, or a search query the site corrected or rewrote,
     returned with `applied_query` and `query_corrected` (inputs and search skills).
   - An input that tailors the answer, such as a location, store or vehicle, that the site still
     won't apply, or a location it says it does not serve, on a read: not an error (tailoring
     skill).
   - An option the page lists but greys out, such as a booked date or a sold-out size: not an
     error on a read, `InvalidInput` with `available` on a write (inputs skill, "Configure,
     then read").
   - A write that declines the task because the caller's own limit or the page's state rules it
     out, such as a total over the caller's price limit, an item out of stock, a variant the
     page does not offer or a product number whose page names another item than the caller's:
     `InvalidInput`, thrown before the mark of the commit it guards (writes skill). Pass
     `field`, the input the caller would change, `kind`, the reason as a stable lowercase token
     such as `over_price_limit`, `out_of_stock`, `variant_unavailable` or `item_mismatch`, and
     `available` where the page lists choices, and give in the message the values the caller
     needs, such as the total the page shows beside the limit. That is a refusal: the run
     reports why, and that it changed nothing unless an earlier marked step ran, and the caller
     can run again with corrected input. It differs from a failure, a tool that broke, and from
     a write that may have changed the site and could not confirm it (both below). A write
     returns a refusal as its output only when its output schema declares that refusal, and
     only before its first mark (writes skill): any other output a write returns without
     `verified()` reports a possible change.
   - A write whose steps may have changed the site and then failed or could not confirm the
     change: let it end as a possible change, which is never retried. Never throw
     `InvalidInput` or `InputNotApplied` to make it look untouched (writes skill).
   - A control the tool could not find, open or read, or a page that changed: `OperationFailure`,
     never `InvalidInput` or `InputNotApplied`.

   Never pick another value for the caller, such as a near match, the page's default or the
   first option, except a read whose value matches several site entries equally, which takes
   the first (inputs skill), and never report a refused or unapplied value in the output instead
   of throwing, such as a `sort_applied: false` flag or a "best-effort" or "lookup-only"
   description. The cases
   above that return results with what applied are the only exceptions.

## In the script

- When the site itself refuses a caller's value, such as a past date, an unknown airport code
  or a party size over its limit, throw `new errors.InvalidInput(message, { field })` saying why,
  with `field` the input's name, starting the message "Caller input error:" only when the
  refusal is obvious (above). When the value is not among choices the page lists, throw
  `new errors.InvalidInput(message, { field, available })` instead, as "Configure, then read"
  in the inputs skill says. Add `kind`, the reason as a stable lowercase token such as `out_of_stock`, when
  a caller needs to tell refusals apart (above). `errors` exists only in the
  script, never in a call's `code`, so when the page
  shows the refusal, return a marker such as `{ refused: "why", field, available }` from the
  call and throw once it returns. The run then fails as the caller's input; with `available`,
  the host ends it at once with those choices and no repair. A repair never asks the caller for
  a replacement value and never runs the tool with a value the caller did not send: when the
  page does not offer the caller's value, the repair makes the code throw with `available`,
  shows it with the caller's own input, and the run ends with those choices. A write that throws it before entering a commit mark reports that it changed nothing. A page,
  control or response that changed is still `OperationFailure`.
- Check every rule the input alone breaks before any site action, such as a check-out on or
  before its check-in, a count below one or a past date, and throw `InvalidInput` at once. Hold
  in the input schema every rule it can express. "Validate it, and fail with the right error",
  above, lists the rules, the time zone that makes a date past, and when
  to throw each error.
- When the page does not apply a valid value the caller supplied, such as a filter, sort or
  date it ignored, reset or replaced with its own, after the tool's bounded retries, throw
  `new errors.InputNotApplied(message, { field, requested, applied, step, siteMessage })`,
  never a flag in the output; the section above says what each field holds and lists the
  exceptions, such as an input that tailors the answer (tailoring skill).
