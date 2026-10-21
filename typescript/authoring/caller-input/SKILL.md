---
name: caller-input
description: Ask the run's caller mid-run for what only they know, such as a choice only the page offers or a code the site sends.
---

# Caller input

## Ask the caller during a run

Try first. Ask only for what the page or the caller uniquely knows at that point:

- a choice whose options exist only once the run reaches them: the open seats of the
  flight the caller just chose, the delivery slots for the cart the run just filled, or
  which of the account's saved travelers, addresses or payment methods to use;
- whether to take a paid add-on within the tool's purpose that the page shows on the way to a
  commit when the input leaves it open, asked before the commit mark; a paid upsell outside the
  tool's purpose is declined, never asked (writes skill);
- for a write, which of several site entries the caller's value matches equally, such as a
  restaurant with several locations or a city with several airports, with those entries as the
  options. A read takes the first in the site's order instead and returns which one it used
  (inputs skill). That is ambiguous, as is a near-miss name the site offers alternatives for:
  prefer not starting a refusal of either with "Caller input error:" (rejections skill). A day or
  option the page greys out, with or without a reason, is not ambiguous and never a question
  (inputs skill, "Configure, then read");
- a code the site sends to confirm a protected action after sign-in, such as a confirmation code
  by text or email, never a code that is part of signing in (auth skill);
- a fact only the caller has that the site now asks for.

Never ask for a value the request, the input or an earlier answer already supplied, a private
one included: use that value. Never undo an answer that declined something by doing it anyway
or by offering it as an input (inputs skill), except a costly choice a write still meets on its
path, which stays an input or a declared question (writes skill). In the tool, take it from its input, or a private one, such as
part of an identity number, through a declared `secret` question, never a plain-text field.
When question review finds a question redundant, remove the ask and use the supplied value; a
reworded question still asks for it again. A placeholder that stands in for a redacted value,
such as "[redacted value]", supplies nothing. A supplied value the site rejects, or two that
conflict, can still need a question, one that names the actual problem.

Work the request already covers proceeds without a question, such as finding the right field
or choosing among alternatives the request already allows. A supplied value the site does not
offer, whether the page does not list it or greys it out, is not such a question either, and
never one to ask about: it follows .agents/inputs/SKILL.md ("Configure, then read"), which never
substitutes another value. Asking the
owner to revise it or stop is the minter's own `request_input` question while it builds, as
`AGENTS.md` says.

Use a published input instead whenever the value is stable and the caller can supply it
up front, such as a flight number, a date or a quantity. Never ask for a password, a
username or any other login: the host asks for a login itself and signs in. Never ask
for something the page shows, for permission to proceed with the operation the caller
already asked for, or to solve a CAPTCHA.

## Declare, read, ask

1. Declare every question the run may ask in the contract,
   `defineOperation({ name, input, output, questions }, ...)`, by id, with its `type`
   and a short `prompt`. The publication review reads these declarations once, so the
   prompt names the choice or value, never a private value. Write `questions` as a plain
   literal inside the entrypoint's own `defineOperation` call: during the build the host
   reads it from that source, not from the running script, and a computed or imported
   declaration declares nothing, so every question is refused as `Undeclared`. Each question
   the example asks is also reviewed before the build's owner sees it. An id starts with a
   lowercase letter and holds only lowercase letters, digits and underscores, up to 64
   characters (`page_title`, not `pageTitle`); the host refuses an invalid id before the
   script runs, and each `ask` uses the declared id exactly.
   - `{ type: "choice", prompt, allowOther? }`: one option; `allowOther` lets the caller
     type their own answer, returned as `{ other }` (a build's `request_input` always
     allows it, `AGENTS.md`). Own text that repeats exactly one
     offered option's label (or its listed form entry, `id (label)`) returns that option.
   - `{ type: "multi_choice", prompt, minSelections?, maxSelections? }`: several options,
     at least one unless `minSelections` says otherwise, at most the options offered.
   - `{ type: "text", prompt, maxLength? }`: free text.
   - `{ type: "confirm", prompt, followUp? }`: yes or no, returned as `{ confirmed }`.
   - `{ type: "secret", secretKind, prompt, maxLength? }`: a code the site sent to
     confirm an action after sign-in (`one_time_code`; a code that is part of signing
     in is a `code` field of the `authenticate` step, never a question), an
     authenticator code (`totp`, which a saved login's TOTP fills without asking) or
     other private text (`private_text`). It stays out of traces,
     logs and the minting model. A secret you ask during the build with `request_input`
     comes back to you as a handle such as `{{secret.s1}}`, which the host fills in only
     when your explore, test or `act` source runs live, and only where it is the whole
     string passed to `fill`, `type` or `pressSequentially` or a field of a request to this
     site (core skill); the published script never holds a handle and asks for the value
     with `ask` instead. Prefer a `secret` question of kind `private_text` for an access
     code, such as a gate, door, alarm or lockbox code.
   - For a payment card the checkout requires, ask for every part its card form shows
     at once, in one request with one `secret` question for each part: `card_number`,
     `card_expiry`, `card_cvc` and `billing_postal_code`. Those handles go only into a
     card-fill step, never into source.
   - A published script asks for a card the same way: declare a `secret` question with
     a card `secretKind` for each part and ask them all in one `ask`, which returns a
     card handle for each, such as `{{card.c1}}`, never the card. Pass the handles to
     the context's `fillCard`, as in
     `await fillCard({ fields: [{ selector: "#cardNumber", handle: answer.card }] })`,
     with each field's own selector, even inside the payment processor's frame. The
     host types the card and clicks nothing, so submit the payment in a later call
     under the write's commit rules. Once you have the caller's card, and wherever source
     calls `fillCard`, no source reads a field's value or the page's markup, runs or
     plants code in the page, opens a DevTools session, takes an accessibility snapshot,
     screenshot or PDF of the page, records the page, or reads a request body, so delete
     such probes before you ask for the card.
2. For a choice, read the options in the execute call that reaches it and return them as
   plain JSON. Each option has a `value` the script acts on and a `label` the caller
   reads. Values are unique within a question. Offer only options the page will accept:
   skip taken seats, disabled slots and sold-out items. The value never leaves the run;
   the caller sees only the label.
3. Mark an option taken from the caller's own account (a saved traveler, address, card
   or account) with `accountSpecific: true` and a `maskedLabel` that keeps it
   recognizable without its numbers or email, such as `"Jane D. •••• 7890"`. The API
   and MCP show the masked label with a notice; only the owner's protected page shows
   the full label. A masked label that still shows five or more digits or an email
   address is replaced by the label's last four digits or a numbered placeholder.
4. Ask once for everything the step needs, between two execute calls:
   - `await ask("code")` returns that question's answer;
   - `await ask(["seat", "note"])` returns one answer per id;
   - `await ask({ seat: { options: seats }, code: {} })` passes a choice's options, and
     nothing for the other types.

   With an array or an object, `ask` returns one answer per question id, so read
   `answer.<id>`, as in `answer.seat`.
   For one question, `askOne("seat", { options })` returns that answer directly.
   One ask takes up to eight questions, with up to 50 options per choice. A choice
   returns the chosen `value`, a multi-choice an array of values. Write answers into
   the next call's code with `JSON.stringify`.

The run waits with its browser open and its active budget stopped, and the next call
starts on the same page. Continue from there. Do not reload, search again or repeat an
earlier step, and never resubmit anything the run already submitted. A second click on a
marked step is not a resubmission when `blockingRequiredFields` returned the fields you
asked for: fill the answers, check the step again, then call `notCommitted`, then
`enteringCommit` again for that step, and click once, as the writes skill says. The wait
can be long, so in that next call confirm the page still shows the chosen option before
acting on it.

## When no answer comes

`ask` throws `ScriptInputFailure`:

- `NoResponse`: the caller did not answer within the request's window (at most ten
  minutes, less when the job's window ends sooner). The run fails as `no_response`. It
  is never retried or repaired, and its result says whether a step before the question
  may already have changed the site.
- `Unavailable`: the host could not put the question to the caller, or the answer did
  not fit the question.
- `Unauthorized`: the caller's access to the job was revoked while the run waited.
- `Undeclared` or `InvalidOptions`: the ask names an id that `questions` does not
  declare, gives a choice no options or duplicate values, gives options to another type,
  or offers fewer options than the selection bounds need.

Let these failures end the run. Never catch one to pick a default, the first option or
a guessed value. For a write, ask every question you can before its first commit step,
reading options in a step that saves nothing, so an unanswered question leaves the site
unchanged rather than holding a partial save. A question whose options the site shows only past
a saved step, such as delivery slots for a cart that step filled, may come after it. A hold or a cart the run made
before the question is reported as a possible change when no answer comes.

## During a mint

A read build's example run, or a write build's `act` step, asks the build's owner
through the same request, and the answer comes back to the running script. Ask the owner each
decision once per build: one a declared question will ask during the run needs no
`request_input` of your own first. The host reuses an earlier answer to a choice,
multi_choice, text or confirm question, never a secret, code or login, for a later ask with the
same id, type, prompt and options, so keep a declared question unchanged between runs unless its
review asks for a rewording. Guardian
reviews each question first. When it asks for a rewording, nobody is asked, the `ask`
fails and the execution's result carries `scriptQuestion` with Guardian's rationale:
change the declared question as it says and execute again. If the owner does not answer
in time, the result carries `scriptQuestion` `unanswered` and the build goes on: decide
how to continue without the answer, as when your own `request_input` returns
`no_answer`. A write step that sent something before its question is reported as a
possible change; verify the site's current state before any further write. In a write
repair, or once the build is signed in or holds a login, an unanswered question still
ends the build as `no_response`. Do not turn an
account-specific choice into a published input to work around a question; a value the
caller can type, such as a member number, is a free-form input instead.

`references/caller-choice.ts` books a seat on the caller's chosen flight: it asks for a
seat and a saved traveler once the flight's seat map is shown, then books once and calls
`verified()` after reading the confirmation back.
`references/caller-code.ts` asks for the code the site sends to confirm an address
change and enters it on the same page.
<!-- pomerado:section caller-input.protected-answers:start

## Standalone protected answers

Declare questions in the operation contract using the existing SDK schema and ask through `ask`. Ordinary answers are caller input, not extra authority. A `secret` answer is delivered privately for its declared purpose; during minting it returns an opaque handle. Use that handle only as a whole value at an authorized destination, never transformed, logged, returned, stored or read back. Website login credentials are requested only by the host during `authenticate`; TOTP/one-time codes are caller-supplied, with no stored seed automation.

pomerado:section caller-input.protected-answers:end -->
