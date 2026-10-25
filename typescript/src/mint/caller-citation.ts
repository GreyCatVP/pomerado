/**
 * How many words in a row of the request's own text a `caller_input` report's intent repeats to
 * cite the caller's instruction; a shorter request is cited whole.
 */
const quotedWords = 4;
/** The most input field names read, and how deep, so a large input stays cheap to check. */
const maximumFields = 2_000;
const maximumDepth = 12;

/** Lowercase words, with a camelCase or snake_case name split into its words. */
const words = (text: string): readonly string[] =>
  text
    .normalize("NFKC")
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];

/** Every field name the input holds, nested ones included, never a value. */
const fieldNames = (input: unknown): readonly string[] => {
  const names: string[] = [];
  const pending: { readonly value: unknown; readonly depth: number }[] = [
    { value: input, depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { value, depth } = next;
    if (typeof value !== "object" || value === null || depth >= maximumDepth) continue;
    for (const [key, child] of Object.entries(value)) {
      if (!Array.isArray(value)) names.push(key);
      if (names.length >= maximumFields) return names;
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  return names;
};

/**
 * Whether a `caller_input` report's intent cites the caller's own request: it names a field the
 * task's input holds, or repeats four words in a row of the request's text, or all of it when the
 * text is shorter. Case, punctuation, spacing and camelCase or snake_case names are ignored.
 */
export const citesCallerRequest = (
  intent: string | undefined,
  requestText: string,
  input: unknown,
): boolean => {
  if (intent === undefined) return false;
  const said = ` ${words(intent).join(" ")} `;
  const has = (run: readonly string[]) => run.length > 0 && said.includes(` ${run.join(" ")} `);
  if (fieldNames(input).some((name) => has(words(name)))) return true;
  const asked = words(requestText);
  const length = Math.min(quotedWords, asked.length);
  for (let start = 0; start + length <= asked.length && length > 0; start++)
    if (has(asked.slice(start, start + length))) return true;
  return false;
};
