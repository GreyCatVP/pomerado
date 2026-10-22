import { Option, Schema } from "effect";
import {
  AutofillApproval,
  AutofillPopup,
  DateControl,
  DateOfBirthFormat,
  IdentifierKinds,
  maximumCodeBoxes,
  maximumStepFields,
  RejectedMarker,
  SecretSlots,
  SignInMethodChoice,
  stepFieldsFit,
  stepFieldsMessage,
  SubmitKey,
} from "./autofill-contracts.js";
import type { AutofillField } from "./autofill-step.js";
export {
  AutofillPopup,
  RejectedMarker,
  SignInMethodChoice,
  SignInMethod,
} from "./autofill-contracts.js";

/** The bundle file a minted tool's sign-in recipe ships as, beside its source. */
export const autofillRecipePath = "auth-fill.json";

const Selector = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1_000));
/**
 * A recorded field: an identifier field by every kind it accepts, which each run resolves against
 * its own login, or a secret field by its slot.
 */
const RecipeField = Schema.Union(
  Schema.Struct({
    selector: Selector,
    accepts: Schema.Array(IdentifierKinds).pipe(Schema.minItems(1), Schema.maxItems(4)),
  }),
  Schema.Struct({
    selector: Selector,
    slot: SecretSlots,
    format: Schema.optional(DateOfBirthFormat),
    control: Schema.optional(DateControl),
    /** A security answer's question, which each replay reads again; never the answer. */
    questionSelector: Schema.optional(Selector),
  }),
);

/**
 * One recorded sign-in screen: the page it ran on (origin and path), the fields the host filled by
 * slot, and the control that submitted them, clicked by the host or, after a missed host click, by
 * the minter. A two-factor method choice records every method the screen offered, each with the
 * control that picks it, and its `submit` is the one the mint picked.
 */
const RecipeStep = Schema.Struct({
  rejectedMarkers: Schema.optional(
    Schema.Array(RejectedMarker).pipe(Schema.maxItems(maximumStepFields)),
  ),
  page: Schema.String.pipe(Schema.maxLength(2_000)),
  fields: Schema.Array(RecipeField).pipe(
    Schema.maxItems(maximumStepFields + maximumCodeBoxes),
    Schema.filter(stepFieldsFit, { message: () => stepFieldsMessage }),
  ),
  submit: Schema.optional(Selector),
  submittedBy: Schema.optional(Schema.Literal("host", "minter")),
  methods: Schema.optional(
    Schema.Array(Schema.Struct({ method: SignInMethodChoice, selector: Selector })).pipe(
      Schema.minItems(1),
      Schema.maxItems(8),
    ),
  ),
});

/**
 * A verified autofill sign-in, value-free: selectors, slots, submits and pages, and the indicator
 * the minter found and the host checked. A run replays it with the host's own fill. `version` is
 * what a host checks before replaying: a host that does not know it refuses the recipe rather than
 * dropping step metadata or typing into a different page.
 */
export const LegacyAutofillRecipe = Schema.Struct({
  version: Schema.Literal(1),
  steps: Schema.Array(RecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  /**
   * The deterministic check that the sign-in worked: a marker on the page it lands on, or on the
   * account page `openPath` the host opens first.
   */
  signedIn: Schema.Struct({
    selector: Schema.optional(Selector),
    urlPath: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
    openPath: Schema.optional(Schema.String.pipe(Schema.maxLength(2_000))),
  }),
});
const PopupRecipeStep = Schema.Struct({
  ...RecipeStep.fields,
  popup: Schema.optional(AutofillPopup),
  approval: Schema.optional(AutofillApproval),
});
/** Version 2 keeps a host that does not know it from dropping popup metadata and filling the primary tab. */
export const PopupAutofillRecipe = Schema.Struct({
  ...LegacyAutofillRecipe.fields,
  version: Schema.Literal(2),
  steps: Schema.Array(PopupRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
});
/**
 * A version 2 step that may run on the login's own workspace host: with `origin: "workspace"`, its
 * `page` is a path only, and each run resolves it against the workspace origin it verified.
 */
const WorkspaceRecipeStep = Schema.Struct({
  origin: Schema.optional(Schema.Literal("workspace")),
  ...PopupRecipeStep.fields,
});
/** A lower-case host name, as a registrable domain is written. */
const HostName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(253),
  Schema.pattern(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/u),
);
const absolutePage = (page: string) => URL.parse(page) !== null;
/**
 * A canonical pathname, which the URL parser keeps unchanged: it starts with one "/", and has no
 * host, backslash, query, fragment, dot segment or character the parser rewrites.
 */
const pathOnlyPage = (page: string) => URL.parse(page, "https://h.invalid")?.pathname === page;
/**
 * Version 4: a sign-in that may move to a per-account workspace host on the site's registrable
 * domain (`workspace`). It names no tenant: `workspace.parent` is the site's own registrable
 * domain, and a workspace step names a path only. A host checks them against the tool's site
 * origin at use, never here. A host that does not know version 4 refuses it, and a version 4
 * recipe with a key this host does not know is refused, so no host drops what a writer adds.
 */
/** Version 4's and 5's checks of their workspace steps' pages against the recipe's workspace. */
const workspacePages = <
  Recipe extends {
    readonly workspace?: unknown;
    readonly steps: readonly { readonly origin?: "workspace" | undefined; readonly page: string }[];
  },
>(
  recipe: Schema.Schema<Recipe, Recipe>,
) =>
  recipe.pipe(
    Schema.filter(
      (recipe) =>
        recipe.steps.every((step) =>
          step.origin === "workspace" ? pathOnlyPage(step.page) : absolutePage(step.page),
        ) || "a workspace step's page is a path, and any other step's an absolute URL",
    ),
    Schema.filter(
      (recipe) =>
        recipe.workspace !== undefined ||
        recipe.steps.every((step) => step.origin !== "workspace") ||
        "a workspace step needs the recipe's workspace",
    ),
  );
export const WorkspaceAutofillRecipe = workspacePages(
  Schema.Struct({
    ...LegacyAutofillRecipe.fields,
    version: Schema.Literal(4),
    workspace: Schema.optional(Schema.Struct({ parent: HostName })),
    steps: Schema.Array(WorkspaceRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  }).annotations({ parseOptions: { onExcessProperty: "error" } }),
);
/** The secret a later screen may ask for again, beside a second factor: the password. */
export const RefillSlot = Schema.Literal("password");
/** A second factor: the one-time values a screen that asks for the password again also takes. */
export const isSecondFactor = (slot: string) => slot === "code" || slot === "recovery_code";
/**
 * A version 5 step: a version 4 step that may submit with a key (`submitKey`): Enter pressed in
 * its last field submits that field's form, on a screen whose form has no submit control. Such a
 * step fills a field and names no submit or method choice. It may also list `refills`, the
 * secrets an earlier screen of the sign-in took that this screen asks for again, as a site that
 * wants the password re-entered with a one-time code does: only a screen that takes the refilled
 * field and a second factor may list one. A step that fills no field and clicks one control may be
 * `ifShown`: the control of a notice the page shows on some visits only, which a run clicks where
 * it shows and goes on without where it does not.
 */
const KeyRecipeStep = Schema.Struct({
  ...WorkspaceRecipeStep.fields,
  submitKey: Schema.optional(SubmitKey),
  refills: Schema.optional(Schema.Array(RefillSlot).pipe(Schema.minItems(1), Schema.maxItems(1))),
  ifShown: Schema.optional(Schema.Literal(true)),
}).pipe(
  Schema.filter(
    (step) =>
      step.submitKey === undefined ||
      (step.submit === undefined && step.methods === undefined && step.fields.length > 0) ||
      "a submitKey step fills a field and names no submit or method choice",
  ),
  Schema.filter(
    (step) =>
      step.refills === undefined ||
      (step.fields.some((field) => "slot" in field && isSecondFactor(field.slot)) &&
        step.refills.every((slot) =>
          step.fields.some((field) => "slot" in field && field.slot === slot),
        )) ||
      "a step's refills name a field it takes, and it takes a code or recovery code",
  ),
  Schema.filter(
    (step) =>
      step.ifShown === undefined ||
      (step.fields.length === 0 && step.submit !== undefined && step.methods === undefined) ||
      "an ifShown step fills no field and clicks one control, with no methods",
  ),
);
/**
 * Version 5: version 4 whose steps may submit with a key (`submitKey`), refill a secret
 * (`refills`) or click a notice only where it shows (`ifShown`). A host that does not know version
 * 5 refuses it, so it never replays such a step without submitting it, without the refill or as a
 * step it must find; a version 5 recipe with a key this host does not know is refused too, as a
 * version 5 host that predates `refills` or `ifShown` refuses one that has it.
 */
export const KeySubmitAutofillRecipe = workspacePages(
  Schema.Struct({
    ...LegacyAutofillRecipe.fields,
    version: Schema.Literal(5),
    workspace: Schema.optional(Schema.Struct({ parent: HostName })),
    steps: Schema.Array(KeyRecipeStep).pipe(Schema.minItems(1), Schema.maxItems(12)),
  }).annotations({ parseOptions: { onExcessProperty: "error" } }),
);
export const AutofillRecipe = Schema.Union(
  LegacyAutofillRecipe,
  PopupAutofillRecipe,
  WorkspaceAutofillRecipe,
  KeySubmitAutofillRecipe,
);
export type AutofillRecipe = typeof AutofillRecipe.Type;
export type AutofillRecipeStep = typeof KeyRecipeStep.Type;
/** Where a version 4 recipe's sign-in may go besides the site's own host. */
export interface AutofillRecipeOrigins {
  readonly workspace?: { readonly parent: string } | undefined;
}

/** The bundle's recipe, or undefined when it has none or one this host cannot replay. */
export const publishedAutofillRecipe = (
  bundle: ReadonlyMap<string, string>,
): AutofillRecipe | undefined => {
  const text = bundle.get(autofillRecipePath);
  return text === undefined
    ? undefined
    : Option.getOrUndefined(Schema.decodeUnknownOption(Schema.parseJson(AutofillRecipe))(text));
};

/**
 * One screen of a sign-in as a host ran it, value-free: what a run replays. `submittedBy` is
 * `minter` when the host's click failed and the minter clicked it itself.
 */
interface RecordedRecipeStep {
  /** `workspace` for a screen on the login's workspace host, whose `page` is then a path. */
  readonly origin?: "workspace" | undefined;
  readonly popup?: AutofillRecipeStep["popup"] | undefined;
  readonly approval?: AutofillRecipeStep["approval"] | undefined;
  readonly rejectedMarkers?: AutofillRecipeStep["rejectedMarkers"] | undefined;
  /** With each identifier field's accepted kinds, never a value. */
  readonly fields: readonly AutofillField[];
  readonly submit?: string | undefined;
  /** The key pressed in the last field to submit its form, on a form with no submit control. */
  readonly submitKey?: SubmitKey | undefined;
  readonly submittedBy?: "host" | "minter" | undefined;
  /** A two-factor method choice's recorded methods. */
  readonly methods?: AutofillRecipeStep["methods"] | undefined;
  /** The secrets an earlier screen took that this one asks for again with a second factor. */
  readonly refills?: AutofillRecipeStep["refills"] | undefined;
  /** A notice's own control the page shows on some visits only. */
  readonly ifShown?: true | undefined;
  /** The page the step ran on, origin and path only. */
  readonly page: string;
}

const isIdentifierKind = Schema.is(IdentifierKinds);

/**
 * A recorded screen as the recipe ships it: an identifier field by the kinds it accepts, never the
 * kind this login sent, which each run resolves against its own login.
 */
export const recipeStep = (step: RecordedRecipeStep): AutofillRecipeStep => ({
  ...(step.origin === undefined ? {} : { origin: step.origin }),
  page: step.page,
  ...(step.approval === undefined ? {} : { approval: step.approval }),
  ...(step.popup === undefined ? {} : { popup: step.popup }),
  ...(step.rejectedMarkers === undefined ? {} : { rejectedMarkers: step.rejectedMarkers }),
  fields: step.fields.map((field) =>
    !isIdentifierKind(field.slot)
      ? {
          selector: field.selector,
          slot: field.slot,
          ...(field.format === undefined ? {} : { format: field.format }),
          ...(field.control === undefined ? {} : { control: field.control }),
          // A replay reads the question again; the recipe never holds an answer.
          ...(field.questionSelector === undefined
            ? {}
            : { questionSelector: field.questionSelector }),
        }
      : { selector: field.selector, accepts: field.accepts ?? [field.slot] },
  ),
  ...(step.refills === undefined ? {} : { refills: step.refills }),
  ...(step.ifShown === undefined ? {} : { ifShown: step.ifShown }),
  ...(step.submit === undefined ? {} : { submit: step.submit }),
  ...(step.submitKey === undefined ? {} : { submitKey: step.submitKey }),
  ...(step.submittedBy === undefined ? {} : { submittedBy: step.submittedBy }),
  ...(step.methods === undefined ? {} : { methods: step.methods }),
});

/**
 * A verified sign-in's recipe: version 5 only when a step submits with a key, refills a secret
 * (`refills`) or is `ifShown`, else version 4 only when its sign-in may move to a workspace host
 * (`origins.workspace`, or a workspace step), else version 2 only with a popup or an approval,
 * else version 1. A security answer's question selector rides in any of them. Versions 4 and 5
 * write `workspace` before `steps`.
 */
export const autofillRecipe = <SignedIn>(
  steps: readonly RecordedRecipeStep[],
  signedIn: SignedIn,
  origins: AutofillRecipeOrigins = {},
) => {
  if (
    steps.some(
      (step) =>
        step.submitKey !== undefined || step.refills !== undefined || step.ifShown !== undefined,
    )
  )
    return {
      version: 5 as const,
      ...(origins.workspace === undefined
        ? {}
        : { workspace: { parent: origins.workspace.parent } }),
      steps: steps.map(recipeStep),
      signedIn,
    };
  if (origins.workspace === undefined && steps.every((step) => step.origin === undefined))
    return {
      version: steps.some((step) => step.popup !== undefined || step.approval !== undefined)
        ? (2 as const)
        : (1 as const),
      steps: steps.map(recipeStep),
      signedIn,
    };
  return {
    version: 4 as const,
    ...(origins.workspace === undefined ? {} : { workspace: { parent: origins.workspace.parent } }),
    steps: steps.map(recipeStep),
    signedIn,
  };
};
