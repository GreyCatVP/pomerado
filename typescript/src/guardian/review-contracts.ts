import { Schema } from "effect";

/**
 * Host-owned index of a publication review's evidence, in UTF-8 bytes. `published` files ship with
 * the tool; the rest are host evidence for this review only. `current` files are the publication
 * as it stands; the others are historical source an earlier execution ran, such as a write
 * session's act steps. `owner` says who wrote a file: the minter edits its own, and nothing it
 * edits changes a host-written one. Guardian reads what the review needs; nothing must be read in
 * full.
 */
export interface PublicationScope {
  readonly files: readonly {
    readonly path: string;
    readonly byteLength: number;
    readonly published: boolean;
    readonly current: boolean;
    readonly owner: "host" | "minter";
  }[];
}

/**
 * The business meaning of an execution, as Guardian's execution review labels it: `read`
 * observes without changing persistent business state; `write` changes it, an intermediate
 * change such as adding to a cart or saving a draft included; `authentication` signs in. Every
 * allowed execution carries one, and a host records it against the execution.
 */
export const guardianActions = ["read", "write", "authentication"] as const;
export const GuardianAction = Schema.Literal(...guardianActions);
export type GuardianAction = typeof GuardianAction.Type;

/**
 * Input findings are feedback for the minter; they never block a publication on their own.
 * `example_input` is the host's own check that each key of an intent-derived example's input is
 * a schema input, never Guardian's.
 */
export const inputFindingCategories = [
  "account_specific_enum",
  "input_option",
  "example_input",
] as const;
export const publicationFindingCategories = [
  "private_literal",
  "credential",
  "customer_data",
  "exfiltration",
  "unsafe_logging",
  "schema_mismatch",
  "unsupported_claim",
  "confirmation",
  // An input narrowed to the example's value, which blocks publication like a source correction.
  "example_value",
  // A safety default an earlier copy of the source set that the current source drops or weakens,
  // which blocks publication with reason privacy.
  "safety_default",
  ...inputFindingCategories,
] as const;
export const publicationReasons = [
  "approved",
  "privacy",
  "authority",
  "evidence",
  "source_correction",
  "unsupported_claim",
  "input_feedback",
  // Every finding is in a host-written file, which no source or metadata edit can fix.
  "host_owned",
] as const;
/**
 * Publication reasons whose denial names a fix the minter can make itself: a source, schema or
 * metadata correction, a narrower claim, input feedback, or evidence it can collect. Such a
 * denial is feedback, never a refusal of the task, so a `policy` block cannot rest on it alone.
 * `privacy`, `authority` and `host_owned` are not: no edit within the minter's authority gets
 * past them.
 */
export const correctablePublicationReasons = [
  "source_correction",
  "unsupported_claim",
  "input_feedback",
  "evidence",
] as const satisfies readonly (typeof publicationReasons)[number][];
/** Whether a publication denial's reason names a fix the minter can make; see above. */
export const correctablePublicationReason = (reason: string | undefined): boolean =>
  (correctablePublicationReasons as readonly (string | undefined)[]).includes(reason);

/** The parts of one route in a host-generated routes.json that a finding can point at. */
export const routePointerParts = [
  "request_field",
  "response_field",
  "query",
  "path_segment",
  "session",
  "url",
] as const;
/**
 * Where in a host-generated file a finding is: the route by its `order`, which every review chunk
 * shows, and the part at fault, named exactly as the file writes it; `url` is the whole route and
 * names nothing. The host checks it against the file; a pointer it cannot match is no pointer.
 */
export const RoutePointer = Schema.Struct({
  order: Schema.Int.pipe(Schema.positive()),
  part: Schema.Literal(...routePointerParts),
  name: Schema.NullOr(Schema.String),
});
export type RoutePointer = typeof RoutePointer.Type;

/**
 * Text cut to `limit` characters, its last an ellipsis, never keeping half of a surrogate pair:
 * Guardian's text that outgrows its limit is kept, not lost with the decision.
 */
export const cutToLimit = (text: string, limit: number) => {
  if (text.length <= limit) return text;
  const high = text.charCodeAt(limit - 2);
  return `${text.slice(0, high >= 0xd800 && high <= 0xdbff ? limit - 2 : limit - 1)}…`;
};

/** The characters one finding's explanation may hold; the host cuts a longer one to fit. */
export const publicationExplanationLimit = 800;
export const PublicationFinding = Schema.Struct({
  path: Schema.String,
  byteStart: Schema.Int.pipe(Schema.nonNegative()),
  byteEnd: Schema.Int.pipe(Schema.positive()),
  category: Schema.Literal(...publicationFindingCategories),
  /**
   * What is wrong, the evidence and the fix, in words the minter acts on without the rest of the
   * review. It may quote the source, so it reaches the minter screened like the rationale.
   */
  explanation: Schema.String.pipe(
    Schema.minLength(1),
    Schema.maxLength(publicationExplanationLimit),
  ),
  /** Only for a finding in a host-generated file; the model sends null for any other. */
  route: Schema.optionalWith(RoutePointer, { exact: true, nullable: true }),
});
export type PublicationFinding = typeof PublicationFinding.Type;
export const PublicationReason = Schema.Literal(...publicationReasons);
export type PublicationReason = typeof PublicationReason.Type;

export interface PublicationFileBlock {
  readonly file: string;
  readonly section?: string;
  readonly check: "registered_value" | "contextual_secret" | "provider_credential" | "invalid_text";
  readonly entity?: string;
  readonly valueSource?: string;
  readonly field?: string;
  readonly line?: number;
  readonly column?: number;
}
