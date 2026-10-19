import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import type { SkillDescriptor } from "@openai/agents/sandbox";
import { Effect, Either, Schema } from "effect";
import { expect, it } from "vitest";
import parser from "../../authoring/examples/parser.js";
import { detailNavigation } from "../../authoring/examples/navigation.js";
import authEntry from "../../authoring/examples/auth-entry.js";
import bookSeat from "../../authoring/examples/caller-choice.js";
import dialogPicker from "../../authoring/examples/dialog-picker.js";
import placeOrder from "../../authoring/examples/write-session.js";
import { selectInvoiceLayout } from "../../authoring/examples/variants.js";
import {
  guardianPublicationPolicy,
  publicationLiveTestsPolicy,
  publicationOutputPolicy,
} from "../../src/guardian/publication.js";
import { inputFeedbackInstruction } from "../../src/mint/input-feedback.js";
import { loadAuthoringSkills, loadWorkspaceGuide } from "../../src/mint/skills.js";
import { ExecutionContext, makeEffectJournal } from "../../src/runtime/context.js";
import { Deadline } from "../../src/runtime/deadline.js";
import { offlineKernel } from "../support/offline-kernel.js";
import { executeKernelOperation } from "../../src/runtime/kernel-operation-run.js";
import { runLocalOperation } from "../../src/execution/local-operation.js";
import { createLocalWorkspace } from "../../src/execution/local-workspace.js";

it("loads modular skill references and keeps auth discovery outside managed login", async () => {
  expect("websiteAuth" in authEntry).toBe(false);
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const skill = (name: string) => skills.find((entry) => entry.name === name);
  expect(new Set(skills.map((entry) => entry.name)).size).toBe(skills.length);
  // Host tool descriptions, failure guidance and AGENTS.md send the agent to these skills by path.
  for (const name of ["writes"]) expect(skill(name)).toBeDefined();
  expect(skill("writes")?.references).toHaveProperty("write-session.ts");
  expect(skill("writes")?.references).toHaveProperty("write-readback.ts");
  expect(skill("core")?.references).toHaveProperty("native-page.ts");
  expect(skill("core")?.references).toHaveProperty("navigation.ts");
  expect(skill("auth")?.references).toHaveProperty("auth-entry.ts");
  expect(skill("forms")?.references).toHaveProperty("custom-selection.ts");
  expect(skill("forms")?.references).toHaveProperty("dialog-picker.ts");
  expect(skill("caller-input")?.references).toHaveProperty("caller-choice.ts");
  // The testing skill is shared text; its capture reference is another host's.
  expect(skills.map((entry) => entry.name)).toStrictEqual([
    "core",
    "search",
    "auth",
    "testing",
    "pagination",
    "records",
    "forms",
    "writes",
    "cart",
    "caller-input",
    "publication",
  ]);
  expect(skill("testing")?.references).toStrictEqual({});
});

/*
 * The shared text names a few skills and reference sections only another host installs, for
 * features the local minter's preamble tells it to ignore: browser recovery, offline commands,
 * captures and maintenance. Every other name loads or installs locally.
 */
const hostedOnlyGuides = new Set([
  ".agents/browser-recovery/SKILL.md",
  "reference/offline-commands.md",
  "reference/captures.md",
  "reference/maintenance.md",
]);

it("names only skills that load and workspace sections that install, or hosted-only ones", async () => {
  const skills = new Set(
    (await Effect.runPromise(loadAuthoringSkills("typescript/authoring"))).map(
      (skill) => skill.name,
    ),
  );
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  expect(guide.files.get("AGENTS.md")).toBe(guide.instructions);
  const hostedNamed = new Set<string>();
  for (const text of guide.files.values()) {
    for (const [path, name = ""] of text.matchAll(/\.agents\/([a-z-]+)\/SKILL\.md/gu))
      if (hostedOnlyGuides.has(path)) hostedNamed.add(path);
      else expect(skills).toContain(name);
    for (const [path] of text.matchAll(/reference\/[a-z-]+\.md/gu))
      if (hostedOnlyGuides.has(path)) hostedNamed.add(path);
      else expect(guide.files.has(path)).toBe(true);
  }
  // A hosted-only name that loads locally, or that no shared text names, is a stale entry.
  expect([...hostedNamed].sort()).toStrictEqual([...hostedOnlyGuides].sort());
  for (const path of hostedOnlyGuides) {
    expect(guide.files.has(path)).toBe(false);
    expect(skills.has(/^\.agents\/([a-z-]+)\//u.exec(path)?.[1] ?? "")).toBe(false);
  }
});

const sectionMarker =
  /<!-- pomerado:section ([a-z0-9.-]+)(?: -->|:start\n[\s\S]*?\npomerado:section \1:end -->)/g;

const authoringCopy = async (edit: (path: string, text: string) => string) => {
  const root = await mkdtemp(join(tmpdir(), "pomerado-authoring-"));
  await cp("typescript/authoring", root, { recursive: true });
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith(".md")) {
      const path = join(entry.parentPath, entry.name);
      await writeFile(path, edit(path, await readFile(path, "utf8")));
    }
  return root;
};

/** What a host that supplies its own text does first: every section gets the host's text. */
const composeHostText = (text: string) =>
  text.replace(sectionMarker, (_match, id: string) => `host text for ${id}`);

const contents = (skills: readonly SkillDescriptor[]) =>
  skills.map((skill) => {
    if (!(skill.content instanceof Uint8Array)) throw new Error(`${skill.name} is not bytes`);
    return new TextDecoder().decode(skill.content);
  });

/*
 * The minter reads the publication review's rules for live tests and output while it explores, so
 * it gathers that evidence before its first publication instead of learning it from a denial. The
 * file is the text the review reads, so a policy change reaches the minter in the same release.
 */
it("installs the publication review's test and output rules for the minter", async () => {
  const rules = `${publicationLiveTestsPolicy}\n\n${publicationOutputPolicy}`;
  for (const part of [publicationLiveTestsPolicy, publicationOutputPolicy])
    expect(guardianPublicationPolicy).toContain(part);
  const root = await authoringCopy((_path, text) => composeHostText(text));
  try {
    // Every host gets the same file, whether it loads standalone text or composes its own.
    for (const guide of [
      await Effect.runPromise(loadWorkspaceGuide("typescript/authoring")),
      await Effect.runPromise(loadWorkspaceGuide(root, (text) => text)),
    ]) {
      expect(guide.files.get("reference/publication-review.md")).toBe(rules);
      expect(guide.instructions).toContain(
        "- `reference/publication-review.md` holds the rules Guardian's publication review applies",
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("loads standalone text by default", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  for (const text of [...contents(skills), ...guide.files.values()])
    expect(text).not.toContain("<!-- pomerado:");
});

it("reads every skill and guide file through a host's render, with its key", async () => {
  const root = await authoringCopy((_path, text) => composeHostText(text));
  const keys: string[] = [];
  // A host that composed the directory keeps its text and refuses any section it left.
  const composed = (text: string, sectionKey: string) => {
    keys.push(sectionKey);
    if (text.includes("pomerado:")) throw new Error("Uncomposed section");
    return text;
  };
  try {
    const skills = await Effect.runPromise(loadAuthoringSkills(root, composed));
    const guide = await Effect.runPromise(loadWorkspaceGuide(root, composed));
    for (const [index, skill] of skills.entries())
      expect(contents(skills)[index]).toBe(
        await readFile(join(root, skill.name, "SKILL.md"), "utf8"),
      );
    expect(guide.instructions).toBe(await readFile(join(root, "workspace/AGENTS.md"), "utf8"));
    expect(guide.instructions).toContain("host text for ");
    // Skills load concurrently, so their keys arrive in any order before the guide's.
    expect(keys.slice(0, skills.length).sort()).toEqual(skills.map((skill) => skill.name).sort());
    expect(keys.slice(skills.length)).toEqual(["agents", "guide"]);
    const refused = { _tag: "Left", left: { code: "Unavailable" } };
    expect(
      await Effect.runPromise(Effect.either(loadAuthoringSkills("typescript/authoring", composed))),
    ).toMatchObject(refused);
    expect(
      await Effect.runPromise(Effect.either(loadWorkspaceGuide("typescript/authoring", composed))),
    ).toMatchObject(refused);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * Guidance about the operation SDK, schemas, page readiness, sign-in, caller questions, forms,
 * pagination and writes is shared text, so a host that composes its own text into the named
 * sections keeps it, and the local host reads it too. One line from each shared place, with its
 * whitespace collapsed.
 */
const sharedGuidance: readonly (readonly [string, string])[] = [
  [
    "core",
    "A `secret` answer comes back as a handle such as `{{secret.s1}}`, never the value, which you never see.",
  ],
  [
    "core",
    "An operation is `defineOperation({ name, input, output }, async ({ kernel, sessionId, siteOrigin, siteDomain, input, decideDialog, ask, waitPastChallenge, verified, remainingMs, errors }) => ...)`.",
  ],
  ["core", "- Make one execute call per operation."],
  ["core", "- The code works for every value the schema accepts."],
  [
    "core",
    "- Match the caller's proper nouns, such as places, venues and company names, with a fuzzy match that accepts the usual forms of the same name, such as a name with or without its accents (Abaca for Abacá), a city alone or with its state and country, or a company with or without Ltd. or Inc. Never require an exact match. When more than one option matches, list them for the caller instead of picking one.",
  ],
  ["core", "Take the site origin from the context's `siteOrigin`."],
  ["core", "The tools and the files you may edit are in `AGENTS.md`."],
  ["core", "Read their bodies only when useful."],
  [
    "core",
    "Inspect login markup using reviewed read-only `explore` without private credential injection.",
  ],
  ["core", "Only the host requests website credentials, and only during `authenticate`."],
  ["auth", "Sign-in pages are often slow, and the next screen can take a while to show."],
  [
    "auth",
    "After a step whose submit the host clicked, its result names `captures/after-submit/<step>.json` (`nextScreen`)",
  ],
  // A run on a saved session can start past a chooser that shows right after sign-in, so the build
  // exercises a chooser step from both starts.
  [
    "auth",
    "Record an authorized choice and its following Continue as separate steps. Prefer exercising a chooser step from both starts in the build, right after a sign-in and from a saved session already past the chooser.",
  ],
  [
    "caller-input",
    "Use a published input instead whenever the value is stable and the caller can supply it up front",
  ],
  ["caller-input", "One ask takes up to eight questions, with up to 50 options per choice."],
  [
    "caller-input",
    "A read build's example run, or a write build's `act` step, asks the build's owner through the same request",
  ],
  [
    "forms",
    "Derive `getByRole` names from a scoped `locator.ariaSnapshot()` or a retained ARIA snapshot.",
  ],
  ["forms", "Preserve add/replace and single/multiple intent."],
  ["forms", "- Walk every step for real, in the session, with the caller's values."],
  [
    "pagination",
    "Spread `listInputFields` into the input schema's fields and `listOutputFields` into the output schema's",
  ],
  ["pagination", "Never recreate a hold, draft, upload, payment token or write in order to page."],
  ["writes", "A write build changes something real on the caller's account"],
  ["writes", "Prefer confirming the write from its commit request."],
  ["writes", "- When a read-back is needed, the first one that matches confirms the write; stop there."],
  ["writes", "- State from before the write never matches."],
  [
    "writes",
    "Write `src/tool.mjs`, the `playwright` version: a Kernel script running the whole flow",
  ],
  [
    "writes",
    "Call `finish_build` with entrypoint `src/tool.mjs` and the confirming step's `executionId`",
  ],
  [
    "workspace/AGENTS.md",
    "This file is the workspace `AGENTS.md`: the host loads it as your instructions on every turn",
  ],
  [
    "workspace/AGENTS.md",
    "**Load large content progressively.** Know a file's size before reading it:",
  ],
  [
    "workspace/AGENTS.md",
    "Follow these stages in order: 1. Discover the public login entry using execute purpose `explore` with `liveBrowser`.",
  ],
  [
    "workspace/AGENTS.md",
    "- When the execute receipt explicitly has `retryable:true` and `reviewDispatch:not_sent`, resubmit that same execution",
  ],
  [
    "workspace/AGENTS.md",
    "Give the evidence in `intent` and a plain one- or two-sentence `explanation` for the caller",
  ],
  ["workspace/AGENTS.md", "Do not manufacture success from model prose."],
  [
    "publication",
    "Read this before your first `finish_build`. `finish_build` asks the host to review the current source and publish it against an execution that already ran",
  ],
  ["publication", "Guardian reports what it finds in rounds, and each round costs minutes"],
  // A builder that skipped the request's own rules met them again as one refusal per round, so the
  // checks before `finish_build` open with them.
  [
    "publication",
    "## Check before `finish_build` Before your first `finish_build`, prefer checking the tool against each rule the request states for its inputs, outputs and refusals.",
  ],
  [
    "publication",
    "- Published files are all of `src/`, the named entrypoints and any `explore/`, `test/` or `scratch/` module they import",
  ],
  ["publication", "## Never put these in published files"],
  // A list whose site rarely shows an empty state still publishes: a no-results case is preferred
  // when the build finds one, and neither skill names it as a gap.
  [
    "testing",
    "and an option the page lists but greys out, such as a sold-out size, which a read returns as unavailable data. Prefer also a query or filter with no results (`empty`, never a throw) when you find one. Without one, move on: it needs no `notTested` entry and no question;",
  ],
  ["publication", "and untested (such as a later page or another layout, live)."],
  [
    "publication",
    "| `reason` | `input_feedback_unresolved` | The feedback rounds are spent | End the attempt; do not execute again |",
  ],
  [
    "publication",
    "A rejection never authorizes repeating a claimed example or a write that may have committed.",
  ],
  [
    "workspace/AGENTS.md",
    "## Publication Read .agents/publication/SKILL.md before your first `finish_build`",
  ],
  [
    "workspace/AGENTS.md",
    "Keep the build's own execution and result separate from future code publication.",
  ],
  // A write proves itself with `verified()` and no argument, whatever it read back.
  [
    "core",
    "- After a write, call `verified()` with no argument just before returning, once a call has read the result back, either the site's confirmation for this submission or the saved state. Return the confirmation number or record in the output. Without it the write stays a possible effect.",
  ],
  // A browser version prefers the page's controls to URLs it builds, and opens a caller's URL on
  // the site unchanged.
  [
    "core",
    "For a detail read whose input is the record's page URL, check that it is https on the tool's site and open it unchanged.",
  ],
  [
    "workspace/AGENTS.md",
    "A URL the caller supplied, on the tool's site, may be opened unchanged: the build's start page, or a URL input such as a product or listing page, which a details tool takes as input and opens directly.",
  ],
  // A value the request gave that the site does not offer goes to the owner before the build ends.
  [
    "workspace/AGENTS.md",
    "ending, and the build goes on. Before ending blocked because a value the request gave is unavailable or invalid on the site, such as a time slot the site does not offer that day, a date outside its calendar or a name it does not list, ask the owner with `request_input` to revise it or stop, as the key rules say. End blocked only when they stop or their answer cannot be met either. In maintenance, follow the intake screen instead. Give the evidence in `intent`",
  ],
  // Only what the caller asked for decides whether a tool books or refuses, every listed option
  // gets read, a repair fixes a broken input but keeps a caller's documented design decision, a
  // fix covers every required control the input has no value for rather than the one that
  // failed, and a format read from one sample breaks on the next value, so the minter reads it
  // off the page.
  [
    "core",
    "never just the example's value. The example's values are one case, never limits. - Prefer keying only on what the caller asked for. A detail that changes from one listing to the next, such as a seating label or a room name, shouldn't decide whether the tool books or refuses unless the caller chose it. - Read results for every option the schema lists. When an option leads to a page with a different structure (other fields or sections), handle that layout too, and on a read signed out run it live as a test case (testing skill); an option that only reorders or filters the same rows needs no case of its own. Never return results for another option in its place. - A repair that finds a declared input broken, never applied or always reported unsupported fixes it in the same repair, whether or not a caller is waiting. Keeping a tool's contract means every input and output it declares works, not leaving a broken one as it was. An input whose description starts \"By design:\" is applied in the use it records, a caller's decision: keep that use and its description word for word, and change them only after asking the same design question again (the input schema, \"Inputs that tailor the answer\"). - Prefer fixing the whole class of a failure over its one instance: when the page requires a control the input has no value for, prefer making every such control a declared caller question with the page's live options over throwing for it. - Never derive a format from one sample: not an input format, an element key, a selector, a URL path or a label. A key the page showed for the example's value says nothing about the next value, as when a calendar keyed December 3 as `12-3-2026` where the tool expected `12-03-2026`. Read the format off the page for the value you need, such as the day cell whose visible label or accessible name is the caller's date, or a key the page itself lists, never a key rebuilt from the one you saw. - Inputs are values a caller knows",
  ],
  // The minter reads the never-loosened needed values, the facts a caller could use, typed output
  // and kept rows before it writes the schema and the parser, so a fact the code could not read
  // fails the output check.
  [
    "core",
    "**Never loosen a value the request needs.** The values the request needs are each value it names, the record's identifier as the site shows it, and the context those depend on as the page shows it, such as dates, a party size or a location. Make each one required and non-null, typed so a value the code could not read fails the output check (`Schema.NonEmptyTrimmedString` for text, `Schema.Int` for a count), never optional, nullable or plain `Schema.Number`, whatever a description says. A run whose output fails its schema goes to repair. - The owner may settle a different form for every run: in the request's own explicit words, in an answer to your design question or in a task update, such as blank fields returned as empty strings. Publication review honours that decision as stated. Build it that way, and say in the field's description what the owner chose. It never covers a value the page shows that the code failed to read, or anything personal or account-specific. - Type each output field as strictly as its value: required text is non-empty and trimmed (`Schema.NonEmptyTrimmedString`), a date or time keeps its `pattern`, and a field that reports an input's value reuses that input's enum or pattern. Make one optional or nullable only where the page may genuinely not show the value. - The one exception is a record whose own page genuinely does not show the value, such as an item that is sold out and shows no amount, or a listing that shows no date yet. Then the value may be null only together with a field that says why, such as its availability, and both descriptions say so. - Null never covers a value the page shows that the code failed to read: that throws `OperationFailure` naming it. Never turn a read that found nothing into null (`?.innerText ?? null`); a missing element is a failure, not an absence. - Before your first example, list the needed values. If the page may not show one, settle it then: find where the site shows it, on every layout its records use, or ask the owner. When you ask how to return it, offer null with a field that says why. The question review rewords an option that loosens a needed value, such as an empty string, unless the owner already chose that form. **Output fields.** Design the output for what a caller could use, and lean toward more fields and more information rather than the minimum: include the facts about each record or result that a caller could reasonably use to identify, choose, compare or act on it, not only the values the request names. Leave out what is unrelated to the tool's purpose or of no use to a caller. - Keep each value's full displayed text. Read the element that holds the whole value, never a shorter or secondary one. When the page splits one value across elements, such as a maker line above a linked name or an author line above a title, return each part in its own field. Never drop either part. - Prefer a separate typed field for each fact over folding it into another field's text. Never derive a value the page does not show. - A field that is not a needed value is nullable when records on this site can lack it, and it is null exactly when this record does not show it. - Never declare a field the code does not read. A field that is always null, empty or fixed is not a disclosed limit: read it from the page, or leave the field out.",
  ],
  // A list returns one page per call and a cursor to the next.
  [
    "core",
    "- A list that can run past one page returns one page per call and a cursor to the next, as the pagination skill says.",
  ],
  // Every field is read from the page on every run and typed as the page states it.
  [
    "core",
    "Then, for every field: - Prefer parsing what the page shows into typed fields over returning a result row, card or itinerary as one text blob or summary, and keep every result row of the main list the page shows, up to the call's `limit` (pagination skill). - Read every output from the page or response on every run, so every returned field has observable support: never a literal, a default you invented, or a constant `null`, `[]`, `false`, `0` or fixed label where the page can show the value. - Return `null` for a field that is not a needed value only when this record's page lacks it, and an empty list only when the page shows none; never throw for either. When the code cannot read a value the request needs, throw `OperationFailure` naming it; never return a placeholder, a label or another record's value in its place. - One field per fact, as the page states it, and variants as the dimensions and values the page lists. - Prefer numbers for amounts and counts, ISO 8601 for dates and times and minutes for durations; type a date-only value as the runtime's `CalendarDate` (forms skill). A value that does not parse cleanly may be the site's own text.",
  ],
  // Output a caller can filter and compare on is parsed into typed fields.
  [
    "publication",
    'did not return is refused (`contract_output_mismatch`). Values the request needs are required and non-null: never loosen one. Only a record whose own page shows no such value may return null, together with a field saying why; a description never excuses a nullable needed value, and Guardian refuses a schema that makes one optional or nullable. No output is a constant where the page shows a value, and titles and names are returned in full (core skill, output fields). - **Typed output.** Prefer parsing what the page shows into typed fields over returning a result row, card or itinerary as one text blob or summary. Give each fact a caller would filter, sort or compare its own field (core skill, output fields). A flight card reading "XX 234, 7:00 AM-3:31 PM, Nonstop, 5h 31m" should return `{ "flight_number": "XX 234", "departure_time": "2026-11-16T07:00:00-08:00", "arrival_time": "2026-11-16T15:31:00-05:00", "stops": 0, "duration_minutes": 331 }` rather than `{ "summary": "XX 234 7:00 AM ..." }`. The site\'s own text may stand in for one value that truly does not parse, with that field\'s description saying so; a record\'s whole text is only an `include` section (core skill, optional sections). - **Clean output.** Every string is clean displayed text: no code, styles, markup, template leftovers, control labels or repeated entries. `finish_build` refuses an example whose output holds code, styles, markup or template leftovers, and gives the publication review the host\'s other output checks as leads. Check each finding against the page and fix a wrong read in source. A check can be wrong: when a flagged value is correct as returned, such as code on a tool that returns code or the page\'s own text that only resembles code, name its path and check with the reason in `finish_build`\'s `outputOverrides`; Guardian checks the reason against the captures. A field that holds code or markup on purpose may instead declare it with `contentMediaType`, such as `text/javascript`, `text/css` or `text/html`: its findings then name that type and never block, and Guardian checks that the type fits what the field holds. - **Lists.** A tool that returns a list the site can run past one page takes `limit` and `cursor` and returns one page with `next_cursor` (pagination skill), or says the site shows the whole list at once. - **Inputs.**',
  ],
  // Rows a filter has not yet applied to are read too early, so the tool waits a bounded time for
  // most rows to pass and returns what is there after that.
  ["core", "After a search or a filter, use `waitForChange` on the rows you return"],
  // A reload after a choice such as a city can drop the search box's suggestions, so the tool
  // types into the box again.
  [
    "core",
    "After a step that reloads the page, such as choosing a city, prefer typing into the search box again when its suggestions don't appear.",
  ],
  // A preselected option that only shares the caller's data, tracks or signs up for marketing is
  // turned off on every run, with no input and no question.
  ["core", "- Turn safety defaults off."],
  // An obvious refusal settles the caller's run at once; one from the tool's own empty read never
  // claims to be obvious.
  [
    "core",
    'When the refusal is obvious, start the message with "Caller input error:" so the caller gets it at once.',
  ],
  // A record whose name differs from the caller's only in case or in a usual form of the same name
  // is still that record, so a picker's "Add new" row never creates a near-duplicate of it.
  [
    "forms",
    'Prefer matching an existing record by a fuzzy match on its name (core skill), and prefer never picking an "Add new" row when an existing record matches.',
  ],
  // A build has no question that takes a file, so a task that needs one the request doesn't carry
  // ends with a report that names the file for the next build.
  [
    "workspace/AGENTS.md",
    "A build can't ask for a file. When the task needs one the request doesn't carry, say so in report_blocked, naming the file the owner should attach when they build again.",
  ],
];

/*
 * Text both hosts now read word for word, from places that were host sections before: one line
 * from each, with its whitespace collapsed.
 */
const formerSections: readonly (readonly [string, string])[] = [
  ["core", "Unclear means possible. `websiteEffect: may_have_dispatched` makes that execution's effect possible"],
  ["auth", "The `loginUrl` you pass on `authenticate` is published with the tool, and every run opens it to sign in."],
  ["auth", "A run can begin partway through that flow because its bound profile or remembered device omitted an earlier stage."],
  ["caller-input", "1. Declare every question the run may ask in the contract, `defineOperation({ name, input, output, questions }, ...)`, by id, with its `type` and a short `prompt`."],
  ["forms", "Filling in or advancing a form that saves data on the site (an application, a profile, a contracting or checkout form) is a write, even when nothing is submitted yet"],
  ["pagination", "The host signs every cursor and checks it before the next run starts"],
  ["writes", "- The first `act` step claims the build's write."],
  ["publication", "- **Login URL.** A signed-in tool publishes the `loginUrl` you signed in from, and every run opens it."],
  ["workspace/AGENTS.md", "Testing a read signed out is your job, never the caller's (.agents/testing/SKILL.md)."],
  ["workspace/AGENTS.md", "- `src/`: your operation. It exists from the start and is empty until you write to it"],
  ["testing", "Choose cases that catch actual risk: applied filters, IDs, units, authoritative empty"],
  ["testing", "Where the host offers `live_tests`, a read signed out has no limit on live tests, and the host runs them for you in parallel."],
];

const renderedTexts = async (directory: string, render?: (text: string) => string) => {
  const skills = await Effect.runPromise(loadAuthoringSkills(directory, render));
  const guide = await Effect.runPromise(loadWorkspaceGuide(directory, render));
  const texts = new Map(skills.map((skill, index) => [skill.name, contents(skills)[index] ?? ""]));
  for (const [path, text] of guide.files) texts.set(`workspace/${path}`, text);
  return texts;
};

it("gives the local host and a composing host the same shared guidance", async () => {
  // A host that composes empty text into every section keeps only what is shared.
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    const hosts = [
      await renderedTexts("typescript/authoring"),
      await renderedTexts(root, (text) => {
        if (text.includes("pomerado:")) throw new Error("Uncomposed section");
        return text;
      }),
    ];
    for (const texts of hosts)
      expect(
        [...sharedGuidance, ...formerSections].filter(
          ([name, line]) => !(texts.get(name) ?? "").replace(/\s+/g, " ").includes(line),
        ),
      ).toStrictEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * Text only the local host reads stays in host sections a composing host replaces: the core
 * skill's closing summary of local execution and completion follows the shared paragraph on host
 * incidents, and a host that composes empty text there keeps that paragraph only.
 */
it("keeps the local execution and completion summary in a host section", async () => {
  const summary =
    "## Standalone execution and completion Use the ordinary `defineOperation` API and existing Kernel-shaped browser calls above.";
  const lines = [
    summary,
    "It offers no browser replacement or captured replay facility. An invalidated native executor ends this attempt; never use a new browser to repeat an uncertain effect.",
    "Correct a refused binding by reading the current screen. A rejected credential needs caller correction; do not resubmit it.",
  ];
  const shared = "so never repeat it without the read-back above.";
  const local = ((await renderedTexts("typescript/authoring")).get("core") ?? "").replace(/\s+/g, " ");
  expect(lines.filter((line) => !local.includes(line))).toStrictEqual([]);
  expect(local.indexOf(shared)).toBeGreaterThan(0);
  expect(local.indexOf(summary)).toBeGreaterThan(local.indexOf(shared));
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    const composed = ((await renderedTexts(root)).get("core") ?? "").replace(/\s+/g, " ");
    expect(composed).toContain(shared);
    expect(composed).not.toContain("Standalone execution and completion");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// The shared tool list describes another host's command sandbox; the local host's own section
// says which description holds here.
it("tells the local minter its own exec_command rule replaces the shared one", async () => {
  const guide = (await renderedTexts("typescript/authoring")).get("workspace/AGENTS.md") ?? "";
  const text = guide.replace(/\s+/g, " ");
  const shared = "`exec_command` is offline only";
  const leadIn =
    "## Standalone workspace and tools On this host, the tool rules below replace the tool list above where they differ.";
  const local = "`exec_command` runs a local process over caller-owned files";
  expect(text.indexOf(shared)).toBeGreaterThan(0);
  expect(text.indexOf(leadIn)).toBeGreaterThan(text.indexOf(shared));
  expect(text.indexOf(local)).toBeGreaterThan(text.indexOf(leadIn));
});

it("lists every installed skill in the local workspace README", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const readme = (await renderedTexts("typescript/authoring")).get("workspace/README.md") ?? "";
  const list = /Read the installed ([^.]+) skills as relevant\./u.exec(readme.replace(/\s+/g, " "));
  const named = new Set((list?.[1] ?? "").split(/, | and /u));
  expect(skills.map(({ name }) => name).filter((name) => !named.has(name))).toStrictEqual([]);
});

// A run's uncertain write status is the host's own word, so the shared sentences leave it to a
// host section: the local host says `may_have_applied`, and a composing host says its own.
it("names the local host's own status for a run's uncertain write", async () => {
  const local = ((await renderedTexts("typescript/authoring")).get("writes") ?? "").replace(/\s+/g, " ");
  expect(local).toContain(
    "before reporting its marks, returns `may_have_applied` with any unconfirmed result",
  );
  expect(local).toContain("An `unverifiable` write reports `may_have_applied` too");
  expect(local).not.toContain("possibly_completed");
  const root = await authoringCopy((path, text) =>
    path.endsWith("/writes/SKILL.md")
      ? text.replace(sectionMarker, (marker: string, id: string) =>
          id.endsWith("-status") ? "`OTHER-STATUS`" : marker,
        )
      : text,
  );
  try {
    const composed = ((await renderedTexts(root)).get("writes") ?? "").replace(/\s+/g, " ");
    expect(composed).toContain("returns `OTHER-STATUS` with any unconfirmed result");
    expect(composed).toContain("An `unverifiable` write reports `OTHER-STATUS` too");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// A read build becomes a write through `mint_update`; `request_input` takes no write upgrade.
it("asks for no write upgrade through request_input anywhere in the shared text", async () => {
  const texts = await renderedTexts("typescript/authoring");
  expect(
    [...texts].filter(([, text]) => /writeUpgrade|write upgrade/iu.test(text)).map(([name]) => name),
  ).toStrictEqual([]);
  expect((texts.get("workspace/AGENTS.md") ?? "").replace(/\s+/g, " ")).toContain(
    "ask the caller with request_input what would change, then change the task to a write with mint_update",
  );
});

/*
 * The publication skill is one text for both hosts. The local builder reads the shared lines about
 * the private fallback, which its preamble lists as a hosted feature, and about the login URL
 * check and recorded confirm popups, which it now has too. The hosted-only checks (site metadata, the HTTP version, recorded requests,
 * session tokens, protected results) stay in host sections it never reads. It saves every file
 * under the four folders when Node could load one the operation's imports do not name.
 */
it("gives the local builder the shared publication text and no hosted-only check", async () => {
  const texts = await renderedTexts("typescript/authoring");
  const publication = (texts.get("publication") ?? "").replace(/\s+/g, " ");
  expect(publication).toContain(
    "Never run the write again. After the last round the host publishes privately and flags it |",
  );
  expect(publication).toContain("- **Login URL.** A signed-in tool publishes the `loginUrl`");
  expect(publication).toContain("`confirmation_unrecorded`, `confirm_action_unmatched`,");
  expect(publication).toContain(
    "`finish_build`'s metadata names the tool and describes it in the public definition Guardian reviews (`publication/definition.json`):",
  );
  expect(publication).toContain(
    "module they import, or every file under those four folders when Node could load a saved file those imports do not name, or the workspace has a `package.json`.",
  );
  for (const hosted of [
    "siteName",
    "routes.json",
    "tool-http.mjs",
    "recorded-requests",
    "session token",
    "issuing response",
    "integration",
    "missing_protected_result",
  ])
    expect(publication).not.toContain(hosted);
  expect(texts.get("core")?.replace(/\s+/g, " ")).toContain(
    "during the run, and publication before the first `finish_build`.",
  );
});

/*
 * The testing skill's capture loading, saved HTTP and DOM fixtures and post-publication cases are
 * another host's sections, so neither the local host nor a host that composes nothing reads them.
 */
it("keeps the testing skill's capture and saved-fixture paragraphs in host sections", async () => {
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    for (const texts of [await renderedTexts("typescript/authoring"), await renderedTexts(root)]) {
      const testing = (texts.get("testing") ?? "").replace(/\s+/g, " ");
      expect(testing).toContain(
        "- pureFiles: parsers/calculation with ordinary files and meaningful assertions. - liveBrowser: authorized fresh observation",
      );
      for (const hosted of [
        "retain_capture",
        "loadCaptureFixture",
        "network.ndjson",
        "SavedCaptureEvidence",
        "held-out",
        "## Load existing capture evidence",
      ])
        expect(testing).not.toContain(hosted);
      expect(testing.trimEnd().endsWith("silently call production from an offline test.")).toBe(
        true,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("leaves no heading, list or skill header of the local host's authoring empty", async () => {
  const texts = await renderedTexts("typescript/authoring");
  const core = texts.get("core") ?? "";
  const kernelScripts = core.slice(core.indexOf("## Kernel scripts"), core.indexOf("**The input"));
  expect(kernelScripts.replace("## Kernel scripts", "").trim()).not.toBe("");
  expect(texts.get("workspace/AGENTS.md")).toContain("Follow these stages in order:\n\n1. ");
  expect(texts.get("writes")).toMatch(/^---\nname: writes\ndescription: \S/u);
});

/*
 * The stale-session rule is one text for both hosts: the host signs in again by itself when a reset
 * or a page load leaves the site signed out, and a step it cannot keep signed in fails with
 * `session_not_kept`. The local host does both.
 */
it("gives both hosts the same stale-session rule", async () => {
  const sentence =
    "A sign-in that started and was never verified is the exception: that reset clears cookies and site storage. When the page is signed out after that reset, or after a full page load your source asks about with `ensureSignedIn`, the host signs in again by itself; do not call `authenticate` for it. When the host cannot keep the site signed in, the step fails with `session_not_kept`: report that cause instead of signing in again. That source must perform the flow from its input, never rely on a page an exploration left open.";
  const local = (await renderedTexts("typescript/authoring")).get("core") ?? "";
  expect(local.replace(/\s+/g, " ")).toContain(sentence);
  const root = await authoringCopy((_path, text) => text.replace(sectionMarker, ""));
  try {
    const composed = (await renderedTexts(root)).get("core")?.replace(/\s+/g, " ") ?? "";
    expect(composed).toContain(sentence);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Many sign-in forms enable their submit only once the fields hold input, and the host waits for
// it. The minter records such a submit as it observes it, disabled or not.
it("lets the minter record a sign-in submit the page has not enabled yet", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const auth = contents(skills)[skills.findIndex((skill) => skill.name === "auth")] ?? "";
  expect(auth.replace(/\s+/g, " ")).toContain(
    "Record a field only after observing its unique visible enabled match in the intended frame and form, and a submit after observing its unique visible match there, even one the page enables only once the fields hold input.",
  );
  expect(auth).not.toContain("enabled submit");
});

// A local build asks for a username, email, phone or account number as text, which the terminal
// shows, and records a verified sign-in's screens as a recipe that each run of the tool replays.
it("tells the local minter how its sign-in values are asked, what it records and what a run does with it", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const auth = (contents(skills)[skills.findIndex((skill) => skill.name === "auth")] ?? "").replace(
    /\s+/g,
    " ",
  );
  expect(auth).toContain(
    "The host obtains the needed value through the caller's input callback or the terminal, checks the original field/document/origin/focus binding and inserts privately. The terminal hides a password, code or other secret as it is typed, and shows a username, email, phone number or account number.",
  );
  expect(auth).toContain(
    "No saved credential, seed or SMS automation is used. The host records the screens of a verified sign-in, without values, and publishes them with the tool; each run of the tool replays them, asking for the login and any code or answer only when the site needs it.",
  );
  expect(auth).not.toContain("masked terminal");
  expect(auth).not.toContain("don't replay");
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  const instructions = guide.instructions.replace(/\s+/g, " ");
  expect(instructions).toContain(
    "The host collects credentials through the caller's input callback or the terminal, which hides a password, code or other secret and shows an identifier as it is typed, and inserts them through the guarded credential channel.",
  );
  expect(instructions).not.toContain("masked terminal");
  // A verified sign-in fixes its login URL, so only a new sign-in from another URL changes it.
  expect(instructions).toContain(
    "The login URL of the build's verified sign-in publishes with the tool, so it never holds a value of the account, such as its email. If `finish_build` refuses it with `login_url_contains_credential`, sign in again from a login URL without one: send each sign-in screen's `signInStep` with that `loginUrl`, then `signedIn`, and call `finish_build` again with the same `executionId`. A signed-in check alone does not change it.",
  );
});

// A write committed values the page never showed matching the input; a page's own recent-search
// save looked like an unintended write; a value the site keeps a few clicks away was called
// invalid input.
it("has the minter read back a write, accept recent-search saves and look before invalid input", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  const text = (name: string) =>
    (contents(skills)[skills.findIndex((skill) => skill.name === name)] ?? "").replace(/\s+/g, " ");
  expect(text("writes")).toContain(
    "- Before committing, read back from the page what you are about to submit and check each value against the caller's input, normalized as the core skill's Confirm step says, in the session and on every branch of the composed script. Fail before the commit if one does not match. Never read back a field filled with a secret handle.",
  );
  expect(text("core")).toContain(
    "Telemetry, analytics and bot-sensor POSTs are normal and need no change. So is an anonymous recent-search, prefill or search-state save the site fires when you submit a search.",
  );
  expect(guide.instructions.replace(/\s+/g, " ")).toContain(
    "Do not infer invalid input from a timeout, missing observation, lost authentication, or failure of our automation. Not finding a value where you first looked is not that evidence. Before you call a value unavailable, check where the site would show it for the requested scope, such as the requested date's calendar or the results for the requested search. Settled evidence for the requested option, such as the site not listing it, is enough, and so is the site showing it sold out or unavailable for a write. A read that finds the requested option greyed out or sold out returns it as unavailable data with the page's alternatives instead",
  );
});

/*
 * An accounting app's invoice list already showed the sent invoice, and the minter kept reading
 * other pages for minutes, some of them refused for not proving the record or for reading without
 * bound. The first bounded read-back that matches confirms the write, and nothing from before the
 * write, such as a list that has not reloaded, can match.
 */
it("has a write confirm from its first matching read-back, never from state before the write", async () => {
  const writes = ((await renderedTexts("typescript/authoring")).get("writes") ?? "").replace(
    /\s+/g,
    " ",
  );
  expect(writes).toContain(
    "- When a read-back is needed, the first one that matches confirms the write; stop there. It matches when it shows the written record after the write, found by something the write produced or entered (its number, its own reference or the values entered), and every field the caller asked for that the view shows agrees (the read before the commit already checked what you entered). Sites reformat what they save, such as line breaks, spaces and dates in the viewer's format, so compare text after the commit normalized as before it (the core skill's Confirm step): pass the caller's text through `normalizeText` from `pomerado/runtime`, as `visibleText` already does with the page's. Compare a chosen option's value only where the view shows that value; otherwise compare the label it shows. When the write changed state that already existed, the same read also checks that only the requested change happened. Write each read-back step to check that match in its own code and call `verified()` when it holds, so the first one that matches is the confirming step. Read one confirmation, list or detail view: find the record there by that identity, never by its position, such as the first or newest row, and prefer finding each value in it by a stable id, its column header or a `data-` attribute over its cell's position. Read only that record, and the view's other rows only where the before-and-after check or another skill, such as the cart skill, compares them. Read another page, in that same step before `verified()`, only for a field the view did not show and the tool's output promises.",
  );
  // Entered values find a record but never prove it new.
  expect(writes).toContain(
    "- State from before the write never matches. Require something only the finished write can show: the number or reference it produced, or a value it changed from what you read before it, such as a status that now reads Sent or a row that was not there. A list still showing the row from before the write, or a table that has not reloaded yet, neither confirms the write nor shows that it did not happen. Values you entered find the record but never prove it new. When they are all a create's read-back can match, read that list before the write too, in the session and the composed script, note the rows that already match (their count or ids), and count only a new one: a row whose id you had not seen, or the one match where there was none. When two rows match after the write and no noted id shows which one is new, values alone do not confirm it.",
  );
  // The rules on commit marks and uncertain outcomes stay as they were.
  expect(writes).toContain(
    "- Mark only the step whose click saves or submits. Opening or filling an unsaved form is not a commit step.",
  );
  expect(writes).toContain(
    "- Never repeat a step blindly. If an `act` step fails after the page sent a state-changing request or opened a socket, after it entered a commit mark, or without returning a result at all (its page was lost), the write may already be committed;",
  );
  // The reference the skill points to confirms from its own commit response.
  expect(
    (await readFile("typescript/authoring/examples/write-readback.ts", "utf8")).replace(/\s+/g, " "),
  ).toContain("// The 201 with its Location confirmed the write. Record it now, with no further call.");
});

/*
 * A write whose own commit request came back 2xx or 3xx, with no error in its body or on the page
 * after it, went through, so the minter confirms it in the commit call instead of opening another
 * page to prove it. It reads the site back only when that request cannot settle the write.
 */
it("has a write confirm from its own commit request, and read back only when that cannot settle it", async () => {
  const texts = await renderedTexts("typescript/authoring");
  const text = (name: string) => (texts.get(name) ?? "").replace(/\s+/g, " ");
  expect(text("writes")).toContain(
    '- Prefer confirming the write from its commit request. Keep the click on the final commit control, such as Save, Send, Submit, Book or Pay, in its own step. In the same call as that click, wait for the site\'s response to the request it sends, matched by the method and path the session saw carry the commit on the site, and by its body where the body shows the caller\'s values, as `references/write-readback.ts` does. Wait too for every way the page can answer with `waitForOutcome`, listing the site\'s error or validation message first. The write went through when that response is 2xx or 3xx, a body the call can read shows no error, and the page shows no error or validation message after it. A 201 whose Location names the new record went through as soon as it arrives, with no wait for the page. A 200 whose body reports an error, as GraphQL can, did not go through. A 202, or a 2xx whose body says the work is queued, went through too; return the site\'s own status word for it in the output. Then read what the output promises from that response or from the page the commit left, match it to the caller\'s values, and call `verified()` with no argument just before returning. Declare `write: { confirmation: "readback" }`. Prefer not opening another page, such as a list, a history or an account screen, only to prove the write: a commit that went through, with the new record\'s id, already proves it. When a commit step returned without calling `verified()` and its `stateChangingRequests` list the commit request with a 2xx or 3xx status, prefer confirming it in the next step from the page as it stands. Make no execute call after `verified()`: a later call reopens the effect. After the confirming step, further `act` steps are refused.',
  );
  // Every case the request cannot settle keeps a read-back.
  expect(text("writes")).toContain(
    "- Read the site's own proof instead only when the commit request can't confirm the write: no such request went out; it failed, got no answer or returned an error status; its body shows an error, or can't be read on an endpoint that reports errors with a 200, such as GraphQL or a batch call; the page shows an error; the commit went over a websocket or a GET link; or a later stage the site can still refuse, such as sending what an earlier click saved, sent no request of its own. Then prefer the confirmation the page shows after the click: an order, booking or reference number, or a success message or toast that appears after the click with no error on the page. Open the saved state, such as the orders page, the booking list or the updated profile, only when the page shows no confirmation. Match it to the caller's values, return the number or record in the output, and call `verified()` as above. A 200 from any other request is not a confirmation.",
  );
  expect(text("writes")).toContain(
    "Before any further write, run an `act` step that only reads the page or the account. When `stateChangingRequests` shows the failed step's commit request went through, that step starts from the page as it stands: check it for an error or validation message, read what the output needs, and call `verified()` there.",
  );
  expect(text("writes")).not.toContain("a 200 response is not a confirmation");
  expect(text("forms")).toContain(
    "Prefer confirming from the commit request the final click sends, checked as the writes skill says, and otherwise from the confirmation the page shows after the click, such as a reference number, a success message or a toast, never from another request's 200.",
  );
  expect(text("forms")).toContain(
    "Never call it for a status code without the page's error check (a 201 whose Location names the new record needs none), or a missing confirmation",
  );
  // The request list carries each request's response status for that check.
  expect(text("core")).toContain(
    "Each entry also lists its requests' final response `statuses` in order, and `unanswered` counts any with no answer when the step ended.",
  );
  expect(text("core")).toContain(
    "For a write session, the list shows the commit your step caused and any autosave, with the status the site answered: a 2xx or 3xx on the commit's route, with no error after it, is what the writes skill confirms from. A 200 whose body reports an error, as GraphQL can, did not go through.",
  );
});

// A write that passed the page's headings to `verified` lost its receipt. With no argument there
// is nothing to get wrong, so no skill or reference teaches the argument form any more.
it("teaches every write to call verified() with no argument and declare a read-back", async () => {
  const texts = await renderedTexts("typescript/authoring");
  const examples = await readdir("typescript/authoring/examples");
  for (const name of examples)
    texts.set(name, await readFile(join("typescript/authoring/examples", name), "utf8"));
  expect(
    [...texts].filter(([, text]) => /verified\(\s*\{|confirmation: "message"/u.test(text)),
  ).toStrictEqual([]);
  expect(placeOrder.write).toEqual({ confirmation: "readback", commits: ["place-order"] });
  expect(bookSeat.write).toEqual({ confirmation: "readback", commits: ["book-seat"] });
});

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/*
 * Pins everything the package gives a standalone minting model: each skill's name, description,
 * text and references in catalog order, the instructions and the workspace README. Change a digest
 * only for an intended authoring change, after reading the rendered text. Each digest comes before
 * its name so a secret scanner does not read a name such as `auth` as a key for it.
 */
it("renders the pinned standalone authoring", async () => {
  const skills = await Effect.runPromise(loadAuthoringSkills("typescript/authoring"));
  const guide = await Effect.runPromise(loadWorkspaceGuide("typescript/authoring"));
  expect(guide.instructions).toBe(guide.files.get("AGENTS.md"));
  expect([
    ...skills.map((skill) => [sha256(JSON.stringify(skill)), skill.name]),
    // The publication review's rules are Guardian's policy text, held equal to it above, so a
    // policy change moves no digest here.
    ...[...guide.files]
      .filter(([path]) => path !== "reference/publication-review.md")
      .map(([path, text]) => [sha256(text), `workspace/${path}`]),
  ]).toStrictEqual([
    ["7a3830220f8ce444ab6975bdcbc12b10813229f6d4999d485a80aa0266c18439", "core"],
    ["cbf9d84d1cdc1a192ec07df90bf99192a72c7b03c0aefb89096f4f0b5bf6ef27", "search"],
    ["ac66bcd6e97b1126cd643bbaee17f1333decc5af5273748060a07b0b82f2b99c", "auth"],
    ["48ba91768a4c1cbb8d6d325bb6b3ef41182bcbdf8097db014391137e29fb7f7d", "testing"],
    ["fc4707b0cd5692efe8cc9b96be4ec88b1f8807451348056eb13dfc3d88486b0f", "pagination"],
    ["3c9a5f4e12e33f5d10758225f0a233f98f9504fce618108fc93a52b5933e0048", "records"],
    ["7e39ab2d515b817c3d42070922a575f6d3cd5b8427d3c97a4af151cec7a32656", "forms"],
    ["482a1233b82951350ebb66f373a56667a47e37796a70a62ff84a6dd6c3abbc7a", "writes"],
    ["01eb1c98d8945987929ca3d8c68d4d848e64415d2042fc844166a490ca9457cb", "cart"],
    ["5e3017df8368f31f52d925062ca0d7f24f2a8badffd8da1589ba9c7860e27b7a", "caller-input"],
    ["3c11e86df509740394a8913710175dbdb364a84afbd2cd755ea19f676be6e0db", "publication"],
    ["65366fa94b5d4203fa00724566b5f509fff2ebf8536bc388b62ad8ba0d8e2e0c", "workspace/AGENTS.md"],
    ["9501ae9c273d5d4db8976a544879f7aee44212c8a616b00e74263dcd3c593035", "workspace/README.md"],
  ]);
});

/*
 * Pins the input-feedback instruction a standalone build's minter reads after a publication
 * review, for a read and a write, with one round left and with none. A standalone build has no
 * fallback, so each ends with the build ending unpublished.
 */
it("renders the pinned standalone input-feedback instructions", () => {
  expect(
    [false, true].flatMap((write) =>
      [1, 0].map((rounds) => [
        sha256(inputFeedbackInstruction(rounds, { write })),
        `${write ? "write" : "read"}, ${rounds} left`,
      ]),
    ),
  ).toStrictEqual([
    ["aba44b16df36914a1d988881085b9b43e4d6e0570e0a68423318eecd7abb4cbc", "read, 1 left"],
    ["bad5f0878c5ecce40c209c1f5e3bd0dac6422c9e42fb0a857c0281e99c6e88eb", "read, 0 left"],
    ["acf24b4205a7e37c6cfab1f19421d36f26a385bbc7bcaaf8a2799ef29fc77d5e", "write, 1 left"],
    ["fa380b552c8ddec278fc6d2de4f613a37459d2f9cbf3c9393fe94251ee71511a", "write, 0 left"],
  ]);
});

it.each([
  ["an unterminated section", "<!-- pomerado:section core.left-open:start\nleft open\n"],
  ["a stray end marker", "pomerado:section core.stray:end -->\n"],
  ["a marker without its space", "<!--pomerado:section core.unspaced -->\n"],
  ["a section named for another file", "<!-- pomerado:section auth.elsewhere -->\n"],
  [
    "a duplicated section",
    "<!-- pomerado:section core.twice -->\n<!-- pomerado:section core.twice -->\n",
  ],
  [
    "a section inside a code fence",
    "```md\n<!-- pomerado:section core.fenced:start\nshown\npomerado:section core.fenced:end -->\n```\n",
  ],
  ["a 0.1.1 end marker", "pomerado:hosted:end -->\n"],
  ["an uppercase marker", "<!-- Pomerado:section core.upper -->\n"],
  ["an uppercase end marker", "POMERADO:SECTION core.upper:end -->\n"],
])("refuses %s", async (_case, appended) => {
  const root = await authoringCopy((path, text) =>
    path.endsWith(join("core", "SKILL.md")) ? `${text}${appended}` : text,
  );
  try {
    expect(await Effect.runPromise(Effect.either(loadAuthoringSkills(root)))).toMatchObject({
      _tag: "Left",
      left: { code: "Unavailable" },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("validates dialog picker request fields before browser work", async () => {
  expect(
    await Effect.runPromise(Schema.decodeUnknown(dialogPicker.input)({ query: "item", key: "B" })),
  ).toEqual({ query: "item", key: "B" });
  for (const input of [
    { query: "", key: "B" },
    { query: "item", key: "" },
    { query: null, key: "B" },
  ])
    expect(
      await Effect.runPromise(Effect.either(Schema.decodeUnknown(dialogPicker.input)(input))),
    ).toMatchObject({ _tag: "Left" });
});

it("validates detail identifiers and rejects traversal before browser work", async () => {
  expect(
    await Effect.runPromise(
      Schema.decodeUnknown(detailNavigation.input)({ record_id: "record_42" }),
    ),
  ).toEqual({ record_id: "record_42" });
  expect(
    await Effect.runPromise(
      Effect.either(Schema.decodeUnknown(detailNavigation.input)({ record_id: "../other-record" })),
    ),
  ).toMatchObject({ _tag: "Left" });
});

it("accepts authoritative empty invoices and rejects absent/invalid bodies", async () => {
  const parse = async (body: string) => {
    const journal = await Effect.runPromise(makeEffectJournal);
    return Effect.runPromise(
      Effect.either(
        Effect.scoped(
          executeKernelOperation(
            parser,
            { body },
            { kernel: offlineKernel, sessionId: "offline" },
          ).pipe(
            Effect.provideService(ExecutionContext, {
              deadline: Deadline.after(5_000),
              journal,
              events: { emit: () => Effect.void },
              capture: { start: Effect.void, finish: Effect.void },
            }),
          ),
        ),
      ),
    );
  };
  expect(await parse(JSON.stringify({ invoices: [], complete: true }))).toEqual(
    Either.right({ invoices: [], complete: true }),
  );
  for (const body of ["", "{}", '{"invoices":[],"complete":"yes"}'])
    expect(await parse(body)).toMatchObject({ _tag: "Left" });
});

it("selects old/new structural variants deterministically and rejects ambiguous/loading/unknown", () => {
  expect(selectInvoiceLayout({ tables: 1, lists: 0, loading: false })).toBe("table");
  expect(selectInvoiceLayout({ tables: 0, lists: 1, loading: false })).toBe("cards");
  for (const [observation, reason] of [
    [{ tables: 1, lists: 1, loading: false }, "ambiguous"],
    [{ tables: 1, lists: 0, loading: true }, "loading"],
    [{ tables: 0, lists: 0, loading: false }, "unsupported"],
    [{ tables: 2, lists: 0, loading: false }, "identity_mismatch"],
  ] as const)
    expect(() => selectInvoiceLayout(observation)).toThrow(reason);
});

it("reacquires a destroyed observation context without replaying the auth-entry click", async () => {
  let clicks = 0;
  let reads = 0;
  let url = "https://members.example.test/";
  const controls = [{ tag: "input", type: "text" }];
  const entry = {
    filter: () => entry,
    count: async () => 1,
    getAttribute: async () => "/member/login",
    click: async () => {
      clicks++;
      url = "https://members.example.test/member/login";
    },
  };
  const form = {
    getByLabel: () => ({ waitFor: async () => undefined }),
    locator: () => ({
      evaluateAll: async () => {
        if (++reads === 1)
          throw new Error("Execution context was destroyed, most likely because of a navigation");
        return controls;
      },
    }),
  };
  const page = {
    url: () => url,
    getByRole: (role: string) => (role === "navigation" ? { getByRole: () => entry } : form),
    waitForURL: async () => undefined,
    waitForLoadState: async () => undefined,
  };
  const journal = await Effect.runPromise(makeEffectJournal);
  const result = await Effect.runPromise(
    Effect.scoped(
      executeKernelOperation(
        authEntry,
        {},
        {
          sessionId: "fixture",
          siteOrigin: "https://members.example.test",
          kernel: {
            browsers: {
              playwright: {
                execute: async (_session, body) => {
                  const pending: unknown = new Script(
                    `(async () => { ${body.code} })()`,
                  ).runInNewContext({ page, URL });
                  const result: unknown = await pending;
                  return { success: true, result, stdout: "", stderr: "" };
                },
              },
            },
          },
        },
      ).pipe(
        Effect.provideService(ExecutionContext, {
          deadline: Deadline.after(2000),
          journal,
          events: { emit: () => Effect.void },
          capture: { start: Effect.void, finish: Effect.void },
        }),
      ),
    ),
  );
  expect(result).toMatchObject({ controls, coverage: "observed_login_form" });
  expect(clicks).toBe(1);
  expect(reads).toBe(2);
});

const runPureFiles = (entrypoint: string, sources: readonly (readonly [string, string])[]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const workspace = yield* createLocalWorkspace();
        return yield* runLocalOperation({
          workspace,
          entrypoint,
          sources,
          input: {},
          target: "pureFiles",
        });
      }),
    ),
  );

/*
 * Every skill reference, as the agent copies it into its workspace, and every import the workspace
 * guide or a skill shows, must load against the SDK the local executor stages beside authored
 * source. It fails when an example or the guidance names an import the executor cannot resolve.
 */
it("loads every reference and every documented import against the runtime the local executor ships", async () => {
  const authoring = "typescript/authoring";
  const skills = await Effect.runPromise(loadAuthoringSkills(authoring));
  const guide = await Effect.runPromise(loadWorkspaceGuide(authoring));
  const modules = new Map<string, string>();
  // A reference names the repository's SDK paths; the workspace README maps them to the
  // workspace's own, two levels above src/.
  for (const name of new Set(skills.flatMap((skill) => Object.keys(skill.references ?? {}))))
    modules.set(
      `src/${name.replace(/\.ts$/u, ".mjs")}`,
      stripTypeScriptTypes(await readFile(join(authoring, "examples", name), "utf8"), {
        mode: "transform",
      }).replaceAll('"../../src/', '"../../'),
    );
  const documents = [
    ...guide.files.values(),
    ...skills.map((skill) => {
      if (typeof skill.content === "string") return skill.content;
      if (skill.content instanceof Uint8Array) return new TextDecoder().decode(skill.content);
      throw new Error(`Expected rendered text for skill ${skill.name}`);
    }),
  ];
  for (const content of documents)
    for (const [index, [, block]] of [
      ...content.matchAll(/```(?:js|javascript|ts|typescript)?\n([\s\S]*?)```/gu),
    ].entries()) {
      // An import statement, over several lines when it lists its names that way.
      const imports = [...(block ?? "").matchAll(/^import\s[^;]*?["'][^"']+["'];?/gmu)].map(
        ([statement]) => statement,
      );
      if (imports.length > 0)
        modules.set(`src/documented-${modules.size}-${index}.mjs`, imports.join("\n"));
    }
  expect([...modules.keys()].filter((path) => path.includes("documented-")).length).toBeGreaterThan(
    0,
  );
  // The real local executor loads every module from one authored entrypoint, which finds the
  // SDK at whichever path this layout resolves, so only the modules under test can fail.
  const entrypoint = "src/load-every-import.mjs";
  const entry = `import { Schema } from "effect";
const sdk = await import("../../runtime/index.js").catch(() => import("../runtime/index.js"));
const paths = ${JSON.stringify([...modules.keys()].map((path) => `./${path.slice("src/".length)}`))};
export default sdk.defineOperation(
  { input: Schema.Struct({}), output: Schema.Struct({ failed: Schema.Array(Schema.String) }) },
  async () => {
    const failed = [];
    for (const path of paths) {
      try {
        await import(path);
      } catch (error) {
        failed.push(path + ": " + String(error?.message ?? error).split("\\n")[0]);
      }
    }
    return { failed };
  },
);
`;
  const result = await runPureFiles(entrypoint, [...modules, [entrypoint, entry]]);
  expect(result.output).toEqual({ failed: [] });
}, 30_000);

/*
 * Before the executor staged authored source a level below the SDK, source in src/ reached the SDK
 * and the dependency folder one level up, a nested module two levels up, and its working folder
 * held package.json. Integrations saved that way keep running, against the same modules as the
 * documented path, with relative file paths still read from the authored root.
 */
it("runs source that reaches the SDK one level up from src/, as saved integrations may", async () => {
  const result = await runPureFiles("src/tool.mjs", [
    [
      "src/tool.mjs",
      `import { Schema } from "effect";
import * as dependency from "../node_modules/effect/dist/esm/index.js";
import { readFileSync } from "node:fs";
import * as documented from "../../runtime/index.js";
import * as runtime from "../runtime/index.js";
import * as browser from "../browser/index.js";
import { nested } from "./lib/nested.mjs";
export default runtime.defineOperation(
  {
    input: Schema.Struct({}),
    output: Schema.Struct({ same: Schema.Boolean, note: Schema.String, type: Schema.String }),
  },
  async () => ({
    same:
      documented.defineOperation === runtime.defineOperation &&
      browser.OperationFailure === runtime.OperationFailure &&
      nested === runtime.defineOperation &&
      dependency.Schema === Schema,
    note: JSON.parse(readFileSync("src/note.json", "utf8")).note,
    type: JSON.parse(readFileSync("package.json", "utf8")).type,
  }),
);`,
    ],
    ["src/lib/nested.mjs", `export { defineOperation as nested } from "../../runtime/index.js";`],
    ["src/note.json", JSON.stringify({ note: "authored root" })],
  ]);
  expect(result.output).toEqual({ same: true, note: "authored root", type: "module" });
}, 30_000);

it("refuses authored files named like a folder the host stages beside them", async () => {
  const operation = `import { Schema } from "effect";
import { defineOperation } from "../../runtime/index.js";
export default defineOperation({ input: Schema.Struct({}), output: Schema.Struct({}) }, async () => ({}));`;
  for (const name of ["runtime", "browser", "privacy", "node_modules"]) {
    const result = await runPureFiles("src/tool.mjs", [
      ["src/tool.mjs", operation],
      [name, "export {};"],
    ]).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(result, name).toMatchObject({
      message: expect.stringContaining(`Reviewed source cannot replace trusted SDK: ${name}`),
    });
  }
}, 30_000);
