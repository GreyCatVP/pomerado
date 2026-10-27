import { expect, it } from "vitest";
import { submissionGuardCode } from "../../src/destinations/autofill-submission-guard.js";

const secret = "synthetic-password";
const decoy = `https://help.example.test/article?note=${secret}`;
const swapped = `https://collector.example.test/take?value=${secret}`;

/**
 * A window whose form method, action and elements are the form's own, and one password field.
 * Returns the guard the page function armed and a way to fire its submit listener.
 */
const arm = (actions: readonly string[], action: string) => {
  const listeners = new Map<string, (event: object) => void>();
  function HTMLFormElement(this: object) {
    return this;
  }
  for (const [name, read] of [
    ["method", function (this: { _method: string }) { return this._method; }],
    ["action", function (this: { _action: string }) { return this._action; }],
    ["elements", function (this: { _elements: unknown[] }) { return this._elements; }],
  ] as const)
    Object.defineProperty(HTMLFormElement.prototype, name, { get: read });
  const view: Record<string, unknown> & { HTMLFormElement: typeof HTMLFormElement } = {
    HTMLFormElement,
    addEventListener: (type: string, fn: (event: object) => void) => listeners.set(type, fn),
    setTimeout: (fn: () => void) => fn(),
  };
  const field = {
    ownerDocument: { defaultView: view },
    value: secret,
    form: null,
    closest: () => null,
  };
  const guardFn = (0, eval)(submissionGuardCode) as (
    field: object,
    options: object,
  ) => boolean;
  guardFn(field, {
    key: "guard",
    call: "call-1",
    actions: [...actions],
    match: "within",
    submit: null,
    submitInForm: false,
    submitGet: false,
    fieldGet: false,
  });
  const form = Object.assign(Object.create(HTMLFormElement.prototype), {
    _method: "post",
    _action: action,
    _elements: [field],
  });
  let prevented = false;
  listeners.get("submit")?.({
    isTrusted: true,
    target: form,
    submitter: null,
    preventDefault: () => {
      prevented = true;
    },
  });
  return { prevented, refused: (view["guard"] as { refused: unknown }).refused };
};

it("refuses an action on another origin that carries a secret only another origin's inspected action held", () => {
  const { prevented, refused } = arm([decoy], swapped);
  expect(prevented).toBe(true);
  expect(refused).toMatchObject({ changed: "action", actionOrigin: "https://collector.example.test" });
});
