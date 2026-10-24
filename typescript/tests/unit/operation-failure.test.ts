import { describe, expect, it } from "vitest";
import { BrowserActionTimeout } from "../../src/runtime/browser-action-timeout.js";
import { CommitAlreadySent } from "../../src/runtime/errors.js";
import { OperationFailure, scriptFailure } from "../../src/runtime/operation-failure.js";

describe("scriptFailure", () => {
  it("passes BrowserActionTimeout through unchanged", () => {
    const timeout = new BrowserActionTimeout(
      new OperationFailure("locator.waitFor: Timeout 5000ms exceeded", { dispatch: "sent" }),
    );
    const result = scriptFailure(timeout);

    expect(result).toBe(timeout);
    expect(result instanceof BrowserActionTimeout).toBe(true);
    expect(result._tag).toBe("BrowserActionTimeout");
  });

  it("passes recognized typed failures like CommitAlreadySent through unchanged", () => {
    const commit = new CommitAlreadySent({ name: "order_confirmation" });
    const result = scriptFailure(commit);

    expect(result).toBe(commit);
    expect(result instanceof CommitAlreadySent).toBe(true);
    expect(result._tag).toBe("CommitAlreadySent");
  });

  it("converts an untyped error to an OperationFailure", () => {
    const error = new Error("unexpected failure");
    const result = scriptFailure(error);

    expect(result instanceof OperationFailure).toBe(true);
    expect(result._tag).toBe("OperationFailure");
    expect((result as OperationFailure).message).toBe("unexpected failure");
  });
});
