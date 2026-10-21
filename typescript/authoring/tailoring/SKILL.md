---
name: tailoring
description: Read before building a read whose answer can depend on where or who the visitor is (a location, store, ZIP, delivery or pickup, vehicle, membership or plan), and before asking about or setting one: find those inputs, apply them, return the value the site applied, and when a caller limits an input's use
---

# Inputs that tailor the answer

Many sites tailor what they show to facts about the visitor,
not just what they searched for: where they are (ZIP, address, store, delivery or pickup),
what they have (a vehicle, a device), or who they are (a membership or rate type, an insurance
plan, a business account). Find them yourself; the request will not list them all. Look on a
search, details or cart tool alike. When the site lets a visitor set one, make it an input even
if the request didn't mention it; it makes the tool more useful.

- Make it optional unless the task can't run without it. Left out, the site's own default
  applies: return the value the site used, such as the store the page shows, and say in the
  description that the site picks it, which can differ from run to run.
- When the caller gives one, honor it. Try each way the site offers, preferring one that needs
  nothing more from the caller, then read the applied value back from the page and return it
  as `applied_<input>`, such as `applied_store`, `applied_zip` or `applied_vehicle`. For a
  location, those ways are the store picker, the ZIP or postal-code box, the delivery or pickup
  choice and the manual entry beside "use current location". Decline the browser's location
  permission when the site asks; declining often reveals a manual ZIP field.
- When the site needs more detail to apply it, such as a street address instead of a ZIP or a
  vehicle's trim, add that detail as its own optional input. Its description says what it is
  for and that it is sent to the site. Submit only what the caller gave; never invent or reuse
  details. A name, email or phone is offered only when the site won't apply the input without
  it. A step that creates an account or a lasting record on the site is a write, so a read
  stops before it. While building, a live step, the example's or a test case's, that enters a
  name, email or phone asks the owner first (`request_input`), since the execution review
  escalates it otherwise. The owner's answer keeps the build a read, with no `mint_update`.
- Only when the site still won't apply what the caller gave, on a read: return what the site
  did show, with the value it actually applied (`applied_<input>`, null only when the page
  shows none) beside the one the caller asked for, and the site's message in an optional
  output field, `<input>_note`, such as `zip_note`, set only on this fallback, which also says
  why when the applied value is null. Never present it as the answer for the caller's value. A location the site says it
  does not serve is such a case: return the site's own answer with its message. A write throws
  `InputNotApplied` (rejections skill) before its first commit step instead.
- Inputs that narrow the results (filters, sort, dates) stay strict: a value the page ignores
  throws `InputNotApplied` (rejections skill).
- Give a tailoring input a limited use, such as a postal code used only to look up nearby
  stores without changing the selected one, only when the caller chose it. When how the tool
  should use such an input is genuinely ambiguous, such as whether a postal code sets the
  store or only lists nearby ones, ask the owner one `request_input` choice question with id
  `input_use_<input>`, `<input>` being the input's name in lowercase snake_case
  (`postalCode` is `input_use_postal_code`), with each use as an option. Always offer the
  full use, such as setting the store from the postal code, never only limited uses. When the
  caller chooses a limited use, start the input's description with "By design:", then state
  how many values it takes and that use in plain words, such as "By design: one postal code,
  used only to find nearby stores; it does not change the selected store." Write it only from that answer, never from the request's
  wording, a free-text instruction or your own judgment, and never for a filter, sort or date,
  which stay strict whatever an answer says. The code still applies the value in that use, and
  a value the page does not take in it throws `InputNotApplied` (rejections skill).
- While building, ask the owner for a location or other tailoring value the result depends on
  (`AGENTS.md`, "Try hard, then ask"); they may skip it. Skipping that question only leaves
  the example without one, and the input stays; saying the tool should use none declines it
  (inputs skill).
- Setting a location, store or delivery or pickup mode in the run's own browser is part of
  the read, never a write, even through a Save button: the run's browser is fresh and
  discarded, so nothing is saved, and a tool that never signs in has no account to change.
  Entering a guest address the caller gave to apply it is part of the read too; a name, email
  or phone follows the rules above. In a signed-in tool,
  use the site's per-visit control and never save an address, default store or preference to
  the account.
