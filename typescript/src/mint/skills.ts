import { Effect } from "effect";
import { file } from "@openai/agents/sandbox";
import type { SkillDescriptor } from "@openai/agents/sandbox";
import { readScopedFile } from "../filesystem/read.js";
import { MintFailure } from "./contracts.js";
import { failureDetail } from "../runtime/failure-detail.js";
import { hostedFeaturesPreamble } from "../hosted-features.js";
import { publicationLiveTestsPolicy, publicationOutputPolicy } from "../guardian/publication.js";

/**
 * Each skill the minter may read: `trigger` says when to read it, in concrete terms it can check
 * against the step it is about to write, and `contents` says what it holds; the skill list shows
 * them as one description. `preload` names the starts whose first message a host may carry the
 * skill in, already read (`preloadedSkills`); every other skill loads when its trigger applies.
 * Catalog order is preload priority.
 */
const catalog = [
  {
    name: "core",
    trigger: "Read first, before any other skill",
    contents: "operation SDK, intake, ownership and execution targets",
    preload: ["build", "repair"],
    references: ["parser.ts", "native-page.ts", "selection.ts"],
  },
  {
    name: "waits",
    trigger:
      "Read before writing or changing any step that waits for the page, a network answer or an outcome, or that uses `waitForOutcome`, `waitForOutcomeResult`, `waitForRows`, `waitForValues`, `waitForChange`, `waitForReady` or `waitPastChallenge`",
    contents:
      "budgets, readiness, naming every answer a step can give, value waits and what each wait failure means",
    preload: ["build", "repair"],
    references: ["navigation.ts", "native-dialog.ts"],
  },
  {
    name: "browser-code",
    trigger:
      "Read before writing or changing any browser code: a `kernel.browsers.playwright.execute` call, an explore or a probe",
    contents:
      "execute calls, clicks and locators, the site origin, reading values from the page, page identity, uncertain transitions, probes and native dialogs",
    preload: ["build", "repair"],
    references: ["native-page.ts", "navigation.ts", "native-dialog.ts"],
  },
  {
    name: "inputs",
    trigger:
      "Read before writing or changing the input schema or any input, and before code that sets an input on the page",
    contents:
      "what the schema holds, required, optional and defaulted inputs, enums and typeahead lookups, JSON Schema constraints, descriptions and examples, contract gaps, and choices set on the page and read back (Configure, then read)",
    preload: ["build"],
    references: [],
  },
  {
    name: "outputs",
    trigger:
      "Read before writing or changing the output schema or any output field, and before code that reads a value the tool returns",
    contents:
      "values the request needs, typed and nullable fields, optional `include` sections, result lists and groups, field names, money, dates and other formats",
    preload: ["build"],
    references: [],
  },
  {
    name: "tailoring",
    trigger:
      "Read before building a read whose answer can depend on where or who the visitor is (a location, store, ZIP, delivery or pickup, vehicle, membership or plan), and before asking about or setting one",
    contents:
      "find those inputs, apply them, return the value the site applied, and when a caller limits an input's use",
    preload: [],
    references: [],
  },
  {
    name: "rejections",
    trigger:
      "Read before writing any check of the caller's input, any `InvalidInput`, `InputNotApplied` or `OperationFailure`, or any refusal a tool returns",
    contents:
      'the rules checked before touching the site, which error fits what happened, `available` and `kind`, and when a message starts "Caller input error:"',
    preload: [],
    references: [],
  },
  {
    name: "site-tools",
    trigger:
      "Read when `reference/site-tools.json` exists, before settling or changing the tool's inputs and outputs",
    contents: "the site's other tools, sharing their identifiers and shapes, and reusing their code",
    preload: [],
    references: [],
  },
  {
    name: "search",
    trigger: "Read before settling a search or listing tool's inputs",
    contents:
      "the site's own filters, sort and location, applied and read back, and honest empty results",
    preload: [],
    references: [],
  },
  {
    name: "auth",
    trigger: "Read before signing in, before any `authenticate` call, and before writing a signed-in tool",
    contents:
      "discover an evidenced login entry, sign in through the host, and keep a signed-in operation signed in",
    preload: [],
    references: ["auth-entry.ts"],
  },
  {
    name: "testing",
    trigger: "Read on a read build once its example passes, before designing its live tests",
    contents:
      "design a few combined live test cases and run them. A read signed out runs a handful; a signed-in read runs four inputs at most. A write skips it and proves its tool with one run",
    preload: [],
    references: [],
  },
  {
    name: "pagination",
    trigger: "Read before settling the schema of any tool that returns a list",
    contents:
      "page size, the cursor, numbered pages, next links, load more, infinite scroll, the site's own list API, changed lists and when to stop",
    preload: [],
    references: ["pagination.ts", "pager.ts"],
  },
  {
    name: "forms",
    trigger:
      "Read before driving a dropdown, picker, date or file control or a form with several steps, and before any write that fills in a form",
    contents: "native/custom selection, resolvers, staged forms and expected terms",
    preload: [],
    references: [
      "dates-and-dropdowns.ts",
      "picker.ts",
      "custom-selection.ts",
      "dialog-picker.ts",
      "dates-and-files.ts",
    ],
  },
  {
    name: "writes",
    trigger: "Read as soon as a build is a write, before its first `act` step",
    contents:
      "perform an authorized write once, confirm it, then return its integration without running it again",
    preload: [],
    references: ["write-session.ts", "write-readback.ts"],
  },
  {
    name: "cart",
    trigger: "Read before building any tool that reads, adds to, changes or checks out a cart",
    contents:
      "sign in first, read the cart before and after, quantity, account values and site limits",
    preload: [],
    references: [],
  },
  {
    name: "caller-input",
    trigger:
      "Read before a run asks its caller anything, such as a choice only the page offers, which of several matches, or a code the site sends, and before declaring any question",
    contents: "declaring, reading and asking questions mid-run, and what happens when no answer comes",
    preload: [],
    references: ["caller-choice.ts", "caller-code.ts"],
  },
  {
    name: "publication",
    trigger: "Read before the first finish_build",
    contents: "what publication checks, private values never to publish, and how to act on each rejection",
    preload: [],
    references: [],
  },
] as const satisfies readonly {
  readonly name: string;
  readonly trigger: string;
  readonly contents: string;
  readonly preload: readonly AuthoringStart[];
  readonly references: readonly string[];
}[];

/** Where a minter starts: a new build, read or write, or a repair of a published tool. */
export type AuthoringStart = "build" | "repair";

/** A skill's description in the skill list: when to read it, then what it holds. */
const skillDescription = (entry: (typeof catalog)[number]) => `${entry.trigger}: ${entry.contents}`;

/**
 * The skills a host may carry, already read, in the first message of a start, most needed first.
 * A host with a budget for that message takes them in this order and leaves out one that does not
 * fit, which then loads when its trigger applies, like every other skill.
 */
export const preloadedSkills = (start: AuthoringStart): readonly string[] =>
  catalog.flatMap(({ name, preload }) =>
    (preload as readonly AuthoringStart[]).includes(start) ? [name] : [],
  );

/**
 * The host-owned workspace guide, relative to the authoring directory. `AGENTS.md` is the
 * always-on context: the host installs it at the workspace root and gives the same text to the
 * minting model as its instructions, so it holds regardless of the agent runtime. The README is
 * read on demand. Each path is installed at the same path under the workspace root, without the
 * `workspace/` prefix.
 */
const workspaceGuideFiles = [{ path: "README.md", sectionKey: "guide" }] as const;

/**
 * The publication review's rules for live tests and output, installed in the workspace for the
 * minter to read while it explores, so it gathers that evidence before its first publication
 * instead of learning it from a denial. It is the text every host's publication policy includes,
 * not a copy, so a change to a rule reaches the minter in the same release. No host render
 * applies: it is not authoring text.
 */
const publicationReviewRules = {
  path: "reference/publication-review.md",
  text: [publicationLiveTestsPolicy, publicationOutputPolicy].join("\n\n"),
} as const;

export interface WorkspaceGuide {
  /** The workspace `AGENTS.md`, which is also the minting model's instructions. */
  readonly instructions: string;
  /** Workspace-relative path to content, `AGENTS.md` included. */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * Turns one authoring file's text into what the minter reads. `sectionKey` is the file's key, such
 * as `core` for `core/SKILL.md`. The default renders each named section's standalone text. A host
 * that composed the directory with its own text supplies a render that checks that text instead.
 */
export type AuthoringRender = (text: string, sectionKey: string) => string;

/**
 * A named section is `<!-- pomerado:section ID -->`, or `<!-- pomerado:section ID:start`, its
 * standalone text and `pomerado:section ID:end -->`. A section that ends the file also takes the
 * file's final newline. Each ID starts with its file's key, such as `core.` in `core/SKILL.md`.
 */
const section =
  /<!-- pomerado:section ([a-z0-9.-]+)(?: -->|:start\n([\s\S]*?)\npomerado:section \1:end -->)(?:\n(?=$))?/g;
/**
 * Anything left that reads as a marker, in any case or spacing, is malformed: a broken section, or
 * a 0.1.1 block such as `pomerado:hosted:end -->`. Authoring text never says `pomerado:` itself.
 */
const sectionTrace = /pomerado:/i;
const fence = /^\s*(`{3,}|~{3,})/;

/** A section marker belongs to the file's own text, never to a fenced example. */
const refuseFencedSections = (text: string) => {
  let open: string | undefined;
  for (const line of text.split("\n")) {
    const marker = fence.exec(line)?.[1];
    if (marker === undefined) {
      if (open !== undefined && sectionTrace.test(line))
        throw new Error("Authoring section inside a code fence");
    } else if (open === undefined) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length) open = undefined;
  }
};

const standaloneText: AuthoringRender = (text, sectionKey) => {
  refuseFencedSections(text);
  const seen = new Set<string>();
  const rendered = text.replace(section, (_match: string, id: string, content?: string) => {
    if (!id.startsWith(`${sectionKey}.`))
      throw new Error(`Authoring section ${id} is not one of ${sectionKey}'s`);
    if (seen.has(id)) throw new Error(`Authoring section ${id} appears twice`);
    seen.add(id);
    return content ?? "";
  });
  if (sectionTrace.test(rendered)) throw new Error("Malformed authoring section");
  return rendered;
};

/**
 * The search URL fast path: a tool enters at the site's results URL with the caller's values in
 * it, filters and a location the URL carries included, whenever that mapping is reliable and
 * clear. A host turns it on with `searchUrlFastPath`. Off, the minter reads the files' own text,
 * which opens such a URL only for the parts it lists, and a search reaches its results through
 * the page's controls before it reads the page's own data. Each entry is whole lines of one
 * file's rendered text, which appear there exactly once, and the lines that replace them.
 */
const searchUrlFastPathPassages: readonly {
  readonly sectionKey: string;
  readonly off: readonly string[];
  readonly on: readonly string[];
}[] = [
  {
    sectionKey: "agents",
    off: [
      "which parts of it carry which input, such as the query, dates, guests or party size, sort or a",
      "record's own identifier route, the tool may open that URL with the caller's values in those",
      "parts, built with `URLSearchParams` for a query part or `encodeURIComponent` for a path part and",
      "every other part copied as the site wrote it, once the build checked that it gives the same answer as the controls. At run time it reads every input",
    ],
    on: [
      "which parts of it carry which input, such as the query, dates, guests or party size, sort,",
      "filters, a location the URL itself carries or a record's own identifier route, the tool enters",
      "at that URL with the caller's values in those parts when the mapping is reliable and clear: each",
      "part's valid values are known and readable in the URL, such as a sort or filter whose values",
      "become the input's enum, or a query the site encodes as typed. An opaque filter code still comes",
      "only from a link the page produced in this run (below). Otherwise it uses the page's controls.",
      "It builds that URL with `URLSearchParams` for a query part or `encodeURIComponent` for a path",
      "part and every other part copied as the site wrote it, once the build checked that it gives the same answer as the controls. At run time it reads every input",
    ],
  },
  {
    sectionKey: "search",
    off: [
      "On every run, set each input the site has a control for through that control, or through the URL",
      "or data request the site itself uses for it when the control is unreliable (testing skill), never",
      "by filtering the returned rows, then read it back from the site's committed state: the",
    ],
    on: [
      "On every run, set each input the site has a control for through that control, through the",
      'results URL when the site\'s URL reliably carries it (`AGENTS.md`, "Work through the page\'s own',
      'controls"), or through the data request the site itself uses for it when the control is',
      "unreliable (testing skill), never by filtering the returned rows, then read it back from the site's committed state: the",
    ],
  },
  {
    sectionKey: "search",
    off: [
      "Try the fast path first. While exploring, check whether the page's own data request or embedded",
      "data carries the result fields. When it does, the default design is: reach the results through",
      "the page's controls, then read that data in the same session, reading the applied location back",
      "from the page or that answer. Read rendered rows only when it doesn't. For a data request, prefer",
      "catching the page's own answer in the same call as the step that sends it",
      "(`Promise.all([page.waitForResponse(...), button.click()])`, waits skill). Fetching it in the page",
      "(`page.evaluate(() => fetch(...))`) is fine to speed things up or when that answer can't be",
      "caught, once the page itself has reached the results, not as the only step.",
    ],
    on: [
      "Try the fast path first. While exploring, check whether the results page loads directly by URL",
      'with the inputs encoded (`AGENTS.md`, "Work through the page\'s own controls"), and whether the',
      "page's own data request or embedded data carries the result fields. When both hold, the default",
      "design is: set a location or store through the page's controls first if the URL cannot carry it,",
      "load the results URL, then read that data in the same session, reading the applied location back",
      "from the page or that answer. Drive the search form and read rendered rows only when they don't.",
      "For a data request, prefer catching the page's own answer in the same call as the step that sends",
      "it (`Promise.all([page.waitForResponse(...), button.click()])`, waits skill). Fetching it in the",
      "page (`page.evaluate(() => fetch(...))`) is fine to speed things up or when that answer can't be",
      "caught, once the page itself has reached the results, not as the only step.",
    ],
  },
];

/** `render`, with the search URL fast path's lines in place of the files' own. */
const withSearchUrlFastPath =
  (render: AuthoringRender): AuthoringRender =>
  (text, sectionKey) =>
    searchUrlFastPathPassages.reduce((rendered, { sectionKey: key, off, on }) => {
      if (key !== sectionKey) return rendered;
      const parts = rendered.split(off.join("\n"));
      if (parts.length !== 2)
        throw new Error(`Authoring ${sectionKey} lacks one search URL fast path passage`);
      return parts.join(on.join("\n"));
    }, render(text, sectionKey));

/**
 * What a host may turn on in the authoring it loads. `searchUrlFastPath` renders the search URL
 * fast path (`searchUrlFastPathPassages`). It is off when absent, and the local host leaves it off.
 */
export type AuthoringOptions = { readonly searchUrlFastPath?: boolean };

const hostRender = (render: AuthoringRender, options: AuthoringOptions) =>
  options.searchUrlFastPath === true ? withSearchUrlFastPath(render) : render;

const readGuideFile = (
  directory: string,
  path: string,
  sectionKey: string,
  render: AuthoringRender,
) =>
  Effect.tryPromise({
    try: async () =>
      render(
        new TextDecoder("utf-8", { fatal: true }).decode(
          await readScopedFile(directory, `workspace/${path}`),
        ),
        sectionKey,
      ),
    catch: (error) =>
      new MintFailure({
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "readScopedFile",
          phase: "workspace_guide",
          error,
          context: { path },
        }),
        code: "Unavailable",
      }),
  });

/** Pass the trusted installed authoring directory explicitly; it is not a model-selected path. */
export const loadWorkspaceGuide = (
  directory: string,
  render: AuthoringRender = standaloneText,
  options: AuthoringOptions = {},
): Effect.Effect<WorkspaceGuide, MintFailure> =>
  Effect.gen(function* () {
    const rendering = hostRender(render, options);
    const instructions = yield* readGuideFile(directory, "AGENTS.md", "agents", rendering);
    const files = new Map([["AGENTS.md", instructions]]);
    for (const { path, sectionKey } of workspaceGuideFiles)
      files.set(path, yield* readGuideFile(directory, path, sectionKey, rendering));
    files.set(publicationReviewRules.path, publicationReviewRules.text);
    return { instructions, files };
  });

/** Pass the trusted installed authoring directory explicitly; it is not a model-selected path. */
export const loadAuthoringSkills = (
  directory: string,
  render: AuthoringRender = standaloneText,
  options: AuthoringOptions = {},
): Effect.Effect<readonly SkillDescriptor[], MintFailure> =>
  Effect.tryPromise({
    try: async () =>
      Promise.all(
        catalog.map(async (entry): Promise<SkillDescriptor> => {
          const references: Record<string, ReturnType<typeof file>> = {};
          for (const name of entry.references)
            references[name] = file({
              content: await readScopedFile(directory, `examples/${name}`),
            });
          return {
            name: entry.name,
            description: skillDescription(entry),
            content: new TextEncoder().encode(
              hostRender(render, options)(
                new TextDecoder("utf-8", { fatal: true }).decode(
                  await readScopedFile(directory, `${entry.name}/SKILL.md`),
                ),
                entry.name,
              ),
            ),
            references,
          };
        }),
      ),
    catch: (error) =>
      new MintFailure({
        failureDetail: failureDetail("mint_host_dependency_failed", {
          operation: "readScopedFile",
          phase: "authoring_skills",
          error,
          context: { skillCount: catalog.length },
        }),
        code: "Unavailable",
      }),
  });

/**
 * Each skill's text at the path the minter reads it, `.agents/<name>/SKILL.md`, for a review that
 * may read the skills the minter followed. A skill whose content is not inline text is left out.
 */
export const skillReferenceFiles = (
  skills: readonly SkillDescriptor[],
): ReadonlyMap<string, string> =>
  new Map(
    skills.flatMap(({ name, content }) => {
      const text =
        typeof content === "string"
          ? content
          : content instanceof Uint8Array
            ? new TextDecoder().decode(content)
            : undefined;
      return text === undefined ? [] : [[`.agents/${name}/SKILL.md`, text] as const];
    }),
  );

/**
 * The local host's authoring: standalone text, with the hosted features its minter is to ignore on
 * top of `AGENTS.md`, both as instructions and as the workspace file.
 */
export const loadStandaloneAuthoring = (directory: string) =>
  Effect.gen(function* () {
    const guide = yield* loadWorkspaceGuide(directory);
    const skills = yield* loadAuthoringSkills(directory);
    if (hostedFeaturesPreamble === "") return { ...guide, skills };
    const instructions = `${hostedFeaturesPreamble}\n\n${guide.instructions}`;
    const files = new Map(
      [...guide.files].map(([path, text]) => [path, path === "AGENTS.md" ? instructions : text]),
    );
    return { instructions, files, skills };
  });
