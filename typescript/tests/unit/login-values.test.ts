import { describe, expect, it } from "vitest";
import { answeredKind, parsedAnswer } from "../../src/runtime/login-values.js";

describe("answeredKind", () => {
  it("rejects a malformed email answer when only email is accepted", () => {
    expect(answeredKind("not-an-email", ["email"])).toBeUndefined();
    expect(answeredKind("user@", ["email"])).toBeUndefined();
    expect(answeredKind("@example.com", ["email"])).toBeUndefined();
    expect(answeredKind("user example.com", ["email"])).toBeUndefined();
  });

  it("rejects a malformed email answer when email or phone is accepted and value is neither", () => {
    expect(answeredKind("not-an-email-or-phone", ["email", "phone"])).toBeUndefined();
    expect(answeredKind("not-an-email", ["email", "phone"])).toBeUndefined();
  });

  it("accepts a valid email answer when only email is accepted", () => {
    expect(answeredKind("user@example.com", ["email"])).toBe("email");
    expect(answeredKind("  ada@example.org  ", ["email"])).toBe("email");
  });

  it("classifies a valid email answer as email when email or phone is accepted", () => {
    expect(answeredKind("user@example.com", ["email", "phone"])).toBe("email");
  });

  it("classifies a valid phone answer as phone when email or phone is accepted", () => {
    expect(answeredKind("+1 415 555 0142", ["email", "phone"])).toBe("phone");
    expect(answeredKind("4155550142", ["email", "phone"])).toBe("phone");
  });

  it("accepts a valid phone answer when only phone is accepted", () => {
    expect(answeredKind("+1 415 555 0142", ["phone"])).toBe("phone");
  });

  it("rejects an invalid phone answer when only phone is accepted", () => {
    expect(answeredKind("not-a-phone", ["phone"])).toBeUndefined();
    expect(answeredKind("123", ["phone"])).toBeUndefined();
  });

  it("falls back to account_number for any value when account_number is accepted", () => {
    expect(answeredKind("123456", ["account_number"])).toBe("account_number");
    expect(answeredKind("any-string", ["account_number"])).toBe("account_number");
    expect(answeredKind("not-an-email", ["email", "account_number"])).toBe("account_number");
    expect(answeredKind("user@example.com", ["email", "account_number"])).toBe("email");
    expect(answeredKind("not-a-phone", ["phone", "account_number"])).toBe("account_number");
    expect(answeredKind("+1 415 555 0142", ["phone", "account_number"])).toBe("phone");
    expect(answeredKind("arbitrary-id", ["email", "phone", "account_number"])).toBe("account_number");
  });
});

describe("parsedAnswer", () => {
  it("returns undefined for a malformed email answer", () => {
    expect(parsedAnswer(["email"], "not-an-email")).toBeUndefined();
    expect(parsedAnswer(["email", "phone"], "not-an-email")).toBeUndefined();
  });

  it("returns the kept email slot and value for a valid email answer", () => {
    expect(parsedAnswer(["email"], "user@example.com")).toEqual({
      slot: "email",
      value: "user@example.com",
    });
    expect(parsedAnswer(["email", "phone"], "user@example.com")).toEqual({
      slot: "email",
      value: "user@example.com",
    });
  });
});
